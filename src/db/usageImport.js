'use strict';

const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const { parse } = require('csv-parse/sync');
const { openUsageDb, getDbPath } = require('./usageDb');

function keepZipEnv() {
  const v = String(process.env.CRAWLER_KEEP_ZIP ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

function assertZipSlipSafe(entryName, outDirResolved) {
  const normalized = String(entryName).replace(/\\/g, '/').replace(/^\/+/, '');
  if (normalized.includes('..')) {
    throw new Error(`非法 zip 路径: ${entryName}`);
  }
  const dest = path.resolve(outDirResolved, normalized);
  const base = path.resolve(outDirResolved);
  if (dest !== base && !dest.startsWith(base + path.sep)) {
    throw new Error(`Zip slip 拒绝: ${entryName}`);
  }
  return dest;
}

function extractZipSafe(zipPath, outDir) {
  const outResolved = path.resolve(outDir);
  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries();
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    assertZipSlipSafe(entry.entryName, outResolved);
  }
  zip.extractAllTo(outResolved, true);
}

function dirHasUsageCostCsv(dirPath) {
  try {
    return fs.readdirSync(dirPath).some((f) => /^cost-.+\.csv$/i.test(f));
  } catch {
    return false;
  }
}

function findUsageDataRoot(downloadDir, zipPath) {
  const stem = path.basename(zipPath, path.extname(zipPath));
  const candidate = path.join(downloadDir, stem);
  if (dirHasUsageCostCsv(candidate)) return candidate;
  if (dirHasUsageCostCsv(downloadDir)) return downloadDir;

  const subs = fs
    .readdirSync(downloadDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => path.join(downloadDir, d.name))
    .filter(dirHasUsageCostCsv);
  if (subs.length === 0) {
    throw new Error('解压后未在下载目录中找到 cost-*.csv，请检查 zip 内容');
  }
  subs.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return subs[0];
}

function readCsvObjects(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  return parse(raw, {
    columns: (header) => header.map((h) => String(h).trim()),
    skip_empty_lines: true,
    relax_column_count: true,
    trim: true,
  });
}

function importCostFile(db, filePath) {
  const rows = readCsvObjects(filePath);
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO usage_cost (user_id, utc_date, model, wallet_type, cost, currency)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  db.exec('BEGIN');
  try {
    for (const r of rows) {
      stmt.run(
        r.user_id,
        r.utc_date,
        r.model,
        r.wallet_type,
        String(r.cost ?? ''),
        r.currency ?? ''
      );
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return rows.length;
}

function importAmountFile(db, filePath) {
  const rows = readCsvObjects(filePath);
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO usage_amount (
      user_id, utc_date, model, api_key_name, api_key, type, price, amount
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  db.exec('BEGIN');
  try {
    for (const r of rows) {
      stmt.run(
        r.user_id,
        r.utc_date,
        r.model,
        r.api_key_name ?? '',
        r.api_key ?? null,
        r.type ?? '',
        r.price === undefined || r.price === '' ? null : String(r.price),
        r.amount === undefined || r.amount === '' ? null : String(r.amount)
      );
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return rows.length;
}

function importUsageFolder(db, folderPath) {
  const names = fs.readdirSync(folderPath);
  let costRows = 0;
  let amountRows = 0;
  for (const name of names) {
    const full = path.join(folderPath, name);
    if (!fs.statSync(full).isFile()) continue;
    if (/^cost-.+\.csv$/i.test(name)) {
      costRows += importCostFile(db, full);
    } else if (/^amount-.+\.csv$/i.test(name)) {
      amountRows += importAmountFile(db, full);
    }
  }
  if (costRows === 0 && amountRows === 0) {
    throw new Error(`目录中未找到可导入的 cost-*.csv / amount-*.csv: ${folderPath}`);
  }
  return { costRows, amountRows, folderPath };
}

function importSingleCsv(db, csvPath) {
  const name = path.basename(csvPath);
  if (/^cost-.+\.csv$/i.test(name)) {
    const n = importCostFile(db, csvPath);
    return { costRows: n, amountRows: 0, folderPath: path.dirname(csvPath) };
  }
  if (/^amount-.+\.csv$/i.test(name)) {
    const n = importAmountFile(db, csvPath);
    return { costRows: 0, amountRows: n, folderPath: path.dirname(csvPath) };
  }
  throw new Error(`不支持的 CSV 文件名（需 cost-*.csv 或 amount-*.csv）: ${name}`);
}

/**
 * 下载完成后：解压 zip（如需）并写入 SQLite（仅 CSV 列，与 node:sqlite）。
 * zip 在解压并导入成功后会删除（除非 CRAWLER_KEEP_ZIP=1）。
 * @param {string} savedPath 本地文件路径
 * @param {{ downloadDir: string }} opts
 */
function importUsageAfterDownload(savedPath, opts) {
  const downloadDir = path.resolve(opts.downloadDir);
  const abs = path.resolve(savedPath);
  const ext = path.extname(abs).toLowerCase();

  const db = openUsageDb();
  let result;
  try {
    if (ext === '.zip') {
      extractZipSafe(abs, downloadDir);
      const root = findUsageDataRoot(downloadDir, abs);
      result = { dbPath: getDbPath(), extractRoot: root, ...importUsageFolder(db, root) };
    } else if (ext === '.csv') {
      result = { dbPath: getDbPath(), extractRoot: null, ...importSingleCsv(db, abs) };
    } else {
      result = { dbPath: getDbPath(), skipped: true, reason: `不处理扩展名: ${ext}` };
    }
  } finally {
    db.close();
  }

  if (ext === '.zip' && result && !result.skipped && !keepZipEnv()) {
    try {
      fs.unlinkSync(abs);
      result.zipDeleted = true;
    } catch (e) {
      result.zipDeleted = false;
      result.zipDeleteError = e.message;
    }
  }

  return result;
}

module.exports = {
  importUsageAfterDownload,
  extractZipSafe,
  findUsageDataRoot,
};

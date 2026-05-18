'use strict';

const path = require('path');
const fs = require('fs/promises');
const fsSync = require('fs');
const puppeteer = require('puppeteer');
const { importUsageAfterDownload } = require('../db/usageImport');
const { getDbPath } = require('../db/usageDb');

const USAGE_URL = 'https://platform.deepseek.com/usage';
const USER_DATA_DIR = path.join(__dirname, '..', '..', '.puppeteer-profile');
/** 浏览器下载与 zip 解压：项目根 usage-exports/（usage-exports/<zip 主名>/ *.csv） */
const USAGE_EXPORT_DIR = path.join(__dirname, '..', '..', 'usage-exports');
/** 有界面模式下等待「导出」（含扫码登录） */
const WAIT_EXPORT_MS = 5 * 60 * 1000;
const WAIT_FILE_MS = 3 * 60 * 1000;
/** 无头模式下等待「导出」的最长时间（毫秒），可用 CRAWLER_HEADLESS_PROBE_MS 覆盖 */
const DEFAULT_HEADLESS_PROBE_MS = 30 * 1000;

class ExportButtonTimeoutError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'ExportButtonTimeoutError';
  }
}

function sleep (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function envTruthy (name) {
  const v = String(process.env[name] ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

function isTimeoutError (err) {
  if (!err) return false;
  if (err.name === 'TimeoutError') return true;
  if (err instanceof ExportButtonTimeoutError) return false;
  return /waiting failed: \d+ms exceeded|timeout/i.test(String(err.message || ''));
}

function isExportFile (name) {
  const lower = name.toLowerCase();
  return lower.endsWith('.csv') || lower.endsWith('.zip');
}

async function waitForStableExportFile (dir, sinceMs, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  let stableTicks = 0;

  while (Date.now() < deadline) {
    if (fsSync.existsSync(dir)) {
      const partial = (await fs.readdir(dir)).some(
        (n) => n.endsWith('.crdownload') || n.endsWith('.tmp') || /\.part$/i.test(n)
      );
      if (partial) {
        await sleep(300);
        continue;
      }
    }

    if (!fsSync.existsSync(dir)) {
      await sleep(300);
      continue;
    }

    const names = await fs.readdir(dir);
    let foundThisRound = false;
    for (const name of names) {
      if (!isExportFile(name)) continue;
      const full = path.join(dir, name);
      let st;
      try {
        st = await fs.stat(full);
      } catch {
        continue;
      }
      if (st.mtimeMs < sinceMs - 2000) continue;
      foundThisRound = true;
      if (last && last.full === full && last.size === st.size) {
        stableTicks += 1;
        if (stableTicks >= 3) return full;
      } else {
        last = { full, size: st.size };
        stableTicks = 0;
      }
    }
    if (!foundThisRound) {
      last = null;
      stableTicks = 0;
    }
    await sleep(400);
  }

  throw new Error(
    '等待导出文件超时：平台可能下载为 .zip 或 .csv。若文件进了系统「下载」文件夹，请检查 CDP 下载目录是否生效，或将文件移入：' +
    path.resolve(dir)
  );
}

function exportButtonPredicate () {
  const nodes = Array.from(
    document.querySelectorAll('button, [role="button"], a.ant-btn, .ant-btn')
  );
  if (
    nodes.some((el) => {
      const t = (el.textContent || '').replace(/\s+/g, '').trim();
      return t === '导出' || t.endsWith('导出');
    })
  ) {
    return true;
  }
  const r = document.evaluate(
    "//*[normalize-space()='导出']",
    document,
    null,
    XPathResult.FIRST_ORDERED_NODE_TYPE,
    null
  );
  return Boolean(r.singleNodeValue);
}

async function waitForExportButton (page, timeoutMs) {
  try {
    await page.waitForFunction(exportButtonPredicate, { timeout: timeoutMs });
  } catch (e) {
    if (isTimeoutError(e)) {
      throw new ExportButtonTimeoutError('在限定时间内未出现「导出」按钮', { cause: e });
    }
    throw e;
  }
}

async function clickExport (page) {
  const viaDom = await page.evaluate(() => {
    const nodes = Array.from(
      document.querySelectorAll('button, [role="button"], a.ant-btn, .ant-btn')
    );
    for (const el of nodes) {
      const t = (el.textContent || '').replace(/\s+/g, '').trim();
      if (t === '导出' || t.endsWith('导出')) {
        el.click();
        return true;
      }
    }
    const r = document.evaluate(
      "//*[normalize-space()='导出']",
      document,
      null,
      XPathResult.FIRST_ORDERED_NODE_TYPE,
      null
    );
    const n = r.singleNodeValue;
    if (n && typeof n.click === 'function') {
      n.click();
      return true;
    }
    return false;
  });

  if (viaDom) return;

  throw new Error('未找到「导出」按钮：请在用量页确认「每月用量」已加载，或页面结构已变更');
}

async function launchBrowser (headless) {
  const launchOpts = {
    headless,
    userDataDir: USER_DATA_DIR,
  };
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    launchOpts.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
  }
  try {
    return await puppeteer.launch(launchOpts);
  } catch (e) {
    console.error(
      [
        '启动浏览器失败。常见原因：本机尚未下载 Puppeteer 自带的 Chrome。',
        '请先执行（只需一次）：pnpm run crawler:install-chrome',
        '若使用系统已安装的 Chrome/Edge，可设置环境变量 PUPPETEER_EXECUTABLE_PATH 为浏览器可执行文件路径。',
      ].join('\n')
    );
    throw e;
  }
}

/**
 * 单次完整流程：打开用量页 → 等「导出」→ 点击 → 等文件落地
 * @param {{ headless: boolean, exportWaitMs: number }} opts
 */
async function runExportOnce (opts) {
  const { headless, exportWaitMs } = opts;
  const modeLabel = headless ? '无头' : '有界面';
  const browser = await launchBrowser(headless);

  try {
    const pages = await browser.pages();
    const page = pages[0] || (await browser.newPage());

    const cdp = await page.createCDPSession();
    await cdp.send('Page.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: path.resolve(USAGE_EXPORT_DIR),
    });

    console.log(`[${modeLabel}] 用户数据目录:`, USER_DATA_DIR);
    console.log(`[${modeLabel}] 导出文件将保存到:`, path.resolve(USAGE_EXPORT_DIR), '（.zip / .csv）');
    console.log(`[${modeLabel}] 正在打开用量页…`);

    await page.goto(USAGE_URL, { waitUntil: 'domcontentloaded', timeout: 120000 });

    console.log(
      `[${modeLabel}] 等待「导出」按钮（本阶段最长 ${Math.round(exportWaitMs / 1000)}s）…`
    );
    await waitForExportButton(page, exportWaitMs);

    const since = Date.now();

    console.log(`[${modeLabel}] 点击「导出」…（当前页所选月份）`);
    await clickExport(page);

    console.log(`[${modeLabel}] 等待导出文件写入完成…`);
    const savedPath = await waitForStableExportFile(USAGE_EXPORT_DIR, since, WAIT_FILE_MS);
    console.log('完成:', savedPath);
    return savedPath;
  } finally {
    await browser.close().catch(() => { });
  }
}

async function main () {
  await fs.mkdir(USER_DATA_DIR, { recursive: true });
  await fs.mkdir(USAGE_EXPORT_DIR, { recursive: true });

  const forceHeaded = envTruthy('CRAWLER_HEADED') || envTruthy('CRAWLER_FORCE_HEADED');
  const probeMsRaw = Number(process.env.CRAWLER_HEADLESS_PROBE_MS);
  const headlessProbeMs =
    Number.isFinite(probeMsRaw) && probeMsRaw > 0 ? probeMsRaw : DEFAULT_HEADLESS_PROBE_MS;

  if (forceHeaded) {
    console.log('已设置 CRAWLER_HEADED=1（或 CRAWLER_FORCE_HEADED）：跳过无头，直接使用有界面浏览器。');
    const savedPath = await runExportOnce({ headless: false, exportWaitMs: WAIT_EXPORT_MS });
    await postImport(savedPath);
    return;
  }

  try {
    console.log(
      `先尝试无头模式；若 ${Math.round(headlessProbeMs / 1000)}s 内未出现「导出」，将自动改为有界面（可扫码登录）。`
    );
    console.log('（强制有界面：设置 CRAWLER_HEADED=1；加长无头等待：CRAWLER_HEADLESS_PROBE_MS=毫秒）');
    const savedPath = await runExportOnce({ headless: true, exportWaitMs: headlessProbeMs });
    await postImport(savedPath);
  } catch (e) {
    if (e instanceof ExportButtonTimeoutError) {
      console.warn(
        '无头模式下未在限定时间内检测到「导出」（可能未登录、会话过期或页面加载较慢）。\n改用有界面浏览器，请在窗口中完成登录后等待导出…'
      );
      const savedPath = await runExportOnce({ headless: false, exportWaitMs: WAIT_EXPORT_MS });
      await postImport(savedPath);
      return;
    }
    throw e;
  }
}

async function postImport (savedPath) {
  console.log('数据库文件:', getDbPath());
  console.log('正在解压（若为 zip）并导入 SQLite…');
  const result = importUsageAfterDownload(savedPath, { downloadDir: USAGE_EXPORT_DIR });
  console.log('导入完成:', result);
  if (result.zipDeleted === true) {
    console.log('已删除下载的 zip（设置 CRAWLER_KEEP_ZIP=1 可保留）');
  } else if (result.zipDeleteError) {
    console.warn('未能删除 zip:', result.zipDeleteError);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

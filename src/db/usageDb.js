'use strict';

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DEFAULT_DB_PATH = path.join(__dirname, '..', '..', 'data', 'usage.sqlite');

/** 与 cost-*.csv 表头一致 */
const USAGE_COST_COLUMNS = [
  'user_id',
  'utc_date',
  'model',
  'wallet_type',
  'cost',
  'currency',
];

/** 与 amount-*.csv 表头一致 */
const USAGE_AMOUNT_COLUMNS = [
  'user_id',
  'utc_date',
  'model',
  'api_key_name',
  'api_key',
  'type',
  'price',
  'amount',
];

function getDbPath() {
  const override = process.env.USAGE_DB_PATH;
  return override ? path.resolve(override) : DEFAULT_DB_PATH;
}

function tableExists(db, name) {
  const row = db
    .prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(name);
  return Boolean(row);
}

function getColumnNames(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name);
}

function columnSetMatches(db, table, expected) {
  if (!tableExists(db, table)) return false;
  const names = new Set(getColumnNames(db, table));
  if (names.size !== expected.length) return false;
  return expected.every((c) => names.has(c));
}

function createUsageCost(db) {
  db.exec(`
    CREATE TABLE usage_cost (
      user_id TEXT NOT NULL,
      utc_date TEXT NOT NULL,
      model TEXT NOT NULL,
      wallet_type TEXT NOT NULL,
      cost TEXT NOT NULL,
      currency TEXT NOT NULL,
      PRIMARY KEY (user_id, utc_date, model, wallet_type)
    );
  `);
}

function createUsageAmount(db) {
  db.exec(`
    CREATE TABLE usage_amount (
      user_id TEXT NOT NULL,
      utc_date TEXT NOT NULL,
      model TEXT NOT NULL,
      api_key_name TEXT NOT NULL DEFAULT '',
      api_key TEXT,
      type TEXT NOT NULL,
      price TEXT,
      amount TEXT,
      PRIMARY KEY (user_id, utc_date, model, api_key_name, type)
    );
  `);
}

function rebuildUsageCostFromOld(db) {
  const cols = getColumnNames(db, 'usage_cost');
  const has = (c) => cols.includes(c);
  if (!has('user_id') || !has('utc_date') || !has('model') || !has('wallet_type') || !has('cost') || !has('currency')) {
    db.exec('DROP TABLE IF EXISTS usage_cost;');
    createUsageCost(db);
    return;
  }
  const selectList = USAGE_COST_COLUMNS.join(', ');
  db.exec(`
    CREATE TABLE usage_cost__m (
      user_id TEXT NOT NULL,
      utc_date TEXT NOT NULL,
      model TEXT NOT NULL,
      wallet_type TEXT NOT NULL,
      cost TEXT NOT NULL,
      currency TEXT NOT NULL,
      PRIMARY KEY (user_id, utc_date, model, wallet_type)
    );
    INSERT INTO usage_cost__m (${selectList})
    SELECT ${selectList} FROM usage_cost;
    DROP TABLE usage_cost;
    ALTER TABLE usage_cost__m RENAME TO usage_cost;
  `);
}

function rebuildUsageAmountFromOld(db) {
  const cols = getColumnNames(db, 'usage_amount');
  const has = (c) => cols.includes(c);
  if (!has('user_id') || !has('utc_date') || !has('model') || !has('type')) {
    db.exec('DROP TABLE IF EXISTS usage_amount;');
    createUsageAmount(db);
    return;
  }
  const keyMasked = cols.includes('api_key_masked');
  const keyPlain = cols.includes('api_key');
  let keyExpr = 'NULL';
  if (keyPlain && keyMasked) keyExpr = 'COALESCE(api_key, api_key_masked)';
  else if (keyPlain) keyExpr = 'api_key';
  else if (keyMasked) keyExpr = 'api_key_masked';

  db.exec(`
    CREATE TABLE usage_amount__m (
      user_id TEXT NOT NULL,
      utc_date TEXT NOT NULL,
      model TEXT NOT NULL,
      api_key_name TEXT NOT NULL DEFAULT '',
      api_key TEXT,
      type TEXT NOT NULL,
      price TEXT,
      amount TEXT,
      PRIMARY KEY (user_id, utc_date, model, api_key_name, type)
    );
    INSERT INTO usage_amount__m (
      user_id, utc_date, model, api_key_name, api_key, type, price, amount
    )
    SELECT
      user_id,
      utc_date,
      model,
      COALESCE(api_key_name, ''),
      ${keyExpr},
      type,
      price,
      amount
    FROM usage_amount;
    DROP TABLE usage_amount;
    ALTER TABLE usage_amount__m RENAME TO usage_amount;
  `);
}

function migrate(db) {
  if (!tableExists(db, 'usage_cost')) {
    createUsageCost(db);
  } else if (!columnSetMatches(db, 'usage_cost', USAGE_COST_COLUMNS)) {
    rebuildUsageCostFromOld(db);
  }

  if (!tableExists(db, 'usage_amount')) {
    createUsageAmount(db);
  } else if (!columnSetMatches(db, 'usage_amount', USAGE_AMOUNT_COLUMNS)) {
    rebuildUsageAmountFromOld(db);
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_usage_cost_date ON usage_cost(utc_date);
    CREATE INDEX IF NOT EXISTS idx_usage_amount_date ON usage_amount(utc_date);
    CREATE INDEX IF NOT EXISTS idx_usage_amount_model ON usage_amount(model);
  `);
}

function openUsageDb() {
  const dbPath = getDbPath();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  migrate(db);
  return db;
}

module.exports = {
  openUsageDb,
  getDbPath,
};

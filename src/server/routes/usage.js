'use strict';

const fs = require('fs');
const express = require('express');
const { DatabaseSync } = require('node:sqlite');
const { getDbPath } = require('../../db/usageDb');

const router = express.Router();

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function usageAuthMiddleware(req, res, next) {
  const token = process.env.USAGE_API_TOKEN;
  if (!token) return next();
  const auth = req.headers.authorization;
  const bearer = auth && String(auth).startsWith('Bearer ') ? String(auth).slice(7).trim() : null;
  const q = req.query.token != null ? String(req.query.token) : null;
  if (bearer === token || q === token) return next();
  return res.status(401).json({
    error: '未授权访问用量接口',
    hint: '设置请求头 Authorization: Bearer <USAGE_API_TOKEN> 或查询参数 token=',
    code: 'USAGE_AUTH_REQUIRED',
  });
}

function attachDbClose(res, db) {
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    try {
      db.close();
    } catch (_) {}
  };
  res.on('finish', close);
  res.on('close', close);
}

function openUsageDbMiddleware(req, res, next) {
  const dbPath = getDbPath();
  if (!fs.existsSync(dbPath)) {
    return res.status(503).json({
      error: '用量数据库不存在',
      hint: '请先运行 pnpm run crawler 完成导出与导入',
      code: 'USAGE_DB_MISSING',
    });
  }
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true, timeout: 5000 });
  } catch (e) {
    return res.status(503).json({
      error: '无法打开用量数据库',
      message: e.message,
      code: 'USAGE_DB_OPEN_FAILED',
    });
  }
  req.usageDb = db;
  attachDbClose(res, db);
  next();
}

function parseLimitOffset(req) {
  const rawLimit = parseInt(req.query.limit, 10);
  const rawOffset = parseInt(req.query.offset, 10);
  const limit = Number.isFinite(rawLimit) ? Math.min(500, Math.max(1, rawLimit)) : 50;
  const offset = Number.isFinite(rawOffset) ? Math.max(0, rawOffset) : 0;
  return { limit, offset };
}

function addDateRange(where, params, from, to, column = 'utc_date') {
  if (from && ISO_DATE.test(from)) {
    where.push(`${column} >= ?`);
    params.push(from);
  }
  if (to && ISO_DATE.test(to)) {
    where.push(`${column} <= ?`);
    params.push(to);
  }
}

/** @param {import('express').Request} req */
function buildCostFilters(req) {
  const where = [];
  const params = [];
  addDateRange(where, params, req.query.from, req.query.to);
  if (req.query.model) {
    where.push('model = ?');
    params.push(String(req.query.model));
  }
  if (req.query.user_id) {
    where.push('user_id = ?');
    params.push(String(req.query.user_id));
  }
  if (req.query.currency) {
    where.push('currency = ?');
    params.push(String(req.query.currency));
  }
  return { where, params };
}

function buildAmountFilters(req) {
  const where = [];
  const params = [];
  addDateRange(where, params, req.query.from, req.query.to);
  if (req.query.model) {
    where.push('model = ?');
    params.push(String(req.query.model));
  }
  if (req.query.user_id) {
    where.push('user_id = ?');
    params.push(String(req.query.user_id));
  }
  if (req.query.api_key_name) {
    where.push('api_key_name = ?');
    params.push(String(req.query.api_key_name));
  }
  if (req.query.type) {
    where.push('type = ?');
    params.push(String(req.query.type));
  }
  return { where, params };
}

router.use(usageAuthMiddleware);
router.use(openUsageDbMiddleware);

router.get('/meta', (req, res) => {
  const db = req.usageDb;
  const costCount = db.prepare('SELECT COUNT(*) AS n FROM usage_cost').get().n;
  const amountCount = db.prepare('SELECT COUNT(*) AS n FROM usage_amount').get().n;
  const body = {
    tables: {
      usage_cost: costCount,
      usage_amount: amountCount,
    },
  };
  if (process.env.NODE_ENV !== 'production') {
    body.dbPath = getDbPath();
  }
  res.json(body);
});

router.get('/dashboard', (req, res) => {
  const db = req.usageDb;
  const range = db
    .prepare(
      `SELECT MIN(utc_date) AS min_date, MAX(utc_date) AS max_date FROM (
        SELECT utc_date FROM usage_cost
        UNION
        SELECT utc_date FROM usage_amount
      ) AS u`
    )
    .get();
  const totalCostRow = db
    .prepare(
      `SELECT currency, SUM(CAST(cost AS REAL)) AS total
       FROM usage_cost GROUP BY currency`
    )
    .all();
  const byType = db
    .prepare(
      `SELECT type,
        SUM(CASE WHEN amount IS NOT NULL AND TRIM(amount) != ''
          THEN CAST(amount AS REAL) ELSE 0 END) AS total_amount
       FROM usage_amount GROUP BY type ORDER BY type`
    )
    .all();
  const cache = db
    .prepare(
      `SELECT type,
        SUM(CASE WHEN amount IS NOT NULL AND TRIM(amount) != ''
          THEN CAST(amount AS REAL) ELSE 0 END) AS total_amount
       FROM usage_amount
       WHERE type IN ('input_cache_hit_tokens', 'input_cache_miss_tokens')
       GROUP BY type`
    )
    .all();
  res.json({
    date_range: {
      min_date: range.min_date ?? null,
      max_date: range.max_date ?? null,
    },
    total_cost_by_currency: totalCostRow,
    amount_by_type: byType,
    cache_tokens: cache,
    row_counts: {
      usage_cost: db.prepare('SELECT COUNT(*) AS n FROM usage_cost').get().n,
      usage_amount: db.prepare('SELECT COUNT(*) AS n FROM usage_amount').get().n,
    },
  });
});

router.get('/cost/range', (req, res) => {
  const row = req.usageDb
    .prepare('SELECT MIN(utc_date) AS min_date, MAX(utc_date) AS max_date FROM usage_cost')
    .get();
  res.json({
    min_date: row.min_date ?? null,
    max_date: row.max_date ?? null,
  });
});

router.get('/cost/models', (req, res) => {
  const rows = req.usageDb.prepare('SELECT DISTINCT model FROM usage_cost ORDER BY model').all();
  res.json({ models: rows.map((r) => r.model) });
});

router.get('/cost/summary', (req, res) => {
  const groupBy = req.query.groupBy === 'month' ? 'month' : 'day';
  const { where, params } = buildCostFilters(req);
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  let sql;
  if (groupBy === 'month') {
    sql = `
      SELECT substr(utc_date, 1, 7) AS period, currency,
        SUM(CAST(cost AS REAL)) AS total_cost
      FROM usage_cost ${clause}
      GROUP BY period, currency
      ORDER BY period DESC, currency`;
  } else {
    sql = `
      SELECT utc_date AS period, currency,
        SUM(CAST(cost AS REAL)) AS total_cost
      FROM usage_cost ${clause}
      GROUP BY utc_date, currency
      ORDER BY utc_date DESC, currency`;
  }
  const rows = req.usageDb.prepare(sql).all(...params);
  res.json({ groupBy, rows });
});

router.get('/cost/day/:utcDate', (req, res) => {
  const d = req.params.utcDate;
  if (!ISO_DATE.test(d)) {
    return res.status(400).json({ error: '日期格式须为 YYYY-MM-DD', code: 'INVALID_DATE' });
  }
  const rows = req.usageDb
    .prepare(
      `SELECT user_id, utc_date, model, wallet_type, cost, currency
       FROM usage_cost WHERE utc_date = ? ORDER BY model`
    )
    .all(d);
  res.json({ utc_date: d, rows, total: rows.length });
});

router.get('/cost', (req, res) => {
  const { limit, offset } = parseLimitOffset(req);
  const { where, params } = buildCostFilters(req);
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const countSql = `SELECT COUNT(*) AS c FROM usage_cost ${clause}`;
  const total = req.usageDb.prepare(countSql).get(...params).c;
  const listSql = `
    SELECT user_id, utc_date, model, wallet_type, cost, currency
    FROM usage_cost ${clause}
    ORDER BY utc_date DESC, model
    LIMIT ? OFFSET ?`;
  const rows = req.usageDb.prepare(listSql).all(...params, limit, offset);
  res.json({ rows, total, limit, offset });
});

router.get('/amount/types', (req, res) => {
  const rows = req.usageDb.prepare('SELECT DISTINCT type FROM usage_amount ORDER BY type').all();
  res.json({ types: rows.map((r) => r.type) });
});

router.get('/amount/by-type', (req, res) => {
  const { where, params } = buildAmountFilters(req);
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const sql = `
    SELECT type,
      SUM(CASE WHEN amount IS NOT NULL AND TRIM(amount) != ''
        THEN CAST(amount AS REAL) ELSE 0 END) AS total_amount
    FROM usage_amount ${clause}
    GROUP BY type
    ORDER BY type`;
  const rows = req.usageDb.prepare(sql).all(...params);
  res.json({ rows });
});

router.get('/amount/cache-tokens', (req, res) => {
  const groupBy = req.query.groupBy === 'day' ? 'day' : 'none';
  const { where, params } = buildAmountFilters(req);
  const typeClause =
    "type IN ('input_cache_hit_tokens', 'input_cache_miss_tokens')";
  const allWhere = where.length ? `${typeClause} AND (${where.join(' AND ')})` : typeClause;
  if (groupBy === 'day') {
    const sql = `
      SELECT utc_date, type,
        SUM(CASE WHEN amount IS NOT NULL AND TRIM(amount) != ''
          THEN CAST(amount AS REAL) ELSE 0 END) AS total_amount
      FROM usage_amount
      WHERE ${allWhere}
      GROUP BY utc_date, type
      ORDER BY utc_date DESC, type`;
    const rows = req.usageDb.prepare(sql).all(...params);
    return res.json({ groupBy: 'day', rows });
  }
  const sql = `
    SELECT type,
      SUM(CASE WHEN amount IS NOT NULL AND TRIM(amount) != ''
        THEN CAST(amount AS REAL) ELSE 0 END) AS total_amount
    FROM usage_amount
    WHERE ${allWhere}
    GROUP BY type`;
  const rows = req.usageDb.prepare(sql).all(...params);
  res.json({ groupBy: 'none', rows });
});

router.get('/amount', (req, res) => {
  const { limit, offset } = parseLimitOffset(req);
  const { where, params } = buildAmountFilters(req);
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const countSql = `SELECT COUNT(*) AS c FROM usage_amount ${clause}`;
  const total = req.usageDb.prepare(countSql).get(...params).c;
  const listSql = `
    SELECT user_id, utc_date, model, api_key_name, api_key, type, price, amount
    FROM usage_amount ${clause}
    ORDER BY utc_date DESC, type
    LIMIT ? OFFSET ?`;
  const rows = req.usageDb.prepare(listSql).all(...params, limit, offset);
  res.json({ rows, total, limit, offset });
});

module.exports = router;

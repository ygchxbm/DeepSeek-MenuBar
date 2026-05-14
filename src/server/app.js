'use strict';

const path = require('path');
const express = require('express');
const axios = require('axios');
const usageRoutes = require('./routes/usage');

const app = express();
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;

app.use(express.json());

const publicDir = path.join(__dirname, '..', '..', 'public');

app.get('/api-test', (req, res) => {
  res.sendFile(path.join(publicDir, 'api-test.html'));
});

app.use('/usage', usageRoutes);
app.get('/user/balance', async (req, res) => {
  try {
    if (!DEEPSEEK_API_KEY) {
      return res.status(500).json({
        error: '未配置 DeepSeek API Key，请设置 DEEPSEEK_API_KEY 环境变量',
      });
    }

    const response = await axios.get('https://api.deepseek.com/user/balance', {
      headers: {
        Authorization: `Bearer ${DEEPSEEK_API_KEY}`,
        Accept: 'application/json',
      },
    });

    const balanceInfo = response.data.balance_infos?.[0];
    const result = {
      total_balance: balanceInfo?.total_balance || '0.00',
      topped_up_balance: balanceInfo?.topped_up_balance || '0.00',
      currency: balanceInfo?.currency || 'CNY',
      is_available: response.data.is_available,
    };

    res.json(result.total_balance);
  } catch (error) {
    console.error('获取余额失败:', error.message);

    if (error.response) {
      return res.status(error.response.status).json({
        error: '调用 DeepSeek API 失败',
        details: error.response.data,
      });
    }

    res.status(500).json({
      error: '服务器内部错误',
      message: error.message,
    });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/', (req, res) => {
  const usage = {
    '/usage/meta': '用量库元信息 (GET)，生产环境不返回 dbPath',
    '/usage/dashboard': '用量汇总看板 (GET)',
    '/usage/cost': '费用明细列表，分页 limit/offset，筛选 from,to,model,user_id,currency',
    '/usage/cost/range': '费用表日期范围 min/max',
    '/usage/cost/models': '费用表中出现过的 model 列表',
    '/usage/cost/summary': '费用汇总 groupBy=day|month + 同上筛选',
    '/usage/cost/day/:utcDate': '单日费用行（YYYY-MM-DD）',
    '/usage/amount': '用量明细列表，分页 + 筛选 from,to,model,user_id,api_key_name,type',
    '/usage/amount/types': '用量 type 枚举',
    '/usage/amount/by-type': '按 type 汇总 amount',
    '/usage/amount/cache-tokens': '缓存命中/未命中 token 汇总，可选 groupBy=day',
  };
  const body = {
    service: 'DeepSeek Balance Service',
    endpoints: {
      '/api-test': 'API 测试页 (GET)，浏览器打开本地址',
      '/health': '健康检查 (GET)',
      '/user/balance': 'DeepSeek 账户余额 (GET)，需 DEEPSEEK_API_KEY',
      ...usage,
    },
  };
  if (process.env.USAGE_API_TOKEN) {
    body.usage_auth =
      '已启用 USAGE_API_TOKEN：访问 /usage/* 需 Authorization: Bearer <token> 或 ?token=';
  }
  res.json(body);
});

module.exports = app;

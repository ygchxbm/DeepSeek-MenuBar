'use strict';

require('dotenv').config();
const fs = require('fs');
const app = require('./app');
const { getDbPath } = require('../db/usageDb');

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  const dbPath = getDbPath();
  const dbOk = fs.existsSync(dbPath);
  console.log(`服务器运行在 http://localhost:${PORT}`);
  console.log('可用接口:');
  console.log(`  GET http://localhost:${PORT}/api-test - API 测试页`);
  console.log(`  GET http://localhost:${PORT}/health - 健康检查`);
  console.log(`  GET http://localhost:${PORT}/usage/* - 用量 SQLite 只读 API`);
  if (process.env.USAGE_API_TOKEN) {
    console.log('  用量接口已启用 USAGE_API_TOKEN 鉴权');
  } else {
    console.log('  用量接口未设置 USAGE_API_TOKEN（仅本机时建议设置）');
  }
  console.log(`  用量数据库: ${dbOk ? '已找到' : '不存在 — 请先 pnpm run crawler'} (${dbPath})`);
  console.log('\n使用方法:');
  console.log('  设置环境变量: set DEEPSEEK_API_KEY=your_api_key_here');
  console.log('  启动服务: pnpm start 或 node src/server/index.js');
});

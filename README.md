# DeepSeek-MenuBar

本地服务：代理 **DeepSeek 官方余额 API**、提供 **用量 SQLite 只读查询**，以及通过 **Puppeteer** 从开放平台导出 zip 并解压入库。

## 环境要求

- **Node.js** `>= 22.5.0`（使用内置 [`node:sqlite`](https://nodejs.org/api/sqlite.html)，启动时可能出现 ExperimentalWarning，属正常现象）
- **pnpm**（勿使用 npm / yarn 安装依赖）

## 快速开始

```bash
pnpm install
```

复制并编辑环境变量（仓库根目录 `.env`，已加入 `.gitignore`）：

| 变量               | 说明                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------- |
| `DEEPSEEK_API_KEY` | DeepSeek API Key，用于 `/user/balance` 转发官方接口                                   |
| `USAGE_API_TOKEN`  | 可选。若设置，则所有 `/usage/*` 需带 `Authorization: Bearer <值>` 或查询参数 `token=` |
| `USAGE_DB_PATH`    | 可选。SQLite 文件路径，默认 `data/usage.sqlite`                                       |
| `PORT`             | 可选。HTTP 端口，默认 `3000`                                                          |

启动 HTTP 服务：

```bash
pnpm start
# 或
node src/server/index.js
```

浏览器打开 **API 测试页**：<http://localhost:3000/api-test>（同源，避免 `file://` 打开 HTML 的跨域问题）。

## 脚本说明

| 命令                              | 作用                                                                                                                 |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `pnpm start`                      | 使用 node 启动 `src/server/index.js`                                                                                 |
| `pnpm run crawler`                | 运行 `src/jobs/crawl-usage-export.js`：无头/有头导出平台用量 zip → 解压到 `usage-exports/` → 导入 `data/usage.sqlite` → 默认删除 zip |
| `pnpm run crawler:install-chrome` | 下载 Puppeteer 自带 Chromium（首次跑爬虫前若报错可执行）                                                             |

### 爬虫相关环境变量

| 变量                                      | 说明                                                      |
| ----------------------------------------- | --------------------------------------------------------- |
| `CRAWLER_HEADED` / `CRAWLER_FORCE_HEADED` | 设为 `1` 时强制有界面浏览器（扫码登录）                   |
| `CRAWLER_HEADLESS_PROBE_MS`               | 无头模式等待「导出」按钮的最长时间（毫秒），默认约 90s    |
| `CRAWLER_KEEP_ZIP`                        | 设为 `1` 时导入成功后**保留** zip；默认会删除已导入的 zip |
| `PUPPETEER_EXECUTABLE_PATH`               | 可选，指定本机 Chrome 可执行文件路径                      |

导出目录：**项目根目录 `usage-exports/`**（与 zip 主名同名的子目录存放 CSV，便于人工核对）。浏览器用户数据目录：`.puppeteer-profile/`（持久登录）。

## HTTP 接口一览

根路径 `GET /` 返回 JSON 形式的接口索引（**不查库**，仅说明）。

| 路径                | 说明                                                                                                           |
| ------------------- | -------------------------------------------------------------------------------------------------------------- |
| `GET /health`       | 健康检查                                                                                                       |
| `GET /user/balance` | 服务端带 `DEEPSEEK_API_KEY` 请求官方余额，当前实现返回简化后的余额字段（见 `src/server/app.js`）               |
| `GET /api-test`     | 返回 `public/api-test.html`，内置各接口测试面板                                                                |
| `GET /usage/*`      | 只读查询 `data/usage.sqlite`，见 `src/server/routes/usage.js`（`meta`、`dashboard`、`cost` 系列、`amount` 系列等） |

用量接口支持查询参数：`from`、`to`（`YYYY-MM-DD`）、`limit`（默认 50，最大 500）、`offset` 等，详见代码或测试页。

## 数据与文件

- **SQLite**：默认 `data/usage.sqlite`，表 `usage_cost`、`usage_amount` 列与平台导出 CSV 一致。
- **WAL 模式**：可能出现 `usage.sqlite-wal`、`usage.sqlite-shm`，与主库配套，勿单独乱删。
- **`.gitignore`**：已忽略 `node_modules/`、`.env`、`.puppeteer-profile/`、`data/`、`usage-exports/` 等。

## 项目结构（节选）

```
public/
  api-test.html           # /api-test 测试页
src/
  server/
    index.js              # 加载 dotenv、监听端口
    app.js                # Express 应用与路由挂载
    routes/
      usage.js            # /usage/* 路由与 SQL
  db/
    usageDb.js            # SQLite 路径与表结构迁移
    usageImport.js        # zip/csv 导入
  jobs/
    crawl-usage-export.js # 平台导出 + 解压 + 入库
```

## 参考链接

- DeepSeek 余额 API：<https://api-docs.deepseek.com/zh-cn/api/get-user-balance>

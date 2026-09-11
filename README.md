# WaveMonitor

WaveMonitor 是面向 Cloudflare 的行情轮询与告警服务。前端、HTTP API、定时任务和数据存储全部部署在 Cloudflare：

- React + TypeScript + Vite 构建管理界面
- Cloudflare Workers + Hono 提供 API
- Workers Static Assets 同源托管 SPA
- Cloudflare D1 保存配置、标的、行情与告警
- Cron Triggers 每 2 分钟执行一次行情轮询
- Telegram 可选推送告警

本仓库仅支持 Cloudflare serverless 部署，不包含 Python 后端、Docker、独立 Nginx 或本地 SQLite 部署方式。HTTP API 契约见 [`API_CONTRACT.md`](API_CONTRACT.md)。

## 功能

- 配置股票、币本位/USDT 合约和 Hyperliquid 永续合约数据源
- 为一个标的维护多档支撑位、阻力位或固定回撤规则
- 展示最新价格、轮询状态、最近告警与数据源错误
- 在首次访问时通过图形界面初始化访问密码
- 在系统设置中启用、替换或停用 Telegram 凭据

## 环境要求

| 依赖 | 要求 |
| --- | --- |
| Cloudflare 账号 | 需可使用 Workers、D1、Static Assets 和 Cron Triggers |
| Node.js | 20+ |
| npm | 随 Node.js 安装 |
| 网络 | Worker 需能访问 TradingView、Hyperliquid、Yahoo Finance 和可选的 Telegram API |

生产部署不需要服务器、容器、Python 或持久磁盘。

## 通过 GitHub 部署

<div align="center">
  <a href="https://dash.cloudflare.com/?url=https://github.com/svlic/wmcf">
    <img src="https://img.shields.io/badge/Deploy_to_Cloudflare-FF6633?style=for-the-badge&logo=cloudflare&logoColor=white" alt="Deploy to Cloudflare">
  </a>
</div>

1. Fork 本仓库到自己的 GitHub 账号。
2. 在 Cloudflare **Workers & Pages → Create application → Import a repository** 中选择该 Fork。
3. Production branch 选择 `master`，Root directory 留空。
4. Build command 填写 `npm run build`。
5. Deploy command 填写 `npm run deploy`。
6. 保存并部署。部署脚本会发布 Worker，并将 `worker/migrations/` 应用到名为 `wavemonitor` 的 D1 数据库。
7. 打开部署生成的 `workers.dev` 地址，在“初始化配置”页设置至少 8 个字符的访问密码；Telegram 凭据可同时填写，也可稍后配置。

后续推送到 `master` 会触发重新构建和部署。自定义域名在 Worker 的 **Settings → Domains & Routes** 中绑定。

## 通过 Wrangler 部署

在项目根目录执行：

```bash
npm --prefix frontend ci
npm --prefix worker ci
npm run build

cd worker
npx wrangler login
npm run deploy
```

`npm run deploy` 会先发布 Worker，再对远程 D1 应用所有 migrations。`/`、`/api/*` 与 `/health` 使用同一个 Worker 域名，不需要配置 API 基址或反向代理。

## 首次初始化与配置

首次打开部署地址时：

1. 设置至少 8 个字符的访问密码。
2. 可选填写 Telegram Bot Token 与 Chat ID；两项必须同时填写。
3. 初始化成功后，浏览器获得 7 天有效的 `HttpOnly` 会话 Cookie。

登录后可在“系统设置”中修改密码或 Telegram 配置：

- 密码以 PBKDF2-SHA256 派生值保存在 D1，D1 不保存明文密码。
- 修改密码会轮换 Cookie 签名密钥，其他浏览器中的旧会话随即失效。
- Telegram Token 不通过 API 或界面回显。
- Telegram 已启用时，两项凭据均留空表示沿用现有值。

早期版本通过 Wrangler secrets 配置的以下变量仍可作为 Cloudflare 部署的兼容回退：

- `WAVEMONITOR_WEB_PASSWORD`
- `WAVEMONITOR_SESSION_SECRET`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`

新部署应使用图形化初始化，不需要创建 `.env`。旧部署登录后可在“系统设置”保存配置；保存后 D1 配置优先。

## 使用

1. 在“标的管理”中新建标的，设置支撑/阻力或固定回撤规则。
2. 添加至少一个行情来源：
   - Yahoo Finance 股票：`yfinance + equity`
   - Binance USDT 合约：`binance + usd_m_futures`
   - Binance 币本位合约：`binance + coin_m_futures`
   - Hyperliquid 永续合约：`hyperliquid + perpetual`
3. Symbol 输入框会查询候选项，也支持手动输入。Binance 数据通过 TradingView Scanner 获取；USD-M 的 `BTCUSDT` 对应 `BINANCE:BTCUSDT.P`，COIN-M 的 `BTCUSD_PERP` 对应 `BINANCE:BTCUSD.P`。
4. 创建或更新标的后，Worker 会请求一次即时轮询；Cron Trigger 此后每 2 分钟轮询。
5. 在“仪表盘”查看最新行情，在“告警与诊断”查看告警、来源错误和 Telegram 测试结果。

首次 Cron 成功完成前，仪表盘可能显示“等待首次触发”。

## 本地开发

本地运行使用 Wrangler 的 Workers、D1 和 Static Assets 模拟环境，不提供第二套后端：

```bash
npm --prefix frontend ci
npm --prefix worker ci
npm run build
npm --prefix worker run d1:migrate:local
npm --prefix worker run dev
```

浏览器打开 Wrangler 输出的地址，通常为 <http://localhost:8787>。修改前端后重新执行 `npm run build`，再由 Worker 提供新的 `frontend/dist` 资源。

运行检查：

```bash
npm test
npm run check
npm run build
```

也可分别执行：

```bash
npm --prefix worker test
npm --prefix worker run check
npm --prefix frontend test
npm --prefix frontend run build
```

## Cloudflare 资源与运行边界

- `worker/wrangler.jsonc` 声明 D1 绑定 `DB`、Static Assets 绑定 `ASSETS` 和 `*/2 * * * *` Cron Trigger。
- 当前 Cron 频率为每天 720 次；请求数、CPU 时间和 D1 读写均受 Cloudflare 账户额度限制。
- 每个启用的数据源每轮至少写入一条行情观测；系统仅保留最近 3 天的观测。
- Cloudflare Cron 可能延迟触发；本项目不是实时交易系统，也不保证精确的两分钟间隔。
- Wrangler 本地状态位于 `worker/.wrangler/`，不得提交到版本库。

## 目录结构

```text
wmcf/
├── API_CONTRACT.md          # Worker HTTP API 契约
├── frontend/                # React SPA、Zod API 边界与 Vitest 测试
├── worker/                  # Cloudflare Worker、D1 migrations 与测试
│   ├── migrations/
│   ├── scripts/
│   ├── src/
│   ├── tests/
│   └── wrangler.jsonc
├── package.json             # 根目录构建、检查、测试与部署命令
└── README.md
```

## 常见问题

**页面能打开，但 API 返回 500**
确认 D1 migration 已执行。远程部署运行 `npm --prefix worker run d1:migrate:remote`，本地运行 `npm --prefix worker run d1:migrate:local`。

**`telegram_ready` 一直为 `false`**
登录后进入“系统设置”，同时填写 Bot Token 和 Chat ID 并启用 Telegram，然后在“告警与诊断”发送测试消息。

**有标的但仪表盘没有价格**
确认标的及来源均已启用、provider/market type 配对正确且 Symbol 有效；随后在“告警与诊断”查看最近来源错误。

**如何查看运行日志**
在 Cloudflare 控制台查看 Worker Observability，或在 `worker/` 中运行 `npx wrangler tail`。

## 许可证

按仓库所有者约定使用；贡献前请阅读 `AGENTS.md`。

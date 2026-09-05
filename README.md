# WaveMonitor

股票与衍生品价格监控服务：按配置的标的与数据源轮询行情，在触及支撑/阻力等规则时记录告警，并可通过 Telegram 推送。

## 功能概览

- **标的管理**：配置名称、支撑/阻力、阈值及多数据源映射（交易所、品种、是否启用）
- **仪表盘**：系统运行状态与全宽价格监控表格
- **告警与诊断**：最近告警、Telegram 测试告警与各数据源最近错误
- **Telegram**：配置 `TELEGRAM_BOT_TOKEN` 与 `TELEGRAM_CHAT_ID` 后可发送测试消息与告警
- **访问验证**：可通过 `WAVEMONITOR_WEB_PASSWORD` 启用首次访问密码验证（无需账号）

## 技术栈

| 层级 | 说明 |
| --- | --- |
| 后端（传统部署） | Python 3.11+、FastAPI、SQLModel、SQLite |
| 后端（Cloudflare） | TypeScript、Cloudflare Workers、D1、Cron Triggers |
| 前端 | React、TypeScript、Vite、Wouter |
| 部署 | Docker Compose，或单个 Cloudflare Worker 同源托管 SPA 与 API |

API 约定见 [`backend/API_CONTRACT.md`](backend/API_CONTRACT.md)。

---

## 环境要求

### 使用 Docker 部署（推荐）

| 依赖 | 版本建议 |
| --- | --- |
| Docker | 24+ |
| Docker Compose | v2（`docker compose` 子命令） |
| 磁盘 | 约 500MB 镜像与构建缓存；数据库在命名卷中增长 |
| 网络 | 容器需访问外网以拉取 Binance / Hyperliquid / Yahoo Finance 等行情 |

### 本地开发

| 依赖 | 版本建议 |
| --- | --- |
| Python | 3.11+ |
| Node.js | 20+（与 `frontend/Dockerfile` 中 Node 24 构建环境兼容即可） |
| npm | 随 Node 安装 |

---

## 安装与部署（Docker Compose）

以下步骤假设已将仓库克隆到本机，并在**项目根目录**（含 `docker-compose.yml` 的目录）执行命令。

### 1. 获取代码

```bash
git clone <你的仓库地址> wavemonitor
cd wavemonitor
```

若你已有源码目录，直接进入该目录即可。

### 2. 配置环境变量

在项目根目录复制示例文件并编辑：

```bash
cp .env.example .env
```

**完整配置示例**（按需修改；勿将含真实 Token 的 `.env` 提交到 Git）：

```bash
# ---------- Telegram（可选；不填则仅 Web 告警，不推送）----------
# 在 @BotFather 创建 Bot 后获得的 Token
TELEGRAM_BOT_TOKEN=123456789:AAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
# 接收告警的 Chat ID（可为个人、群组或频道；频道常用 -100 开头）
TELEGRAM_CHAT_ID=-1001234567890

# ---------- 可选：Web 访问验证（不填则关闭密码验证）----------
# 首次访问前端和受保护 /api 时使用的共享密码，无需账号
WAVEMONITOR_WEB_PASSWORD=change-me
# 可选：Cookie 签名密钥；不填则在首次启动时自动生成并保存在 SQLite 同目录（Docker 为 /data/session_secret）
# WAVEMONITOR_SESSION_SECRET=
# 可选：仅供 Binance USD-M / COIN-M API 请求使用的 HTTPS 代理
# BINANCE_HTTPS_PROXY=http://proxy-host:port

# ---------- 本地开发常用（Docker Compose 默认不读取下列变量，见下文说明）----------
# 本地 SQLite（相对路径，文件落在项目根目录）
DATABASE_URL=sqlite:///./wavemonitor.sqlite3
# 本地前端请求后端的根地址；生产 Docker 前端走同源 /api，无需设置
VITE_API_BASE_URL=http://localhost:8000
```

**Docker Compose 实际注入后端的变量**（定义在 `docker-compose.yml`）：

| 变量 | Compose 中的值 | 说明 |
| --- | --- | --- |
| `DATABASE_URL` | `sqlite:////data/wavemonitor.sqlite3` | 固定写在 compose 中，覆盖 `.env` 里同名项对**容器**无效 |
| `TELEGRAM_BOT_TOKEN` | 从宿主机 `.env` 或环境传入 | 空则 Telegram 未就绪 |
| `TELEGRAM_CHAT_ID` | 从宿主机 `.env` 或环境传入 | 须与 Token 同时配置 |
| `WAVEMONITOR_WEB_PASSWORD` | 从宿主机 `.env` 或环境传入 | 空则关闭访问验证；设置后首次访问需输入共享密码 |
| `WAVEMONITOR_SESSION_SECRET` | 可选；未设置时自动生成并写入数据卷 `/data/session_secret` | 覆盖自动生成的 Cookie 签名密钥（多实例部署时需显式配置同一密钥） |
| `BINANCE_HTTPS_PROXY` | 从宿主机 `.env` 或环境传入 | 可选；仅代理 Binance USD-M / COIN-M API 请求，适用于部署网络收到 HTTP 451 的情况 |

Compose **不会**自动把 `WAVEMONITOR_POLL_INTERVAL_SECONDS`、`WAVEMONITOR_MONITORING_DISABLED` 传入容器。若要在 Docker 中调整轮询间隔或关闭调度，在 `docker-compose.yml` 的 `backend.environment` 中增加，例如：

```yaml
    environment:
      DATABASE_URL: sqlite:////data/wavemonitor.sqlite3
      TELEGRAM_BOT_TOKEN: ${TELEGRAM_BOT_TOKEN:-}
      TELEGRAM_CHAT_ID: ${TELEGRAM_CHAT_ID:-}
      WAVEMONITOR_POLL_INTERVAL_SECONDS: "120"
      # WAVEMONITOR_MONITORING_DISABLED: "1"   # 设为 1/true/yes 可关闭后台轮询
```

### 3. 构建并启动

```bash
docker compose up --build -d
```

首次会构建 `backend`、`frontend` 镜像。`frontend` 会等待 `backend` 健康检查通过后再启动。

### 4. 访问与验证

| 入口 | 地址 | 说明 |
| --- | --- | --- |
| **Web 管理界面** | <http://localhost:54002> | 日常使用入口；`/api` 由 Nginx 转发到后端 |
| 后端 API（直连） | <http://localhost:8000> | 调试、脚本调用 |
| 健康检查 | <http://localhost:54002/health> 或 <http://localhost:8000/health> | 应返回 JSON，含 `status`、`telegram_ready` |

命令行快速检查：

```bash
curl -s http://localhost:54002/health | python3 -m json.tool
curl -s http://localhost:8000/api/runtime | python3 -m json.tool
```

在 Web 界面中：

1. 若设置了 `WAVEMONITOR_WEB_PASSWORD`，先在中文访问验证页输入共享密码；会话通过 7 天有效的 `HttpOnly` Cookie 保持。
2. 打开 **标的管理**，新建标的并配置支撑/阻力、阈值及数据源（YFinance / Binance / Hyperliquid 等）；Symbol 输入框会通过实时查询接口给出候选项，也支持手动输入。
3. 在 **仪表盘** 查看 `scheduler_ready`、`polled_sources` 与全宽价格监控表格。
4. 在 **告警与诊断** 查看最近告警；若已配置 Telegram，发送测试告警（或 `POST /api/telegram/test`）并查看数据源错误。

### 5. 日常运维

```bash
# 查看日志
docker compose logs -f
docker compose logs -f backend
docker compose logs -f frontend

# 停止服务（保留数据卷）
docker compose down

# 停止并删除数据库卷（清空 SQLite，慎用）
docker compose down -v

# 重新构建并滚动更新
docker compose up --build -d
```

**数据持久化**：SQLite 保存在 Docker 命名卷 `wavemonitor-sqlite`，挂载到后端容器 `/data/wavemonitor.sqlite3`。删除卷会丢失全部标的与历史观测数据。

**端口说明**：

- `54002:8080` — 前端 Nginx（对外 Web）
- `8000:8000` — 后端 FastAPI（可选直连；前端容器通过服务名 `backend:8000` 访问 API）

修改对外端口时，请同步改 `docker-compose.yml` 与本 README。

---

## Cloudflare 免费无服务器部署

`worker/` 提供 Cloudflare Workers 实现：Workers Static Assets 托管前端，D1 保存业务和配置数据，Cron Trigger 每 2 分钟轮询行情。此路径不需要 Python、容器、常驻进程、持久磁盘，也不迁移原 SQLite 历史数据。

### 方式一：通过 GitHub 绑定一键部署（推荐）

<div align="center">
  <a href="https://dash.cloudflare.com/?url=https://github.com/svlic/wavemonitor/tree/serverless">
    <img src="https://img.shields.io/badge/Deploy_to_Cloudflare-FF6633?style=for-the-badge&logo=cloudflare&logoColor=white" alt="Deploy to Cloudflare">
  </a>
  <p>跳转至 Cloudflare 控制台，授权 GitHub 后可完成部署，无需本地开发环境。</p>
</div>

1. Fork 本仓库到自己的 GitHub 账号。
2. 点击上方按钮，或在 Cloudflare **Workers & Pages → Create application → Import a repository** 中选择 Fork。
3. Production branch 选择 `serverless`；Root directory 留空（使用仓库根目录）。
4. Build command 填写 `npm run build:frontend`，Deploy command 填写 `npm run deploy`。根目录的 npm 脚本会分别安装并调用 `frontend/` 与 `worker/` 中的实际构建、部署命令。
5. 保存并部署。Wrangler 会自动创建并绑定名为 `wavemonitor` 的 D1；部署命令随后应用 D1 migrations。
6. 打开部署生成的 `workers.dev` 地址，在“初始化配置”页设置访问密码，并可同时填写 Telegram Bot Token 与 Chat ID。

后续推送到所选分支会自动重新构建和部署。自定义域名可在 Worker 的 **Settings → Domains & Routes** 中绑定。

### 方式二：本地命令行部署

```bash
cd worker
npm ci
npm run build:frontend
npx wrangler login
npm run deploy
```

`npm run build:frontend` 安装并构建前端；`npm run deploy` 自动供应 D1、发布 Worker 并应用 migrations。部署后访问 Wrangler 输出的地址完成图形化初始化。`/`、`/api/*` 与 `/health` 同源，无需设置 `VITE_API_BASE_URL`。

### 图形化配置

- 首次访问必须设置至少 8 个字符的访问密码；该密码经 PBKDF2-SHA256 派生后保存，D1 不保存明文。
- Telegram 可在首次初始化时填写，也可登录后进入“系统设置”启用、替换或停用。
- Telegram Token 不会通过 API 或界面回显；更新时两项都留空表示沿用现有凭据。
- 若旧部署已经通过 Wrangler secrets 设置 `WAVEMONITOR_WEB_PASSWORD`、`WAVEMONITOR_SESSION_SECRET` 和 `TELEGRAM_*`，仍可登录并在“系统设置”切换到 GUI 管理；切换后 D1 配置优先。
- 修改访问密码会轮换 Cookie 签名密钥，使其他浏览器中的旧会话失效。

首次 Cron 成功执行前，仪表盘显示“等待首次触发”。

### 免费额度边界

- 当前配置每 2 分钟执行一次 Cron，即每天 720 次；Worker 请求与 D1 读写仍受 Cloudflare 账户免费额度约束。
- 每个启用来源每轮至少写一条价格观测；系统仅保留 3 天观测。来源数量较多或公开 API 流量较高时，免费额度不是无限容量保证。
- Workers 不支持 `BINANCE_HTTPS_PROXY`。若 Cloudflare 出口访问 Binance 被地域限制，应停用该来源或改用可直接访问的数据源，不能依赖原 Docker 代理配置。
- Cloudflare Cron 由平台调度，可能有触发延迟；本实现不是实时行情系统，也不保证恰好每 2 分钟执行。

---

## Telegram 配置说明

1. 在 Telegram 中联系 [@BotFather](https://t.me/BotFather)，执行 `/newbot`，按提示创建 Bot，保存 **Bot Token**（形如 `数字:字母数字`）。
2. 获取 **Chat ID**：
   - **个人**：先给 Bot 发一条消息，再访问 `https://api.telegram.org/bot<TOKEN>/getUpdates`，在 JSON 中查看 `message.chat.id`。
   - **群组**：将 Bot 拉入群并发言一次，同样在 `getUpdates` 中查看群的 `id`（常为负数）。
   - **频道**：将 Bot 设为管理员，频道 ID 多为 `-100` 开头。
3. 将 Token 与 Chat ID 写入项目根目录 `.env` 的 `TELEGRAM_BOT_TOKEN`、`TELEGRAM_CHAT_ID`。
4. 重启后端使环境变量生效：

   ```bash
   docker compose up -d --force-recreate backend
   ```

5. 确认 `GET /health` 或仪表盘/告警与诊断页中 `telegram_ready` 为 `true`，再发送测试消息。

密钥仅由**后端**进程读取；前端与 Nginx 不接收 Telegram 环境变量。日志与 API 会对敏感信息脱敏。

---

## 环境变量参考

| 变量 | 默认值 / 行为 | 说明 |
| --- | --- | --- |
| `DATABASE_URL` | 本地：`sqlite:///./wavemonitor.sqlite3` | SQLAlchemy 连接串；Docker 后端使用卷内绝对路径 |
| `TELEGRAM_BOT_TOKEN` | 无 | Telegram Bot Token（可选） |
| `TELEGRAM_CHAT_ID` | 无 | 告警接收方 Chat ID（可选） |
| `WAVEMONITOR_WEB_PASSWORD` | 无，访问验证关闭 | 设置后，前端首次访问显示密码验证页，且 `/api/*` 需要会话 Cookie（`/api/auth/*` 与 `/health` 除外） |
| `WAVEMONITOR_SESSION_SECRET` | 无（启用密码时自动生成并持久化） | 可选覆盖；未设置时在数据库文件旁写入 `session_secret` |
| `BINANCE_HTTPS_PROXY` | 无 | 可选；仅供 Binance USD-M / COIN-M API 请求使用的 HTTP(S) 代理 URL |
| `WAVEMONITOR_POLL_INTERVAL_SECONDS` | `120` | 行情轮询周期（秒），须 > 0；默认 2 分钟 |
| `WAVEMONITOR_MONITORING_DISABLED` | 未设置 | 设为 `1` / `true` / `yes` 时关闭后台调度（仅 API，不轮询） |
| `VITE_API_BASE_URL` | 空字符串 | **仅本地前端构建/开发**：API 根地址；Docker 生产构建留空，使用同源 `/api` |

---

## 本地开发

适合改代码、跑测试，**不依赖 Docker**。

### 后端

在**项目根目录**：

```bash
python3 -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -e ".[test]"

# 可选：加载 .env（若未 export，可手动 export 或使用 direnv）
export DATABASE_URL=sqlite:///./wavemonitor.sqlite3
export TELEGRAM_BOT_TOKEN=...
export TELEGRAM_CHAT_ID=...

uvicorn wavemonitor_backend.app:get_application --factory --reload --app-dir backend/src --host 0.0.0.0 --port 8000
```

运行测试：

```bash
pytest
```

### 前端

```bash
cd frontend
npm ci
npm test
npm run build
```

开发服务器（需能访问后端 API）：

```bash
# 方式 A：通过环境变量指向后端（与 .env.example 一致）
export VITE_API_BASE_URL=http://localhost:8000
npx vite --host 0.0.0.0 --port 5173

# 方式 B：不设置 VITE_API_BASE_URL 时，请求为相对路径 /api/...
# 需在 vite.config.ts 中自行添加 server.proxy，将 /api 与 /health 代理到 http://localhost:8000
```

本地联调时，先启动后端（8000），再启动前端（5173），浏览器打开 Vite 提示的地址。

### 与 Docker 的差异

| 项目 | 本地开发 | Docker |
| --- | --- | --- |
| 数据库文件 | 项目根目录 `wavemonitor.sqlite3` | 卷 `wavemonitor-sqlite` |
| 前端访问 API | `VITE_API_BASE_URL` 或 Vite proxy | Nginx 同源 `/api` |
| 对外端口 | 5173 + 8000 | **54002**（Web）+ 8000（API） |

---

## 目录结构

```text
wavemonitor/
├── backend/                 # FastAPI 应用、Dockerfile、测试
│   ├── src/wavemonitor_backend/
│   ├── tests/
│   └── API_CONTRACT.md
├── frontend/                # React SPA、Nginx 配置、Dockerfile
├── docker-compose.yml
├── .env.example             # 环境变量模板（复制为 .env）
├── pyproject.toml
├── AGENTS.md                # AI 协作者说明
└── README.md
```

---

## 常见问题

**Q：界面打不开或 API 404**  
检查 `docker compose ps` 是否两个服务均为 `running`，`backend` 为 `healthy`。查看 `docker compose logs frontend` 中 Nginx 是否正常。

**Q：`telegram_ready` 一直为 false**  
确认 `.env` 中两项均已填写且无多余引号/空格，并执行 `docker compose up -d --force-recreate backend`。

**Q：有标的但仪表盘无价格**  
确认标的已启用、数据源映射已启用且 symbol 正确；在 **告警与诊断** 查看数据源错误表或 `GET /api/source-errors`。容器需能访问外网。

**Q：如何备份数据**  
从卷中拷贝 SQLite 文件，例如：

```bash
docker compose exec backend cat /data/wavemonitor.sqlite3 > wavemonitor-backup.sqlite3
```

---

## 许可证

按仓库所有者约定使用；贡献前请阅读 `AGENTS.md`（面向 AI 协作者的项目说明）。
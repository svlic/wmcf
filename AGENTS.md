# WaveMonitor 工作指南

WaveMonitor 是仅部署于 Cloudflare 的行情轮询与告警服务：Cloudflare Workers + Hono + D1 + Cron Triggers 后端，React + TypeScript + Vite 前端。

## 代码与契约

- `worker/src/`、`worker/tests/`：Worker 实现与 Cloudflare Vitest 测试
- `worker/migrations/`：D1 schema migrations
- `frontend/src/`、`frontend/tests/`：前端实现与 Vitest 测试
- `API_CONTRACT.md`：唯一 HTTP API 契约
- `frontend/src/api/schemas.ts`：前端 API 数据的 Zod 边界
- `frontend/DESIGN.md`：UI 规范
- `README.md`：Cloudflare 部署、运行与开发说明

以当前代码和契约为准；`.omo/plans/` 仅供追溯，不作为实现依据。

## 修改规则

- Worker 行为变更或缺陷修复应补回归测试；API 变更同时更新契约、前端 schema/client 及相关测试。
- D1 schema 变更必须新增 migration，不修改已发布 migration 的既有语义。
- 前端接收的 API 数据必须经 Zod 校验；保留无障碍语义，遵循 `frontend/DESIGN.md`，不新增 CSS 框架。
- 部署绑定、Cron 或 Static Assets 路由变更时，同步 `worker/wrangler.jsonc` 与 `README.md`。
- 不引入 Python 后端、Docker、独立反向代理或本地 SQLite 部署路径。
- 不在代码、日志、API 响应或提交内容中暴露密钥；不提交 `.env`、`.dev.vars`、构建产物或 `.wrangler` 本地状态。
- 面向用户的文档使用中文；代码注释和 API 契约使用英文。

## 验证

按改动范围运行：

```bash
(cd worker && npm test && npm run check)
(cd frontend && npm test && npm run build)
```

Worker 业务逻辑变更必须运行 Worker 测试与类型检查；前端改动必须运行测试与构建。

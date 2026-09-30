# 协作岛

聊天优先的多人协作空间。真实账号、房间、邀请、实时消息、轻任务和私有文件；桌面三栏与手机单页布局。依据《协作岛_整体开发文档_V0.1》实现完整人类协作阶段（V0.1–V0.3），未来 Agent 仅做边界预留。

## 本地启动

要求 Node.js ≥22、npm、Linux/macOS。仓库已有锁文件。开发 PostgreSQL 二进制由 npm 的 embedded-postgres 包提供，无需 Docker、数据库账号或 Supabase API Key；不能以 root 运行开发数据库，建议普通用户执行。

```bash
npm ci
npm run db:start
```

数据库在前台运行，默认监听回环地址的 55432 端口；首启自动应用迁移，重启保留 `.data/postgres`。

另开终端，在仓库根目录：

```bash
npm run dev
```

浏览器打开 http://localhost:3000。可直接注册账号，无需邮箱验证。创建房间、生成邀请，用第二个浏览器/隐身窗口注册另一账号加入，就能实际协作。没有内置假账号或房间。

可选本地配置：复制 `apps/web/.env.example` 为 `.env.local`。数据库开发默认值已内置。`DATABASE_URL` 如用于 `db:migrate` 或测试，还需在执行这些命令的 shell 中设置（Next.js 专属 `.env.local` 不自动加载到独立脚本）。

## 构建与验收

数据库与应用运行后：

```bash
npm run typecheck
npm test
npm run test:e2e
```

Playwright 自动使用 `/usr/bin/chromium`（若存在）；也可设置 `CHROMIUM_PATH` 指向浏览器，否则先执行 `npx playwright install chromium`。测试覆盖两个独立 BrowserContext、断网恢复、实时任务、文件拒绝访问、权限转移和移动流程。测试会创建专用账号和房间，成功时解散房间，截图在 `docs/screenshots`，报告在 `playwright-report`。

```bash
npm run build
npm start
```

`npm start` 是实际生产构建运行方式。启动前停止开发服务，避免端口冲突；不要同时向同一个 `.next` 目录执行 dev 与 build。

## 目录

- `apps/web`：Next.js 页面、响应式界面、服务端 API、认证、文件和事件推送。
- `packages/protocol`：统一 Participant/Message/Task/Event 类型、校验与未来 Adapter 契约。
- `packages/ui`：共享 Avatar、设计 Token 与结构预留组件。
- `supabase/migrations`：PostgreSQL 表、RLS、约束与事务业务函数；可被 Supabase 使用。
- `database/bootstrap.sql`：自托管 Auth/Storage 命名空间与本项目会话表。
- `scripts`：数据库启动与带校验的迁移。
- `tests`：协议/数据库测试和双用户 Playwright。
- `docs`：需求、架构决策、部署说明、验收结果和真实页面截图。

## 架构与安全

所有业务引用 participant_id，预留 human/agent 类型。房间始终仅一名主持人；转移、移除和任务变更在 PostgreSQL 事务中验证。客户端无数据库管理凭据，隐藏按钮之外还有服务端校验与数据库 RLS。

消息、任务和 Event 同事务持久化，数据库 NOTIFY 唤醒 SSE；事件游标可补齐遗漏。客户端幂等消息 ID、明确连接状态和重试按钮避免假实时与重复消息。文件保存到私有对象目录，数据库仅保存元数据；下载和图片预览都重新检查成员身份。

原推荐 Supabase 的 Docker 镜像仓库在当前云环境被拒绝，故验收使用真实自托管 PostgreSQL。当前认证是项目服务端会话，不是 Supabase Auth；实时为 PostgreSQL/SSE，不声称 Hosted Realtime 已连通。可选 Supabase Storage Adapter 与原生 Supabase 服务部署尚需目标项目验证。详见 [架构决策](docs/requirements.md) 和 [部署说明](docs/deployment.md)。

[验收报告](docs/acceptance.md) · [未来 Agent 边界](docs/agent-boundary.md)

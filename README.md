# 协作岛

聊天优先的多人协作空间。真实账号、房间、邀请、实时消息、轻任务和私有文件；桌面三栏与手机单页布局。依据开发文档实现人类协作、后台管理、安装引导，以及异地 Agent 联机和协同开发。Agent 运行在设备所有者自己的电脑或服务器上，通过 Node 主动连接聊天室。

## 本地启动

推荐使用完整安装引导：Windows 双击 `install.cmd`，Linux/macOS 运行 `./install.sh`，已有 Node.js 22+ 与 npm 也可执行 `npm run setup`。程序检测环境和已有 PostgreSQL，引导填写网站、私有存储、管理员昵称/邮箱/密码，再自动安装、迁移、构建、启动并验证前后台。已有网站进入保留数据升级。

安装后使用 `start.cmd` / `./start.sh`，或 `npm run island:start`；停止用 `npm run island:stop`。所有启动及初始化命令读取同一保存配置。详见 [安装与配置](docs/installation.md)、[安装验收及截图](docs/installation-acceptance.md)。本次实机验收为 Linux x64；Windows/macOS 原生入口已提供，尚未完成这两种系统的实机验收。

以下是手工开发启动方式：

要求 Node.js ≥22、npm、Linux/macOS（Windows 推荐使用 WSL）。仓库已有锁文件。开发 PostgreSQL 二进制由 npm 的 embedded-postgres 包提供，无需 Docker、数据库账号或 Supabase API Key；不能以 root 运行开发数据库，建议普通用户执行。

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

可选本地配置：复制 `apps/web/.env.example` 为 `apps/web/.env.local`。开发默认值已内置，网站及迁移/初始化脚本统一读取配置。安装器保存的配置优先于旧环境文件；显式环境覆盖规则见安装说明。测试使用 `DATABASE_URL` 指定专用测试数据库，不对生产数据库运行自动化测试。

## 网站管理后台

完整后台位于 `/admin`，与聊天系统使用同一用户、房间、成员、消息、任务、文件与事件。包括真实概览、用户限制、房间冻结/恢复、主持人转移、举报处置、文件隔离、邀请、网站 Logo/名称/SEO、统计工具、公告、灰度开关、系统诊断、Session/IP、管理员与审计。

安装向导完成后，使用设置的管理员账号直接登录 `/admin`。手工部署时，先在网站注册自己的账号，再运行 `npm run admin:init -- your@email.com` 初始化首位超级管理员；没有默认密码。已有管理员后通过后台授权。详见 [后台设计与适配](docs/admin-design.md)、[运行与部署](docs/admin-deployment.md)、[后台验收](docs/admin-acceptance.md)。

用户管理支持超级/运营管理员“一键生成用户”：生成随机登录账号（不可收邮件的占位邮箱）和强随机初始密码，普通用户无管理权限，不切换管理员会话。密码仅首次结果回显，数据库只保存哈希，审计不保存密码。重复请求不会重复创建；每位管理员 24 小时最多 100 个。请安全交付并妥善保存登录信息。

WorkBuddy 等 GUI Agent 使用当前宿主 MCP 直连，不再默认或回退到 Codex CLI。MCP 不承诺 GUI 自动后台唤醒；宿主需有界等待和自行处理任务。旧错误路由的席位须撤销并用新邀请重配，详见 [Agent 接入说明](docs/agents.md)。

## 异地 Agent 联机与开发

WorkBuddy、豆包工作等支持 HTTP MCP 的助手，也可在「联机席位」生成专属远程连接直接参与讨论，无需安装 Node 客户端。每个 Agent 独立身份，不会转给 Codex；本机开发继续使用专用本地 MCP / 该产品自己的程序。成员可查看房间内其他 Agent 的所属用户、连接和模型等待状态。具体兼容性及唤醒限制见 [通用接入说明](docs/universal-mcp.md)。

ZCode 官方开源版具备原生 HTTP/stdio MCP 接入条件，推荐远程讨论、本地宿主开发；专用预设和自动接单适配器尚未实现，真实 ZCode 宿主尚未验收。源码依据、协议检查和实施边界见 [ZCode 接入评估与设计](docs/zcode-integration-design.md)。

进入房间的「联机席位」，下载 Node 客户端并在 Agent 所在设备运行 `connect.cmd`（Windows）或 `bash connect.sh`（Linux/macOS）。填写网站地址、一次性配对码、本机 Agent 类型及自己授权的工作目录。该设备安装并登录的 Agent 由 Node 调用，网站无需配置模型 API。

人类房间管理者审批席位、选定 Agent 主持人，发布需求、设计文档和 ZIP 源码基线。主持人围绕主题有限点名讨论并提出分工；全员确认同一版本后，人类批准开发，各设备分别在本地 Git 工作目录完成任务。实际源码变更和本机检查结果回传到房间，经过审阅及冲突选择后生成合并源码 ZIP。支持暂停、停止、静音、断线重连、撤销设备和后台紧急撤销。

详见 [连接与协同开发](docs/agents.md)、[协议及权限设计](docs/agent-boundary.md)、[验收结果](docs/agent-acceptance.md)。公网部署需 HTTPS 并在网站同一端口转发 `/agent-wire` 的 WebSocket Upgrade。

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
- `packages/runtime`：安装配置、Web 和独立脚本共用的服务器运行配置与密码校验。
- `packages/protocol`：统一 Participant/Message/Task/Event 类型、校验与未来 Adapter 契约。
- `packages/ui`：共享 Avatar、设计 Token 与结构预留组件。
- `supabase/migrations`：PostgreSQL 表、RLS、约束与事务业务函数；可被 Supabase 使用。
- `database/bootstrap.sql`：自托管 Auth/Storage 命名空间与本项目会话表。
- `scripts`：安装引导、跨平台启动、数据库启动与带校验的迁移。
- `tests`：协议/数据库测试和双用户 Playwright。
- `docs`：需求、架构决策、部署说明、验收结果和真实页面截图。

## 架构与安全

所有业务引用 participant_id，预留 human/agent 类型。房间始终仅一名主持人；转移、移除和任务变更在 PostgreSQL 事务中验证。客户端无数据库管理凭据，隐藏按钮之外还有服务端校验与数据库 RLS。

消息、任务和 Event 同事务持久化，数据库 NOTIFY 唤醒 SSE；事件游标可补齐遗漏。客户端幂等消息 ID、明确连接状态和重试按钮避免假实时与重复消息。文件保存到私有对象目录，数据库仅保存元数据；下载和图片预览都重新检查成员身份。

原推荐 Supabase 的 Docker 镜像仓库在当前云环境被拒绝，故验收使用真实自托管 PostgreSQL。当前认证是项目服务端会话，不是 Supabase Auth；实时为 PostgreSQL/SSE，不声称 Hosted Realtime 已连通。可选 Supabase Storage Adapter 与原生 Supabase 服务部署尚需目标项目验证。详见 [架构决策](docs/requirements.md) 和 [部署说明](docs/deployment.md)。

[验收报告](docs/acceptance.md) · [Agent 架构与协议](docs/agent-boundary.md) · [远程联机使用说明](docs/agents.md) · [Agent 验收](docs/agent-acceptance.md)

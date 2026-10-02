# 远程 Agent 与联机席位验收

日期：2026-10-01。基于已交付聊天、后台和安装系统追加实现。需求来自用户明确要求：不同设备的 Agent 主动联机，人类选定主持人，有界讨论、对齐文档、各自本地开发，真实成果合并到房间文件。

## 原联机功能交付基线验证结果

- 单元/真实 PostgreSQL/联机/适配器：**81 项通过、0 失败、0 跳过**，包括原聊天、后台、安装回归。
- Playwright 生产服务：**12 项通过、0 失败、0 跳过**，包括联机席位完整操作、桌面/手机、原多人协作、后台，以及全新安装、保留数据升级和启动恢复。
- TypeScript 检查与 Next.js 生产构建通过。
- 生产依赖审计：0 漏洞。
- 可下载独立 Node 包实际解压并 `npm ci`，不依赖服务器源码或 workspace npm 链接；一个实际客户端进程从此下载包运行。

原交付基线的机器可读结果：[agent-test-results.json](agent-test-results.json)。原阶段验收报告和结果保留为历史记录，当前 Agent 范围以本报告为准。

## 一句话连接补充验收

「联机席位」新增复制一键连接提示词，自动携带网站地址、一次性配对码、独立配置路径和本机开发授权选择。配对码下载接口无需浏览器会话，下载不消耗配对码，过期/撤销/已配对及房间冻结均拒绝下载。

- `npx vitest run tests/agents.test.ts tests/node-integration.test.ts tests/adapters.test.ts`：29 项通过、0 失败。实际 HTTPS 下载 ZIP、锁文件安装、Linux 启动脚本参数传递、无交互配对与连接、默认仅讨论、重启复用凭据及原联机协作流程均通过。
- `E2E_BASE_URL=http://localhost:3100 npx playwright test tests/e2e/agents.spec.ts`：1 项完整浏览器流程通过，包含提示词复制、授权选项、失效配对码拒绝下载及桌面/手机协作操作。
- TypeScript 检查、生产构建和格式检查通过。本次追加功能验证针对受影响流程，未将原交付基线的全量结果冒充本次全量重跑。

真实模型账号和 Windows/macOS 实机边界仍见下文；一句话安装依赖目标设备具备可用且已登录的 Agent，以及可访问的网站地址。

## 客户端 UTF-8 兼容修复验收

Windows 下载包的 PowerShell 脚本与 README 使用带 BOM 的 UTF-8，CMD 切换代码页 65001，PowerShell 控制台输入、输出与原生程序管道统一 UTF-8。生成 Windows 脚本时先移除源文件 BOM，再替换入口，避免影响非交互参数传递；Linux/macOS 的 shebang 保持无 BOM。

`npx vitest run tests/node-integration.test.ts`：8 项通过。实际 HTTPS 下载的 ZIP 验证 UTF-8 严格解码、编码标识、中文原文及启动参数；独立安装、非交互连接、重连、协作开发与回传合并继续通过。生产构建及类型检查通过。当前环境为 Linux，未将编码文件验证称为 Windows 实机验收。

## 席位审批、实例隔离与重复启动修复验收

已批准的空闲席位显示「已批准，等待点名或任务」，本机终端与 status 同步审批/静音状态。不同配对码自动使用独立配置、工作目录与任务状态；显式复用其他 Agent 配置会拒绝覆盖。跨进程锁阻止同一配置重复配对和启动，Gateway 拒绝重复凭据连接并保留原 session。

- `npx vitest run tests/agents.test.ts tests/node-integration.test.ts tests/adapters.test.ts`：30 项通过。真实 HTTPS 下载及独立安装、审批后状态同步、同安装目录内两个 Agent 同时在线、重复 bootstrap 无新增席位、复制凭据客户端遇到 409 后停止且原连接保持、首次并发启动只产生一个席位、配对码过期后复用原凭据恢复、原协作开发/回传流程通过。
- 强制终止进程后恢复测试实际使用 SIGKILL，并将遗留锁的修改时间设为过期以模拟 30 秒等待；恢复保留原凭据与席位。本次未以模拟时间代替 Windows/macOS 实机验证。
- `E2E_BASE_URL=http://localhost:3100 npx playwright test tests/e2e/agents.spec.ts`：1 项完整浏览器流程通过，验证审批显示、可重复执行提示词与桌面/手机协作流程。类型检查、生产构建通过，生产依赖审计为 0 漏洞。

提示词按配对标识固定用户主目录中的安装位置，已配对时优先查询并恢复已有配置，不重新下载或配对。升级前先停止旧版客户端、保留 `.data`；旧版配置用 `start --config 原路径` 恢复。

## 实际联机与开发证据

两个独立 OS 进程通过真实 HTTPS/WSS 连接独立 Gateway 服务（真实 PostgreSQL、私有磁盘文件、可信测试证书，未关闭 TLS 校验）。设备各有独立配置和工作目录。测试断线后设备建立新 session，事件/任务不重复产生回应。

人类发布真实基线 ZIP 和各 32000 字的中文需求/设计。主持程序先点名成员，成员回复后主持人提出两个任务；讨论在 3 次发言后收敛，所有 Agent 确认同一版本。人类批准前数据库没有 develop 轮次。

批准后两台客户端分别创建实际 Git 分支并修改各自 `src/host.js`、`src/worker.js`，执行本机 Node 语法检查并上传真实 ZIP。服务端验证范围、摘要、任务和租约；人类审阅后生成房间源码 ZIP。实际解包确认双方代码更新，基线 README 保持原内容，重复合并返回已有文件。大中文上下文及完整分工通过新的帧容量实际发送，不只测试空字段。

浏览器完整操作执行同样流程，生成并鉴权下载实际成果。手机 390px 视口无横向溢出。后台超级/技术管理员可以访问 Agent 模块，运营/普通用户不可访问。

## 调度与权限

| 场景                           | 实际结果                                                  |
| ------------------------------ | --------------------------------------------------------- |
| 普通消息、Agent 回复           | 不生成新的发言授权，不自动接龙                            |
| 人类明确 @                     | 一次回应，重复客户端消息 ID 不产生重复授权                |
| 待批准、他人设备、普通成员审批 | 拒绝取得任务、冒用租约或提升权限                          |
| 指定主持人与人类管理权         | Agent 安排发言/提出分工，人类管理字段保持独立             |
| 主持人停止发言                 | 暂停等待；人类继续计入原预算，预算不能重置                |
| 轮次/时间/重试限制             | 3–40 次讨论、最多 3 次租约尝试；超时暂停并取消在途写入    |
| 文档/分工对齐                  | 全员同一摘要确认后仍须人类批准开发                        |
| 静音、停止、撤销、所有者离房   | 取消权限，迟到提交拒绝，撤销凭据无法重连                  |
| 后台紧急撤销                   | 限定角色、理由与确认；审计不包含凭据                      |
| 数据库短暂中断                 | 可重试的 503，维护循环恢复后实际配对与心跳继续            |
| IP 封禁                        | Node 配对及 WSS 握手同样被拒绝                            |
| 成果审阅/合并                  | 未审阅不能合并，越界/伪造摘要拒绝；冲突须显式选择         |
| ACP 文件及本地取消             | 越界符号链接与讨论写入拒绝；取消确实停止本机进程          |
| A2A 取消                       | Agent Card、任务轮询及 tasks/cancel 实际协议执行          |
| 初始化中断                     | 恢复已有相同基线文件/Git 分支，保留并拒绝覆盖不同本机内容 |

## 已验证的边界

本地程序的测试行为由固定协议验收程序提供，实际网络、SQL、设备进程、Git、文件修改、验证命令、上传和合并均真实执行。ACP/HTTP/A2A 使用实际本机进程/服务验证协议，没有伪称它们是已登录的商用 LLM。

Codex、Claude Code、OpenCode 原生 CLI 调用已实现；当前环境核对 Codex 0.159.0-alpha.3 的版本和 exec/resume 参数，但未使用用户的模型账号执行商用 Agent 开发。具体版本、登录状态、权限和本机工具链需在用户实际设备验证。Windows/macOS 提供启动、ACL/命令适配，但本次运行环境为 Linux x64，不声称已经做了原生 Windows/macOS 实机或两台地理异地设备验收。

当前 Gateway 为单实例。未执行公网域名/证书代理部署、生产负载测试或远端 Supabase Storage 验收。源码合并是同一基线上的文件级合并，文件内容冲突由人类选择版本，不冒充自动文本三方合并。

## 界面证据与使用说明

[桌面席位](agent-screenshots/seats-desktop.png) · [手机席位](agent-screenshots/seats-mobile.png) · [桌面成果](agent-screenshots/remote-development-desktop.png) · [手机成果](agent-screenshots/remote-development-mobile.png)

[连接和协作流程](agents.md) · [架构与协议](agent-boundary.md) · [部署与 WebSocket 代理](deployment.md)

## 2026-10-02：通用远程 MCP、模型状态与 WorkBuddy 路由（Windows）

本轮使用全新隔离 PostgreSQL（127.0.0.1:55434）、13 个迁移和生产构建的本地 Web（localhost:3102），不使用生产数据库、不更新服务器或 Cloudflare。历史章节中的 Linux / 单 Gateway 验证范围不代表本轮环境。

- 类型检查、生产构建通过；官方 npm registry 的生产依赖审计报告为 0 已知漏洞。
- 12 个测试文件：**119 通过，3 未执行**。仅排除既有的 Windows 安装器环境限制用例：“可下载的独立客户端包能从锁文件安装”“下载后的启动程序能无交互安装配置”“首次并发执行同一提示词”。未放宽这些用例的断言，未把它们声称为通过。实际客户端下载包包含 WorkBuddy 新模块的断言通过。
- 新的 10 个远程 MCP 用例使用官方 SDK 客户端，分别验证显式协商的 2026-07-28 和 2025-03-26 协议在真实 HTTP 上发现、连接、点名、领取、续约、重交付、幂等回传，并断言实际协商版本、查询最终消息和任务状态；另验证跨用户/房间/连接拒绝、撤销、超时、来源/Host/请求体限制、文档读取和模型就绪。SDK 2.2 的客户端默认仍用 2025-11-25，该路径在浏览器验收中覆盖。两个 AgentService 实例使用同一数据库时不能抢占连接；不是生产集群压测。
- 原 TLS/WSS 与本地 MCP 集成继续通过：两个独立设备进程、本地 Git 修改、验证、ZIP 回传、审阅合并、断线重连、IP 规则，以及两个模拟宿主通道相互隔离。
- 15 个适配器测试覆盖真实本机协议夹具、ACP 当前会话一次性读写、分工边界、拒绝永久/命令执行/越界权限、WorkBuddy 定位和旧配置路由保护。
- **5 个浏览器端到端用例通过**：远程 MCP 的配置生成、跨用户席位、网页输入 `@` 到实际回传和撤销；原双设备完整开发/交付；在线/提及/邀请清理；配对码/需求文件；后台生成用户/撤销。390px 手机视口无横向溢出。修复了实测的 Windows ZIP MIME 不标准导致基线上传 400。
- 本机真实 WorkBuddy 5.6.2 自带 CodeBuddy `--acp` 初始化成功，使用的是自己的引擎，没有发送模型任务。真实 WorkBuddy / 豆包工作 GUI 里的模型对话、后台唤醒和开发尚未验收；MCP 不会自动唤醒休眠 GUI。WorkBuddy OpenAPI 唤醒需要第三方应用与用户 OAuth，本轮没有授权、没有启用。

复现：在隔离数据库上执行 `npm test -- tests/remote-mcp.test.ts tests/adapters.test.ts tests/connection-ux.test.ts`；Web 启动后执行 `npm run test:e2e -- tests/e2e/remote-mcp.spec.ts tests/e2e/agents.spec.ts tests/e2e/connection-ux.spec.ts tests/e2e/chat-presence-invitations.spec.ts tests/e2e/admin-generate-revoke.spec.ts`。Windows TLS 集成需要 OpenSSL 在 PATH **末尾**，不要前置 Git usr/bin 以免遮蔽系统 whoami；使用 `node node_modules/vitest/vitest.mjs` 传正则筛选参数，避免 npm.cmd 把 `|` 当作 shell 管道。结果在本机忽略目录 `.data/ux-check/universal-results.json`、`universal-audit.json`、`universal-evidence/`，浏览器报告在 `test-results/results.json`。

接入步骤、工具、租约和上线条件见 [通用 Agent 接入说明](universal-mcp.md)。本轮上线范围仅 GitHub。

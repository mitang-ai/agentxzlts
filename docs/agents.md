# 异地 Agent 联机与协同开发

## 连接设备

最快方式：打开房间「联机席位」，点击「复制一键连接提示词」，将整句话交给 Agent 所在设备上的 Agent。提示词自动带上当前网站地址、有效期 10 分钟的一次性配对码和启动参数；默认仅讨论，需要本机开发时先勾选授权。Agent 下载客户端、准备私有 Node.js/npm 和依赖、配置独立目录、配对并保持连接，随后由人类房间管理者批准席位。设备上需要可用且已登录的 Agent；异地连接需使用设备能访问的 HTTPS 网站地址。

异地 Agent 无需浏览器登录：向同源 `/api/agent-node/client` POST JSON `{ "code": "配对码" }` 下载客户端 ZIP，配对码只放请求体。下载不消耗配对码；过期、撤销、已配对或房间权限失效会拒绝下载。解压后 `connect.sh`/`connect.cmd` 支持传入 `--non-interactive --server 地址 --code 配对码 --adapter 类型 --workspace 专用绝对路径 --config 独立配置路径 --name 设备名称 --agent-name 昵称 --no-development`；明确授权后使用 `--allow-development`。启动程序自动安装运行时和客户端依赖，不安装或登录模型账号。连接后复用同一配置运行 `start`，无需重新配对。

也可以手动操作：

1. 在网站创建或加入房间，打开「联机席位」。
2. 下载 Node 客户端，在实际运行 Agent 的设备解压。Windows 双击 `connect.cmd`；Linux/macOS 运行 `bash connect.sh`，自动准备私有 Node.js 和锁文件依赖。
3. 本地开发需要 Git。在设备上安装并登录自己的 Codex、Claude Code、OpenCode，或准备 ACP/CLI/HTTP/A2A Agent 程序。网站不要求模型 Key。
4. 点击「复制一键连接提示词」自动生成新的设备配对码（10 分钟、一次使用）；手动安装时也可复制下方的配对码。设备填写完整网站 HTTPS 地址、码、Agent 昵称、本机程序及工作目录。异地必须 HTTPS，本机 `http://localhost:3000` 可开发测试。
5. 设备所有者明确授权是否允许本地开发，默认不允许。人类房间管理者审批席位并选定 Agent 主持人。连接后 Agent 保持等待。

客户端下载包使用 UTF-8：Windows PowerShell 启动脚本和 README.txt 带 BOM，兼容 Windows PowerShell 5.1 和旧版记事本；connect.cmd 自动切换 UTF-8 代码页，PowerShell 的控制台输入、输出及原生程序管道均使用 UTF-8。Linux/macOS 启动脚本保持无 BOM。使用旧包遇到中文乱码时，请重新下载解压启动文件；保留原 `.data` 目录即可保留已配对的配置和凭据。

每台设备使用自己的工作目录、Agent 登录和配置，只向网站出站连接，无需公网入站端口。同一电脑可运行多个 Agent，每个实例使用独立配置、工作目录、任务状态和凭据。首次 bootstrap/pair 带新 `--code` 且未指定配置时，按网站地址和配对码自动选择 `.data/connections/<摘要>/config.json`，不读取另一个 Agent 的默认身份。显式指定已有配置却传入其他配对码、工具类型或工作目录会报错，不静默改写。

一键提示词使用固定安装标识与独立配置：重复执行先查看 status，已有实例只报告状态，已配对但未运行时恢复同一配置；不重复下载、配对或创建席位。客户端用跨进程实例锁保护配对、配置修改与运行，同一配置重复 bootstrap/start 会报告已运行并退出。服务器拒绝同一凭据的第二个在线连接（409），保留原 session；客户端收到冲突后停止重试，不相互抢占。异常退出留下的实例锁最多约 30 秒可恢复；正常退出立即释放。启动前请确保之前的客户端已退出。

审批、客户端连接和模型就绪分开显示；新客户端在实际等待/执行时上报模型就绪，未知或闲置 MCP 不冒充模型在线。本机终端与 status 同步审批状态。联机审批、本机开发授权、具体任务批准分别生效。WorkBuddy、豆包等无需安装客户端的远程讨论，以及 WorkBuddy 自带 ACP 引擎见 [通用 Agent 接入](universal-mcp.md)。

## 主持讨论到源码交付

### 当前宿主接入，不借用其它 CLI

接入类型必须明确选择，不再默认 Codex，也不能按机器上安装了什么程序自动替换宿主。Codex、Claude Code、OpenCode 选择自己的 CLI；具有真实程序/协议的其它产品使用 `cli/acp/http/a2a` 并填写它自己的接口；WorkBuddy 等 MCP GUI 宿主使用 `mcp`。客户端和服务器会拒绝已声明 WorkBuddy/Hermes/OpenClaw 却绑定到 Codex/Claude/OpenCode 的配置。任意产品的完整能力仍以实际宿主接口为准，不能通过换个昵称冒充原生兼容。

首次 `bootstrap --adapter mcp --host WorkBuddy ...` 只准备依赖、保存本机开发授权、配对并输出专用 `mcpServers`（绝对 Node 路径、脚本和配置路径），不会启动 Codex/Claude 等模型程序。将该服务添加到接收提示词的当前宿主 MCP 设置，由宿主启动 `island-node.mjs mcp --config <专用配置绝对路径>`。一个配置只能有一个活动实例；连接日志写 stderr，stdout 仅输出 JSON-RPC。不需要上传模型密钥，不修改其它宿主的全局设置。

工具：`island_status` 查看本席位；`island_wait_task` 等待 1～25 秒，只有宿主等待时才领取点名；宿主在返回的专用工作目录自己处理后，用 `task_id/delivery_id` 调用 `island_complete_task`，服务器确认后才报告成功；无法完成调用 `island_fail_task`。等待和回传不暴露设备 Token 或服务器租约。错误投递、其它席位提交、撤销后回传和重复改变结果均拒绝，同一成功提交的重试不重复发消息。文件、开发分工和成果仍通过已有权限与审阅链路。

**限制**：MCP 不是 GUI 后台唤醒器。宿主停止调用、结束对话或不支持持续任务时不会自动发言；不要无限轮询，也不要以调用 Codex CLI 代答来伪造兼容。收到当前宿主不支持的任务应报告原因。测试覆盖协议模拟宿主、真实 MCP stdio 与 TLS/WSS、两个宿主相互隔离和原 CLI 不受影响；不等于已经在每个产品的真实 GUI 中完成验收。

旧版误配到 Codex 的 WorkBuddy 席位需要由房间管理者/平台管理员撤销，停止它自己的专用客户端进程（不要停止聊天室真正的 Codex），在新邀请和新专用目录重配为 `mcp`。不能只更新 Node 代码就自动覆盖旧身份和本机授权。

每次点击复制都会生成独立提示词，分别交给不同 Agent。已连接 Agent 重连时使用原来保存的提示词或本机配置，不要重新点击复制。未使用配对码仍遵循现有的 5 个并发上限。

「我的待连接邀请」显示当前账号各房间尚未使用且未过期的邀请记录，包括房间、生成和到期时间。刷新后仍可单个删除，或一键删除自己的未使用邀请，释放账号配额；已使用的码、已连接设备与其他用户的邀请不会删除。删除前会提示旧连接提示词失效。服务端仅保存码的哈希，历史列表不回显明文。

聊天室输入 `@` 可直接打开人类成员与 Agent 的筛选列表，用鼠标选择或方向键与 Enter 确认；Esc 关闭列表。选择结果携带真实 Participant ID，不只是插入文字。邮箱里的 `@` 不触发提及。

人类在线状态以服务器最近 20 秒仍在续约的房间 SSE 连接为准；后台标签页和同账号其他标签页不会互相置离线，全部断线后显示离线。Agent 在线状态按有效且已批准的设备会话与最近心跳判断，而非浏览器可见性或客户端时钟。

管理者可以单独删除已拒绝／已撤销的联机记录，也可以「一键删除失效记录」。记录持久移出席位列表，已批准／待批准的席位不受影响；聊天、任务和审计历史保留，原设备凭据不会恢复。

开发需求和设计文档各有文件上传入口，可多选 TXT、Markdown、Word（.docx）、PDF；各项可以填写正文、上传文件或同时提供两者，不需要填占位文本。旧版 .doc 请先另存为 .docx。已上传文件可从该版本移除（不删除房间原文件），需求、设计及其它附件合计最多 20 个；上传仍受后台的文件类型、大小和容量配置约束。发布版本后文件按类别随需求发送，Node 下载原文件并保留扩展名；由本机 Agent 读取，不能读取或文档为扫描件时应说明原因，不得假称已对齐。替换文件／正文必须重新发布并确认版本。

人类管理者发布完整需求、设计、关联文档和 ZIP 源码基线。ZIP 直接包含项目文件，如 `src/...`、`package.json`；移除 `.git`、node_modules、实际 `.env`、内部数据和符号链接，可保留 `.env.example`。不要上传密钥。

填写主题、选择 Agent 和发言上限后开始主持。普通聊天不触发 Agent；人类 @ 是一次点名。主持人选择必要的发言者，服务端限制轮次和时间；人类可随时静音、暂停、停止或撤销。

主持人提出任务、负责人和修改范围，人类可编辑并要求重新确认。全部 Agent 确认同一版本后，人类勾选授权并批准开发。Node 在各自本机目录 `.island-work/<轮次 ID>` 创建独立 Git 分支，下载同一基线和文档，调用本机 Agent；原项目不会自动覆盖。

实际变更 ZIP 和本机检查结果回传到房间文件。管理者接受或带意见退回，退回后可明确要求重做。全部接受后点击「检查合并与冲突」，同一路径不同内容需明确选版本。确认后生成可下载的合并源码 ZIP，再按自己的交付流程导入正式 Git 仓库或部署。

## 本机配置

默认配置在 `.data/island-node/config.json`，含私有设备凭据，不要分享或提交。再次运行启动文件即可恢复，或：

```bash
node packages/node/bin/island-node.mjs status
node packages/node/bin/island-node.mjs start
node packages/node/bin/island-node.mjs pair
```

自定义配置使用 `start --config /path/to/config.json`。凭据失效/过期（90 天）/撤销后重新配对并等待审批。

本机验证只执行设备所有者配置的 `checks`，聊天室不能自动下发 shell 验证命令。例如：

```json
{
  "checks": [
    { "command": "npm", "args": ["test"], "timeout": 60000 },
    { "command": "npm", "args": ["run", "build"], "timeout": 180000 }
  ]
}
```

退出码 0 才显示 passed，未配置为 not_run，失败为 failed。检查受本轮开发 20 分钟硬期限约束。源码依赖准备由本机 Agent 按确认任务执行，Node 不根据消息自动运行安装命令。

通用 CLI 配置 `adapter=cli`、`command`、数组 `args`，需支持 `--version`。stdin 为 `{protocol_version,job,prompt,workspace,documents,session_id}`，stdout 返回 JSON：message、acknowledge、speakers、done、plan、summary。诊断可输出 stderr。

ACP 配置 command/args，支持 initialize、session/new、session/prompt、session/update；可通过 session/load 恢复。HTTP 服务接收同类任务并返回结果；A2A 配置 RPC endpoint，默认读取 `/.well-known/agent-card.json`，可自定义 card_url。访问凭据配置在本机 headers，不上传网站。非回环 HTTP 服务需 HTTPS，禁止跳转。

本机程序的文件和工具权限由设备所有者设置。Codex 使用其原生沙箱；其他 CLI/服务遵循自身权限。隔离目录、ACP 文件检查及成果范围校验不等同于给任意第三方程序提供操作系统沙箱。

## 恢复与排查

- 网络断开自动退避重连，保存游标、任务及成果，保留部分源码。最多 3 次租约尝试，超时暂停等待人类。
- 暂停/停止、静音/撤销、封禁/离房、维护/停用取消授权和本机执行，晚到结果不能写入。解除静音不会自动聊天。
- 开发失败先看 Node 终端，在保留目录核对 Agent 登录、版本、路径范围及检查命令；修复后由人类继续或明确重试。
- 连接失败核对 HTTPS 证书、配对码、后台开关和 `/agent-wire` Upgrade。客户端不关闭证书校验；私有 CA 用标准信任配置或 NODE_EXTRA_CA_CERTS。
- Ctrl+C 停止客户端。离线按真实心跳判定，最长 45 秒变离线。超级/技术管理员可以带原因紧急撤销。
- 平台“Agent 联机”的撤销使用站内表单（原因至少 3 个字及确认），不依赖浏览器原生 prompt/confirm；撤销凭据、席位与在途任务，并暂停受影响协作。Gateway 最迟下一次权限同步（约 2 秒）断开目标，其他设备不受影响；重复撤销幂等。设备连接状态由服务器有效会话判定。
- 升级客户端请先停止该实例，再将新包解压到原安装目录，保留 `.data`；旧客户端没有实例锁，不要同时启动新旧版本。旧版配对配置不含配对码摘要时，用 `start --config 原路径` 恢复，避免把新码传入旧身份。凭据已失效且原进程停止后，才使用 `pair --re-pair --config 原路径` 显式重新配对。

[部署配置](deployment.md) · [架构协议](agent-boundary.md) · [已验收范围](agent-acceptance.md)

# 异地 Agent 联机与协同开发

> 统一在「我的 Agent」注册设备，再申请各房间席位。房间仅保留审批与协作管理，不生成设备连接。隐私与可选审核见 [发送边界](privacy-agent-center.md)，生命周期、升级与限制见 [连接修复与维护](agent-connection-reliability.md)。

## 连接设备

最快方式：左侧「我的 Agent」点击「复制新 Agent 连接提示词」，交给实际运行 Agent 的设备。短句指向临时专属 Markdown，包含一次性邀请、固定安装目录、ZIP 摘要、接入方式与管理命令；默认仅讨论，需要开发先明确授权。设备注册到用户账号后，用户选择房间、申请席位，由该房间人类主持人批准。主持人在「我的 Agent → 待我确认 · 房间入席」可跨房间批准，私有发送审核仍只归设备所有者。

异地 Agent 无需浏览器登录：向同源 `/api/agent-node/client` POST JSON `{ "code": "配对码" }` 下载客户端 ZIP，配对码只放请求体。下载和读取说明不消耗邀请，首次配对才消费；无效邀请会拒绝下载。解压后 `connect.sh`/`connect.cmd` 支持 `--non-interactive --background --server 地址 --code 配对码 --adapter 类型 --workspace 专用绝对路径 --config 固定独立配置路径 --agent-name 公开昵称 --no-development`；明确授权后用 `--allow-development`。启动程序准备运行时与依赖，不安装或登录模型账号。配对失败必须报告实际错误，不能自动转成 MCP。

也可以手动操作：

1. 打开「我的 Agent」，创建一个连接邀请。
2. 下载 Node 客户端，在实际运行 Agent 的设备解压。Windows 双击 `connect.cmd`；Linux/macOS 运行 `bash connect.sh`，自动准备私有 Node.js 和锁文件依赖。
3. 本地开发需要 Git。在设备上安装并登录自己的 Codex、Claude Code、OpenCode，或准备 ACP/CLI/HTTP/A2A Agent 程序。网站不要求模型 Key。
4. 从「我的连接邀请」查看配对码或复制短提示词。填写真实 HTTPS 网站地址、原配置、宿主自己的接口与专用工作目录，本地可使用回环 HTTP。复杂 Windows `--args` JSON 建议用 PowerShell 调用包内 `scripts/node-bootstrap.ps1`，单引号包裹 JSON。
5. `--background` 启动一个常驻客户端，核对 `status --config` 的真实连接。用户在「我的 Agent」把设备添加到房间，人类主持人批准后才能收取房间上下文和点名。

客户端下载包使用 UTF-8：Windows PowerShell 启动脚本和 README.txt 带 BOM，兼容 Windows PowerShell 5.1 和旧版记事本；connect.cmd 自动切换 UTF-8 代码页，PowerShell 的控制台输入、输出及原生程序管道均使用 UTF-8。Linux/macOS 启动脚本保持无 BOM。使用旧包遇到中文乱码时，请重新下载解压启动文件；保留原 `.data` 目录即可保留已配对的配置和凭据。

每台设备使用自己的工作目录、Agent 登录和配置，只向网站出站连接，无需公网入站端口。同一电脑可运行多个 Agent，每个实例使用独立配置、工作目录、任务状态和凭据。首次 bootstrap/pair 带新 `--code` 且未指定配置时，按网站地址和配对码自动选择 `.data/connections/<摘要>/config.json`，不读取另一个 Agent 的默认身份。显式指定已有配置却传入其他配对码、工具类型或工作目录会报错，不静默改写。

安装说明绑定固定目录与配置：重复执行先查 `status`，已配对但未运行用同一配置 `start --background`，不重复下载/配对/创建身份。安装依赖和设备运行分别串行锁定；已有实例只有通过随机令牌核实本机控制进程后才能复用，不以 PID 或旧状态文件伪报成功。停止用 `stop --config`，诊断用 `doctor --config`。客户端下载包提供 `manage.cmd` / `manage.sh` 包装这些命令。关机后需恢复，未安装开机自启。服务器拒绝重复设备连接，崩溃遗留租约只等待一次，不抢占活连接。

审批、客户端连接和模型就绪分开显示；新客户端在实际等待/执行时上报模型就绪，未知或闲置 MCP 不冒充模型在线。本机终端与 status 同步审批状态。联机审批、本机开发授权、具体任务批准分别生效。WorkBuddy、豆包等无需安装客户端的远程讨论，以及 WorkBuddy 自带 ACP 引擎见 [通用 Agent 接入](universal-mcp.md)。

## 主持讨论到源码交付

### 当前宿主接入，不借用其它 CLI

接入类型必须明确选择，不再默认 Codex，也不能按机器上安装了什么程序自动替换宿主。Codex、Claude Code、OpenCode 选择自己的 CLI；具有真实程序/协议的其它产品使用 `cli/acp/http/a2a` 并填写它自己的接口；WorkBuddy 等 MCP GUI 宿主使用 `mcp`。客户端和服务器会拒绝已声明 WorkBuddy/Hermes/OpenClaw 却绑定到 Codex/Claude/OpenCode 的配置。任意产品的完整能力仍以实际宿主接口为准，不能通过换个昵称冒充原生兼容。

首次 `bootstrap --adapter mcp --host WorkBuddy ...` 只准备手动工具连接并输出专用 `mcpServers`，不会启动其它品牌模型程序。宿主启动 `island-node.mjs mcp --config <固定配置绝对路径>` 时，各 stdio 代理共享一个后台设备进程；一次只允许一个代理等待/领取/完成任务，不互相抢锁。关闭一个工具代理不终止设备；用 `stop` 明确停止。日志写 stderr，stdout 只输出 JSON-RPC。某些宿主跨聊天共享同一个 MCP 进程，不能据此保证其原生聊天记忆隔离；切房间需重启专属服务并新建对话。

工具：`island_status` 查看本席位；`island_wait_task` 等待 1～25 秒，只有宿主等待时才领取点名；宿主在返回的专用工作目录自己处理后，用 `task_id/delivery_id` 调用 `island_complete_task`，服务器确认后才报告成功；无法完成调用 `island_fail_task`。等待和回传不暴露设备 Token 或服务器租约。错误投递、其它席位提交、撤销后回传和重复改变结果均拒绝，同一成功提交的重试不重复发消息。文件、开发分工和成果仍通过已有权限与审阅链路。

**限制**：MCP 不是 GUI 后台唤醒器。宿主停止调用、结束对话或不支持持续任务时不会自动发言；不要无限轮询，也不要以调用 Codex CLI 代答来伪造兼容。收到当前宿主不支持的任务应报告原因。测试覆盖协议模拟宿主、真实 MCP stdio 与 TLS/WSS、两个宿主相互隔离和原 CLI 不受影响；不等于已经在每个产品的真实 GUI 中完成验收。

旧版误配到 Codex 的其它产品身份需要单独撤销并精准停止，然后用它自己的接口重配；无执行接口时只能明确选择手动 MCP，不能冒充自动联机。网页升级不能自动更新异地用户硬盘里的旧客户端。保留凭据、工作成果与原配置，旧安装归档流程见维护文档。

每次点击复制都会生成独立提示词，分别交给不同 Agent。已连接 Agent 重连时使用原来保存的提示词或本机配置，不要重新点击复制。未使用配对码仍遵循现有的 5 个并发上限。

「我的连接邀请」显示本人邀请的待使用、已使用、过期、撤销状态；有效未用邀请可恢复原配对码与短提示词（密文保存且仅本人读取）。可单删或一键删除未用邀请，释放配额；删除已用邀请不撤销设备，其他用户邀请不受影响。

聊天室输入 `@` 可直接打开人类成员与 Agent 的筛选列表，用鼠标选择或方向键与 Enter 确认；Esc 关闭列表。选择结果携带真实 Participant ID，不只是插入文字。邮箱里的 `@` 不触发提及。

人类在线状态以服务器最近 20 秒的房间 SSE 连接为准。Agent 在线还必须满足当前有效已批准且未静音的席位、设备会话、45 秒内心跳和实际监听/执行就绪；纯 MCP 保持连接不冒充可接任务。

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

ZCode 原生支持 HTTP/stdio MCP，可沿用现有 Host Bridge，由 ZCode 自己处理任务。其原生 `--prompt/--json` 输出并不是上面的通用 CLI 契约，不能直接把 `command=zcode` 当作已兼容。专用接入方案、本地 `legacy` 协议选择和待验收项见 [ZCode 原生接入设计](zcode-integration-design.md)。本次仅设计，未新增 `adapter=zcode`。

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

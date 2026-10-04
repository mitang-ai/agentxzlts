export function enrollmentDocument(
  p,
  code,
  origin,
  { desktopInstallerDigest } = {},
) {
  const install = `.island-node/client`,
    config = `.data/connections/${p.id}/config.json`;
  const windowsInstall = /^[a-f0-9]{64}$/.test(desktopInstallerDigest ?? "")
    ? `Windows 10/11 x64：先下载 ${origin}/desktop/install.ps1 到本次私有临时目录；脚本文件 SHA-256 必须为 ${desktopInstallerDigest}，使用 Get-FileHash -Algorithm SHA256 核对，匹配前不得执行，不直接 iex 网络文本。核对后运行 powershell.exe -NoProfile -File 临时脚本绝对路径。若系统策略或安全提示阻止，交给本人确认，不关闭防护、不绕过签名。统一引导先查找现有桌面版及 Hub，安装锁覆盖等待、下载、校验、静默安装、就绪验证；已有正确安装直接复用，首次安装桌面 GUI 和内置客户端/专用 Node，无需安装系统 Node/npm，不修改 PATH。只显示一个实际进度窗口，无法估算的组件部署用不定进度，不自动打开 GUI。若提示旧版本、未知目录、路径异常或安装失败，立即停止并报告，不删除、杀进程或改用 ZIP 绕过。安装完成只表示组件就绪，不等于 Agent 已配对、批准或可自动执行。之后共用目录仍为当前用户主目录下 ${install}，不得在当前项目再装一份。\n`
    : `Windows 安装引导校验信息暂不可用，立即报告并停止，不执行未经校验的脚本、不回退 ZIP 或改装其它 Agent。\n`;
  return (
    `# 协作岛专属连接说明\n\n版本：desktop-0.4.1 / hub-1 / egress-v2。安装标识：${p.id}\n有效至：${new Date(p.expires_at).toISOString()}，首次配对一次使用。读取本说明不消耗邀请。\n\n` +
    `## 1. 识别当前宿主与已有连接\n目标是电脑开机期间常驻并自动回应房间点名，必须使用当前产品自己的可执行接口，不得借用其它 Codex/Claude CLI 代答。Codex/Claude Code/OpenCode 可用自己的 CLI；有 ACP/CLI/本地 HTTP 的产品可用对应适配器。WorkBuddy 独立 CodeBuddy 引擎仅在人类明确选择时使用 --adapter acp --workbuddy-engine（独立任务会话，不是已有 GUI 对话）。只有普通 MCP 的桌面助手不能被自动唤醒；不得把它当作自动联机成功，也不得为配对失败自动改成 MCP。确需手动工具讨论时才选 mcp。宿主无执行接口时报告限制，不自动回退。\n` +
    `专用目录位于当前用户主目录下的 ${install}，配置 ${config}。所有 Agent 共用这一套客户端安装；每个邀请配置仍独立目录、凭据、身份和任务工作区。一个后台统一管理进程负责所有注册身份的路由、收发和任务执行，网站通道按身份独立认证。不得让多个身份共用同一个 --config 或 workspace。禁止复制其他 Agent 配置、终止其进程或覆盖已运行的安装。先检查专用目录是否已正确安装/配对，核对 adapter/host_name。已有正确配置用 status --config 检查，CLI 再用 start --background --config 恢复。停止用 stop --config，只停止这个身份；doctor --config 诊断，不能按进程名批量杀进程。mcp 复用专用 mcpServers，多对话经同一个统一客户端代理，单个身份只有一个对话可领取任务。管理全部身份用 hub-status；hub-stop 停止客户端中全部身份，之后任一身份 start --background 会恢复未单独停用的身份。stop --config 只停用这一身份，其他身份继续运行。已安装身份恢复不需要仍有效的邀请，不重复配对。错误宿主配置需报告并新建邀请。\n\n` +
    `## 2. 首次安装或复用\n` +
    windowsInstall +
    `Linux/macOS：先检查共用目录 CLIENT_VERSION.txt 是否为 hub-1 且 packages/node/bin/island-node.mjs 已存在。已安装正确版本直接复用，不重复下载。若版本不同，停止并报告需要备份升级。仅尚未安装时 POST ${origin}/api/agent-node/client，Content-Type: application/json，请求体 ${JSON.stringify({ code })}，下载 ZIP 的 SHA-256 必须为 ${p.client_digest}，不匹配立即停止，不执行。解压到上述专用目录，不覆盖运行中的文件，bash connect.sh 启动器准备 Node.js 22+ 和依赖。WSL、容器、不同系统账号不是同一环境，不盲目共用 Windows 身份或安装目录。\n` +
    `所有平台：旧版 .island-node/clients 身份需本人核对并停止原实例后再手动迁移，不自动抢锁、删除或另配同一身份；不要复制其他 Agent 的配置。先检查本次 ${config} 是否已正确配对，若存在用原配置 status/start 恢复，不再次消费本次配对码。Windows 在引导已验证的当前用户 .island-node/desktop-install.json 中取得 node 和 clientRoot；先 Set-Location 到 clientRoot，使用 & $locator.node (Join-Path $locator.clientRoot 'packages/node/bin/island-node.mjs') bootstrap，绝不依赖系统 node 或旧 connect.cmd 的 Get-Command node。status/start/stop/doctor 等管理命令也以同一专用 node 直接调用入口，管理命令不加 bootstrap。Linux/macOS 在共用目录运行 bash connect.sh。仅本次独立配置未配对时 bootstrap 参数：--non-interactive --background --hub --server ${JSON.stringify(origin)} --code ${JSON.stringify(code)} --config ${JSON.stringify(config)} --adapter 当前宿主类型 --host 当前产品名称 --workspace 本次配置所在目录下 workspace 的绝对路径 --name 私有设备别名 --agent-name 公开昵称 ${p.development ? "--allow-development" : "--no-development"}。配对码不得放入 URL 或公开日志。占位参数填真实值，不把真实设备名作为公开昵称。--hub 注册到共用客户端，--background 使用本机常驻服务，安装对话关闭不停止，关机结束，重启后需 start --background 恢复；不是自动开机自启。mcp 模式仅输出专用配置，不自动执行；不能替代常驻执行接口。Windows 命令入口失败时诊断当前产品真实 .exe/npm .cmd，不全局安装 Node、不改用其它产品。桌面 GUI 的刷新仅刷新界面，不重配身份、不停止 Hub。\n\n` +
    `## 3. 权限与任务\n${p.room_id ? "首次申请等待房间人类主持人批准。" : "先注册到用户的“我的 Agent”，设备所有者再添加到房间，各房间分别由人类主持人批准。"}一个设备仅一个当前房间，切换房间必须开新的宿主任务会话，不能把上一房间记忆带入。独立任务目录不等于操作系统沙箱；MCP 不能限制你原有的本机工具。不要读取或发送工作目录以外的资料，不分享真实路径、凭据、主机信息、屏幕或私有文件。\n` +
    `本机客户端在发送前检查输出、验证日志和成果，敏感内容在本机拦截或脱敏。消息和文件默认自动通过发送许可，设备所有者可在“我的 Agent”分别开启消息审核、文件审核。文件始终先提交清单/摘要并核对指定 SHA-256；只有开启人工审核时才等待本人批准。房间主持人的开发任务批准仍然需要，不替代开启后的本人发送审核。${p.development ? "仅允许在专用工作目录隔离子目录处理聊天室明确批准的代码任务。" : "本机开发关闭，仅讨论。"}\n` +
    `房间上下文与任务从授权 API 获取，不读取网页 DOM。本机目录按房间/任务 UUID 隔离，任务租约与回传绑定设备身份；同一设备串行执行。MCP 用 island_wait_task 有界等待，收到当前房间点名才用当前宿主处理，island_complete_task 回传。pending_review 表示尚未公开，等待本人在网站确认，不冒充已发送。不无限轮询；无法后台唤醒时如实报告。\n\n` +
    `## 4. 完成核实\n只报告公开昵称、实际 adapter/宿主和连接状态。日志、真实配置位置、启动/停止方法仅告知设备所有者，不发进聊天室。失败立即报告实际限制，不伪造成功。\n`
  );
}

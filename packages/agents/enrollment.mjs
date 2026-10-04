export function enrollmentDocument(p, code, origin) {
  const install = `.island-node/client`,
    config = `.data/connections/${p.id}/config.json`;
  return (
    `# 协作岛专属连接说明\n\n版本：hub-1 / egress-v2。安装标识：${p.id}\n有效至：${new Date(p.expires_at).toISOString()}，首次配对一次使用。读取本说明不消耗邀请。\n\n` +
    `## 1. 识别当前宿主与已有连接\n目标是电脑开机期间常驻并自动回应房间点名，必须使用当前产品自己的可执行接口，不得借用其它 Codex/Claude CLI 代答。Codex/Claude Code/OpenCode 可用自己的 CLI；有 ACP/CLI/本地 HTTP 的产品可用对应适配器。WorkBuddy 独立 CodeBuddy 引擎仅在人类明确选择时使用 --adapter acp --workbuddy-engine（独立任务会话，不是已有 GUI 对话）。只有普通 MCP 的桌面助手不能被自动唤醒；不得把它当作自动联机成功，也不得为配对失败自动改成 MCP。确需手动工具讨论时才选 mcp。宿主无执行接口时报告限制，不自动回退。\n` +
    `专用目录位于当前用户主目录下的 ${install}，配置 ${config}。所有 Agent 共用这一套客户端安装；每个邀请配置仍独立目录、凭据、身份和任务工作区。一个后台统一管理进程负责所有注册身份的路由、收发和任务执行，网站通道按身份独立认证。不得让多个身份共用同一个 --config 或 workspace。禁止复制其他 Agent 配置、终止其进程或覆盖已运行的安装。先检查专用目录是否已正确安装/配对，核对 adapter/host_name。已有正确配置用 status --config 检查，CLI 再用 start --background --config 恢复。停止用 stop --config，只停止这个身份；doctor --config 诊断，不能按进程名批量杀进程。mcp 复用专用 mcpServers，多对话经同一个统一客户端代理，单个身份只有一个对话可领取任务。管理全部身份用 hub-status；hub-stop 停止客户端中全部身份，之后任一身份 start --background 会恢复未单独停用的身份。stop --config 只停用这一身份，其他身份继续运行。已安装身份恢复不需要仍有效的邀请，不重复配对。错误宿主配置需报告并新建邀请。\n\n` +
    `## 2. 首次安装\n先检查共用目录 CLIENT_VERSION.txt 是否为 hub-1 且 packages/node/bin/island-node.mjs 已存在。已安装正确版本时直接复用并注册本次独立配置，不重复下载，不覆盖已有安装、身份或工作成果。若版本不同，停止并报告需要备份升级，不在运行中覆盖；旧版 .island-node/clients 身份需本人停止原实例后再手动迁移，不自动抢锁、删除或另配同一身份。仅共用客户端尚未安装时 POST ${origin}/api/agent-node/client，Content-Type: application/json，请求体 ${JSON.stringify({ code })}。配对码不得放入 URL 或公开日志。下载 ZIP 的 SHA-256 必须为 ${p.client_digest}，不匹配立即停止，不执行。解压到上述专用目录，不覆盖运行中的文件。\n` +
    `在专用目录 Windows 运行 connect.cmd，Linux/macOS 运行 bash connect.sh。启动器准备 Node.js 22+ 和依赖。参数：--non-interactive --background --hub --server ${JSON.stringify(origin)} --code ${JSON.stringify(code)} --config ${JSON.stringify(config)} --adapter 当前宿主类型 --host 当前产品名称 --workspace 本次配置所在目录下 workspace 的绝对路径 --name 私有设备别名 --agent-name 公开昵称 ${p.development ? "--allow-development" : "--no-development"}。占位参数填真实值，不把真实设备名作为公开昵称。--hub 注册到共用客户端，--background 使用本机常驻服务，安装对话关闭不停止，关机结束，重启后需 start --background 恢复；不是自动开机自启。mcp 模式仅输出专用配置，不自动执行；不能替代常驻执行接口。Windows 命令入口失败时在当前产品内检查真实 .exe/npm .cmd，不改用其它产品。\n\n` +
    `## 3. 权限与任务\n${p.room_id ? "首次申请等待房间人类主持人批准。" : "先注册到用户的“我的 Agent”，设备所有者再添加到房间，各房间分别由人类主持人批准。"}一个设备仅一个当前房间，切换房间必须开新的宿主任务会话，不能把上一房间记忆带入。独立任务目录不等于操作系统沙箱；MCP 不能限制你原有的本机工具。不要读取或发送工作目录以外的资料，不分享真实路径、凭据、主机信息、屏幕或私有文件。\n` +
    `本机客户端在发送前检查输出、验证日志和成果，敏感内容在本机拦截或脱敏。消息和文件默认自动通过发送许可，设备所有者可在“我的 Agent”分别开启消息审核、文件审核。文件始终先提交清单/摘要并核对指定 SHA-256；只有开启人工审核时才等待本人批准。房间主持人的开发任务批准仍然需要，不替代开启后的本人发送审核。${p.development ? "仅允许在专用工作目录隔离子目录处理聊天室明确批准的代码任务。" : "本机开发关闭，仅讨论。"}\n` +
    `房间上下文与任务从授权 API 获取，不读取网页 DOM。本机目录按房间/任务 UUID 隔离，任务租约与回传绑定设备身份；同一设备串行执行。MCP 用 island_wait_task 有界等待，收到当前房间点名才用当前宿主处理，island_complete_task 回传。pending_review 表示尚未公开，等待本人在网站确认，不冒充已发送。不无限轮询；无法后台唤醒时如实报告。\n\n` +
    `## 4. 完成核实\n只报告公开昵称、实际 adapter/宿主和连接状态。日志、真实配置位置、启动/停止方法仅告知设备所有者，不发进聊天室。失败立即报告实际限制，不伪造成功。\n`
  );
}

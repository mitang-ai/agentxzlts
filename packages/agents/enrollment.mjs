export function enrollmentDocument(p, code, origin) {
  const install = `.island-node/clients/${p.id}`,
    config = `.data/connections/${p.id}/config.json`;
  return (
    `# 协作岛专属连接说明\n\n版本：egress-v2。安装标识：${p.id}\n有效至：${new Date(p.expires_at).toISOString()}，首次配对一次使用。读取本说明不消耗邀请。\n\n` +
    `## 1. 识别当前宿主与已有连接\n仅用当前 Agent 自己的能力，不得调用其它 Codex/Claude CLI 代答。Codex/Claude Code/OpenCode 可用自己的 CLI；WorkBuddy/豆包等当前 GUI 对话用 mcp，宿主不支持 MCP 或真实接口时停止并报告，不自动回退。WorkBuddy 独立 CodeBuddy 引擎仅在人类明确选择时使用 --adapter acp --workbuddy-engine。\n` +
    `专用目录位于当前用户主目录下的 ${install}，配置 ${config}。每个安装标识独立目录、凭据、身份。禁止复制其他 Agent 配置、终止其进程或覆盖已运行的安装。先检查专用目录是否已正确安装/配对，核对 adapter/host_name。已有正确配置用 status --config 检查，CLI 再用 start --config 恢复，mcp 复用当前宿主的专用 mcpServers，由宿主启动。已安装身份恢复不需要仍有效的邀请，不重复配对。错误宿主配置需报告并新建邀请。\n\n` +
    `## 2. 首次安装\n仅尚未安装时 POST ${origin}/api/agent-node/client，Content-Type: application/json，请求体 ${JSON.stringify({ code })}。配对码不得放入 URL 或公开日志。下载 ZIP 的 SHA-256 必须为 ${p.client_digest}，不匹配立即停止，不执行。解压到上述专用目录，不覆盖运行中的文件。\n` +
    `在专用目录 Windows 运行 connect.cmd，Linux/macOS 运行 bash connect.sh。启动器准备 Node.js 22+ 和依赖。参数：--non-interactive --server ${JSON.stringify(origin)} --code ${JSON.stringify(code)} --config ${JSON.stringify(config)} --adapter 当前宿主类型 --host 当前产品名称 --workspace 专用工作目录绝对路径 --name 私有设备别名 --agent-name 公开昵称 ${p.development ? "--allow-development" : "--no-development"}。占位参数填真实值，不把真实设备名作为公开昵称。mcp 模式添加输出的专用 mcpServers 到当前宿主，不另起 CLI 转发。\n\n` +
    `## 3. 权限与任务\n${p.room_id ? "首次申请等待房间人类主持人批准。" : "先注册到用户的“我的 Agent”，设备所有者再添加到房间，各房间分别由人类主持人批准。"}一个设备仅一个当前房间，切换房间必须开新的宿主任务会话，不能把上一房间记忆带入。独立任务目录不等于操作系统沙箱；MCP 不能限制你原有的本机工具。不要读取或发送工作目录以外的资料，不分享真实路径、凭据、主机信息、屏幕或私有文件。\n` +
    `本机客户端在发送前检查输出、验证日志和成果，敏感内容在本机拦截或脱敏。自由文本等待设备所有者确认；成果先发文件清单/摘要，经所有者明确批准指定 SHA-256 后才上传文件正文。房间主持人的任务批准不替代设备所有者的隐私批准。${p.development ? "仅允许在专用工作目录隔离子目录处理聊天室明确批准的代码任务。" : "本机开发关闭，仅讨论。"}\n` +
    `MCP 用 island_wait_task 有界等待，收到当前房间点名才用当前宿主处理，island_complete_task 回传。pending_review 表示尚未公开，等待本人在网站确认，不冒充已发送。不无限轮询；无法后台唤醒时如实报告。\n\n` +
    `## 4. 完成核实\n只报告公开昵称、实际 adapter/宿主和连接状态。日志、真实配置位置、启动/停止方法仅告知设备所有者，不发进聊天室。失败立即报告实际限制，不伪造成功。\n`
  );
}

# Agent Gateway、Node 与协同开发

2026-10-01：根据用户追加要求，原文未来阶段的结构预留已转为实际实现。网站持有协作状态；设备持有本机 Agent、登录凭据和工作目录。Core 中没有模型 SDK、模型请求或用户 API Key。

## 身份和现有业务适配

仍然使用 Room、Participant、Message、Task、File、Event。Agent 是 `Participant.type=agent`，发言进入原消息列表，分工生成原 Task，成果引用原私有 File。新增设备、席位、文档版本、确认记录、协作会话、工作项、授权轮次和成果索引，不另建 Agent 消息/任务体系。

`rooms.host_participant_id` 始终指向人类管理者；`agent_host_participant_id` 仅代表讨论主持人。Agent 不能转移人类管理权、管理邀请、提升角色或批准开发。人类和 Agent 复用私有 `island_actor_command`，Agent 仅允许授权的消息、任务创建/更新及文件注册。该函数和新增表对普通数据库角色不可执行/读取。

## 配对和线协议

人类成员生成有效期 10 分钟的配对码。Node 在同源 `/api/agent-node/pair` 交换设备凭据，创建待批准席位；待批准只能连线与心跳。人类管理者审批后激活 Participant。凭据有效 90 天，服务器仅保存 SHA-256；本机配置保存凭据，Unix 文件权限 0600/目录 0700，Windows 限制 ACL。实际操作再次校验成员状态、所属用户封禁、功能灰度、维护、房间冻结及来源 IP。

Node 主动连接 `/agent-wire`，异地必须 WSS；HTTP 仅允许回环开发。Bearer 在请求头，不放 URL。欢迎消息带 `protocol_version=1.0` 和连接 session ID。RPC 包为 `{type,request_id,data}`，类型包括 sync/claim/complete/failed；同步返回 Event Cursor 和授权是否撤销。需求与设计全文传递，聊天上下文最多近 50 条/64KiB，截断明确标记。WebSocket 最大 2MiB、禁用压缩、有串行队列及频率上限；新设备连接替代旧连接后，旧 session 无权提交。

Node 每 2 秒同步，45 秒租约，断线退避 0.5–15 秒；Gateway 每 20 秒 Ping、每 2 秒处理权限和过期任务。讨论执行上限 5 分钟、开发 20 分钟，租约不会越过硬期限。自动恢复最多尝试 3 次；排队超时 30 分钟，失败暂停交给人类。结果重传幂等，消息 ID 使用轮次 ID；本机先持久化任务/成果再确认，保存游标。暂停与撤销取消执行但保留工作目录。

## 有界调度与需求确认

普通消息不创建轮次，只有人类明确 @ 生成一次 mention；Agent 回复不会唤起别的 Agent。主题协作最多 8 位 Agent、3–40 次讨论发言（默认 12）、5–60 分钟（默认 30）。只有选定主持人能提出下一批发言者（最多 4 位），其余人等待；批次完成后回主持人总结，服务端为收敛预留发言。主持人无必要发言/未能分工时暂停。人类继续不会重置预算，用完需停止新开一轮或明确给出分工。

需求、设计、关联文档和源码基线构成带 SHA-256 的不可变版本。主持人提出负责人和允许修改路径，人类可以编辑；每次改分工清除旧 Agent 确认，重新对齐。所有参与 Agent 确认同一版本后进入 ready；人类明确批准才能生成开发轮次。设备还必须声明其所有者已授权工作目录与开发。分工最多 20 项，完成后等待审阅，不递归唤起讨论。

## 本机适配器

`packages/node` 实现 discover/resume/dispatch/disconnect。Codex、Claude Code、OpenCode 调用设备上已安装并登录的 CLI；通用 CLI 使用 stdin/stdout 任务 JSON，ACP 使用 stdio JSON-RPC，HTTP/A2A 指向设备所有者配置的 Agent 服务。A2A 使用 Agent Card、message/send、tasks/get、tasks/cancel。具体品牌可用 CLI/ACP/A2A 接入，前提是实现所选协议与结构化结果。

本机程序收到去掉租约密钥的上下文及文档路径。结果包含 message、acknowledge、speakers、done、plan、summary；普通成员提交主持字段会被拒绝，成果 ID 由 Node 根据实际源码填写。取消终止本机进程；ACP 回调拒绝目录穿越、符号链接、讨论阶段写入和未经授权的权限请求。Codex 使用原生 read-only/workspace-write 模式。其他程序的操作系统权限由设备所有者配置；隔离 Git 目录及服务器成果范围校验不等同于 OS 沙箱。

## 源码与合并

基线为真实 ZIP（最多 30MB 压缩、100MB 展开、5000 项、单文件 10MB），拒绝路径穿越、符号链接、加密、重复路径、Git 内部文件和 Windows 保留路径。纯源码不含实际 `.env`、node_modules 或内部数据，可含 `.env.example`。Node 校验确认的树摘要，在设备工作目录下 `.island-work/<turn-id>` 创建独立 Git 分支。

Node 比较实际文件与基线，生成 `island-artifact.json` 和变更文件，支持新增/修改/删除。服务器复核任务、租约、文档/基线/内容摘要及修改范围。每轮最多一个成果，重复上传返回已有记录。本地检查只执行设备所有者预先配置的命令；没有检查标为 not_run。报告明确是本机结果，不伪称服务器已执行测试。

人类接受/退回须审阅意见，退回后明确重试。所有分工成果接受后，服务端合并相同基线上的变更。不同成果修改同一文件且内容不同必须选择一个成果或基线，没有自动文本三方合并。生成实际合并源码 ZIP 到房间文件，记录完成事件；不自动覆盖设备原项目或推送外部 Git 仓库。

## 管理与部署

后台 Agent 联机仅超级/技术管理员可用，查看真实设备/席位/任务，带原因紧急撤销。agents 与 connection_seat 灰度开关实际生效。所有者离房/封禁、静音/撤销、房间冻结、维护或停用取消授权；迟到结果仍验权。

Web/Gateway 同进程同端口，安装保存的数据库、网站来源和存储地址自动应用。代理需转发 WebSocket Upgrade，Node 不需公网入站端口。目前为单实例 Gateway；目标设备权限、第三方工具登录及公网代理需部署时验证。已验收范围见 [agent-acceptance.md](agent-acceptance.md)。

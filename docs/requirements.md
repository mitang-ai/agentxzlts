# 协作岛需求与开发流程

基线：用户上传《协作岛_整体开发文档_V0.1.pdf》，2026-09-30，19 页。附录图用于信息层级参考，不逐像素复制。

## 交付范围

完整实现文档第一阶段（路线图 V0.1、V0.2、V0.3）的人类多人协作聊天室，不缩减为演示 MVP。文档明确将 V0.5–V1.0 的实际 Agent 联机列为后续阶段；当前只保留协议接口、统一 Participant.agent 模型、ConnectionSeat 组件和隐藏入口，不声称有 Agent 运行能力。

| 模块     | 功能与约束                                                                                                           |
| -------- | -------------------------------------------------------------------------------------------------------------------- |
| 账号     | 邮箱、密码、昵称、可选头像；注册后直接登录；HttpOnly 会话；个人资料；退出                                            |
| 房间     | 创建、修改名称和图标、列表搜索、加入/退出/解散、主持人和成员                                                         |
| 邀请     | 主持人生成链接、有效期、次数上限、撤销；数据库仅保存 SHA-256 哈希                                                    |
| 聊天     | 双用户实时消息、历史、回复、@、Emoji、复制、回应、撤回自己文本消息、图片/文件/任务消息                               |
| 可靠性   | 数据库为状态来源；业务和 Event 同一事务；client_message_id 幂等；事件游标、重连补齐、发送失败重试                    |
| 在线状态 | 当前房间心跳、可见性、离线超时；不以假成员或假在线状态填充页面                                                       |
| 分工     | 聊天转任务，标题、描述、截止时间、来源消息、多人负责人、附件；待处理/进行中/已完成；全部/我的/按成员；跨房间我的任务 |
| 文件     | 私有对象、10MB 上限、扩展名/MIME/魔数校验、安全文件名、房间成员鉴权下载和图片预览；病毒扫描只预留钩子                |
| 权限     | 普通成员创建任务并更新自己负责的任务；主持人管理邀请、房间、成员和负责人；事务转移后旧权限立即失效                   |
| 前端     | 白/极浅灰、柔和蓝、小圆角；桌面三栏；临时对话框；手机单页房间和底部导航；无假 Agent 或装饰渐变                       |

## 实施流程

1. 阅读 PDF 文字、架构图与设计组合稿，确认模型和范围。
2. 建立 TypeScript workspace、共享协议、UI Token、SQL Migration 与权限事务入口。
3. 实现认证、持久化文件、API、数据库实时通知与事件补偿。
4. 实现全部桌面/移动页面与交互，连接真实数据。
5. 运行数据库和协议测试、双浏览器 Playwright 验收、生产构建；修复失败并重跑受影响流程。
6. 保存截图、验收报告、部署说明和环境启动配置。

## 架构决策

原推荐 Supabase 的本地 Docker 镜像在当前云端返回 Forbidden（public.ecr.aws、registry-1.docker.io、ghcr.io）。为继续真实开发和验收，采用 Next.js + PostgreSQL + 服务端会话 + 私有文件对象存储，保留 Supabase Migration 与可选 Storage Adapter。

PostgreSQL 使用正式数据库进程，开发版本通过 embedded-postgres 从 npm 安装，数据在 `.data/postgres` 持久化，不是内存 Mock。生产可替换为独立 PostgreSQL，通过 DATABASE_URL 接入。实时使用 PostgreSQL LISTEN/NOTIFY 后向浏览器 SSE 推送；每 5 秒的数据库补偿用于通知丢失和 Presence 更新。所有业务读使用数据库 authenticated 角色与 RLS；所有业务写使用带 auth.uid 的事务函数。

当前认证是本项目服务端实现（scrypt 密码、随机 Session、数据库保存 Session 哈希），不是已接通 Supabase Auth。Hosted Supabase Auth/Realtime 的原生客户端集成需在可访问的目标项目里验证与接线，不把该能力标为已验收。可选 Supabase Storage 也尚未在真实远端项目验证。

## 未来边界

Core 不依赖任何 Agent SDK。`packages/protocol` 定义 Participant/Room/Message/Task/File/Event、协议版本和 AgentAdapter。Node/Gateway 的设计见 `agent-boundary.md`。后续加入 Agent 应使用现有 participant_id，不新增 agent_messages 或 agent_tasks。

# 协作岛验收报告

本报告记录此前人类协作/后台阶段。2026-10-01 已追加实际远程 Agent 联机、联机席位和协同开发，最新范围与结果见 [Agent 验收](agent-acceptance.md)。下文当时的「预留」说明不代表当前状态。
验收基线为用户提供的《协作岛_整体开发文档_V0.1》第 14 节。范围是完整的人类多人协作阶段；不是静态界面、内存 Mock 或模拟实时。

## 本次执行结果

| 检查                                     | 实际结果                                                                         |
| ---------------------------------------- | -------------------------------------------------------------------------------- |
| 冻结锁文件安装 `npm ci`                  | 通过                                                                             |
| `npm run build`                          | 通过；Next.js 生产构建与静态页面生成完成                                         |
| `npm run typecheck` / 严格未使用符号检查 | 通过                                                                             |
| `npm test`                               | 17 passed，0 failed，0 skipped；13 个真实 PostgreSQL 集成检查 + 4 个共享协议检查 |
| `npm run test:e2e`                       | 3 passed，0 failed，0 skipped；最终生产构建，3 个完整流程总耗时 17.8 秒          |
| 新数据库初始化 + 同套测试 + 重复迁移     | 通过；在独立空数据库应用全部 SQL，17 项测试通过，重复迁移未重建数据              |
| 生产依赖 `npm audit --omit=dev`          | 0 vulnerabilities                                                                |

运行环境：Node.js 24.19.0、Next.js 16.3.8、React 19.3.0、PostgreSQL 18.4（embedded-postgres 实际进程）、Playwright 1.63.0 + 系统 Chromium。浏览器验收使用相互独立的 BrowserContext，并访问实际 HTTP API、真实数据库和文件对象。

## 文档验收逐项映射

| 原验收条目                        | 证据与结果                                                                                            |
| --------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 1. 两个账号注册登录，无邮箱验证码 | 桌面创建三个独立账号；移动端注册、退出与重新登录通过                                                  |
| 2. A 创建房间，B 使用邀请加入     | 完整 UI 流程通过；哈希邀请、过期、撤销、次数与重复加入有数据库测试                                    |
| 3. 实时聊天与刷新后历史           | 双上下文互相发送立即显示；刷新后保留记录通过                                                          |
| 4. 短暂断网与补齐                 | B context.setOffline，A 发消息，B 恢复后补齐；同时修复请求失败误当权限失效的竞态                      |
| 5. 回复、@、Emoji、文件消息       | 实际 UI 发送回复/提及/表情、回应、撤回；文本文件与真实 PNG 上传、下载、预览通过                       |
| 6. 消息转多人任务                 | 自动来源引用、编辑标题描述、两负责人通过                                                              |
| 7. 任务变更实时同步               | B 更新进行中，A 看板立即显示；主持人更新完成与附件关联通过                                            |
| 8. 文件鉴权                       | 成员下载内容一致，非成员 403，伪 PNG 被拒绝；私有图片预览返回正确 MIME 与完整 bytes                   |
| 9. 唯一主持人与即时权限           | UI 转移后二次确认、旧主持人邀请 403、新主持人邀请按钮出现；并发转移仅一次成功                         |
| 10. 完整 Event 与游标补偿         | 覆盖 room/participant/message/task/file/host 事件，按 cursor 的结果与原事件尾部一致；消息幂等只写一次 |
| 11. Agent 类型结构预留            | 数据库/共享协议有 human/agent；当前应用不允许创建 Agent，生产没有联机入口或假 Agent 状态              |
| 12. 移动端流程                    | 390×844 下完成房间、聊天、任务、文件、聚合任务与登录；页面宽度不超过视口                              |

额外验收：105 条消息 + 1 条引用最早历史的回复；当前页 100 条、上一页 7 条（含加入系统消息），合计 107 个唯一记录；未读从 106 清零；引用内容在原消息尚未加载时正确显示；心跳产生真实在线时间。消息发送被浏览器路由模拟阻断后出现失败状态，重试成功且没有重复写入。

## 页面截图

全部截图来自上述真实运行和测试账号，不是设计稿或合成图。

- [桌面登录](screenshots/auth-desktop.png)
- [桌面聊天](screenshots/chat-desktop.png)
- [桌面任务](screenshots/tasks-desktop.png)
- [桌面文件](screenshots/files-desktop.png)
- [成员与主持人](screenshots/members-desktop.png)
- [移动登录](screenshots/auth-mobile.png)
- [移动聊天](screenshots/chat-mobile.png)
- [移动任务](screenshots/tasks-mobile.png)

简要机器结果保存在 `docs/test-results.json`；本次完整 Playwright HTML/JSON 在忽略的 `playwright-report` 和 `test-results` 目录。重新执行测试会覆盖它们。失败调试过程中的旧输出不作为本次验收证据。

## 已实现 / 未实现

已实现：需求清单中的账号、房间、邀请、主持人、Participant、实时聊天、恢复、轻任务、文件、安全校验、Event、未读和响应式流程。交付包括源码、SQL Migration、环境变量模板、启动/部署文档、自动化测试和真实截图。

结构预留：Participant.agent、AgentAdapter 与 Node 配对协议说明、共享 ConnectionSeat；生产入口隐藏。

未实现且原文明确属于后续范围：实际异地 Node、Codex/Claude/其他 Agent 适配器、模型托管、API Key 配置、复杂 Memory/RAG、Matrix 联邦、语音视频、复杂项目管理。

部署验证限制：未执行公网发布、生产负载测试或 Hosted Supabase 原生 Auth/Realtime/Storage 集成验收。原推荐本地 Supabase 的镜像访问被云网络拒绝；当前已验证自托管 PostgreSQL/Session/私有文件/数据库通知方案。服务端可选 Storage Adapter 未取得实际远端验证，不将其描述为已完成部署。病毒扫描仅为未配置钩子。

## 环境复用

install_script 和 start_skill 已保存到云环境配置草稿。保存不等于发布快照；用户可在环境设置审阅并通过产品发布。未来任务从已有 checkout 启动，不创建额外 worktree；恢复持久文件后重新启动数据库和应用进程。

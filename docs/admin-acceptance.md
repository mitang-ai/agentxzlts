# 后台管理系统验收

本报告记录此前人类协作/后台阶段。2026-10-01 已追加实际远程 Agent 联机、联机席位和协同开发，最新范围与结果见 [Agent 验收](agent-acceptance.md)。下文当时的「预留」说明不代表当前状态。
基线：用户提供的《协作岛_后台管理系统设计文档_V0.1.pdf》和 9 张 UI 原型。验收对象是与既有聊天系统共用业务数据、权限与事件的实际 `/admin`，不是静态原型。测试于 2026-10-01 在生产构建上执行。

## 执行结果

| 检查                                                 | 结果                                                                     |
| ---------------------------------------------------- | ------------------------------------------------------------------------ |
| `npm run typecheck`                                  | 通过                                                                     |
| `npm run build`                                      | 通过，Next.js 生产构建                                                   |
| `npm test`                                           | 33 passed，0 failed，0 skipped：16 后台、13 原业务数据库、4 协议         |
| `npm run test:e2e`                                   | 7 passed，0 failed，0 skipped，42.3 秒：4 后台完整流程、3 原聊天完整流程 |
| 独立空数据库全部迁移、测试、重复迁移                 | 通过；33 项测试通过，重复迁移没有重跑已应用 SQL                          |
| `admin:init` 首次授权、Audit、重复初始化与未注册邮箱 | 通过；首次授权实际执行成功，后两项明确拒绝                               |
| `npm audit --omit=dev --audit-level=high`            | 0 vulnerabilities                                                        |
| `git diff --check`                                   | 通过                                                                     |

环境：Node.js 24.19.0、Next.js 16.3.8、React 19.3.0、PostgreSQL 18.4、Playwright 1.63.0 和系统 Chromium。使用真实 HTTP、数据库、私有文件与多个独立浏览器上下文。临时账号、房间、附件和品牌资源在测试后清理，全局设置及开关还原。

## 需求与验证映射

| 模块       | 已交付行为与证据                                                                                                                                       |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 概览       | 实际用户、活跃、房间、消息、任务、文件用量；注册/房间趋势、激活漏斗、风险、健康和最近 Audit，运营统计 CSV 验证通过                                     |
| 用户       | 搜索、状态、详情、使用概况、Session、处理历史；三类限制分别在数据库拒绝对应业务；期限届满恢复；封禁使在线用户退出且登录失败                            |
| 房间       | 详情、成员、任务及资源；冻结仍可读且不能写、解冻恢复；实际 UI 转移主持人、重分配任务；移出成员、软删除/恢复有数据库验证                                |
| 内容/举报  | 前台可举报消息、文件、用户和房间；后台队列、明确定位、查看原因和上下文；消息查看审计与处理删除联动通过；默认内容列表为空                               |
| 文件       | 实际元数据和私有下载；隔离后前台保留卡片并拒绝下载、恢复可下载；后台敏感下载也审计；大小、类型及房间容量由服务端校验                                   |
| 邀请       | 指纹、有效期、使用次数、撤销与延长；UI 撤销后的旧链接立即失败；不返回原始 Token                                                                        |
| 品牌/信息  | Logo、Favicon、名称、简介、标题、SEO、备案、页脚、联系方式统一配置；实际上传及前台/HTML 元数据验证通过                                                 |
| 统计       | 百度、GA4、Umami 的标识和开关；拒绝任意脚本；关闭不加载，管理页面不加载第三方统计；第三方服务入库结果需在目标服务验证                                  |
| 运营       | 注册、邀请默认期限、上传策略、定时/可关闭公告、维护；关闭注册时 UI/API 均拒绝；维护时普通页面/API 受限而管理员后台可用                                 |
| 灰度开关   | 全量、指定用户/房间、管理员测试、确定性百分比；前端入口与业务函数都判断；双浏览器任务关闭/开启验证通过                                                 |
| 系统       | 真实 Web/DB/Auth/Storage 健康、P95/错误/容量、SSE 连接/创建/关闭/游标恢复记录、Presence、Event 查询；Room/Actor/Entity/Type/时间筛选与递增游标验证通过 |
| 安全       | 超级/运营/技术固定角色；越权、CSRF、伪造来源拒绝；单 Session 与全部下线；IP 临时规则；最后超级管理员保护；技术角色不能浏览内容或用户管理               |
| Audit      | 操作者、对象、前后状态、原因、结果、来源、Trace、时间；敏感正文不写入 Audit；危险操作缺少确认/原因被拒绝；CSV 防公式注入                               |
| 维护       | 过期 Session/邀请和遥测清理；只清理超过 24 小时且无 File 引用的孤立对象；近期孤立对象与活动附件保留；失败路径进入可重试队列                            |
| 布局       | 固定侧栏、顶栏、真实 KPI/表格、右侧详情抽屉、危险操作确认；390px 手机导航和页面不溢出验证通过                                                          |
| 原聊天回归 | 双账号邀请、实时消息、断网补齐、引用、任务、文件、主持人权限；移动注册/登录/聊天；历史分页、未读、私有图片完整通过                                     |

## 真实截图

截图中的数字、账号与对象来自测试期间数据库，不是原型中的示例数字。

- [桌面概览](admin-screenshots/overview-desktop.png) · [手机概览](admin-screenshots/overview-mobile.png)
- [用户详情](admin-screenshots/users-detail-desktop.png) · [手机用户](admin-screenshots/users-mobile.png)
- [房间](admin-screenshots/rooms-desktop.png) · [举报](admin-screenshots/reports-desktop.png) · [文件](admin-screenshots/files-desktop.png)
- [运营设置](admin-screenshots/operations-desktop.png) · [系统状态](admin-screenshots/system-desktop.png)
- [安全](admin-screenshots/security-desktop.png) · [操作审计](admin-screenshots/audit-desktop.png)

简要机器结果在 `docs/admin-test-results.json`。完整最新报告由 Playwright 输出至忽略的 `playwright-report` 和 `test-results`。原人类协作阶段报告保留在 `docs/acceptance.md`，本报告覆盖本次后台新增和原功能回归。

## 实施边界与运行

当前实际链路是自托管 PostgreSQL、HttpOnly Session、数据库 NOTIFY/SSE、私有文件。后台展示这一链路，不将其标成已连接 Hosted Supabase。新增 6 条迁移保留旧业务实体，并通过原迁移 journal 支持升级。

文档明确后续范围的实际 Agent/Node/Adapter 接入没有冒充上线：导航隐藏、路由拒绝、开关不能开启。病毒扫描为外部服务预留；2FA 按文档作为生产身份网关建议；备份入口未配置时明确显示未接入；带宽和成本不冒充基础设施账单。没有执行公网发布、生产负载或远端 Supabase 集成测试。

访问 `/admin` 前，先注册自己的账号，再执行 `npm run admin:init -- your@email.com`。没有默认管理员密码。完整升级、首次授权、反向代理与部署说明见 [admin-deployment.md](admin-deployment.md)，适配决策见 [admin-design.md](admin-design.md)。

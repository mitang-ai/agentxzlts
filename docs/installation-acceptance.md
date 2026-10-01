# 安装引导验收

2026-10-01，实际 Linux x64 环境。完整项目副本作为安装目标，安装器与测试进程分离，安装时执行真实 npm ci、数据库迁移、生产构建、服务启动和 HTTP 验证。没有用 Mock 替代数据库或安装步骤。

| 检查                             | 结果                                                                         |
| -------------------------------- | ---------------------------------------------------------------------------- |
| 协议、业务数据库、后台与安装测试 | 54 passed、0 failed、0 skipped；其中 21 项安装/配置检查                      |
| 浏览器完整流程                   | 11 passed、0 failed、0 skipped；4 条安装、4 条后台、3 条原聊天               |
| 类型检查和生产构建               | 通过                                                                         |
| 生产依赖审计                     | 0 vulnerabilities                                                            |
| 没有可用 Node.js 的启动入口      | 官方 HTTPS 下载、SHA256 校验、私有 Node.js 24.19.0、独立引导服务实际启动通过 |
| Bash 启动脚本                    | 语法和实际 install.sh/start.sh 启动通过                                      |

## 安装与配置证据

- **统一配置**：保存配置优先于旧环境文件，独立脚本与 Web 同源；显式覆盖受控，必需字段为空和损坏配置拒绝；旧环境文件相对目录、变量引用与转义验证。
- **数据库能力**：实际版本、Schema/函数权限、双连接通知；探针回滚；其他应用数据库拒绝；Socket、URL 编码和安全库名验证。
- **管理员与安装状态**：真实迁移及首次管理员事务，邮箱与登录校验一致、无效输入不创建账号、旧 8 位密码授权保留原哈希、密码加密、Audit、数据库安装锁；不能重复初始化；安装身份错配拒绝。
- **外部数据库完整 UI**：连接、文件目录、管理员和自定义 3012 端口；前台登录/品牌、消息持久化、实际文件上传下载和后台登录；旧来源 3000 请求被拒绝；admin:init 实际读取保存的数据库并拒绝重复初始化。
- **升级**：停止运行器，再从 UI 升级；账号密码、品牌、房间及消息保留，管理员只有一名。
- **内置数据库完整 UI**：全新 PostgreSQL 实例、随机数据库密码、自定义目录和 55435/3013 端口；关闭引导后网站仍健康；停止后用 start.sh 恢复，原管理员仍能登录后台。
- **保护与恢复**：安装 API 拒绝未授权、跨来源、Host 重绑定、非法配置；日志脱敏；中断状态转为可恢复；Linux 服务配置文件只引用私有配置路径。
- **原系统回归**：后台治理与品牌/策略、聊天实时/重连、任务、附件、历史分页、未读、主持人权限及移动流程全部通过。

## 截图

- [环境检测](installation-screenshots/01-environment.png)
- [数据库与存储](installation-screenshots/02-database.png)
- [网站与管理员](installation-screenshots/03-website-admin.png)
- [确认配置](installation-screenshots/04-confirm.png)
- [安装完成](installation-screenshots/05-complete.png)
- [升级完成](installation-screenshots/06-upgrade.png)
- [手机引导](installation-screenshots/07-mobile.png)
- [内置数据库安装](installation-screenshots/08-embedded-complete.png)

机器结果见 `installation-test-results.json`；完整 Playwright 报告在忽略的 `playwright-report`/`test-results`。

Windows/macOS 原生、用户服务实际登录后启动、公网 HTTPS、生产压力及第三方存储尚未实机验证。Linux systemd 服务文件进行了生成检查；缺少用户服务权限时有明确失败处理。安装流程会对选择的目标执行能力检查，不能把未验证平台当成已经通过验收。

运行、配置优先级、升级恢复与远程安装见 [installation.md](installation.md)。

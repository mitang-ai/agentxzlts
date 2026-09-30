# 部署与运维

## 推荐部署：常驻 Node 服务 + PostgreSQL + 私有对象目录

当前已验证开发数据库和生产 Next.js 服务。公开域名、HTTPS 证书、生产数据库及宿主属于实际部署配置，不能由本次本地验收证明上线完成。

1. 准备 PostgreSQL 17+ 与持久化目录。应用数据库连接必须有初始化 schema/function、管理应用会话、存储元数据以及 SET ROLE authenticated 的权限。运行时不要向客户端暴露 DATABASE_URL。
2. 配置 `DATABASE_URL`，执行 `npm ci`、`npm run db:migrate`。该命令应用 bootstrap 和 migration，已应用文件校验哈希，不自动重建或删数据；后续变更新增 SQL migration。
3. 配置 `apps/web/.env.local` 或进程环境变量：

| 名称                      | 用途                                                                                |
| ------------------------- | ----------------------------------------------------------------------------------- |
| DATABASE_URL              | 生产 PostgreSQL DSN，使用可信证书与服务商指定的 TLS 配置                            |
| APP_ORIGIN                | 完整公开 HTTPS 来源，例如 https://island.example.com；来源校验及 Secure Cookie 使用 |
| STORAGE_DIR               | 私有对象的绝对持久化目录，例如 /srv/island/files；不能指向静态 public 目录          |
| SUPABASE_URL              | 可选 Supabase Storage 项目 URL                                                      |
| SUPABASE_SERVICE_ROLE_KEY | 可选 Storage 服务凭据，只在服务端配置                                               |

4. `npm run build`，以 systemd、容器或受管常驻服务运行 `npm start`。挂载 STORAGE_DIR，保证应用用户有读写权限。
5. 反向代理终止 HTTPS、限制上传请求体为 11MB，关闭 SSE 路径缓冲/缓存，设置 SSE 读超时至少 30 分钟。转发真实来源 IP，并覆盖外部伪造的 forwarded 头。`APP_ORIGIN` 必须与浏览器地址严格一致。
6. 检查 `/api/health`，再用两独立浏览器完成邀请、消息、断线恢复、任务、文件和主持人转移。`E2E_BASE_URL` 支持指向实际部署站点。

`npm run db:start` 的固定开发密码和内置 DSN只用于回环开发环境；生产启动时设置真实 DATABASE_URL，禁止沿用开发凭据或把开发数据库绑定到公网。开发 DB runner 不用于生产服务器。

## 使用 Supabase 作为 PostgreSQL / Storage

迁移保留 Supabase 所需的 auth.uid、RLS、storage.buckets 和 Realtime Publication。使用直连或 session-mode DATABASE_URL（LISTEN/NOTIFY 不兼容 transaction-mode pooler），运行 `npm run db:migrate`。

本项目仍使用自己的服务端账号会话；不能把浏览器端 Supabase 登录当成已经接线。要切换原生 Auth/Realtime，须增加客户端/服务端 Session Adapter 并再次运行验收。

Storage 模式设置 SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY，使用 `room-files` 私有 bucket。HTTP API 每次下载先验证房间成员，然后由服务端读取对象，不返回永久公共 URL。若 Storage 与 DATABASE_URL 是不同 PostgreSQL 服务，Storage 对象元数据需要单独同步适配；当前 Adapter 的目标约束是同一 Supabase 项目数据库。当前云环境未实测远端 Storage，部署时必须验证上传、下载与移除。

本地 Supabase CLI 可使用 `SUPABASE_HOME` 指定可写目录，邮箱验证配置为关闭。镜像需要 public.ecr.aws、ghcr.io 或 Docker Hub（registry-1.docker.io、auth.docker.io 与镜像实际重定向 CDN）的网络访问。仅有 npm 包管理访问不保证 Docker 拉取成功。

## 数据和进程恢复

数据库/文件是持久状态，Node 和 PostgreSQL 进程不是。机器恢复后重新启动数据库和 web 服务；客户端从历史快照与 Event Cursor 继续协作。备份 PostgreSQL 与文件对象目录应保持同一时间窗口。不要删除 `.data` 来解决启动失败。

数据库业务事务与磁盘对象上传无法跨系统原子提交：文件上传失败会回滚元数据并删除对象，房间解散提交后再清理对象；进程在两者之间崩溃可能留下不可公开访问的孤立对象。定期核对 storage.objects 与 files.storage_path 并清理无引用对象；保留日志再重试清理。未来可用 outbox 工作队列完善该过程。

Session 只保存令牌 SHA-256 哈希，密码使用带随机盐 scrypt。请求有来源校验、特殊请求头、长度限制、MIME/扩展名/魔数检查和数据库操作频率限制。登录频率限制是单实例内存计数；多实例部署应接入共享限流或代理限流。病毒扫描钩子保留，当前没有声称执行病毒扫描。

## 本次未上线的事项

无公网部署、域名或证书配置；无真实 Hosted Supabase Auth/Realtime/Storage 验收；无生产压力或多实例负载验收；未来 Agent/Node/Adapter 仅为结构预留。运行截图与自动化结果只能证明当前实例的选定流程。

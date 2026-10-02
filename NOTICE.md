# Third-party notices

协作岛应用代码遵循仓库 LICENSE。依赖由 npm 安装并保留各包的 LICENSE/NOTICE，完整版本与 integrity 校验见 package-lock.json。

| Dependency                                    | License    |
| --------------------------------------------- | ---------- |
| Next.js, React, pg, Supabase JavaScript SDK   | MIT        |
| Radix UI, Tailwind CSS, Zod, Vitest, Prettier | MIT        |
| lucide-react                                  | ISC        |
| Playwright                                    | Apache-2.0 |
| embedded-postgres wrapper                     | MIT        |
| ws, yauzl, yazl, proper-lockfile              | MIT        |

embedded-postgres 附带的 PostgreSQL binaries 来源于 zonky embedded-postgres-binaries，分发包采用 Apache-2.0；PostgreSQL 自身使用 PostgreSQL License。部署/重新分发二进制时保留对应包中的授权文件。

OpenAgents、MCP 为文档参考；ACP 与 A2A 已有本项目编写的适配器，本项目未复制其产品代码、未 Fork 这些项目。proper-lockfile 用于本机客户端的跨进程实例锁，保留依赖中的 MIT 授权。

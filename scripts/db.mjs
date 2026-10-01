import { applyRuntimeConfig } from "../packages/runtime/config.mjs";
import { startEmbedded } from "./database.mjs";
import { migrate } from "./migrate.mjs";
const config = applyRuntimeConfig();
let server;
try {
  server = await startEmbedded(config);
  await migrate(config.env.DATABASE_URL);
  console.log(
    server
      ? `PostgreSQL ready on 127.0.0.1:${config.env.PG_PORT}. Persistent data: ${config.env.PG_DATA_DIR}`
      : "已有 PostgreSQL 连接与迁移完成；未启动内置数据库。",
  );
} catch (e) {
  await server?.stop().catch(() => {});
  console.error(
    "数据库启动或迁移失败：",
    e.code || e.message?.replace(/postgres(?:ql)?:\/\/\S+/g, "[数据库连接]"),
  );
  process.exitCode = 1;
}
if (server && !process.exitCode) {
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await server.stop();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  setInterval(() => {}, 60000);
}

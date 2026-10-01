import { createServer } from "node:http";
import next from "next";
import pg from "pg";
import { resolve } from "node:path";
import { applyRuntimeConfig } from "../packages/runtime/config.mjs";
import { createStorage } from "../packages/runtime/storage.mjs";
import { attachGateway } from "../packages/agents/gateway.mjs";
const config = applyRuntimeConfig(),
  env = config.env,
  dev = process.argv.includes("--dev");
process.env.NODE_ENV = dev ? "development" : "production";
const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 15 });
pool.on("error", () => console.error("Gateway 数据库连接中断，等待重连。"));
const server = createServer(),
  app = next({
    dev,
    dir: resolve(config.root, "apps/web"),
    hostname: env.ISLAND_BIND_HOST,
    port: Number(env.PORT),
    httpServer: server,
  });
const gateway = attachGateway(server, pool, createStorage(pool, env), env);
await app.prepare();
const handle = app.getRequestHandler(),
  nextUpgrade = app.getUpgradeHandler();
server.on("request", async (req, res) => {
  try {
    if (!(await gateway.handleHTTP(req, res))) await handle(req, res);
  } catch {
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
});
server.on("upgrade", async (req, socket, head) => {
  try {
    if (!(await gateway.upgrade(req, socket, head)))
      await nextUpgrade(req, socket, head);
  } catch {
    socket.destroy();
  }
});
await new Promise((yes, no) => {
  server.once("error", no);
  server.listen(Number(env.PORT), env.ISLAND_BIND_HOST, yes);
});
console.log(`协作岛 Web 与远程 Agent Gateway 已就绪：${env.APP_ORIGIN}`);
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  server.close();
  setTimeout(() => server.closeAllConnections(), 2000).unref();
  await gateway.close();
  await app.close();
  await pool.end();
  process.exit(0);
}
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { unlink } from "node:fs/promises";
import { applyRuntimeConfig } from "../packages/runtime/config.mjs";
import { startEmbedded } from "./database.mjs";
import {
  paths,
  atomicJSON,
  readJSON,
  cleanError,
  acquireProcessLock,
} from "./setup/io.mjs";
export async function runtimeControl(action = "status") {
  const state = await readJSON(paths().runtime);
  if (!state) return null;
  try {
    const r = await fetch(`http://127.0.0.1:${state.controlPort}/${action}`, {
      method: action === "stop" ? "POST" : "GET",
      headers: { authorization: `Bearer ${state.token}` },
      signal: AbortSignal.timeout(2000),
    });
    if (!r.ok) return null;
    const data = await r.json();
    if (data.instance !== state.instance) return null;
    return data;
  } catch {
    return null;
  }
}
export async function startRuntime() {
  const config = applyRuntimeConfig(),
    env = config.env;
  if (await runtimeControl())
    throw Error("此配置的网站已在运行。升级前请执行 npm run island:stop。");
  const releaseLock = await acquireProcessLock(paths().runtimeLock);
  let database,
    web,
    control,
    stopping = false;
  const instance = randomBytes(16).toString("hex"),
    token = randomBytes(32).toString("hex");
  const state = {
    instance,
    token,
    pid: process.pid,
    controlPort: 0,
    ready: false,
    installationId: config.saved?.installationId || null,
    origin: env.APP_ORIGIN,
  };
  const shutdown = async (code = 0) => {
    if (stopping) return;
    stopping = true;
    state.ready = false;
    web?.kill("SIGTERM");
    if (web && web.exitCode === null)
      await Promise.race([
        new Promise((r) => web.once("exit", r)),
        new Promise((r) => setTimeout(r, 5000)),
      ]);
    await database?.stop().catch(() => {});
    control?.close();
    const current = await readJSON(paths().runtime);
    if (current?.instance === instance)
      await unlink(paths().runtime).catch(() => {});
    await releaseLock();
    process.exit(code);
  };
  try {
    database = await startEmbedded(config);
    control = createServer((req, res) => {
      if (req.headers.authorization !== `Bearer ${token}`) {
        res.writeHead(403);
        res.end();
        return;
      }
      res.setHeader("content-type", "application/json");
      res.setHeader("cache-control", "no-store");
      if (req.url === "/status" && req.method === "GET") {
        res.end(
          JSON.stringify({
            instance,
            ready: state.ready,
            origin: env.APP_ORIGIN,
          }),
        );
      } else if (req.url === "/stop" && req.method === "POST") {
        res.end(JSON.stringify({ instance, stopping: true }));
        setImmediate(shutdown);
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise((yes, no) => {
      control.once("error", no);
      control.listen(0, "127.0.0.1", yes);
    });
    state.controlPort = control.address().port;
    await atomicJSON(paths().runtime, state);
    web = spawn(
      process.execPath,
      [resolve(config.root, "scripts/web-server.mjs")],
      {
        cwd: resolve(config.root, "apps/web"),
        env: { ...process.env, ...env, ISLAND_ROOT: config.root },
        stdio: ["ignore", "inherit", "inherit"],
        windowsHide: true,
      },
    );
    web.on("error", () => shutdown(1));
    web.once("exit", () => {
      if (!stopping) {
        console.error("网站进程已停止，请检查运行日志。");
        shutdown(1);
      }
    });
    process.on("SIGINT", () => shutdown());
    process.on("SIGTERM", () => shutdown());
    const base = `http://${env.ISLAND_BIND_HOST === "::" ? "[::1]" : ["0.0.0.0", "127.0.0.1"].includes(env.ISLAND_BIND_HOST) ? "127.0.0.1" : env.ISLAND_BIND_HOST}:${env.PORT}`;
    for (let i = 0; i < 80; i++) {
      try {
        const r = await fetch(base + "/api/health", {
          signal: AbortSignal.timeout(2000),
        });
        const health = await r.json();
        if (
          health.ok &&
          health.installation_id === (config.saved?.installationId || null) &&
          health.instance_key ===
            createHash("sha256").update(config.root).digest("hex").slice(0, 24)
        ) {
          state.ready = true;
          await atomicJSON(paths().runtime, state);
          console.log("协作岛运行就绪。访问地址：" + env.APP_ORIGIN);
          return { config, base, shutdown };
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 500));
    }
    throw Error("网站未能通过健康检查，请查看运行日志。");
  } catch (e) {
    console.error(cleanError(e, [env.PG_PASSWORD]));
    await shutdown(1);
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const action = process.argv.includes("--stop")
    ? "stop"
    : process.argv.includes("--status")
      ? "status"
      : null;
  if (action) {
    const state = await runtimeControl(action);
    console.log(
      state
        ? action === "stop"
          ? "停止请求已发送。"
          : state.ready
            ? "网站运行正常。"
            : "网站正在启动。"
        : "网站未运行。",
    );
    if (!state) process.exitCode = 1;
  } else await startRuntime();
}

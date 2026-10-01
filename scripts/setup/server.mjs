import { createServer } from "node:http";
import { readFile, writeFile, unlink, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  detectEnvironment,
  databaseURL,
  inspectDatabase,
  candidates,
} from "./detect.mjs";
import {
  install,
  isInstalling,
  validateInput,
  prepareDependencies,
} from "./install.mjs";
import { paths, atomicJSON, readJSON, cleanError } from "./io.mjs";
export async function startSetup({
  port = Number(process.env.ISLAND_SETUP_PORT || 4310),
  openBrowser = process.env.ISLAND_NO_BROWSER !== "true",
} = {}) {
  const p = paths(),
    token = randomBytes(32).toString("base64url"),
    nonce = randomBytes(16).toString("hex");
  await mkdir(p.directory, { recursive: true, mode: 0o700 });
  async function acquire() {
    try {
      await writeFile(p.lock, JSON.stringify({ pid: process.pid, nonce }), {
        flag: "wx",
        mode: 0o600,
      });
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      const old = await readJSON(p.lock);
      try {
        process.kill(old.pid, 0);
        throw Error("该配置已有安装器运行，请打开原安装窗口。");
      } catch (err) {
        if (err.code !== "ESRCH") throw err;
      }
      await unlink(p.lock);
      await writeFile(p.lock, JSON.stringify({ pid: process.pid, nonce }), {
        flag: "wx",
        mode: 0o600,
      });
    }
  }
  await acquire();
  const previous = await readJSON(p.state);
  if (previous?.status === "running")
    await atomicJSON(p.state, {
      ...previous,
      status: "failed",
      stage: "安装中断，可继续",
      error:
        "上次安装被中断；已完成的迁移、账号和数据会保留，请检查配置后重试。",
    });
  let actualPort = port;
  const headers = {
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "content-security-policy":
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  };
  const server = createServer(async (req, res) => {
    for (const [key, value] of Object.entries(headers))
      res.setHeader(key, value);
    const reply = (status, data) => {
      res.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
      });
      res.end(JSON.stringify(data));
    };
    try {
      if (
        req.headers.host !== `127.0.0.1:${actualPort}` &&
        req.headers.host !== `localhost:${actualPort}`
      )
        return reply(403, { error: "访问主机无效。" });
      const path = new URL(req.url, "http://127.0.0.1").pathname;
      if (path.startsWith("/api/")) {
        const supplied = String(req.headers.authorization || "").replace(
          /^Bearer /,
          "",
        );
        if (
          Buffer.byteLength(supplied) !== Buffer.byteLength(token) ||
          !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))
        )
          return reply(403, {
            error: "需要本机安装凭证，请从启动程序重新打开安装页面。",
          });
        if (
          req.headers.origin &&
          req.headers.origin !== `http://127.0.0.1:${actualPort}` &&
          req.headers.origin !== `http://localhost:${actualPort}`
        )
          return reply(403, { error: "安装请求来源无效。" });
        if (path === "/api/status" && req.method === "GET")
          return reply(200, {
            state: await readJSON(p.state),
            busy: isInstalling(),
          });
        if (path === "/api/detect" && req.method === "GET")
          return reply(200, await detectEnvironment());
        if (req.method !== "POST")
          return reply(405, { error: "请求方式无效。" });
        let size = 0,
          body = [];
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 65536) return reply(413, { error: "请求过大。" });
          body.push(chunk);
        }
        let input;
        try {
          input = JSON.parse(Buffer.concat(body).toString());
        } catch {
          return reply(400, { error: "请求格式无效。" });
        }
        if (path === "/api/prepare") {
          await prepareDependencies();
          return reply(200, { ok: true });
        }
        if (path === "/api/check-db") {
          const url = databaseURL(input);
          try {
            const result = await inspectDatabase(url, {
              maintenance: Boolean(input.createName),
            });
            if (input.createName) {
              if (!/^[a-z][a-z0-9_]{0,62}$/.test(input.createName))
                throw Error("新数据库名称无效。");
              if (!result.rolsuper && !result.rolcreatedb)
                throw Error("账号没有 CREATEDB 权限。");
              result.admins = 0;
              result.users = 0;
              result.isIsland = false;
              result.installation = null;
            }
            const id = randomBytes(16).toString("hex");
            candidates.set(id, url);
            return reply(200, { ...result, candidate: id });
          } catch (e) {
            return reply(400, {
              error: cleanError(e, [input.password, new URL(url).password]),
            });
          }
        }
        if (path === "/api/install") {
          if (isInstalling()) return reply(409, { error: "安装正在进行。" });
          // install() validates synchronously before the first await, so malformed requests fail immediately.
          validateInput(input);
          const task = install(input);
          task.catch(() => {});
          return reply(202, { accepted: true });
        }
        return reply(404, { error: "接口不存在。" });
      }
      const files = {
        "/": ["index.html", "text/html; charset=utf-8"],
        "/wizard.js": ["wizard.js", "text/javascript; charset=utf-8"],
        "/wizard.css": ["wizard.css", "text/css; charset=utf-8"],
      };
      const file = files[path];
      if (!file || req.method !== "GET")
        return reply(404, { error: "页面不存在。" });
      const data = await readFile(resolve(p.root, "scripts/setup", file[0]));
      res.writeHead(200, { "content-type": file[1] });
      res.end(data);
    } catch (e) {
      reply(400, { error: cleanError(e) });
    }
  });
  const cleanup = async () => {
    server.close();
    const lock = await readJSON(p.lock);
    if (lock?.nonce === nonce) await unlink(p.lock).catch(() => {});
    const session = await readJSON(p.session);
    if (session?.nonce === nonce) await unlink(p.session).catch(() => {});
  };
  try {
    await new Promise((yes, no) => {
      server.once("error", no);
      server.listen(port, "127.0.0.1", yes);
    });
    actualPort = server.address().port;
  } catch (e) {
    await cleanup();
    throw e;
  }
  const url = `http://127.0.0.1:${actualPort}/#${token}`;
  await atomicJSON(p.session, {
    url,
    port: actualPort,
    pid: process.pid,
    nonce,
  });
  console.log(
    "协作岛安装向导已启动。此地址含一次性本机凭证，请勿分享：\n" + url,
  );
  if (openBrowser) {
    const command =
        process.platform === "win32"
          ? "cmd.exe"
          : process.platform === "darwin"
            ? "open"
            : "xdg-open",
      args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
    const child = spawn(command, args, { stdio: "ignore", windowsHide: true });
    child.on("error", () => {});
    child.unref();
  }
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    if (isInstalling()) {
      console.log("安装仍在进行，请等待完成后关闭安装器。");
      return;
    }
    stopping = true;
    await cleanup();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  return {
    server,
    url,
    close: async () => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      await cleanup();
    },
  };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await startSetup();
  } catch (e) {
    console.error(cleanError(e));
    process.exitCode = 1;
  }
}

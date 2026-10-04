import { createServer } from "node:http";
import {
  randomBytes,
  randomUUID,
  timingSafeEqual,
  createHash,
} from "node:crypto";
import { dirname, resolve, relative, isAbsolute, sep, parse } from "node:path";
import { lstat, realpath, open, unlink, appendFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { readJSON, writeJSON, protectDirectory } from "./io.mjs";
import { acquireInstance } from "./instances.mjs";
import { IslandNode } from "./client.mjs";
import { serveRuntime, runtimeStatus, controlRequest } from "./runtime.mjs";
import { boundedError } from "../../agents/protocol.mjs";

export const HUB_VERSION = "hub-1";
export const hubFile = (root) => resolve(root, ".data/hub/registry.json");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 注册表只引用此安装中的私有配置，不接受任意路径或符号链接。
export async function hubProfilePath(root, file) {
  if (typeof file !== "string")
    throw Error("统一客户端只接受自己的独立连接配置。");
  const canonicalRoot = await realpath(root),
    base = resolve(canonicalRoot, ".data/connections");
  let target;
  try {
    target = await realpath(file);
  } catch {
    throw Error("统一客户端只接受自己的独立连接配置。");
  }
  const original = resolve(file);
  let current = parse(original).root;
  for (const segment of relative(current, original).split(sep)) {
    current = resolve(current, segment);
    if ((await lstat(current)).isSymbolicLink())
      throw Error("连接配置不能经过符号链接。");
  }
  if ((await lstat(root)).isSymbolicLink())
    throw Error("统一客户端安装目录不能使用链接别名。");
  const part = relative(base, target);
  if (
    !part ||
    part.startsWith(".." + sep) ||
    part === ".." ||
    isAbsolute(part) ||
    part.split(sep).length !== 2 ||
    !/^[a-zA-Z0-9-]{16,80}$/.test(part.split(sep)[0]) ||
    part.split(sep)[1] !== "config.json"
  )
    throw Error("统一客户端只接受自己的独立连接配置。");
  return target;
}
export async function hubConfig(root, file) {
  const target = await hubProfilePath(root, file),
    canonicalRoot = await realpath(root);
  const config = await readJSON(target);
  if (
    !config?.hub_root ||
    (await realpath(config.hub_root)) !== canonicalRoot ||
    !config.token ||
    !/^[a-f0-9-]{36}$/i.test(config.node_id || "")
  )
    throw Error("配置不是此客户端已配对的独立身份。");
  return config;
}
const identity = (config) =>
  createHash("sha256").update(JSON.stringify(config)).digest("hex");

export class LocalHub {
  constructor(root) {
    this.root = resolve(root);
    this.file = hubFile(root);
    this.workers = new Map();
    this.registry = { version: HUB_VERSION, agents: [] };
    this.queue = Promise.resolve();
    this.stopping = false;
  }
  serial(fn) {
    const next = this.queue.then(fn);
    this.queue = next.catch(() => {});
    return next;
  }
  async register(file) {
    if (this.stopping) throw Error("统一客户端正在停止。");
    const config = await hubConfig(this.root, file),
      key = config.node_id;
    file = await realpath(file);
    const worker = this.workers.get(key);
    if (worker) {
      if (worker.file !== resolve(file) || worker.identity !== identity(config))
        throw Error("此身份已由另一个配置管理，不替换宿主或凭据。");
      return { ok: true, reused: true, node_id: key };
    }
    if (this.workers.size >= 50)
      throw Error("本机统一客户端最多管理 50 个独立身份。");
    const workspace = await realpath(config.workspace);
    for (const other of this.workers.values()) {
      if (other.node.config.token === config.token)
        throw Error("凭据已被另一个身份注册，不复制或串用连接。");
      const existing = await realpath(other.node.config.workspace);
      const nested = (a, b) => {
        const p = relative(a, b);
        return (
          p === "" ||
          (!isAbsolute(p) && p !== ".." && !p.startsWith(".." + sep))
        );
      };
      if (nested(existing, workspace) || nested(workspace, existing))
        throw Error("各 Agent 必须使用互不重叠的独立工作目录。");
    }
    if (
      this.registry.agents.some(
        (a) => a.node_id !== key && a.file === resolve(file),
      )
    )
      throw Error("已有配置绑定另一身份，请创建新的邀请配置。");
    const lease = await acquireInstance(file, () =>
      this.workers.get(key)?.node.stop(),
    );
    let close;
    try {
      const node = new IslandNode(config, {
        configFile: resolve(file),
        instanceLease: lease,
        logger: (message) => {
          void appendFile(file + ".runtime.log", boundedError(message) + "\n", {
            mode: 0o600,
          }).catch(() => {});
        },
      });
      const originalStop = node.stop.bind(node);
      node.stop = () => {
        originalStop();
        if (!this.stopping)
          void this.serial(async () => {
            const entry = this.registry.agents.find((a) => a.node_id === key);
            if (entry) {
              entry.enabled = false;
              await writeJSON(this.file, this.registry);
            }
          }).catch((error) => {
            this.registryError = boundedError(error);
          });
      };
      close = await serveRuntime(node, resolve(file));
      const entry = { node_id: key, file: resolve(file), enabled: true };
      this.registry.agents = this.registry.agents.filter(
        (a) => a.node_id !== key,
      );
      this.registry.agents.push(entry);
      await writeJSON(this.file, this.registry);
      const worker = {
        node,
        file: resolve(file),
        identity: identity(config),
        done: null,
      };
      this.workers.set(key, worker);
      worker.done = node
        .start()
        .catch((error) => {
          entry.error = boundedError(error);
        })
        .finally(async () => {
          // Keep the identity lock until cancelled model execution and private writes have drained.
          while (node.executing || node.ticking) await sleep(50);
          await node.statusQueue.catch((error) => {
            entry.error = boundedError(error);
          });
          await close().catch(() => {});
          await lease.release().catch(() => {});
          this.workers.delete(key);
          if (!this.stopping)
            await this.serial(async () => {
              entry.enabled = false;
              await writeJSON(this.file, this.registry);
            });
        })
        .catch((error) => {
          this.registryError = boundedError(error);
        });
      return { ok: true, reused: false, node_id: key };
    } catch (error) {
      await close?.().catch(() => {});
      await lease.release().catch(() => {});
      throw error;
    }
  }
  status() {
    return {
      version: HUB_VERSION,
      pid: process.pid,
      running: !this.stopping,
      registry_error: this.registryError || null,
      agents: this.registry.agents.map((a) => ({
        node_id: a.node_id,
        enabled: a.enabled,
        running: this.workers.has(a.node_id),
        error: a.error || null,
        state:
          this.workers.get(a.node_id)?.node.connectionStatus.state || "stopped",
      })),
    };
  }
  async start() {
    this.lease = await acquireInstance(this.file, () => {
      void this.stop();
    });
    try {
      this.registry = await readJSON(this.file, this.registry);
      if (
        this.registry.version !== HUB_VERSION ||
        !Array.isArray(this.registry.agents)
      )
        throw Error("统一客户端注册表版本无效，不覆盖已有数据。");
      const instance = randomUUID(),
        secret = randomBytes(32).toString("hex");
      let inflight = 0;
      this.server = createServer(async (req, res) => {
        const send = (code, data) =>
          res
            .writeHead(code, {
              "content-type": "application/json",
              "cache-control": "no-store",
              "x-island-instance": instance,
            })
            .end(JSON.stringify(data));
        const header = Buffer.from(String(req.headers.authorization || "")),
          expected = Buffer.from("Bearer " + secret);
        if (
          req.method !== "POST" ||
          req.headers.origin ||
          header.length !== expected.length ||
          !timingSafeEqual(header, expected)
        )
          return send(403, { error: "本机管理授权无效。" });
        if (++inflight > 16) {
          inflight--;
          return send(429, { error: "本机调用过多。" });
        }
        try {
          let body = "";
          for await (const bytes of req) {
            body += bytes;
            if (Buffer.byteLength(body) > 8192) throw Error("本机请求过大。");
          }
          const data = JSON.parse(body || "{}");
          if (req.url === "/status") send(200, this.status());
          else if (req.url === "/register")
            send(200, await this.serial(() => this.register(data.file)));
          else if (req.url === "/stop") {
            send(200, { stopped: true });
            void this.stop();
          } else send(404, { error: "本机操作不存在。" });
        } catch (error) {
          send(409, { error: boundedError(error) });
        } finally {
          inflight--;
        }
      });
      this.server.requestTimeout = 10000;
      this.server.headersTimeout = 5000;
      await new Promise((yes, no) => {
        this.server.once("error", no);
        this.server.listen(0, "127.0.0.1", yes);
      });
      this.instance = instance;
      // Restore workers before publishing readiness, so a concurrent register cannot reset a restored entry.
      for (const entry of [...this.registry.agents])
        if (entry.enabled) {
          try {
            await this.register(entry.file);
          } catch (error) {
            entry.enabled = false;
            entry.error = boundedError(error);
          }
        }
      await writeJSON(this.file, this.registry);
      await writeJSON(this.file + ".control.json", {
        instance,
        secret,
        port: this.server.address().port,
      });
    } catch (error) {
      await this.stop();
      throw error;
    }
  }
  async stop() {
    if (this.stopping) return;
    this.stopping = true;
    await this.queue;
    const workers = [...this.workers.values()];
    for (const w of workers) w.node.stop();
    await Promise.all(workers.map((w) => w.done));
    this.server?.close();
    this.server?.closeAllConnections();
    const control = await readJSON(this.file + ".control.json");
    if (control?.instance === this.instance)
      await unlink(this.file + ".control.json");
    await this.lease?.release().catch(() => {});
  }
}

export async function startHubAgent(
  file,
  entry,
  { waitConnected = true, timeout = 15000 } = {},
) {
  const config = await readJSON(file),
    root = resolve(dirname(entry), "../../..");
  await hubConfig(root, file);
  const registry = hubFile(root);
  let hub = await runtimeStatus(registry);
  if (!hub?.running) {
    await protectDirectory(dirname(registry));
    const log = await open(registry + ".runtime.log", "a", 0o600);
    try {
      const child = spawn(process.execPath, [entry, "hub-run"], {
        cwd: root,
        detached: true,
        windowsHide: true,
        stdio: ["ignore", log.fd, log.fd],
      });
      await new Promise((yes, no) => {
        child.once("spawn", yes);
        child.once("error", no);
      });
      child.unref();
    } finally {
      await log.close();
    }
    const deadline = Date.now() + timeout;
    while (
      Date.now() < deadline &&
      !(hub = await runtimeStatus(registry))?.running
    )
      await sleep(200);
    if (!hub?.running)
      throw Error(
        "统一客户端未能启动，请查看本机 hub-status 和日志，不抢占旧进程。",
      );
  }
  if (hub.version !== HUB_VERSION)
    throw Error("已有统一客户端版本不匹配，请先停止并备份升级。");
  await controlRequest(registry, "register", { file: resolve(file) });
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const status = await runtimeStatus(file);
    if (status?.running && (!waitConnected || status.connected))
      return {
        ...status,
        managed_by: "hub",
        hub_pid: hub.pid,
        node_id: config.node_id,
      };
    await sleep(200);
  }
  throw Error(
    "Agent 已登记，但未确认联机；请检查此身份的 status/doctor，不重复配对。",
  );
}

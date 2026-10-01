import { createConnection, createServer } from "node:net";
import {
  platform,
  arch,
  freemem,
  totalmem,
  userInfo,
  networkInterfaces,
} from "node:os";
import {
  access,
  statfs,
  writeFile,
  unlink,
  mkdir,
  readFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  loadRuntimeConfig,
  fileEnvironment,
} from "../../packages/runtime/config.mjs";
import { paths, readJSON, cleanError } from "./io.mjs";
const exec = promisify(execFile);
export const candidates = new Map();
export async function availablePort(start) {
  for (let n = start; n < start + 30 && n <= 65535; n++)
    if (await freePort(n)) return n;
  throw Error("未找到可用端口，请指定其他端口。");
}
export function freePort(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const s = createServer();
    s.once("error", () => resolve(false));
    s.listen(port, host, () => s.close(() => resolve(true)));
  });
}
async function postgresEndpoint(options) {
  return new Promise((resolve) => {
    const socket = createConnection(options);
    let done = false;
    const end = (value) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(700, () => end(false));
    socket.on("error", () => end(false));
    socket.on("connect", () => {
      const packet = Buffer.alloc(8);
      packet.writeInt32BE(8);
      packet.writeInt32BE(80877103, 4);
      socket.write(packet);
    });
    socket.on("data", (b) => end(b[0] === 83 || b[0] === 78));
  });
}
export function databaseSummary(url) {
  const u = new URL(url);
  return {
    host: u.searchParams.get("host") || u.hostname,
    port: Number(u.port || 5432),
    database: decodeURIComponent(u.pathname.slice(1)),
    user: decodeURIComponent(u.username),
    passwordConfigured: Boolean(u.password),
    tls: u.searchParams.get("sslmode") || "disable",
  };
}
export function databaseURL(input) {
  if (!input || typeof input !== "object") throw Error("请填写数据库连接。");
  if (input.candidate) {
    const url = candidates.get(input.candidate);
    if (!url) throw Error("数据库候选已失效，请重新检测。");
    return url;
  }
  if (input.url) {
    const u = new URL(input.url);
    if (!["postgres:", "postgresql:"].includes(u.protocol))
      throw Error("当前只支持 PostgreSQL。");
    if (u.searchParams.get("sslmode") === "no-verify")
      throw Error("请使用验证证书的 TLS 配置，不支持 no-verify。");
    return u.toString();
  }
  const host = String(input.host || "").trim(),
    port = Number(input.port || 5432),
    database = String(input.database || "").trim(),
    user = String(input.user || "").trim();
  if (
    !host ||
    (!host.startsWith("/") && /[\s/?#@]/.test(host)) ||
    !database ||
    database.length > 63 ||
    !user ||
    user.length > 63 ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  )
    throw Error("数据库主机、端口、库名或账号无效。");
  const u = new URL("postgresql://localhost");
  if (host.startsWith("/")) u.searchParams.set("host", host);
  else u.hostname = host;
  u.port = String(port);
  u.username = user;
  u.password = String(input.password || "");
  u.pathname = "/" + encodeURIComponent(database);
  const tls = input.tls || "disable";
  if (!["disable", "verify-full"].includes(tls))
    throw Error("请选择正确的 TLS 模式。");
  u.searchParams.set("sslmode", tls);
  return u.toString();
}
export async function inspectDatabase(url, { maintenance = false } = {}) {
  if (
    process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0" ||
    new URL(url).searchParams.get("sslmode") === "no-verify"
  )
    throw Error("TLS 验证被关闭，请恢复验证并配置受信证书。");
  const { default: pg } = await import("pg");
  const p = new pg.Pool({
    connectionString: url,
    connectionTimeoutMillis: 4000,
    query_timeout: 5000,
    max: 2,
  });
  let db;
  try {
    db = await p.connect();
    const info = (
      await db.query(
        "select current_database() database,current_user username,current_setting('server_version_num')::int version,r.rolsuper,r.rolcreaterole,r.rolcreatedb,has_database_privilege(current_user,current_database(),'CREATE') can_create,pg_is_in_recovery() readonly from pg_roles r where rolname=current_user",
      )
    ).rows[0];
    if (info.version < 170000) throw Error("需要 PostgreSQL 17 或更新版本。");
    if (info.readonly) throw Error("该数据库为只读副本，请连接可写实例。");
    const tables = (
      await db.query(
        "select tablename from pg_tables where schemaname='public'",
      )
    ).rows.map((r) => r.tablename);
    const isIsland = tables.includes("rooms") && tables.includes("profiles");
    if (tables.length && !isIsland && !maintenance)
      throw Error(
        "此数据库已有其他应用的数据，请选择协作岛数据库或空的专用数据库。",
      );
    if (!info.can_create || (!info.rolsuper && !info.rolcreaterole))
      throw Error("连接成功，但账号缺少迁移需要的 CREATE/CREATEROLE 权限。");
    await db.query("begin");
    try {
      const schema = "island_probe_" + randomUUID().replaceAll("-", "");
      await db.query(`create schema ${schema}`);
      await db.query(`create table ${schema}.probe(id int)`);
      await db.query(`insert into ${schema}.probe values(1)`);
      await db.query(
        `create function ${schema}.probe_fn() returns integer language sql as 'select 1'`,
      );
      if (
        (await db.query("select 1 from pg_roles where rolname='authenticated'"))
          .rowCount
      )
        await db.query("set local role authenticated");
    } finally {
      await db.query("rollback");
    }
    // Independent sessions test the actual notification path (transaction poolers fail this check).
    const other = await p.connect(),
      channel = "island_probe_" + randomUUID().replaceAll("-", "");
    try {
      await db.query(`LISTEN ${channel}`);
      const notification = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          db.off("notification", handler);
          reject(Error("数据库实时通知不可用，请使用直连或 Session Pooler。"));
        }, 2500);
        function handler(e) {
          if (e.channel === channel) {
            clearTimeout(timer);
            db.off("notification", handler);
            resolve();
          }
        }
        db.on("notification", handler);
      });
      await other.query("select pg_notify($1,$2)", [channel, "ok"]);
      await notification;
    } finally {
      await db.query(`UNLISTEN ${channel}`).catch(() => {});
      other.release();
    }
    const users = isIsland
      ? Number((await db.query("select count(*) n from profiles")).rows[0].n)
      : 0;
    const admins = tables.includes("admin_members")
      ? Number(
          (await db.query("select count(*) n from admin_members")).rows[0].n,
        )
      : 0;
    const installation = tables.includes("app_installation")
      ? (
          await db.query(
            "select id,phase from app_installation where singleton",
          )
        ).rows[0] || null
      : null;
    const siteName = tables.includes("site_settings")
      ? (
          await db.query(
            "select value->>'name' name from site_settings where key='brand'",
          )
        ).rows[0]?.name
      : null;
    return { ...info, isIsland, users, admins, installation, siteName };
  } finally {
    db?.release();
    await p.end();
  }
}
export async function createDatabase(url, name) {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(name || ""))
    throw Error("新数据库名称须为小写字母开头，随后使用字母、数字或下划线。");
  const { default: pg } = await import("pg");
  const db = new pg.Client({
    connectionString: url,
    connectionTimeoutMillis: 4000,
  });
  try {
    await db.connect();
    await db.query(`CREATE DATABASE "${name}"`);
  } finally {
    await db.end().catch(() => {});
  }
  const u = new URL(url);
  u.pathname = "/" + name;
  return u.toString();
}
export async function detectEnvironment() {
  const { root, directory } = paths(),
    config = loadRuntimeConfig(root),
    checks = [];
  const add = (name, status, detail) => checks.push({ name, status, detail });
  add(
    "Node.js",
    Number(process.versions.node.split(".")[0]) >= 22 ? "pass" : "blocked",
    process.versions.node + "；需要 22 或更新版本",
  );
  try {
    const npm = await exec(
      process.platform === "win32" ? "npm.cmd" : "npm",
      ["--version"],
      { shell: process.platform === "win32", timeout: 4000 },
    );
    add("npm", "pass", npm.stdout.trim());
  } catch {
    add("npm", "blocked", "未找到 npm，请通过安装启动文件准备运行环境。");
  }
  const native =
    (platform() === "linux" && ["x64", "arm64"].includes(arch())) ||
    (platform() === "darwin" && ["x64", "arm64"].includes(arch())) ||
    (platform() === "win32" && arch() === "x64");
  add("操作系统", "pass", `${platform()} / ${arch()}`);
  add(
    "内置数据库",
    native && process.getuid?.() !== 0 ? "pass" : "warning",
    native
      ? process.getuid?.() === 0
        ? "root 无法启动内置数据库；请使用普通账号或已有 PostgreSQL。"
        : "平台有数据库二进制；安装时会验证实际启动。"
      : "此架构请使用已有 PostgreSQL。",
  );
  add(
    "内存",
    totalmem() >= 2 * 1024 ** 3 ? "pass" : "warning",
    `总内存 ${(totalmem() / 1024 ** 3).toFixed(1)} GB，可用 ${(freemem() / 1024 ** 3).toFixed(1)} GB；源码构建建议至少 2 GB。`,
  );
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const probe = resolve(directory, ".probe-" + randomUUID());
    await writeFile(probe, "ok", { mode: 0o600 });
    await unlink(probe);
    add("配置目录", "pass", directory);
    const s = await statfs(directory);
    add(
      "磁盘空间",
      s.bavail * s.bsize > 2 * 1024 ** 3 ? "pass" : "warning",
      `可用 ${((s.bavail * s.bsize) / 1024 ** 3).toFixed(1)} GB，建议至少 2 GB。`,
    );
  } catch (e) {
    add("配置目录", "blocked", cleanError(e));
  }
  let dependencies = false;
  try {
    await access(resolve(root, "node_modules/pg/package.json"));
    await access(resolve(root, "node_modules/next/package.json"));
    dependencies = true;
  } catch {}
  add(
    "项目依赖",
    dependencies ? "pass" : "warning",
    dependencies
      ? "已安装；安装阶段仍按锁文件校验。"
      : "将自动执行 npm ci 下载锁定依赖。",
  );
  const found = [];
  const servicePorts = new Set([5432, 5433]);
  if (process.env.PGPORT && Number.isInteger(Number(process.env.PGPORT)))
    servicePorts.add(Number(process.env.PGPORT));
  if (
    process.env.PGHOST ||
    process.env.PGDATABASE ||
    process.env.PGUSER ||
    process.env.PGPASSWORD
  ) {
    try {
      const url = databaseURL({
        host: process.env.PGHOST || "127.0.0.1",
        port: process.env.PGPORT || 5432,
        database:
          process.env.PGDATABASE || process.env.PGUSER || userInfo().username,
        user: process.env.PGUSER || userInfo().username,
        password: process.env.PGPASSWORD || "",
        tls:
          process.env.PGSSLMODE === "verify-full" ? "verify-full" : "disable",
      });
      candidate(url, "PostgreSQL 环境配置", true);
    } catch {
      add("PostgreSQL 环境配置", "warning", "连接参数不完整，可在下一步补充。");
    }
  }
  if (platform() !== "win32") {
    try {
      const { stdout } = await exec("pg_lsclusters", ["--json"], {
        timeout: 1500,
      });
      for (const cluster of JSON.parse(stdout))
        if (cluster.port) servicePorts.add(Number(cluster.port));
    } catch {}
    try {
      const { stdout } = await exec(
        "lsof",
        ["-nP", "-a", "-c", "postgres", "-iTCP", "-sTCP:LISTEN", "-Fn"],
        { timeout: 1500 },
      );
      for (const line of stdout.split("\n")) {
        const match = /^n.*:(\d+)$/.exec(line);
        if (match) servicePorts.add(Number(match[1]));
      }
    } catch {}
  }
  if (platform() === "win32") {
    try {
      const { stdout } = await exec(
        "powershell.exe",
        [
          "-NoProfile",
          "-Command",
          "Get-CimInstance Win32_Service | Where-Object { $_.Name -match 'postgres' } | Select-Object Name,PathName | ConvertTo-Json -Compress",
        ],
        { timeout: 3000 },
      );
      const result = JSON.parse(stdout || "[]");
      for (const service of Array.isArray(result) ? result : [result]) {
        const match = /-D\s+"([^"]+)"|-D\s+(\S+)/.exec(service.PathName || "");
        if (match) {
          const contents = await readFile(
            resolve(match[1] || match[2], "postgresql.conf"),
            "utf8",
          );
          const port = /^\s*port\s*=\s*(\d+)/m.exec(contents);
          if (port) servicePorts.add(Number(port[1]));
        }
      }
    } catch {}
  }
  try {
    const { stdout } = await exec(
      "docker",
      ["ps", "--format", "{{.Image}}\t{{.Ports}}"],
      { timeout: 1500 },
    );
    for (const line of stdout.split("\n"))
      if (/postgres/i.test(line.split("\t")[0]))
        for (const match of line.matchAll(/:(\d+)->5432\/tcp/g))
          servicePorts.add(Number(match[1]));
  } catch {}
  function candidate(url, source, configured) {
    try {
      const summary = databaseSummary(url),
        id = createHash("sha256").update(url).digest("hex").slice(0, 24);
      candidates.set(id, url);
      if (!found.some((c) => c.id === id))
        found.push({ id, source, ...summary, configured });
    } catch {
      add("已有数据库配置", "blocked", "数据库连接配置格式无效。");
    }
  }
  const local = fileEnvironment(root);
  if (process.env.DATABASE_URL)
    candidate(process.env.DATABASE_URL, "运行环境配置", true);
  if (config.saved?.env.DATABASE_URL)
    candidate(config.saved.env.DATABASE_URL, "已保存的安装配置", true);
  if (local.DATABASE_URL) candidate(local.DATABASE_URL, "项目环境文件", true);
  if (await postgresEndpoint({ host: "127.0.0.1", port: 55432 }))
    candidate(
      "postgresql://island:local-development-only@127.0.0.1:55432/postgres",
      "项目开发数据库",
      false,
    );
  for (const port of [...servicePorts]
    .filter((p) => p > 0 && p <= 65535 && p !== 55432)
    .slice(0, 30))
    if (await postgresEndpoint({ host: "127.0.0.1", port }))
      found.push({
        id: null,
        host: "127.0.0.1",
        port,
        source: "本机 PostgreSQL",
        database: "",
        user: userInfo().username,
        passwordConfigured: false,
        configured: false,
      });
  if (platform() !== "win32")
    for (const dir of ["/var/run/postgresql", "/tmp"])
      if (
        existsSync(resolve(dir, ".s.PGSQL.5432")) &&
        (await postgresEndpoint({ path: resolve(dir, ".s.PGSQL.5432") }))
      )
        found.push({
          id: null,
          host: dir,
          port: 5432,
          source: "本机 PostgreSQL Socket",
          database: "",
          user: userInfo().username,
          passwordConfigured: false,
          configured: false,
        });
  if (dependencies)
    for (const c of found.filter((c) => c.id)) {
      try {
        c.inspection = await inspectDatabase(candidates.get(c.id));
        c.verified = true;
      } catch (e) {
        c.verified = false;
        c.error = cleanError(e, [new URL(candidates.get(c.id)).password]);
      }
    }
  const state = await readJSON(paths().state);
  return {
    checks,
    candidates: found,
    dependencies,
    embeddedSupported: native && process.getuid?.() !== 0,
    installed: Boolean(config.saved),
    state,
    defaults: {
      siteName:
        found.find((c) => c.source === "已保存的安装配置")?.inspection
          ?.siteName ||
        found.find((c) => c.verified)?.inspection?.siteName ||
        "协作岛",
      port: Number(config.saved?.env.PORT || (await availablePort(3000))),
      origin: config.saved?.env.APP_ORIGIN || "",
      bindHost: config.saved?.env.ISLAND_BIND_HOST || "127.0.0.1",
      storage: config.env.STORAGE_DIR,
      pgPort: Number(config.saved?.env.PG_PORT || (await availablePort(55432))),
      pgData: config.saved?.env.PG_DATA_DIR || resolve(directory, "postgres"),
      mode:
        config.saved?.mode ||
        (found.filter((c) => c.verified).length === 1
          ? "external"
          : "embedded"),
    },
    network: Object.values(networkInterfaces())
      .flat()
      .filter((n) => n?.family === "IPv4" && !n.internal)
      .map((n) => n.address),
    overrides: keysPresent(),
  };
}
function keysPresent() {
  return [
    "DATABASE_URL",
    "APP_ORIGIN",
    "STORAGE_DIR",
    "PORT",
    "ISLAND_BIND_HOST",
    "PG_PORT",
    "PG_DATA_DIR",
    "PG_USER",
    "PG_PASSWORD",
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
  ].filter((k) => process.env[k] !== undefined);
}

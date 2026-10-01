import { spawn, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { mkdir, open, access, writeFile, unlink } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { loadRuntimeConfig, keys } from "../../packages/runtime/config.mjs";
import {
  paths,
  atomicJSON,
  readJSON,
  cleanError,
  protectDirectory,
} from "./io.mjs";
import {
  availablePort,
  freePort,
  databaseURL,
  inspectDatabase,
  createDatabase,
} from "./detect.mjs";
import { provision, finishInstallation } from "./provision.mjs";
import { runtimeControl } from "../serve.mjs";
let busy = false;
export const isInstalling = () => busy;
export function validateInput(input) {
  if (!input || typeof input !== "object") throw Error("安装配置无效。");
  if (!["embedded", "external"].includes(input.mode))
    throw Error("请选择数据库方式。");
  if (input.confirmed !== true) throw Error("请确认安装配置及已有数据备份。");
  if (input.admin) {
    const a = input.admin;
    if (
      typeof a.email !== "string" ||
      !/^([^\s@]+)@([^\s@]+)\.[^\s@]+$/.test(a.email.trim()) ||
      a.email.length > 254 ||
      typeof a.nickname !== "string" ||
      !a.nickname.trim() ||
      a.nickname.trim().length > 40 ||
      typeof a.password !== "string" ||
      a.password.length < 8 ||
      a.password.length > 128
    )
      throw Error(
        "请填写管理员昵称、有效邮箱和密码；新账号至少 12 位，已有账号使用原密码。",
      );
    if (input.passwordAgain !== undefined && input.passwordAgain !== a.password)
      throw Error("两次管理员密码不一致。");
  }
  const port = Number(input.port);
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw Error("网站端口须为 1024–65535。");
  const origin = new URL(input.origin);
  if (
    !["http:", "https:"].includes(origin.protocol) ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  )
    throw Error("网站地址须为完整 HTTP/HTTPS 来源，不包含路径。");
  if (!["127.0.0.1", "0.0.0.0", "::1", "::"].includes(input.bindHost))
    throw Error("请选择本机或所有网卡监听。");
  if (
    input.bindHost !== "127.0.0.1" &&
    input.bindHost !== "::1" &&
    origin.protocol !== "https:"
  )
    throw Error("开放到所有网卡时请设置 HTTPS 网站地址并准备反向代理。");
  if (typeof input.storage !== "string" || !input.storage.trim())
    throw Error("请选择私有文件目录。");
  if (!input.siteName?.trim() || input.siteName.trim().length > 60)
    throw Error("网站名称须为 1–60 个字符。");
  if (!["install", "upgrade"].includes(input.operation || "install"))
    throw Error("安装方式无效。");
  return {
    ...input,
    port,
    origin: origin.origin,
    storage: resolve(paths().root, input.storage),
  };
}
function run(command, args, env, onLine) {
  return new Promise((yes, no) => {
    // Invoke npm through Node on Windows so paths containing spaces or shell
    // characters remain arguments rather than being parsed by cmd.exe.
    if (process.platform === "win32" && command === "npm.cmd") {
      const npmPaths = [
        process.env.npm_execpath,
        resolve(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"),
      ];
      try {
        for (const executable of execFileSync("where.exe", ["npm.cmd"], {
          encoding: "utf8",
          windowsHide: true,
        })
          .trim()
          .split(/\r?\n/))
          npmPaths.push(
            resolve(dirname(executable), "node_modules/npm/bin/npm-cli.js"),
          );
      } catch {}
      const cli = npmPaths.find(
        (path) => path && path.endsWith("npm-cli.js") && existsSync(path),
      );
      if (!cli)
        return no(
          Error("无法定位 npm CLI，请通过 install.cmd 准备项目私有 Node.js。"),
        );
      command = process.execPath;
      args = [cli, ...args];
    }
    const child = spawn(command, args, {
      cwd: paths().root,
      env: { ...process.env, ...env },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let pending = "";
    const data = (b) => {
      pending += b.toString();
      const lines = pending.split(/\r?\n/);
      pending = lines.pop();
      for (const line of lines) if (line.trim()) onLine(line);
    };
    child.stdout.on("data", data);
    child.stderr.on("data", data);
    child.once("error", no);
    child.once("close", (code) => {
      if (pending.trim()) onLine(pending);
      code === 0
        ? yes()
        : no(Error(`命令执行失败（退出码 ${code}），请检查上方日志后重试。`));
    });
  });
}

export async function prepareDependencies() {
  if (busy) throw Error("安装正在进行，请等待。");
  busy = true;
  try {
    await run(
      process.platform === "win32" ? "npm.cmd" : "npm",
      [
        "ci",
        "--cache",
        process.env.ISLAND_NPM_CACHE ||
          resolve(paths().root, ".data/npm-cache"),
        "--no-audit",
        "--no-fund",
      ],
      {},
      () => {},
    );
  } finally {
    busy = false;
  }
}

async function verifyWeb(config, input) {
  const base = `http://${["::", "::1"].includes(config.env.ISLAND_BIND_HOST) ? "[::1]" : "127.0.0.1"}:${config.env.PORT}`;
  const health = await fetch(base + "/api/health", {
    signal: AbortSignal.timeout(5000),
  });
  const h = await health.json();
  if (!h.ok || h.installation_id !== config.installationId)
    throw Error("网站连接的数据库与安装配置不一致。");
  const site = await fetch(base + "/api/site", {
    signal: AbortSignal.timeout(5000),
  });
  if (!site.ok) throw Error("网站配置接口未通过验证。");
  // Check both administrative authentication and API routing when this setup created the administrator.
  if (input.admin?.email && input.admin.password) {
    const login = await fetch(base + "/api/auth/login", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-island-request": "1",
        origin: config.env.APP_ORIGIN,
      },
      body: JSON.stringify({
        email: input.admin.email.trim().toLowerCase(),
        password: input.admin.password,
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!login.ok)
      throw Error("管理员登录验证失败，请使用该账号的实际密码重试。");
    const cookie = login.headers.get("set-cookie")?.split(";")[0];
    const admin = await fetch(base + "/api/admin/overview", {
      headers: { cookie },
      signal: AbortSignal.timeout(5000),
    });
    if (!admin.ok) throw Error("管理员后台权限验证失败。");
    await fetch(base + "/api/auth/logout", {
      method: "POST",
      headers: {
        cookie,
        "x-island-request": "1",
        origin: config.env.APP_ORIGIN,
      },
    });
  }
}
export async function install(raw) {
  if (busy) throw Error("安装正在进行，请等待当前操作完成。");
  const input = validateInput(raw);
  busy = true;
  let temporaryDatabase,
    config,
    checkpoint,
    startedRuntime = false;
  try {
    checkpoint = await readJSON(paths().state);
  } catch (e) {
    busy = false;
    throw e;
  }
  const secrets = [
    input.admin?.password,
    input.database?.password,
    input.database?.url,
  ];
  let writeQueue = Promise.resolve();
  const save = () => {
    const snapshot = structuredClone(state);
    writeQueue = writeQueue.then(() => atomicJSON(paths().state, snapshot));
    return writeQueue;
  };
  let state = {
    status: "running",
    stage: "准备",
    progress: 0,
    logs: [],
    startedAt: new Date().toISOString(),
    attempt: (checkpoint?.attempt || 0) + 1,
  };
  const log = async (message) => {
    state.logs.push({
      time: new Date().toISOString(),
      message: cleanError(message, secrets),
    });
    state.logs = state.logs.slice(-120);
    await save();
  };
  const step = async (stage, progress) => {
    state.stage = stage;
    state.progress = progress;
    await log(stage);
  };
  try {
    await step("检测并准备项目依赖", 5);
    const existing = loadRuntimeConfig(),
      old = existing.saved;
    if (process.env.ISLAND_ENV_OVERRIDES)
      throw Error(
        "当前启用了 ISLAND_ENV_OVERRIDES，请先解除配置覆盖再运行安装向导。",
      );
    if (
      old &&
      input.operation !== "upgrade" &&
      checkpoint?.status === "complete"
    )
      throw Error("此网站已安装，请选择保留数据升级。");
    const probeHost = ["::", "::1"].includes(existing.env.ISLAND_BIND_HOST)
      ? "[::1]"
      : "127.0.0.1";
    try {
      const live = await fetch(
        `http://${probeHost}:${existing.env.PORT}/api/health`,
        { signal: AbortSignal.timeout(1200) },
      );
      const health = await live.json();
      if (
        health.instance_key ===
        createHash("sha256").update(paths().root).digest("hex").slice(0, 24)
      )
        throw Error(
          "当前项目的 Web 服务仍在运行，请先停止原网站再安装或升级。",
        );
    } catch (e) {
      if (e.message?.includes("Web 服务仍在运行")) throw e;
    }
    if (await runtimeControl())
      throw Error(
        "网站正在运行；请先运行 npm run island:stop，再执行安装或升级。",
      );
    if (!(await freePort(input.port, input.bindHost)))
      throw Error("网站端口已被占用，请选择其他端口。");
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    await run(
      npm,
      [
        "ci",
        "--cache",
        process.env.ISLAND_NPM_CACHE ||
          resolve(paths().root, ".data/npm-cache"),
        "--no-audit",
        "--no-fund",
      ],
      {},
      (line) => {
        void log(line);
      },
    );
    await step("验证私有文件存储", 18);
    if (input.storage.includes(resolve(paths().root, "apps/web/public")))
      throw Error("私有文件不能存放在网站 public 目录。");
    await mkdir(input.storage, { recursive: true, mode: 0o700 });
    await protectDirectory(input.storage);
    const probe = resolve(input.storage, ".install-probe-" + randomUUID());
    await writeFile(probe, "island-storage", { mode: 0o600 });
    await unlink(probe);
    await step("连接并验证 PostgreSQL", 28);
    const env = {
      ...existing.env,
      APP_ORIGIN: input.origin,
      PORT: String(input.port),
      ISLAND_BIND_HOST: input.bindHost,
      STORAGE_DIR: input.storage,
    };
    // The existing storage adapter is retained on upgrades. New installations use local private files.
    if (!old) {
      env.SUPABASE_URL = "";
      env.SUPABASE_SERVICE_ROLE_KEY = "";
    }
    let url;
    if (input.mode === "embedded") {
      const port = Number(input.pgPort);
      if (!Number.isInteger(port) || port < 1024 || port > 65535)
        throw Error("数据库端口须为 1024–65535。");
      env.PG_PORT = String(port);
      env.PG_DATA_DIR = resolve(paths().root, input.pgData || ".data/postgres");
      env.PG_USER = old?.env.PG_USER || "island";
      let hasData = false;
      try {
        await access(resolve(env.PG_DATA_DIR, "PG_VERSION"));
        hasData = true;
      } catch {}
      env.PG_PASSWORD =
        old?.env.PG_PASSWORD ||
        (hasData
          ? "local-development-only"
          : randomBytes(32).toString("base64url"));
      secrets.push(env.PG_PASSWORD);
      const u = new URL("postgresql://127.0.0.1");
      u.port = env.PG_PORT;
      u.username = env.PG_USER;
      u.password = env.PG_PASSWORD;
      u.pathname = "/postgres";
      url = u.toString();
      env.DATABASE_URL = url;
      const { startEmbedded } = await import("../database.mjs");
      temporaryDatabase = await startEmbedded({ mode: "embedded", env });
    } else {
      url = databaseURL(input.database);
      if (input.database.createName) {
        if (old) throw Error("升级流程不能创建并切换空数据库。");
        await log("按配置创建专用数据库");
        url = await createDatabase(url, input.database.createName);
      }
      env.DATABASE_URL = url;
    }
    secrets.push(
      new URL(url).password,
      decodeURIComponent(new URL(url).password),
    );
    const inspection = await inspectDatabase(url);
    if (
      old &&
      inspection.installation &&
      inspection.installation.id !== old.installationId
    )
      throw Error("目标数据库属于另一套安装，不能用更换地址代替数据迁移。");
    if (old && !inspection.installation && input.operation === "upgrade")
      throw Error("升级不能切换到空数据库；请使用原数据库或单独执行迁移。");
    if (
      inspection.installation?.phase === "complete" &&
      input.operation !== "upgrade"
    )
      throw Error("数据库已安装，请选择保留数据升级。");
    if (!inspection.admins && (!input.admin?.email || !input.admin?.password))
      throw Error("请设置首位管理员；已有普通账号可填写原密码进行授权。");
    config = {
      version: 1,
      installationId:
        inspection.installation?.id || old?.installationId || randomUUID(),
      mode: input.mode,
      env: Object.fromEntries(keys.map((k) => [k, String(env[k] ?? "")])),
      createdAt: old?.createdAt || new Date().toISOString(),
    };
    await step("应用数据库迁移", 42);
    const { migrate } = await import("../migrate.mjs");
    await migrate(url);
    await step(
      inspection.admins ? "保留原管理员与网站数据" : "初始化首位超级管理员",
      55,
    );
    await provision(config, {
      ...input,
      preserveBrand: inspection.isIsland && inspection.users > 0,
    });
    await step("保存统一配置", 63);
    if (old) await atomicJSON(paths().config + ".backup", old);
    await atomicJSON(paths().config, config);
    state.installationId = config.installationId;
    await save();
    await step("构建网站与后台", 70);
    await run(
      npm,
      ["run", "build"],
      {
        ...config.env,
        ISLAND_ROOT: paths().root,
        ISLAND_CONFIG_FILE: paths().config,
      },
      (line) => {
        void log(line);
      },
    );
    await temporaryDatabase?.stop();
    temporaryDatabase = null;
    await step("启动网站服务", 87);
    await mkdir(paths().logs, { recursive: true, mode: 0o700 });
    const fd = await open(resolve(paths().logs, "runtime.log"), "a", 0o600);
    try {
      const child = spawn(
        process.execPath,
        [resolve(paths().root, "scripts/serve.mjs")],
        {
          cwd: paths().root,
          env: {
            ...process.env,
            ...config.env,
            ISLAND_ROOT: paths().root,
            ISLAND_CONFIG_FILE: paths().config,
          },
          detached: true,
          stdio: ["ignore", fd.fd, fd.fd],
          windowsHide: true,
        },
      );
      child.unref();
      startedRuntime = true;
    } finally {
      await fd.close();
    }
    let ready = false;
    for (let i = 0; i < 90; i++) {
      const control = await runtimeControl();
      if (control?.ready) {
        ready = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    if (!ready)
      throw Error(
        "网站启动失败，请查看安装目录 logs/runtime.log；修复后可重试。",
      );
    await step("验证网站、配置与管理员登录", 95);
    await verifyWeb(
      config,
      inspection.admins ? { ...input, admin: null } : input,
    );
    if (
      input.verifyPublic ||
      !["localhost", "127.0.0.1", "[::1]"].includes(
        new URL(input.origin).hostname,
      )
    ) {
      await step("验证公开网站地址", 97);
      const r = await fetch(input.origin + "/api/health", {
        signal: AbortSignal.timeout(10000),
      });
      const result = await r.json();
      if (!result.ok || result.installation_id !== config.installationId)
        throw Error(
          "公开访问地址未能连接此网站，请检查 DNS、HTTPS 与代理配置。",
        );
    }
    if (input.autoStart) {
      await step("配置登录后自动启动", 98);
      const { installService } = await import("../service.mjs");
      await installService(config);
    }
    await finishInstallation(config);
    state = {
      ...state,
      status: "complete",
      stage: "安装完成",
      progress: 100,
      origin: input.origin,
      adminURL: input.origin + "/admin",
      completedAt: new Date().toISOString(),
      operation: input.operation || "install",
    };
    await log(
      "安装完成；后续使用 npm run island:start 启动，npm run island:stop 停止。",
    );
    return state;
  } catch (e) {
    if (startedRuntime) await runtimeControl("stop");
    await temporaryDatabase?.stop().catch(() => {});
    state.status = "failed";
    state.error = cleanError(e, secrets);
    state.stage = "需要处理后重试";
    await log(state.error);
    throw Error(state.error);
  } finally {
    busy = false;
  }
}

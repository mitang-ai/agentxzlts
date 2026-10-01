import {
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  test,
  expect,
} from "vitest";
import { Pool } from "pg";
import { request as httpRequest } from "node:http";
import { randomUUID } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  stat,
  rm,
} from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  loadRuntimeConfig,
  applyRuntimeConfig,
  fileEnvironment,
} from "../packages/runtime/config.mjs";
import { passwordHash, verifyPassword } from "../packages/runtime/password.mjs";
// @ts-ignore Node scripts are intentionally directly executable ES modules.
import {
  atomicJSON,
  cleanError,
  acquireProcessLock,
} from "../scripts/setup/io.mjs";
// @ts-ignore
import {
  inspectDatabase,
  databaseURL,
  candidates,
  createDatabase,
} from "../scripts/setup/detect.mjs";
// @ts-ignore
import { provision, finishInstallation } from "../scripts/setup/provision.mjs";
// @ts-ignore
import { validateInput } from "../scripts/setup/install.mjs";
// @ts-ignore
import { migrate } from "../scripts/migrate.mjs";
// @ts-ignore
import { startSetup } from "../scripts/setup/server.mjs";
// @ts-ignore
import { installService } from "../scripts/service.mjs";
const mainURL =
  process.env.DATABASE_URL ||
  "postgresql://island:local-development-only@127.0.0.1:55432/postgres";
const main = new Pool({ connectionString: mainURL });
const database = "wizard_test_" + randomUUID().replaceAll("-", "");
let root: string,
  url: string,
  db: Pool,
  env: NodeJS.ProcessEnv,
  configFile: string;
beforeAll(async () => {
  root = await mkdtemp(resolve(tmpdir(), "island-wizard-"));
  await main.query(`create database "${database}"`);
  const u = new URL(mainURL);
  u.pathname = "/" + database;
  url = u.toString();
  db = new Pool({ connectionString: url });
});
afterAll(async () => {
  await db.end();
  let remaining = 0;
  for (let i = 0; i < 40; i++) {
    remaining = Number(
      (
        await main.query(
          "select count(*) n from pg_stat_activity where datname=$1",
          [database],
        )
      ).rows[0].n,
    );
    if (!remaining) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  expect(remaining).toBe(0);
  await main.query(`drop database "${database}"`);
  await main.end();
  await rm(root, { recursive: true, force: true });
});
beforeEach(async () => {
  env = { ...process.env };
  configFile = resolve(root, "config-" + randomUUID() + ".json");
  process.env.ISLAND_CONFIG_FILE = configFile;
});
afterEach(() => {
  for (const key of Object.keys(process.env))
    if (!(key in env)) delete process.env[key];
  Object.assign(process.env, env);
});
const profile = () => ({
  version: 1 as const,
  installationId: randomUUID(),
  mode: "external" as const,
  env: {
    DATABASE_URL: url,
    APP_ORIGIN: "http://localhost:3900",
    PORT: "3900",
    STORAGE_DIR: resolve(root, "files"),
  },
  createdAt: new Date().toISOString(),
});
const admin = {
  email: "owner@wizard.invalid",
  password: "Wizard-Owner-Password-2026",
  nickname: "安装管理员",
};
test("统一配置在工作区、Web 与独立脚本一致，保存配置优先于旧环境文件", async () => {
  await mkdir(resolve(root, "apps/web"), { recursive: true });
  await writeFile(
    resolve(root, "apps/web/.env.local"),
    "DATABASE_URL=postgresql://old.invalid/old\nSTORAGE_DIR=../../.data/files\n",
  );
  const saved = profile();
  await atomicJSON(configFile, saved);
  process.env.DATABASE_URL = "postgresql://injected.invalid/ignored";
  const config = loadRuntimeConfig(root);
  expect(config.env.DATABASE_URL).toBe(url);
  expect(config.env.STORAGE_DIR).toBe(resolve(root, "files"));
  applyRuntimeConfig(root);
  expect(process.env.DATABASE_URL).toBe(url);
});
test("显式覆盖需要指名变量，配置文件权限受保护且不会存管理员明文密码", async () => {
  const saved = profile();
  await atomicJSON(configFile, saved);
  process.env.DATABASE_URL = "postgresql://explicit.invalid/override";
  process.env.ISLAND_ENV_OVERRIDES = "DATABASE_URL";
  expect(loadRuntimeConfig(root).env.DATABASE_URL).toContain(
    "explicit.invalid",
  );
  if (process.platform !== "win32")
    expect((await stat(configFile)).mode & 0o777).toBe(0o600);
  expect(await readFile(configFile, "utf8")).not.toContain(admin.password);
});
test("未安装时读取已有环境文件，旧相对文件目录正确解析", () => {
  delete process.env.DATABASE_URL;
  const config = loadRuntimeConfig(root);
  expect(config.env.DATABASE_URL).toContain("old.invalid");
  expect(config.env.STORAGE_DIR).toBe(resolve(root, ".data/files"));
});
test("旧环境文件变量引用与转义在独立启动工具中正确读取", async () => {
  const other = resolve(root, "references");
  await mkdir(resolve(other, "apps/web"), { recursive: true });
  await writeFile(
    resolve(other, "apps/web/.env.local"),
    "INSTALL_TEST_SECRET=example-secret\nDATABASE_URL=postgresql://owner:${INSTALL_TEST_SECRET}@localhost/island\nESCAPED=literal\\$DOLLAR\n",
  );
  const values = fileEnvironment(other);
  expect(values.DATABASE_URL).toBe(
    "postgresql://owner:example-secret@localhost/island",
  );
  expect(values.ESCAPED).toBe("literal$DOLLAR");
});
test("实际检查 PostgreSQL 版本、可写 Schema、角色及双连接通知", async () => {
  const result = await inspectDatabase(url);
  expect(result.version).toBeGreaterThanOrEqual(170000);
  expect(result.isIsland).toBe(false);
  expect(
    (
      await db.query(
        "select count(*)::int n from pg_namespace where nspname like 'island_probe_%'",
      )
    ).rows[0].n,
  ).toBe(0);
});
test("数据库有其他应用时拒绝迁移目标，并保留原表", async () => {
  await db.query("create table unrelated_application(id int)");
  try {
    await expect(inspectDatabase(url)).rejects.toThrow("其他应用");
    expect(
      (await db.query("select * from unrelated_application")).rows,
    ).toEqual([]);
  } finally {
    await db.query("drop table unrelated_application");
  }
});
test("数据库连接参数使用 URL 编码，凭据不进入候选详情", () => {
  const result = databaseURL({
    host: "db.example.com",
    port: 5434,
    database: "island",
    user: "a@b",
    password: "x:$@/?#",
    tls: "verify-full",
  });
  const u = new URL(result);
  expect(decodeURIComponent(u.password)).toBe("x:$@/?#");
  expect(decodeURIComponent(u.username)).toBe("a@b");
  expect(u.searchParams.get("sslmode")).toBe("verify-full");
  candidates.set("private-test", result);
  expect(databaseURL({ candidate: "private-test" })).toBe(result);
});
test("支持本机 PostgreSQL Socket 地址，拒绝其他 SQL 协议", () => {
  expect(
    new URL(
      databaseURL({
        host: "/var/run/postgresql",
        database: "island",
        user: "owner",
      }),
    ).searchParams.get("host"),
  ).toBe("/var/run/postgresql");
  expect(() => databaseURL({ url: "mysql://localhost/island" })).toThrow(
    "PostgreSQL",
  );
});
test("数据库创建仅接受安全的独立库名", async () => {
  await expect(
    createDatabase(mainURL, "a;drop database postgres"),
  ).rejects.toThrow("名称");
});
test("追加迁移后管理员、网站设置和安装身份同事务创建", async () => {
  await migrate(url);
  const saved = profile();
  await atomicJSON(configFile, saved);
  await expect(
    provision(saved, {
      siteName: "向导安装站",
      operation: "install",
      admin: { ...admin, email: "owner@domain.x" },
    }),
  ).rejects.toThrow("有效邮箱");
  await expect(
    provision(saved, {
      siteName: "向导安装站",
      operation: "install",
      admin: { ...admin, password: "12345678" },
    }),
  ).rejects.toThrow("新管理员密码");
  expect(
    (await db.query("select count(*)::int n from profiles")).rows[0].n,
  ).toBe(0);
  expect(
    (await db.query("select count(*)::int n from app_installation")).rows[0].n,
  ).toBe(0);
  await provision(saved, {
    siteName: "向导安装站",
    admin,
    operation: "install",
  });
  const result = (
    await db.query(
      "select p.display_name,c.password_hash,a.role from profiles p join auth.local_credentials c on p.id=c.user_id join admin_members a on a.user_id=p.id where email=$1",
      [admin.email],
    )
  ).rows[0];
  expect(result.display_name).toBe(admin.nickname);
  expect(result.role).toBe("super");
  expect(verifyPassword(admin.password, result.password_hash)).toBe(true);
  expect(result.password_hash).not.toContain(admin.password);
  expect(
    (
      await db.query(
        "select value->>'name' name from site_settings where key='brand'",
      )
    ).rows[0].name,
  ).toBe("向导安装站");
  expect(
    (
      await db.query(
        "select count(*)::int n from admin_audit_logs where action='bootstrap_admin'",
      )
    ).rows[0].n,
  ).toBe(1);
  await finishInstallation(saved);
});
test("安装锁由数据库验证，配置文件删除也不能再次初始化管理员", async () => {
  const row = (await db.query("select id from app_installation")).rows[0];
  const saved = { ...profile(), installationId: row.id };
  await expect(
    provision(saved, {
      siteName: "覆盖",
      admin: { ...admin, email: "second@wizard.invalid" },
      operation: "install",
    }),
  ).rejects.toThrow("已安装");
  expect(
    (await db.query("select count(*)::int n from admin_members")).rows[0].n,
  ).toBe(1);
});
test("保留数据升级不会修改原管理员密码或品牌，且迁移可重复执行", async () => {
  const row = (await db.query("select id from app_installation")).rows[0],
    saved = { ...profile(), installationId: row.id };
  const before = (
    await db.query("select password_hash from auth.local_credentials")
  ).rows[0].password_hash;
  await migrate(url);
  await provision(saved, {
    operation: "upgrade",
    siteName: "不会覆盖",
    admin: { ...admin, password: "Different-Password-123" },
  });
  expect(
    (await db.query("select password_hash from auth.local_credentials")).rows[0]
      .password_hash,
  ).toBe(before);
  expect(
    (
      await db.query(
        "select value->>'name' name from site_settings where key='brand'",
      )
    ).rows[0].name,
  ).toBe("向导安装站");
});
test("拒绝安装身份错配，事务不改变原管理员", async () => {
  await expect(
    provision(profile(), { operation: "upgrade", siteName: "错配" }),
  ).rejects.toThrow("安装身份");
  expect(
    (await db.query("select count(*)::int n from admin_members")).rows[0].n,
  ).toBe(1);
});
test("安装验证阻止非法来源、低端口及非 HTTPS 公开监听", () => {
  const input = {
    confirmed: true,
    mode: "external",
    siteName: "测试",
    port: 3000,
    origin: "http://localhost:3000",
    storage: root,
    bindHost: "127.0.0.1",
  };
  expect(() => validateInput({ ...input, port: 22 })).toThrow("端口");
  expect(() =>
    validateInput({ ...input, origin: "https://example.com/subpath" }),
  ).toThrow("路径");
  expect(() => validateInput({ ...input, bindHost: "0.0.0.0" })).toThrow(
    "HTTPS",
  );
  expect(validateInput(input).origin).toBe(input.origin);
});
test("密码格式校验与日志脱敏不会泄露数据库或管理员密码", () => {
  const hash = passwordHash(admin.password);
  expect(verifyPassword(admin.password, hash)).toBe(true);
  expect(verifyPassword(admin.password, "invalid")).toBe(false);
  const result = cleanError(
    Error("postgresql://user:secret@db.local/island admin:" + admin.password),
    [admin.password],
  );
  expect(result).not.toContain("secret");
  expect(result).not.toContain(admin.password);
});
test("安装 API 拒绝未授权、跨来源、Host 重绑定和非法提交", async () => {
  const setup = await startSetup({ port: 0, openBrowser: false });
  try {
    const u = new URL(setup.url),
      base = u.origin,
      token = u.hash.slice(1);
    expect((await fetch(base + "/api/status")).status).toBe(403);
    expect(
      (
        await fetch(base + "/api/status", {
          headers: {
            authorization: "Bearer " + token,
            origin: "https://evil.invalid",
          },
        })
      ).status,
    ).toBe(403);
    const hostStatus = await new Promise((resolve) => {
      const r = httpRequest(
        base + "/api/status",
        { headers: { authorization: "Bearer " + token, host: "evil.invalid" } },
        (response) => {
          response.resume();
          resolve(response.statusCode);
        },
      );
      r.end();
    });
    expect(hostStatus).toBe(403);
    const valid = await fetch(base + "/api/status", {
      headers: { authorization: "Bearer " + token },
    });
    expect(valid.status).toBe(200);
    expect(
      (
        await fetch(base + "/api/install", {
          method: "POST",
          headers: {
            authorization: "Bearer " + token,
            "content-type": "application/json",
          },
          body: "{}",
        })
      ).status,
    ).toBe(400);
  } finally {
    await setup.close();
  }
});
test("明确配置不能覆盖为空，损坏配置不会回显凭据", async () => {
  const saved = profile();
  await atomicJSON(configFile, saved);
  process.env.ISLAND_ENV_OVERRIDES = "DATABASE_URL";
  process.env.DATABASE_URL = "";
  expect(() => loadRuntimeConfig(root)).toThrow("覆盖为空");
  await writeFile(configFile, '{"credential":"do-not-print');
  try {
    loadRuntimeConfig(root);
  } catch (e) {
    expect(String(e)).not.toContain("do-not-print");
    expect(String(e)).toContain("安装配置");
  }
});
test("安装进程中断后重启显示可恢复状态", async () => {
  const state = resolve(root, "state.json");
  await atomicJSON(state, { status: "running", progress: 55, stage: "初始化" });
  const setup = await startSetup({ port: 0, openBrowser: false });
  try {
    const result = JSON.parse(await readFile(state, "utf8"));
    expect(result.status).toBe("failed");
    expect(result.error).toContain("上次安装被中断");
  } finally {
    await setup.close();
  }
});
test("Linux 登录后自启服务文件引用同一配置且不包含数据库凭据", async () => {
  if (process.platform !== "linux") return;
  const saved = profile(),
    output = resolve(root, "service");
  await atomicJSON(configFile, saved);
  const result = await installService(saved, { output, dryRun: true });
  const body = await readFile(result.file, "utf8");
  expect(body).toContain(configFile);
  expect(body).toContain("scripts/serve.mjs");
  expect(body).not.toContain(url);
});

test("运行器启动锁拒绝并发，失效进程锁可恢复", async () => {
  const file = resolve(root, "runtime-test.lock");
  const release = await acquireProcessLock(file);
  await expect(acquireProcessLock(file)).rejects.toThrow("启动进程");
  await release();
  await atomicJSON(file, { pid: 2147483647, nonce: "stale" });
  const recovered = await acquireProcessLock(file);
  await recovered();
});

test("已有普通账号可用原 8 位密码授权管理员，错误密码不改账号", async () => {
  const userId = randomUUID(),
    email = "legacy@wizard.invalid",
    password = "Oldpass8";
  const hash = passwordHash(password);
  const owner = (await db.query("select user_id,role from admin_members"))
    .rows[0];
  const installationId = (await db.query("select id from app_installation"))
    .rows[0].id;
  await db.query(
    "insert into auth.users(id,email,raw_user_meta_data) values($1,$2,$3)",
    [userId, email, JSON.stringify({ display_name: "旧账号" })],
  );
  await db.query(
    "insert into auth.local_credentials(user_id,password_hash) values($1,$2)",
    [userId, hash],
  );
  await db.query("delete from admin_members");
  try {
    const saved = { ...profile(), installationId };
    await expect(
      provision(saved, {
        operation: "upgrade",
        admin: { email, password: "Wrongpw8", nickname: "旧账号" },
      }),
    ).rejects.toThrow("原账号密码");
    expect(
      (await db.query("select count(*)::int n from admin_members")).rows[0].n,
    ).toBe(0);
    await provision(saved, {
      operation: "upgrade",
      admin: {
        email: "  LEGACY@wizard.invalid  ",
        password,
        nickname: "旧账号",
      },
    });
    expect(
      (
        await db.query("select role from admin_members where user_id=$1", [
          userId,
        ])
      ).rows[0].role,
    ).toBe("super");
    expect(
      (
        await db.query(
          "select password_hash from auth.local_credentials where user_id=$1",
          [userId],
        )
      ).rows[0].password_hash,
    ).toBe(hash);
  } finally {
    await db.query("delete from admin_members where user_id=$1", [userId]);
    await db.query("insert into admin_members(user_id,role) values($1,$2)", [
      owner.user_id,
      owner.role,
    ]);
    await db.query("delete from auth.users where id=$1", [userId]);
  }
});

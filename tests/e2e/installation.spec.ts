import { test, expect, type Page } from "@playwright/test";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, cp } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
const suffix = Date.now(),
  directory = resolve(".data", `installation-e2e-${suffix}`),
  database = "installation_e2e_" + suffix;
const main = new Pool({
  connectionString:
    process.env.DATABASE_URL ||
    "postgresql://island:local-development-only@127.0.0.1:55432/postgres",
});
const configFile = resolve(directory, "config.json");
const email = `owner-${suffix}@installation.invalid`,
  password = "Install-Owner-Password-2026";
let setup: any, room: string, db: Pool;
const checkout = resolve(directory, "checkout");
async function installed(page: Page, name: string) {
  await expect(page.locator("#outcome .result, #outcome .error")).toBeVisible({
    timeout: 150000,
  });
  expect(
    await page.locator("#outcome .error").count(),
    await page.locator("#outcome").innerText(),
  ).toBe(0);
  await expect(
    page.getByRole("heading", { name, exact: true, level: 1 }),
  ).toBeVisible();
}
async function shot(page: Page, name: string) {
  await page.screenshot({
    path: `docs/installation-screenshots/${name}.png`,
    fullPage: true,
  });
}
async function runtimeControl(action = "status", dir = directory) {
  let state;
  try {
    state = JSON.parse(await readFile(resolve(dir, "runtime.json"), "utf8"));
  } catch {
    return null;
  }
  try {
    const r = await fetch(`http://127.0.0.1:${state.controlPort}/${action}`, {
      method: action === "stop" ? "POST" : "GET",
      headers: { authorization: "Bearer " + state.token },
    });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}
async function stop(dir = directory) {
  await runtimeControl("stop", dir);
  await expect
    .poll(async () => await runtimeControl("status", dir), { timeout: 20000 })
    .toBeNull();
}
test.describe.serial("真实安装与保留数据升级", () => {
  test.beforeAll(async () => {
    await mkdir(checkout, { recursive: true });
    for (const name of [
      "apps",
      "packages",
      "scripts",
      "database",
      "supabase",
      "package.json",
      "package-lock.json",
      "install.sh",
      "start.sh",
    ])
      await cp(resolve(name), resolve(checkout, name), {
        recursive: true,
        filter: (path) =>
          !path
            .split(/[\\/]/)
            .some(
              (part) =>
                ["node_modules", ".next", ".temp", ".branches"].includes(
                  part,
                ) ||
                (part.startsWith(".env") && !part.endsWith(".example")),
            ),
      });
    process.env.ISLAND_CONFIG_FILE = configFile;
    process.env.ISLAND_NO_BROWSER = "true";
    await main.query(`create database "${database}"`);
    const u = new URL(
      process.env.DATABASE_URL ||
        "postgresql://island:local-development-only@127.0.0.1:55432/postgres",
    );
    u.pathname = "/" + database;
    db = new Pool({ connectionString: u.toString() });
    const child = spawn(process.execPath, ["scripts/setup/server.mjs"], {
      cwd: checkout,
      env: {
        ...process.env,
        ISLAND_ROOT: checkout,
        ISLAND_CONFIG_FILE: configFile,
        ISLAND_NPM_CACHE: "/workspace/.npm-cache",
        ISLAND_NO_BROWSER: "true",
        ISLAND_SETUP_PORT: "0",
      },
      stdio: "ignore",
    });
    await expect
      .poll(
        async () => {
          try {
            return JSON.parse(
              await readFile(resolve(directory, "setup-session.json"), "utf8"),
            ).url;
          } catch {
            return null;
          }
        },
        { timeout: 15000 },
      )
      .not.toBeNull();
    const session = JSON.parse(
      await readFile(resolve(directory, "setup-session.json"), "utf8"),
    );
    setup = {
      url: session.url,
      close: async () => {
        child.kill("SIGTERM");
        if (child.exitCode === null)
          await new Promise((r) => child.once("exit", r));
      },
    };
  });
  test.afterAll(async () => {
    await stop().catch(() => {});
    await setup?.close();
    await db?.end();
    await main.query(`drop database "${database}" with(force)`);
    await main.end();
    delete process.env.ISLAND_CONFIG_FILE;
    await rm(directory, { recursive: true, force: true });
  });
  test("环境检测、连接验证、管理员与网站配置，安装后前后台共用新地址", async ({
    browser,
  }) => {
    test.setTimeout(180000);
    const context = await browser.newContext(),
      page = await context.newPage();
    await page.goto(setup.url);
    await expect(
      page.getByRole("heading", { name: "欢迎安装协作岛" }),
    ).toBeVisible();
    await shot(page, "01-environment");
    await page.getByRole("button", { name: "自动准备项目依赖" }).click();
    await expect(
      page.getByRole("button", { name: "自动准备项目依赖" }),
    ).toHaveCount(0, { timeout: 60000 });
    await page.getByRole("button", { name: "下一步", exact: true }).click();
    await page.getByRole("button", { name: /已有 PostgreSQL/ }).click();
    await page.getByLabel("发现的数据库").selectOption("manual");
    await page.getByLabel("数据库主机 / Socket 目录").fill("127.0.0.1");
    await page.getByLabel("数据库端口", { exact: true }).fill("55432");
    await page.getByLabel("数据库名称", { exact: true }).fill(database);
    await page.getByLabel("数据库账号", { exact: true }).fill("island");
    await page
      .getByLabel("数据库密码", { exact: true })
      .fill("local-development-only");
    await page.getByLabel("私有文件目录").fill(resolve(directory, "files"));
    await page.getByRole("button", { name: "测试连接与安装权限" }).click();
    await expect(page.getByText(/连接与权限验证通过/)).toBeVisible();
    await shot(page, "02-database");
    await page.getByRole("button", { name: "下一步", exact: true }).click();
    await page.getByLabel("网站名称", { exact: true }).fill("安装向导验收站");
    await page.getByLabel("网站监听端口").fill("3012");
    await expect(page.getByLabel("浏览器访问地址")).toHaveValue(
      "http://localhost:3012",
    );
    await page.getByLabel("管理员昵称").fill("向导站长");
    await page.getByLabel("管理员账号（邮箱）").fill(email);
    await page.getByLabel("管理员密码", { exact: true }).fill(password);
    await page.getByLabel("确认密码").fill(password);
    await shot(page, "03-website-admin");
    await page.getByRole("button", { name: "下一步", exact: true }).click();
    await page.getByRole("checkbox", { name: /确认配置正确/ }).check();
    await shot(page, "04-confirm");
    await page.getByRole("button", { name: "开始安装", exact: true }).click();
    await installed(page, "安装完成");
    await shot(page, "05-complete");
    const saved = JSON.parse(await readFile(configFile, "utf8"));
    expect(saved.env.DATABASE_URL).toContain(database);
    expect(saved.env.PORT).toBe("3012");
    expect(saved.env.STORAGE_DIR).toBe(resolve(directory, "files"));
    expect(JSON.stringify(saved)).not.toContain(password);
    const app = await browser.newContext({ baseURL: "http://localhost:3012" });
    const login = await app.request.post("/api/auth/login", {
      headers: { "x-island-request": "1" },
      data: { email, password },
    });
    expect(login.status()).toBe(200);
    const frontend = await app.newPage();
    await frontend.goto("http://localhost:3012");
    await expect(
      frontend.getByRole("button", { name: "个人资料" }),
    ).toBeVisible();
    await expect(
      frontend.getByText("安装向导验收站", { exact: true }).first(),
    ).toBeVisible();
    const create = await app.request.post("/api/command", {
      headers: { "x-island-request": "1" },
      data: {
        command: "create_room",
        data: { name: "升级保留的真实房间", icon: "🏝️" },
      },
    });
    expect(create.ok(), await create.text()).toBe(true);
    room = (await create.json()).id;
    const message = await app.request.post("/api/command", {
      headers: { "x-island-request": "1" },
      data: {
        command: "message",
        data: {
          room_id: room,
          content: "安装后的消息实际持久化",
          client_message_id: randomUUID(),
        },
      },
    });
    expect(message.ok(), await message.text()).toBe(true);
    const file = await app.request.post(`/api/rooms/${room}/files`, {
      headers: { "x-island-request": "1" },
      multipart: {
        file: {
          name: "安装后文件.txt",
          mimeType: "text/plain",
          buffer: Buffer.from("安装路径验证"),
        },
      },
    });
    expect(file.ok(), await file.text()).toBe(true);
    const fid = (await file.json()).id;
    expect(await (await app.request.get(`/api/files/${fid}`)).text()).toBe(
      "安装路径验证",
    );
    const admin = await app.newPage();
    await admin.goto("http://localhost:3012/admin");
    await expect(
      admin.getByRole("heading", { name: "概览", exact: true }),
    ).toBeVisible();
    expect(
      (
        await db.query(
          "select count(*)::int n from messages where content=$1",
          ["安装后的消息实际持久化"],
        )
      ).rows[0].n,
    ).toBe(1);
    const cli = spawnSync(
      process.execPath,
      [resolve(checkout, "scripts/admin-init.mjs"), email],
      {
        cwd: checkout,
        env: {
          ...process.env,
          ISLAND_ROOT: checkout,
          ISLAND_CONFIG_FILE: configFile,
        },
        encoding: "utf8",
      },
    );
    expect(cli.status).toBe(1);
    expect(cli.stderr).toContain("管理员已初始化");
    const badOrigin = await app.request.post("/api/command", {
      headers: { "x-island-request": "1", origin: "http://localhost:3000" },
      data: { command: "create_room", data: { name: "来源不能沿用旧地址" } },
    });
    expect(badOrigin.status()).toBe(403);
    await app.close();
    await context.close();
  });
  test("保留数据升级、安装锁、停止与重新启动使用保存配置", async ({
    browser,
  }) => {
    test.setTimeout(180000);
    await stop();
    const context = await browser.newContext(),
      page = await context.newPage();
    await page.goto(setup.url);
    await expect(
      page.getByRole("heading", { name: "管理现有安装" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "下一步", exact: true }).click();
    await expect(page.getByText(/连接与权限验证通过/)).toBeVisible();
    await page.getByRole("button", { name: "下一步", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "保留原管理员" }),
    ).toBeVisible();
    await expect(page.getByLabel("管理员密码", { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "下一步", exact: true }).click();
    await page.getByRole("checkbox", { name: /确认配置正确/ }).check();
    await page.getByRole("button", { name: "开始安装", exact: true }).click();
    await installed(page, "升级完成");
    await shot(page, "06-upgrade");
    const app = await browser.newContext({ baseURL: "http://localhost:3012" });
    const login = await app.request.post("/api/auth/login", {
      headers: { "x-island-request": "1" },
      data: { email, password },
    });
    expect(login.status()).toBe(200);
    const rooms = await app.request.get("/api/rooms");
    expect((await rooms.json()).rooms.map((r: any) => r.id)).toContain(room);
    expect(
      (await db.query("select count(*)::int n from admin_members")).rows[0].n,
    ).toBe(1);
    expect(
      (
        await db.query(
          "select value->>'name' name from site_settings where key='brand'",
        )
      ).rows[0].name,
    ).toBe("安装向导验收站");
    const setupURL = new URL(setup.url),
      locked = await context.request.post(setupURL.origin + "/api/install", {
        headers: { authorization: "Bearer " + setupURL.hash.slice(1) },
        data: {
          confirmed: true,
          mode: "external",
          port: 3012,
          bindHost: "127.0.0.1",
          origin: "http://localhost:3012",
          storage: resolve(directory, "files"),
          siteName: "不覆盖",
          database: {
            host: "127.0.0.1",
            port: 55432,
            user: "island",
            password: "local-development-only",
            database,
          },
          operation: "install",
        },
      });
    expect(locked.status()).toBe(202);
    await expect
      .poll(async () => {
        const r = await context.request.get(setupURL.origin + "/api/status", {
          headers: { authorization: "Bearer " + setupURL.hash.slice(1) },
        });
        return (await r.json()).state?.status;
      })
      .toBe("failed");
    expect(
      (await db.query("select count(*)::int n from admin_members")).rows[0].n,
    ).toBe(1);
    await context.close();
    await app.close();
  });
  test("手机环境检测与数据库配置页面不溢出", async ({ browser }) => {
    const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
      }),
      page = await context.newPage();
    await page.goto(setup.url);
    await expect(
      page.getByRole("heading", { name: "管理现有安装" }),
    ).toBeVisible();
    await shot(page, "07-mobile");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.getByRole("button", { name: "下一步", exact: true }).click();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await context.close();
  });
});
test("全新内置 PostgreSQL 自动配置、安装窗口关闭后运行及启动文件恢复", async ({
  browser,
}) => {
  test.setTimeout(180000);
  const dir = resolve(".data", "embedded-installation-e2e-" + Date.now()),
    copy = resolve(dir, "checkout"),
    file = resolve(dir, "config.json");
  await mkdir(copy, { recursive: true });
  for (const name of [
    "apps",
    "packages",
    "scripts",
    "database",
    "supabase",
    "package.json",
    "package-lock.json",
    "install.sh",
    "start.sh",
  ])
    await cp(resolve(name), resolve(copy, name), {
      recursive: true,
      filter: (path) =>
        !path
          .split(/[\\/]/)
          .some(
            (part) =>
              ["node_modules", ".next", ".temp", ".branches"].includes(part) ||
              (part.startsWith(".env") && !part.endsWith(".example")),
          ),
    });
  const env = {
    ...process.env,
    ISLAND_ROOT: copy,
    ISLAND_CONFIG_FILE: file,
    ISLAND_NPM_CACHE: "/workspace/.npm-cache",
    ISLAND_NO_BROWSER: "true",
    ISLAND_SETUP_PORT: "0",
  };
  const launcher = spawn("bash", ["install.sh"], {
    cwd: copy,
    env,
    stdio: "ignore",
  });
  let context;
  try {
    await expect
      .poll(
        async () => {
          try {
            return JSON.parse(
              await readFile(resolve(dir, "setup-session.json"), "utf8"),
            ).url;
          } catch {
            return null;
          }
        },
        { timeout: 15000 },
      )
      .not.toBeNull();
    const session = JSON.parse(
      await readFile(resolve(dir, "setup-session.json"), "utf8"),
    );
    context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(session.url);
    await expect(
      page.getByRole("heading", { name: "欢迎安装协作岛" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "自动准备项目依赖" }).click();
    await expect(
      page.getByRole("button", { name: "自动准备项目依赖" }),
    ).toHaveCount(0, { timeout: 60000 });
    await page.getByRole("button", { name: "下一步", exact: true }).click();
    await page.getByRole("button", { name: /内置 PostgreSQL/ }).click();
    await page.getByLabel("数据库端口", { exact: true }).fill("55435");
    await page.getByLabel("数据库数据目录").fill(resolve(dir, "postgres"));
    await page.getByLabel("私有文件目录").fill(resolve(dir, "files"));
    await page.getByRole("button", { name: "下一步", exact: true }).click();
    await page
      .getByLabel("网站名称", { exact: true })
      .fill("内置数据库安装验收");
    await page.getByLabel("网站监听端口").fill("3013");
    await page.getByLabel("浏览器访问地址").fill("http://localhost:3013");
    await page
      .getByLabel("管理员账号（邮箱）")
      .fill("embedded-owner@installation.invalid");
    await page.getByLabel("管理员密码", { exact: true }).fill(password);
    await page.getByLabel("确认密码").fill(password);
    await page.getByRole("button", { name: "下一步", exact: true }).click();
    await page.getByRole("checkbox", { name: /确认配置正确/ }).check();
    await page.getByRole("button", { name: "开始安装", exact: true }).click();
    await installed(page, "安装完成");
    await shot(page, "08-embedded-complete");
    const saved = JSON.parse(await readFile(file, "utf8"));
    expect(saved.mode).toBe("embedded");
    expect(saved.env.PG_PASSWORD).not.toBe("local-development-only");
    expect(saved.env.PG_DATA_DIR).toBe(resolve(dir, "postgres"));
    const state = await readFile(resolve(dir, "state.json"), "utf8");
    expect(state).not.toContain(password);
    expect(state).not.toContain(saved.env.PG_PASSWORD);
    await context.close();
    context = null;
    launcher.kill("SIGTERM");
    if (launcher.exitCode === null)
      await new Promise((r) => launcher.once("exit", r));
    expect(
      (await (await fetch("http://localhost:3013/api/health")).json())
        .installation_id,
    ).toBe(saved.installationId);
    await stop(dir);
    const runtime = spawn("bash", ["start.sh"], {
      cwd: copy,
      env,
      stdio: "ignore",
    });
    await expect
      .poll(async () => Boolean((await runtimeControl("status", dir))?.ready), {
        timeout: 30000,
      })
      .toBe(true);
    const app = await browser.newContext({ baseURL: "http://localhost:3013" });
    const login = await app.request.post("/api/auth/login", {
      headers: { "x-island-request": "1" },
      data: { email: "embedded-owner@installation.invalid", password },
    });
    expect(login.status()).toBe(200);
    expect((await app.request.get("/api/admin/overview")).status()).toBe(200);
    await app.close();
    await stop(dir);
    if (runtime.exitCode === null)
      await new Promise((r) => runtime.once("exit", r));
  } finally {
    await context?.close();
    await stop(dir).catch(() => {});
    launcher.kill("SIGTERM");
    if (launcher.exitCode === null)
      await new Promise((r) => launcher.once("exit", r));
    await rm(dir, { recursive: true, force: true });
  }
});

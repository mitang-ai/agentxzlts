import { test, expect } from "@playwright/test";
import { Pool } from "pg";

// Generated passwords must not end up in trace, screenshots or saved HTML.
test.use({ trace: "off", screenshot: "off", video: "off" });

test("一键创建、保存提示、复制、退出后用生成账密重新登录", async ({
  page,
  context,
  baseURL,
}) => {
  expect(new URL(baseURL!).hostname).toBe("localhost");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  let id: string | undefined;
  try {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto("/");
    let registrations = 0;
    page.on("request", (r) => {
      if (r.url().endsWith("/api/auth/register")) registrations++;
    });
    await page
      .getByRole("button", { name: "一键创建账号密码", exact: true })
      .evaluate((button: HTMLButtonElement) => {
        button.click();
        button.click();
      });
    const dialog = page.getByRole("dialog", { name: "账号已创建并登录" });
    await expect(dialog).toBeVisible();
    const email = await dialog
      .getByLabel("登录账号", { exact: true })
      .inputValue();
    const password = await dialog
      .getByLabel("登录密码（明文，仅供本人保存）")
      .inputValue();
    expect(email).toMatch(/^member-[a-f0-9]{32}@accounts\.invalid$/);
    expect(password).toMatch(/^[a-f0-9]{48}$/);
    await expect(dialog.getByText(/请妥善保管自己的账号和密码/)).toBeVisible();
    id = (await context.request.get("/api/auth/me").then((r) => r.json())).user
      .id;
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "复制账号和密码" }).click();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied === `协作岛登录账号：${email}\n登录密码：${password}`).toBe(
      true,
    );
    for (const viewport of [
      { width: 1366, height: 768 },
      { width: 320, height: 568 },
    ]) {
      await page.setViewportSize(viewport);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await expect(
        dialog.getByRole("button", { name: "我已妥善保存，开始使用" }),
      ).toBeInViewport({ ratio: 1 });
    }
    expect(
      await page.evaluate(
        (value) =>
          !JSON.stringify({ ...localStorage, ...sessionStorage }).includes(
            value,
          ),
        password,
      ),
    ).toBe(true);
    await dialog
      .getByRole("button", { name: "我已妥善保存，开始使用" })
      .click();
    await expect(dialog).not.toBeVisible();
    await page.getByRole("button", { name: "个人资料", exact: true }).click();
    await page.getByRole("button", { name: "退出登录", exact: true }).click();
    await page.getByLabel("邮箱 / 登录账号").fill(email);
    await page.locator('input[name="password"]').fill(password);
    await page
      .locator(
        ".auth-card form button[type=submit], .auth-card form button.primary",
      )
      .click();
    await expect(
      page.getByRole("complementary", { name: "协作岛导航" }),
    ).toBeVisible();
    expect(
      (await context.request.get("/api/auth/me").then((r) => r.json())).user
        .id === id,
    ).toBe(true);
    expect(registrations).toBe(1);
  } finally {
    await page.goto("about:blank");
    if (id) {
      await pool.query("delete from realtime_connections where user_id=$1", [
        id,
      ]);
      await pool.query("delete from auth.users where id=$1", [id]);
    }
    await pool.end();
  }
});

test("响应丢失后恢复同一账号，注册关闭时不能绕过", async ({
  page,
  context,
  baseURL,
}) => {
  expect(new URL(baseURL!).hostname).toBe("localhost");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  let email: string | undefined;
  const original = (
    await pool.query("select value from site_settings where key='operations'")
  ).rows[0].value;
  try {
    await page.goto("/");
    let first = true;
    await page.route("**/api/auth/register", async (route) => {
      if (!first) return route.continue();
      first = false;
      email = route.request().postDataJSON().email;
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      await route.abort("failed");
    });
    await page
      .getByRole("button", { name: "一键创建账号密码", exact: true })
      .click();
    await expect(page.getByText(/尚未确认创建成功/)).toBeVisible();
    await expect(page.getByLabel("登录账号", { exact: true })).toHaveValue(
      email!,
    );
    await page
      .getByRole("button", { name: "重试创建 / 恢复登录", exact: true })
      .click();
    await expect(
      page.getByRole("dialog", { name: "账号已创建并登录" }),
    ).toBeVisible();
    expect(
      Number(
        (
          await pool.query("select count(*) n from auth.users where email=$1", [
            email,
          ])
        ).rows[0].n,
      ),
    ).toBe(1);
    await page.getByRole("button", { name: "我已妥善保存，开始使用" }).click();
    await context.request.post("/api/auth/logout", {
      headers: { origin: baseURL!, "x-island-request": "1" },
      data: {},
    });
    await pool.query(
      "update site_settings set value=$1 where key='operations'",
      [{ ...original, registration: false }],
    );
    await page.reload();
    await expect(
      page.getByRole("button", { name: "一键创建账号密码", exact: true }),
    ).toBeDisabled();
    const denied = await context.request.post("/api/auth/register", {
      headers: { origin: baseURL!, "x-island-request": "1" },
      data: {
        email: "denied@quick-account.invalid",
        password: "Only-Isolated-Fixture-2026",
        display_name: "Denied",
      },
    });
    expect(denied.status()).toBe(403);
    await pool.query(
      "update site_settings set value=$1 where key='operations'",
      [{ ...original, maintenance: true }],
    );
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "网站维护中" }),
    ).toBeVisible();
    expect(
      (
        await context.request.post("/api/auth/register", {
          headers: { origin: baseURL!, "x-island-request": "1" },
          data: {
            email: "maintenance@quick-account.invalid",
            password: "Only-Isolated-Fixture-2026",
            display_name: "Denied",
          },
        })
      ).status(),
    ).toBe(403);
  } finally {
    await page.goto("about:blank");
    await pool.query(
      "update site_settings set value=$1 where key='operations'",
      [original],
    );
    if (email) {
      const ids = (
        await pool.query("select id from auth.users where email=$1", [email])
      ).rows.map((r) => r.id);
      await pool.query(
        "delete from realtime_connections where user_id=any($1::uuid[])",
        [ids],
      );
      await pool.query("delete from auth.users where id=any($1::uuid[])", [
        ids,
      ]);
    }
    await pool.end();
  }
});

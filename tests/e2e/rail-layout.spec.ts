import { test, expect } from "@playwright/test";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";

test("导航在普通桌面高度无需滚动，短窗口固定底部，手机无横向溢出", async ({
  page,
  context,
  baseURL,
}) => {
  expect(new URL(baseURL!).hostname).toBe("localhost");
  const email = `${randomUUID()}@rail-layout.invalid`;
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const registered = await context.request.post("/api/auth/register", {
      headers: { origin: baseURL!, "x-island-request": "1" },
      data: {
        email,
        password: "Rail-Layout-Fixture-2026",
        display_name: "导航布局验收",
      },
    });
    expect(registered.status(), await registered.text()).toBe(200);
    await page.goto("/");
    const rail = page.getByRole("complementary", { name: "协作岛导航" });
    const nav = rail.getByRole("navigation", { name: "主要功能" });
    await expect(rail).toBeVisible();
    for (const [width, height] of [
      [1366, 900],
      [1366, 768],
      [1366, 640],
      [1024, 768],
    ]) {
      await page.setViewportSize({ width, height });
      expect(
        await rail.evaluate((el) => el.scrollHeight <= el.clientHeight + 1),
      ).toBe(true);
      expect(
        await nav.evaluate((el) => el.scrollHeight <= el.clientHeight + 1),
      ).toBe(true);
      for (const action of await rail.locator("button, a").all()) {
        await expect(action).toBeInViewport({ ratio: 1 });
      }
    }
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.screenshot({ path: "test-results/rail-desktop-768.png" });

    // Small utility windows may scroll only the main nav, never bury settings.
    await page.setViewportSize({ width: 1366, height: 300 });
    await expect(
      rail.getByRole("button", { name: "设置", exact: true }),
    ).toBeInViewport({ ratio: 1 });
    await expect(
      rail.getByRole("button", { name: "个人资料", exact: true }),
    ).toBeInViewport({ ratio: 1 });
    expect(
      await rail.evaluate((el) => el.scrollHeight <= el.clientHeight + 1),
    ).toBe(true);
    expect(await nav.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(
      true,
    );
    await nav.getByRole("button", { name: "自研 Agent", exact: true }).click();
    await expect(
      nav.getByRole("button", { name: "自研 Agent", exact: true }),
    ).toHaveClass("selected");
    await rail.getByRole("button", { name: "设置", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "关闭", exact: true })
      .click();
    await page.screenshot({ path: "test-results/rail-short-window.png" });

    for (const [width, height] of [
      [390, 844],
      [320, 568],
    ]) {
      await page.setViewportSize({ width, height });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
      for (const action of await nav.getByRole("button").all())
        await expect(action).toBeInViewport({ ratio: 1 });
      await expect(
        rail.getByRole("button", { name: "个人资料", exact: true }),
      ).toBeInViewport({ ratio: 1 });
      await rail.getByRole("button", { name: "个人资料", exact: true }).click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "关闭", exact: true })
        .click();
    }
    await page.screenshot({ path: "test-results/rail-mobile-320.png" });
    // The production site has notices above the app, unlike a fresh account
    // fixture. Their height must be shared with the app, never added to 100dvh.
    for (const noticeCount of [1, 2]) {
      await page.evaluate((count) => {
        document
          .querySelectorAll("[data-rail-notice]")
          .forEach((el) => el.remove());
        const app = document.querySelector(".app")!;
        for (let i = 0; i < count; i++) {
          const notice = document.createElement("div");
          notice.className = i === 0 ? "site-announcement" : "site-sync-error";
          notice.dataset.railNotice = "fixture";
          notice.textContent = "公告高度回归：欢迎来到协作岛，一起把想法做成。";
          app.before(notice);
        }
      }, noticeCount);
      for (const [width, height] of [
        [1366, 900],
        [1366, 768],
        [1366, 640],
        [1366, 300],
        [390, 844],
        [320, 568],
      ]) {
        await page.setViewportSize({ width, height });
        expect(
          await page.evaluate(
            () => document.documentElement.scrollHeight <= innerHeight + 1,
          ),
        ).toBe(true);
        for (const name of width >= 768 ? ["设置", "个人资料"] : ["个人资料"]) {
          await expect(
            rail.getByRole("button", { name, exact: true }),
          ).toBeInViewport({ ratio: 1 });
        }
        if (width >= 768 && height >= 640) {
          expect(
            await nav.evaluate((el) => el.scrollHeight <= el.clientHeight + 1),
          ).toBe(true);
        }
      }
    }
    await page.evaluate(() =>
      document
        .querySelectorAll("[data-rail-notice]")
        .forEach((el) => el.remove()),
    );
  } finally {
    await page.goto("about:blank");
    const profiles = (
      await pool.query("select id from profiles where email=$1", [email])
    ).rows.map((row) => row.id);
    await pool.query(
      "delete from realtime_connections where user_id=any($1::uuid[])",
      [profiles],
    );
    await pool.query("delete from auth.users where id=any($1::uuid[])", [
      profiles,
    ]);
    await pool.end();
  }
});

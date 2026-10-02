import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";

test("多用户/多标签页在线、输入 @ 提及人与 Agent、邀请码单删及批量清理", async ({
  page,
  context,
  browser,
}) => {
  test.setTimeout(150000);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL }),
    guest = await browser.newContext({
      baseURL: process.env.E2E_BASE_URL || "http://localhost:3102",
    });
  const uid = randomUUID(),
    emails = [uid + "@chat-ux.invalid", randomUUID() + "@chat-ux.invalid"];
  let room: string | undefined;
  const origin = process.env.E2E_BASE_URL || "http://localhost:3102";
  expect(new URL(origin).hostname).toBe("localhost");
  async function post(c: BrowserContext, path: string, data: any) {
    const r = await c.request.post(path, {
      headers: { origin, "x-island-request": "1" },
      data,
    });
    expect(r.status(), await r.text()).toBe(200);
    return r.json();
  }
  async function command(c: BrowserContext, name: string, data: any) {
    return post(c, "/api/command", { command: name, data });
  }
  async function open(p: Page) {
    await p.goto("/");
    await p.getByRole("button", { name: /在线与提及验收/ }).click();
    await expect(
      p.getByRole("heading", { name: "在线与提及验收", exact: true }),
    ).toBeVisible();
  }
  try {
    await post(context, "/api/auth/register", {
      email: emails[0],
      password: "Chat-UX-Testing-2026",
      display_name: "房间主人",
    });
    await post(guest, "/api/auth/register", {
      email: emails[1],
      password: "Chat-UX-Testing-2026",
      display_name: "小林",
    });
    room = (
      await command(context, "create_room", {
        name: "在线与提及验收",
        icon: "🏝️",
      })
    ).id;
    const invite = await command(context, "invite", {
      room_id: room,
      hours: 1,
      max_uses: 2,
    });
    await command(guest, "join_invite", { token: invite.token });
    await open(page);
    const visitor = await guest.newPage();
    await open(visitor);
    await expect
      .poll(async () => {
        const r = await context.request.get(`/api/rooms/${room}`);
        return (await r.json()).participants.find(
          (p: any) => p.display_name === "小林",
        ).online;
      })
      .toBe(true);
    // 切换标签/应用不等于断线；同时模拟后台可见性事件，复现旧客户端主动置离线的问题。
    await visitor.evaluate(() => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => "hidden",
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await page.getByRole("button", { name: "成员", exact: true }).click();
    await expect(
      page
        .getByRole("dialog")
        .locator(".member-row")
        .filter({ hasText: "小林" }),
    ).toContainText("在线");
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "关闭", exact: true })
      .click();
    const secondTab = await guest.newPage();
    await open(secondTab);
    await secondTab.close();
    await expect
      .poll(async () => {
        const r = await context.request.get(`/api/rooms/${room}`);
        return (await r.json()).participants.find(
          (p: any) => p.display_name === "小林",
        ).online;
      })
      .toBe(true);

    await page.getByRole("button", { name: "联机席位", exact: true }).click();
    const panel = page.getByRole("region", { name: "联机席位" });
    const paired = await post(context, `/api/rooms/${room}/agents/pairing`, {});
    const agent = await post(context, "/api/agent-node/pair", {
      code: paired.code,
      node_name: "本地验收设备",
      agent_name: "代码 Agent",
      adapter: "cli",
      fingerprint: randomUUID(),
      capabilities: {},
    });
    await post(context, `/api/rooms/${room}/agents/approve`, {
      participant_id: agent.participant_id,
    });
    await page
      .getByRole("main")
      .getByRole("button", { name: "聊天", exact: true })
      .click();
    const input = page.getByRole("textbox", { name: "消息", exact: true });
    await input.fill("@");
    const options = page.getByRole("option");
    await expect(options).toHaveCount(3);
    await input.press("ArrowDown");
    await expect(options.nth(1)).toHaveAttribute("aria-selected", "true");
    await input.press("ArrowUp");
    await expect(options.nth(0)).toHaveAttribute("aria-selected", "true");
    await input.fill("你好 @小");
    await expect(
      page.getByRole("listbox", { name: "提及房间成员" }),
    ).toBeVisible();
    await page.getByRole("option", { name: /小林/ }).click();
    await expect(input).toHaveValue("你好 @小林 ");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect
      .poll(async () => {
        const r = await context.request.get(`/api/rooms/${room}`);
        const s = await r.json();
        return s.messages.find((m: any) => m.content === "你好 @小林")
          ?.mentioned_participant_ids.length;
      })
      .toBe(1);
    await input.fill("@代码");
    await expect(
      page.getByRole("option", { name: /代码 Agent/ }),
    ).toBeVisible();
    await input.press("Enter");
    await expect(input).toHaveValue("@代码 Agent ");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect
      .poll(async () => {
        const r = await context.request.get(`/api/rooms/${room}`);
        return (await r.json()).messages.find(
          (m: any) => m.content === "@代码 Agent",
        )?.mentioned_participant_ids;
      })
      .toEqual([agent.participant_id]);
    await input.fill("email@example.com");
    await expect(page.getByRole("listbox")).toHaveCount(0);
    await input.fill("@没有此成员");
    await expect(page.getByText("没有匹配的成员或 Agent")).toBeVisible();
    await input.press("Escape");
    await expect(page.getByRole("listbox")).toHaveCount(0);
    await visitor.close();
    await expect
      .poll(async () => {
        const r = await context.request.get(`/api/rooms/${room}`);
        return (await r.json()).participants.find(
          (p: any) => p.display_name === "小林",
        ).online;
      })
      .toBe(false);

    await page.getByRole("button", { name: "我的 Agent", exact: true }).click();
    const invites = page.getByRole("region", { name: "我的连接邀请" });
    const pending = invites.locator('.agent-invite[data-status="pending"]');
    const codes: any[] = [];
    for (let i = 0; i < 5; i++) {
      const wait = page.waitForResponse(
        (r) =>
          r.url().endsWith("/api/my-agents/pairing") &&
          r.request().method() === "POST",
      );
      await page
        .getByRole("button", { name: "复制新 Agent 连接提示词", exact: true })
        .click();
      codes.push(await (await wait).json());
      await expect(pending).toHaveCount(i + 1);
    }
    await page
      .getByRole("button", { name: "复制新 Agent 连接提示词", exact: true })
      .click();
    await expect(
      page.getByText("未使用的配对码过多，请撤销旧码后再试。", { exact: true }),
    ).toBeVisible();
    page.on("dialog", (d) => d.accept());
    await invites
      .getByLabel("连接邀请 " + codes[0].id, { exact: true })
      .getByRole("button", { name: "删除记录", exact: true })
      .click();
    await expect(pending).toHaveCount(4);
    expect(
      (
        await context.request.post("/api/agent-node/client", {
          data: { code: codes[0].code },
        })
      ).status(),
    ).toBe(403);
    await page
      .getByRole("button", { name: "复制新 Agent 连接提示词", exact: true })
      .click();
    await expect(pending).toHaveCount(5);
    await page.reload();
    await page.getByRole("button", { name: "我的 Agent", exact: true }).click();
    await expect(pending).toHaveCount(5);
    await invites
      .getByRole("button", { name: "一键删除未使用邀请", exact: true })
      .click();
    await expect(pending).toHaveCount(0);
    expect(
      (
        await (await context.request.get(`/api/rooms/${room}/agents`)).json()
      ).seats.map((s: any) => s.participant_id),
    ).toContain(agent.participant_id);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await invites.evaluate((e) => e.scrollWidth <= e.clientWidth + 1),
    ).toBe(true);
    await page.screenshot({
      path: "test-results/chat-ux-mobile.png",
      fullPage: true,
    });
  } finally {
    await guest.close();
    await page.goto("about:blank");
    if (room) await pool.query("delete from rooms where id=$1", [room]);
    const users = (
      await pool.query("select id from profiles where email=any($1::text[])", [
        emails,
      ])
    ).rows.map((r) => r.id);
    await pool.query(
      "delete from realtime_connections where user_id=any($1::uuid[])",
      [users],
    );
    await pool.query("delete from auth.users where id=any($1::uuid[])", [
      users,
    ]);
    await pool.end();
  }
});

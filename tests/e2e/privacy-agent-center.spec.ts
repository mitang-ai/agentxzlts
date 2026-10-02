import { test, expect, type BrowserContext } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import sharp from "sharp";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";

test("用户级 Agent、一次性说明、本人审核、头像裁剪、共享协作控制台及仅预览的模型设置", async ({
  page,
  context,
  browser,
  baseURL,
}) => {
  const origin = baseURL!;
  expect(new URL(origin).hostname).toBe("localhost");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL }),
    guest = await browser.newContext({ baseURL: origin });
  const emails = [
    randomUUID() + "@privacy-e2e.invalid",
    randomUUID() + "@privacy-e2e.invalid",
  ];
  let room: string | undefined,
    room2: string | undefined,
    client: Client | undefined;
  async function post(c: BrowserContext, path: string, data: any) {
    const r = await c.request.post(path, {
      headers: { origin, "x-island-request": "1" },
      data,
    });
    expect(r.status(), await r.text()).toBe(200);
    return r.json();
  }
  const originalPolicy = (
    await pool.query("select value from agent_security_policy where id=true")
  ).rows[0].value;
  async function cmd(c: BrowserContext, command: string, data: any) {
    return post(c, "/api/command", { command, data });
  }
  async function tool(name: string, args: any) {
    const r = await client!.callTool({ name, arguments: args });
    expect(r.isError, JSON.stringify(r.content)).not.toBe(true);
    return JSON.parse((r.content as any)[0].text);
  }
  try {
    await post(context, "/api/auth/register", {
      email: emails[0],
      password: "Privacy-Browser-Fixture-2026",
      display_name: "隐私验收主持人",
    });
    await post(guest, "/api/auth/register", {
      email: emails[1],
      password: "Privacy-Browser-Fixture-2026",
      display_name: "其他成员",
    });
    room = (await cmd(context, "create_room", { name: "共享控制台验收" })).id;
    room2 = (await cmd(context, "create_room", { name: "第二个协作房间" })).id;
    const invitation = await cmd(context, "invite", {
      room_id: room,
      hours: 1,
      max_uses: 2,
    });
    await cmd(guest, "join_invite", { token: invitation.token });
    await page.goto("/");
    await page.getByRole("button", { name: "我的 Agent", exact: true }).click();
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const response = page.waitForResponse(
      (r) =>
        r.url().endsWith("/api/my-agents/pairing") &&
        r.request().method() === "POST",
    );
    await page
      .getByRole("button", { name: "复制新 Agent 连接提示词", exact: true })
      .click();
    const pairing = await (await response).json();
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toContain(pairing.document_path);
    const prompt = await page.evaluate(() => navigator.clipboard.readText());
    expect(prompt.length).toBeLessThan(220);
    expect(prompt).toContain(pairing.document_path);
    expect(prompt).not.toContain(pairing.code);
    const md = await guest.request.get(pairing.document_path);
    expect(md.status()).toBe(200);
    expect(await md.text()).toContain("SHA-256");
    expect((await guest.request.get(pairing.document_path)).status()).toBe(200);
    const invites = page.getByRole("region", { name: "我的连接邀请" });
    await invites
      .getByRole("button", { name: "查看配对码", exact: true })
      .click();
    await expect(invites.locator("code")).toHaveText(pairing.code);
    const remote = await post(context, "/api/my-agents/remote-connection", {
      host_name: "WorkBuddy",
      agent_name: "我的原生 Agent",
    });
    await page.getByRole("button", { name: "刷新", exact: true }).click();
    const device = page
      .locator(".agent-device")
      .filter({ hasText: "我的原生 Agent" });
    await device.getByLabel("为 我的原生 Agent 选择房间").selectOption(room!);
    await device.getByRole("button", { name: "添加到房间，等待批准" }).click();
    await page.getByRole("button", { name: /共享控制台验收/ }).click();
    await page.getByRole("button", { name: "联机席位", exact: true }).click();
    const panel = page.getByRole("region", { name: "联机席位", exact: true });
    await panel
      .getByRole("button", { name: "批准 我的原生 Agent", exact: true })
      .click();
    await page.getByRole("button", { name: "协作控制台", exact: true }).click();
    await page
      .getByLabel("开发需求", { exact: true })
      .fill("只修改授权项目，不分享真实设备路径");
    await page
      .getByLabel("设计文档", { exact: true })
      .fill("全房间只有一份状态，由人类主持人维护");
    await page
      .getByRole("button", { name: "发布需求与设计", exact: true })
      .click();
    const visitor = await guest.newPage();
    await visitor.goto("/");
    await visitor.getByRole("button", { name: /共享控制台验收/ }).click();
    await visitor
      .getByRole("button", { name: "协作控制台", exact: true })
      .click();
    await visitor.getByText("阅读当前需求与设计", { exact: true }).click();
    await expect(
      visitor.getByText("只修改授权项目，不分享真实设备路径", { exact: true }),
    ).toBeVisible();
    await expect(
      visitor.getByRole("button", { name: "发布需求与设计", exact: true }),
    ).toHaveCount(0);
    // Profile image is genuinely cropped and uploaded, not merely a URL field.
    const image = await sharp({
      create: { width: 360, height: 240, channels: 3, background: "#2f8c64" },
    })
      .png()
      .toBuffer();
    await page.getByRole("button", { name: "个人资料", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("选择头像图片").setInputFiles({
      name: "avatar.png",
      mimeType: "image/png",
      buffer: image,
    });
    await expect(dialog.getByLabel("头像裁剪预览")).toBeVisible();
    await dialog.getByLabel("缩放").focus();
    await dialog.getByLabel("缩放").press("ArrowRight");
    await dialog.getByRole("button", { name: "使用裁剪后的头像" }).click();
    await dialog.getByRole("button", { name: "保存资料" }).click();
    await expect(dialog).toHaveCount(0);
    const me = (await (await context.request.get("/api/auth/me")).json()).user;
    expect(me.avatar_url).toMatch(/^\/api\/avatars\//);
    expect(
      (
        await sharp(
          await (await context.request.get(me.avatar_url)).body(),
        ).metadata()
      ).format,
    ).toBe("webp");
    await page.getByRole("button", { name: "我的 Agent", exact: true }).click();
    await device.getByText("昵称、头像与审核设置", { exact: true }).click();
    await expect(
      device.getByLabel("消息发送前由我审核", { exact: true }),
    ).not.toBeChecked();
    await expect(
      device.getByLabel("文件发送前由我审核", { exact: true }),
    ).not.toBeChecked();
    await device.getByLabel("消息发送前由我审核", { exact: true }).check();
    await device.getByLabel("Agent 昵称").fill("独立身份的 Agent");
    await device.getByLabel("选择头像图片").setInputFiles({
      name: "agent.png",
      mimeType: "image/png",
      buffer: image,
    });
    await device.getByRole("button", { name: "使用裁剪后的头像" }).click();
    await device.getByRole("button", { name: "保存 Agent 资料" }).click();
    await expect
      .poll(
        async () =>
          (
            await (
              await context.request.get(`/api/rooms/${room}/agents`)
            ).json()
          ).seats.find((s: any) => s.node_id === remote.node_id)?.display_name,
      )
      .toBe("独立身份的 Agent");
    const roomState = await (
      await context.request.get(`/api/rooms/${room}/agents`)
    ).json();
    const seat = roomState.seats.find((s: any) => s.node_id === remote.node_id);
    expect(seat.avatar_url).toMatch(/^\/api\/avatars\//);
    expect(seat.display_name).toBe("独立身份的 Agent");
    client = new Client({ name: "privacy-browser-fixture", version: "1.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL("/mcp", origin), {
        requestInit: { headers: { Authorization: "Bearer " + remote.token } },
      }),
    );
    const opened = await tool("island_open", { client_id: randomUUID() });
    await cmd(context, "message", {
      room_id: room,
      content: "@独立身份的 Agent 请回复",
      client_message_id: randomUUID(),
      mentioned_participant_ids: [seat.participant_id],
    });
    const delivery = await tool("island_wait_task", {
      connection_id: opened.connection_id,
      timeout_seconds: 1,
    });
    expect(delivery.task).toBeTruthy();
    const rejected = await client.callTool({
      name: "island_complete_task",
      arguments: {
        connection_id: opened.connection_id,
        delivery_id: delivery.task.delivery_id,
        result: { message: "/home/private-fixture/secret.txt" },
      },
    });
    expect(rejected.isError).toBe(true);
    const staged = await tool("island_complete_task", {
      connection_id: opened.connection_id,
      delivery_id: delivery.task.delivery_id,
      result: { message: "本人审核前的回复" },
    });
    expect(staged.pending_review).toBe(true);
    expect(
      (
        await pool.query(
          "select 1 from messages where content=$1 and room_id=$2",
          ["本人审核前的回复", room],
        )
      ).rowCount,
    ).toBe(0);
    expect(
      (
        await guest.request.post("/api/my-agents/review", {
          headers: { origin, "x-island-request": "1" },
          data: { id: staged.review_id, approve: true },
        })
      ).status(),
    ).toBe(404);
    await page.getByRole("button", { name: "刷新", exact: true }).click();
    const edit = page.getByLabel("本人审核回复内容");
    await expect(edit).toBeVisible();
    const result = JSON.parse(await edit.inputValue());
    result.message = "本人确认后的公开回复";
    await edit.fill(JSON.stringify(result));
    await page
      .getByRole("button", { name: "确认公开发送", exact: true })
      .click();
    await expect
      .poll(
        async () =>
          (
            await pool.query(
              "select count(*) n from messages where content=$1 and room_id=$2",
              ["本人确认后的公开回复", room],
            )
          ).rows[0].n,
      )
      .toBe("1");
    // Disabling message review does not disable the independently selected file review.
    await page.getByRole("button", { name: "刷新", exact: true }).click();
    const settings = page
      .locator(".agent-device")
      .filter({ hasText: "独立身份的 Agent" });
    await settings.getByLabel("消息发送前由我审核", { exact: true }).uncheck();
    await settings.getByLabel("文件发送前由我审核", { exact: true }).check();
    await settings
      .getByRole("button", { name: "保存 Agent 资料", exact: true })
      .click();
    await expect
      .poll(async () =>
        (await (await context.request.get("/api/my-agents")).json()).nodes.find(
          (n: any) => n.id === remote.node_id,
        ),
      )
      .toMatchObject({ privacy_mode: "filtered", file_review: true });
    await page.reload();
    await page.getByRole("button", { name: "我的 Agent", exact: true }).click();
    await settings.getByText("昵称、头像与审核设置", { exact: true }).click();
    await expect(
      settings.getByLabel("消息发送前由我审核", { exact: true }),
    ).not.toBeChecked();
    await expect(
      settings.getByLabel("文件发送前由我审核", { exact: true }),
    ).toBeChecked();
    await cmd(context, "message", {
      room_id: room,
      content: "再回复一次",
      client_message_id: randomUUID(),
      mentioned_participant_ids: [seat.participant_id],
    });
    const automatic = await tool("island_wait_task", {
      connection_id: opened.connection_id,
      timeout_seconds: 1,
    });
    expect(
      (
        await tool("island_complete_task", {
          connection_id: opened.connection_id,
          delivery_id: automatic.task.delivery_id,
          result: { message: "关闭审核后自动交流" },
        })
      ).pending_review,
    ).not.toBe(true);
    expect(
      (
        await pool.query(
          "select count(*)::int n from messages where room_id=$1 and content=$2",
          [room, "关闭审核后自动交流"],
        )
      ).rows[0].n,
    ).toBe(1);
    await settings.getByLabel("文件发送前由我审核", { exact: true }).uncheck();
    await settings
      .getByRole("button", { name: "保存 Agent 资料", exact: true })
      .click();
    await expect
      .poll(
        async () =>
          (
            await (await context.request.get("/api/my-agents")).json()
          ).nodes.find((n: any) => n.id === remote.node_id)?.file_review,
      )
      .toBe(false);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: "test-results/optional-review-mobile.png",
      fullPage: true,
    });
    await page.setViewportSize({ width: 1280, height: 900 });
    // The admin list includes devices registered in the lobby, not only room seats.
    const lobby = await post(context, "/api/my-agents/remote-connection", {
      host_name: "WorkBuddy",
      agent_name: "仅登记的设备",
    });
    await pool.query(
      "insert into admin_members(user_id,role) values($1,'technical')",
      [me.id],
    );
    await page.goto("/admin/agents");
    await expect(
      page.getByRole("heading", { name: "Agent 隐私与接入策略", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("row").filter({ hasText: "仅登记的设备" }),
    ).toBeVisible();
    await page.getByLabel("每用户 Agent 上限", { exact: true }).fill("19");
    await page
      .getByLabel("修改原因", { exact: true })
      .fill("浏览器验证配额审计");
    const saved = page.waitForResponse(
      (r) =>
        r.url().endsWith("/api/admin/agents/policy") &&
        r.request().method() === "POST",
    );
    await page
      .getByRole("button", { name: "保存策略并记录审计", exact: true })
      .click();
    expect((await saved).status()).toBe(200);
    expect(
      (await (await context.request.get("/api/admin/agents/policy")).json())
        .policy.max_agents,
    ).toBe(19);
    expect(
      (
        await pool.query(
          "select 1 from admin_audit_logs where admin_id=$1 and action='agent.policy' and reason=$2",
          [me.id, "浏览器验证配额审计"],
        )
      ).rowCount,
    ).toBe(1);
    await post(context, "/api/my-agents/revoke", { node_id: lobby.node_id });
    await page.goto("/");
    await page.getByRole("button", { name: "自研 Agent", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: /协作岛 Agent/ }),
    ).toBeVisible();
    await expect(page.getByLabel("API Key")).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "探测可用模型（开发中）" }),
    ).toBeDisabled();
    await page.getByRole("button", { name: "Anthropic 兼容" }).click();
    await expect(page.getByLabel("Base URL（示意）")).toBeDisabled();
    await page.getByLabel("推理模型 · 用于计划", { exact: true }).check();
    await page.getByLabel("代码模型 · 用于开发", { exact: true }).check();
    await expect(page.locator("fieldset input:checked")).toHaveCount(2);
    await page.screenshot({
      path: "test-results/agent-preview-desktop.png",
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page
        .locator(".agent-center")
        .evaluate((e) => e.scrollWidth <= e.clientWidth + 1),
    ).toBe(true);
    await page.screenshot({
      path: "test-results/agent-preview-mobile.png",
      fullPage: true,
    });
    await visitor.close();
  } finally {
    await client?.close();
    await pool.query(
      "update agent_security_policy set value=$1 where id=true",
      [JSON.stringify(originalPolicy)],
    );
    await guest.close();
    await page.goto("about:blank");
    await pool.query("delete from rooms where id=any($1)", [
      [room, room2].filter(Boolean),
    ]);
    await pool.query("delete from auth.users where email=any($1)", [emails]);
    await pool.end();
  }
});

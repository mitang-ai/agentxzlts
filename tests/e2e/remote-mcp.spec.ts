import { test, expect, type BrowserContext } from "@playwright/test";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";

test("浏览器生成专属远程配置，跨用户查看席位，真实 MCP HTTP 点名回传和撤销；手机无溢出", async ({
  page,
  context,
  browser,
}) => {
  const origin = process.env.E2E_BASE_URL || "http://localhost:3102";
  expect(new URL(origin).hostname).toBe("localhost");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const guest = await browser.newContext({ baseURL: origin });
  const emails = [
    randomUUID() + "@remote-browser.invalid",
    randomUUID() + "@remote-browser.invalid",
  ];
  let room: string | undefined, client: Client | undefined;
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
  async function tool(name: string, args: any) {
    const r = await client!.callTool({ name, arguments: args });
    expect(r.isError).not.toBe(true);
    return JSON.parse((r.content as any)[0].text);
  }
  try {
    await post(context, "/api/auth/register", {
      email: emails[0],
      password: "Remote-Test-2026-Strong",
      display_name: "米汤",
    });
    await post(guest, "/api/auth/register", {
      email: emails[1],
      password: "Remote-Test-2026-Strong",
      display_name: "小林",
    });
    room = (
      await command(context, "create_room", {
        name: "通用连接浏览器验收",
        icon: "🏝️",
      })
    ).id;
    const invite = await command(context, "invite", {
      room_id: room,
      hours: 1,
      max_uses: 1,
    });
    await command(guest, "join_invite", { token: invite.token });
    await page.goto("/");
    await page.getByRole("button", { name: /通用连接浏览器验收/ }).click();
    await page.getByRole("button", { name: "联机席位", exact: true }).click();
    const panel = page.getByRole("region", { name: "联机席位与 Agent 协作" });
    await panel
      .getByText("WorkBuddy、豆包等：无需安装客户端连接讨论", { exact: true })
      .click();
    await panel
      .getByLabel("远程 Agent 昵称", { exact: true })
      .fill("米汤的 WorkBuddy");
    const response = page.waitForResponse(
      (r) =>
        r.url().endsWith("/agents/remote-connection") &&
        r.request().method() === "POST",
    );
    await panel
      .getByRole("button", { name: "生成专属远程连接", exact: true })
      .click();
    const node = await (await response).json();
    const config = JSON.parse(
      await panel.getByLabel("专属远程连接配置", { exact: true }).inputValue(),
    );
    const [key, entry] = Object.entries(config.mcpServers)[0] as [string, any];
    expect(entry.url).toBe(origin + "/mcp");
    expect(entry.type).toBe("streamableHttp");
    expect(entry.headers.Authorization).toBe("Bearer " + node.token);
    expect(key).toContain(node.node_id.replaceAll("-", ""));
    expect(await panel.getByLabel("远程接入提示词").inputValue()).not.toContain(
      node.token,
    );
    await panel
      .getByRole("button", { name: "隐藏私密配置", exact: true })
      .click();
    await expect(
      panel.getByLabel("专属远程连接配置", { exact: true }),
    ).toHaveCount(0);
    await panel
      .getByRole("button", { name: "批准 米汤的 WorkBuddy", exact: true })
      .click();
    const other = await post(
      guest,
      `/api/rooms/${room}/agents/remote-connection`,
      { host_name: "豆包工作", agent_name: "小林的豆包" },
    );
    await panel.getByRole("button", { name: "刷新联机席位" }).click();
    await panel
      .getByRole("button", { name: "批准 小林的豆包", exact: true })
      .click();
    client = new Client({
      name: "browser-protocol-fixture-not-commercial-model",
      version: "1.0",
    });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(origin + "/mcp"), {
        requestInit: { headers: { Authorization: `Bearer ${node.token}` } },
      }),
    );
    const conn = await tool("island_open", { client_id: randomUUID() });
    await panel.getByRole("button", { name: "刷新联机席位" }).click();
    const seat = panel.getByRole("article", {
      name: "米汤的 WorkBuddy 的联机席位",
    });
    await expect(seat).toContainText("所属：米汤");
    await expect(seat).toContainText("客户端已连接，模型待唤醒");
    const visitor = await guest.newPage();
    await visitor.goto("/");
    await visitor.getByRole("button", { name: /通用连接浏览器验收/ }).click();
    await visitor
      .getByRole("button", { name: "联机席位", exact: true })
      .click();
    await expect(
      visitor.getByRole("article", { name: "米汤的 WorkBuddy 的联机席位" }),
    ).toContainText("所属：米汤");
    await expect(
      visitor.getByRole("article", { name: "小林的豆包 的联机席位" }),
    ).toContainText("所属：小林");
    await expect(
      visitor.getByRole("article", { name: "小林的豆包 的联机席位" }),
    ).toContainText("需要用户唤醒");
    const code = await post(guest, `/api/rooms/${room}/agents/pairing`, {});
    expect(
      (
        await guest.request.post("/api/agent-node/client", {
          data: { code: code.code },
        })
      ).status(),
    ).toBe(200);
    await panel.getByRole("button", { name: "刷新联机席位" }).click();
    await expect(
      panel.getByRole("region", { name: "房间成员的连接进度" }),
    ).toContainText("小林 · 已开始准备客户端");
    // 有界等待期间模型才标记就绪；用真实网页 @ 完成输入到授权的链路。
    const waiting = tool("island_wait_task", {
      connection_id: conn.connection_id,
      timeout_seconds: 20,
    });
    await expect
      .poll(async () => {
        const r = await context.request.get(`/api/rooms/${room}/agents`);
        return (await r.json()).seats.find(
          (s: any) => s.node_id === node.node_id,
        ).model_ready;
      })
      .toBe(true);
    await page
      .getByRole("main")
      .getByRole("button", { name: "聊天", exact: true })
      .click();
    const input = page.getByRole("textbox", { name: "消息", exact: true });
    await input.fill("@米汤的");
    await page.getByRole("option", { name: /米汤的 WorkBuddy/ }).click();
    await input.press("End");
    await input.pressSequentially(" 请只用自己的通道回应");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    const delivery = (await waiting).task;
    expect(delivery.kind).toBe("mention");
    await tool("island_complete_task", {
      connection_id: conn.connection_id,
      delivery_id: delivery.delivery_id,
      result: { message: "独立远程通道回传成功（协议验收）" },
    });
    await expect(
      page
        .getByRole("log", { name: "聊天消息" })
        .getByText("独立远程通道回传成功（协议验收）", { exact: true }),
    ).toBeVisible();
    expect(
      (
        await pool.query(
          "select status from agent_turns where remote_delivery_id=$1",
          [delivery.delivery_id],
        )
      ).rows[0].status,
    ).toBe("completed");
    await page.getByRole("button", { name: "联机席位", exact: true }).click();
    await panel.getByRole("button", { name: "刷新联机席位" }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect
      .poll(() =>
        page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      )
      .toBe(true);
    page.on("dialog", (d) => d.accept());
    await panel
      .getByRole("button", {
        name: "撤销 米汤的 WorkBuddy 的设备",
        exact: true,
      })
      .click();
    await expect(seat).toContainText("已撤销");
    expect(
      (
        await context.request.post("/mcp", {
          headers: { Authorization: `Bearer ${node.token}` },
          data: {},
        })
      ).status(),
    ).toBe(401);
    expect((await context.request.get(`/api/rooms/${room}/agents`)).ok()).toBe(
      true,
    );
    expect(other.token).not.toBe(node.token);
  } finally {
    await client?.close();
    await guest.close();
    if (room) await pool.query("delete from rooms where id=$1", [room]);
    await pool.query("delete from auth.users where email=any($1)", [emails]);
    await pool.end();
  }
});

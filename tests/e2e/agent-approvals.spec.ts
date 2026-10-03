import { test, expect, type BrowserContext } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";

test("我的 Agent 汇总所有主持房间的他人入席审批，与房间状态同步，冻结不放行", async ({
  page,
  context,
  browser,
  baseURL,
}) => {
  const origin = baseURL!;
  expect(new URL(origin).hostname).toBe("localhost");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const guest = await browser.newContext({ baseURL: origin });
  const emails = [
    randomUUID() + "@approval-e2e.invalid",
    randomUUID() + "@approval-e2e.invalid",
  ];
  const rooms: string[] = [];
  async function post(c: BrowserContext, path: string, data: any) {
    const r = await c.request.post(path, {
      headers: { origin, "x-island-request": "1" },
      data,
    });
    expect(r.status(), await r.text()).toBe(200);
    return r.json();
  }
  const cmd = (c: BrowserContext, command: string, data: any) =>
    post(c, "/api/command", { command, data });
  try {
    await post(context, "/api/auth/register", {
      email: emails[0],
      password: "Approval-E2E-Fixture-2026",
      display_name: "房间主持人",
    });
    await post(guest, "/api/auth/register", {
      email: emails[1],
      password: "Approval-E2E-Fixture-2026",
      display_name: "设备所有者",
    });
    for (const name of ["入席审批甲房间", "入席审批乙房间"]) {
      const room = (await cmd(context, "create_room", { name })).id;
      rooms.push(room);
      const invite = await cmd(context, "invite", {
        room_id: room,
        hours: 1,
        max_uses: 1,
      });
      await cmd(guest, "join_invite", { token: invite.token });
    }
    const node = await post(guest, "/api/my-agents/remote-connection", {
      host_name: "fixture",
      agent_name: "他人的独立 Agent",
    });
    const seats = [];
    for (const room_id of rooms)
      seats.push(
        await post(guest, "/api/my-agents/add-to-room", {
          room_id,
          node_id: node.node_id,
        }),
      );
    await pool.query("update rooms set status='frozen' where id=$1", [
      rooms[1],
    ]);
    const ownerData = await (await guest.request.get("/api/my-agents")).json();
    expect(ownerData.approvals).toEqual([]);
    await page.goto("/");
    await page.getByRole("button", { name: "我的 Agent", exact: true }).click();
    const approvals = page.getByRole("region", { name: "我的房间入席审批" });
    await expect(approvals).toContainText("房间入席（2）");
    await expect(approvals).toContainText("所属：设备所有者");
    await expect(
      approvals.getByRole("button", {
        name: "批准 他人的独立 Agent 加入 入席审批乙房间",
        exact: true,
      }),
    ).toBeDisabled();
    await approvals.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: test.info().outputPath("approvals-desktop.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect
      .poll(() =>
        page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      )
      .toBe(true);
    await approvals.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: test.info().outputPath("approvals-mobile.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 1280, height: 720 });
    await approvals
      .getByRole("button", {
        name: "批准 他人的独立 Agent 加入 入席审批甲房间",
        exact: true,
      })
      .click();
    await expect(approvals).toContainText("房间入席（1）");
    const state = await (
      await context.request.get(`/api/rooms/${rooms[0]}/agents`)
    ).json();
    expect(
      state.seats.find((s: any) => s.participant_id === seats[0].participant_id)
        .state,
    ).toBe("approved");
    await pool.query("update rooms set status='active' where id=$1", [
      rooms[1],
    ]);
    await page.getByRole("button", { name: "刷新", exact: true }).click();
    await approvals
      .getByRole("button", {
        name: "拒绝 他人的独立 Agent 加入 入席审批乙房间",
        exact: true,
      })
      .click();
    await expect(approvals).toContainText("房间入席（0）");
    await page.reload();
    await page.getByRole("button", { name: "我的 Agent", exact: true }).click();
    await expect(approvals).toContainText("暂无待批准的入席申请");
    await page.setViewportSize({ width: 390, height: 844 });
    await expect
      .poll(() =>
        page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      )
      .toBe(true);
  } finally {
    await guest.close();
    for (const room of rooms)
      await pool.query("delete from rooms where id=$1", [room]);
    await pool.query("delete from auth.users where email=any($1)", [emails]);
    await pool.end();
  }
});

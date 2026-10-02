import { test, expect } from "@playwright/test";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";

test("站内撤销不依赖原生弹窗，一键生成用户可登录且不会获得管理权限", async ({
  page,
  context,
  browser,
}) => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const origin = process.env.E2E_BASE_URL || "http://localhost:3102";
  expect(new URL(origin).hostname).toBe("localhost");
  const users: string[] = [],
    other = await browser.newContext({ baseURL: origin });
  let room: string | undefined;
  const post = async (path: string, data: any) => {
    const response = await context.request.post(path, {
      headers: { origin, "x-island-request": "1" },
      data,
    });
    expect(response.status(), await response.text()).toBe(200);
    return response.json();
  };
  try {
    const registered = await post("/api/auth/register", {
      email: randomUUID() + "@admin-gen-ui.invalid",
      password: "Admin-UI-Verification-2026",
      display_name: "后台验收管理员",
    });
    users.push(registered.user.id);
    await pool.query(
      "insert into admin_members(user_id,role) values($1,'super')",
      [users[0]],
    );
    room = (
      await post("/api/command", {
        command: "create_room",
        data: { name: "设备撤销验收", icon: "🏝️" },
      })
    ).id;
    const code = await post(`/api/rooms/${room}/agents/pairing`, {});
    const node = await post("/api/agent-node/pair", {
      code: code.code,
      node_name: "测试设备",
      agent_name: "待撤销 Agent",
      adapter: "mcp",
      fingerprint: randomUUID(),
      capabilities: { host_name: "WorkBuddy" },
    });
    await post(`/api/rooms/${room}/agents/approve`, {
      participant_id: node.participant_id,
    });
    await page.addInitScript(() => {
      window.prompt = () => {
        throw Error("原生 prompt 已被宿主阻止");
      };
      window.confirm = () => {
        throw Error("原生 confirm 已被宿主阻止");
      };
    });
    await page.goto("/admin/agents");
    const row = page.getByRole("row").filter({ hasText: "待撤销 Agent" });
    await row.getByRole("button", { name: "撤销设备", exact: true }).click();
    const modal = page.getByRole("dialog");
    await expect(
      modal.getByRole("heading", { name: "撤销 Agent 设备" }),
    ).toBeVisible();
    await expect(
      modal.getByRole("button", { name: "确认执行" }),
    ).toBeDisabled();
    await modal
      .getByLabel("操作原因", { exact: true })
      .fill("回收设备接入权限");
    await modal.getByRole("checkbox").check();
    await modal.getByRole("button", { name: "确认执行" }).click();
    await expect(modal).toBeHidden();
    await expect(row).toContainText("已撤销");
    await expect(row).toContainText("离线");
    await expect(row.getByRole("button", { name: "撤销设备" })).toHaveCount(0);
    const state = (
      await pool.query(
        "select revoked_at,session_id from agent_nodes where id=$1",
        [node.node_id],
      )
    ).rows[0];
    expect(state.revoked_at).toBeTruthy();
    expect(state.session_id).toBeNull();
    const denied = await context.request.get(
      "/api/agent-node/files/" + randomUUID(),
      { headers: { authorization: "Bearer " + node.token } },
    );
    expect(denied.status()).toBe(401);
    await page.goto("/admin/users");
    const response = page.waitForResponse(
      (r) =>
        r.url().endsWith("/api/admin/users/generate") &&
        r.request().method() === "POST",
    );
    await page
      .getByRole("button", { name: "一键生成用户", exact: true })
      .click();
    const generated = await (await response).json();
    users.push(generated.user.id);
    await expect(
      page.getByRole("dialog").getByRole("heading", { name: "用户已生成" }),
    ).toBeVisible();
    await expect(page.getByLabel("生成的登录账号")).toHaveValue(
      generated.user.email,
    );
    await expect(page.getByLabel("生成的初始密码")).toHaveValue(
      generated.password,
    );
    expect((await context.request.get("/api/admin/overview")).status()).toBe(
      200,
    );
    const login = await other.request.post("/api/auth/login", {
      headers: { origin, "x-island-request": "1" },
      data: { email: generated.user.email, password: generated.password },
    });
    expect(login.status()).toBe(200);
    expect((await other.request.get("/api/admin/overview")).status()).toBe(403);
    expect(
      (
        await other.request.post("/api/admin/users/generate", {
          headers: { origin, "x-island-request": "1" },
          data: { request_id: randomUUID() },
        })
      ).status(),
    ).toBe(403);
    await page.getByRole("button", { name: "已保存，关闭" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.reload();
    await expect(
      page.getByRole("row").filter({ hasText: generated.user.email }),
    ).toBeVisible();
    await page.screenshot({
      path: "test-results/admin-generated-users.png",
      fullPage: true,
    });
    const audit = (
      await pool.query(
        "select * from admin_audit_logs where admin_id=$1 and action in ('agent.revoke','user.generate')",
        [users[0]],
      )
    ).rows;
    expect(audit).toHaveLength(2);
    expect(JSON.stringify(audit)).not.toContain(generated.password);
  } finally {
    await page.goto("about:blank");
    await other.close();
    await pool.query(
      "delete from admin_audit_logs where admin_id=any($1::uuid[])",
      [users],
    );
    if (room) await pool.query("delete from rooms where id=$1", [room]);
    await pool.query("delete from auth.users where id=any($1::uuid[])", [
      users,
    ]);
    await pool.end();
  }
});

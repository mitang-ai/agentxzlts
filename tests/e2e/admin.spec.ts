import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ||
    "postgresql://island:local-development-only@127.0.0.1:55432/postgres",
});
const suffix = Date.now();
const ids: string[] = [];
let initialSettings: any[], initialFlags: any[];
const roomIds: string[] = [];
const brandIds: string[] = [];
const emails: string[] = [];
const password = "Admin-Flow-Testing-2026";
async function account(ctx: BrowserContext, name: string) {
  const email = `u${ids.length}-${suffix}@admin-e2e.invalid`;
  emails.push(email);
  const res = await ctx.request.post("/api/auth/register", {
    headers: { "x-island-request": "1" },
    data: { email, password, display_name: name },
  });
  expect(res.ok(), await res.text()).toBe(true);
  const user = (await res.json()).user;
  ids.push(user.id);
  return user;
}
async function cmd(ctx: BrowserContext, command: string, data: any) {
  const res = await ctx.request.post("/api/command", {
    headers: { "x-island-request": "1" },
    data: { command, data },
  });
  expect(res.ok(), await res.text()).toBe(true);
  return res.json();
}
async function admin(ctx: BrowserContext, action: string, data: any) {
  const res = await ctx.request.post("/api/admin/command", {
    headers: { "x-island-request": "1" },
    data: {
      action,
      data: { confirm: true, reason: "前后台联动自动验收", ...data },
    },
  });
  expect(res.ok(), await res.text()).toBe(true);
  return res.json();
}
async function confirm(page: Page) {
  const modal = page.getByRole("dialog");
  await modal
    .getByLabel("操作原因", { exact: true })
    .fill("后台原型与前台联动验收");
  await modal.getByRole("checkbox").check();
  await modal.getByRole("button", { name: "确认执行" }).click();
  await expect(modal).toBeHidden();
}
async function screenshot(page: Page, name: string) {
  await page.screenshot({
    path: `docs/admin-screenshots/${name}.png`,
    fullPage: true,
  });
}
test.describe.serial("完整后台与现有聊天系统适配", () => {
  test.beforeAll(async () => {
    initialSettings = (await pool.query("select * from site_settings")).rows;
    initialFlags = (await pool.query("select * from feature_flags")).rows;
  });
  test.afterAll(async () => {
    await pool.query("delete from brand_assets where id=any($1::uuid[])", [
      brandIds,
    ]);
    for (const s of initialSettings)
      await pool.query("update site_settings set value=$2 where key=$1", [
        s.key,
        s.value,
      ]);
    for (const f of initialFlags)
      await pool.query(
        "update feature_flags set enabled=$2,scope=$3,targets=$4,rollout=$5 where key=$1",
        [f.key, f.enabled, f.scope, f.targets, f.rollout],
      );
    await pool.query("delete from reports where reporter_id=any($1)", [ids]);
    await pool.query("delete from rooms where id=any($1::uuid[])", [roomIds]);
    const objects = (
      await pool.query(
        "delete from storage.objects where name like any($1) returning name",
        [roomIds.map((id) => `${id}/%`)],
      )
    ).rows;
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    for (const o of objects)
      await fs.unlink(path.resolve(".data/files", o.name)).catch(() => {});
    await pool.query("delete from announcements where title like $1", [
      "后台验收%",
    ]);
    await pool.query("delete from admin_audit_logs where admin_id=any($1)", [
      ids,
    ]);
    await pool.query(
      "delete from control_events where target_user_id=any($1) or entity_id=any($2::text[])",
      [ids, roomIds],
    );
    await pool.query("delete from login_events where email=any($1)", [emails]);
    await pool.query("delete from realtime_connections where user_id=any($1)", [
      ids,
    ]);
    await pool.query(
      "delete from storage_cleanup_jobs where path like any($1)",
      [roomIds.map((id) => `${id}/%`)],
    );
    await pool.query("delete from auth.users where id=any($1)", [ids]);
    await pool.end();
  });
  test("双前台实时联动：冻结、主持人、文件、邀请、任务开关、举报、封禁与审计", async ({
    browser,
  }) => {
    const a = await browser.newContext(),
      b = await browser.newContext(),
      c = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    const pa = await a.newPage(),
      pb = await b.newPage(),
      pc = await c.newPage();
    const host = await account(a, "后台房主"),
      member = await account(b, "后台成员"),
      superUser = await account(c, "平台管理员");
    await pool.query(
      "insert into admin_members(user_id,role) values($1,'super')",
      [superUser.id],
    );
    const room = (
      await cmd(a, "create_room", { name: "后台联动房间", icon: "🏝️" })
    ).id;
    roomIds.push(room);
    const inv = await cmd(a, "invite", { room_id: room });
    await cmd(b, "join_invite", { token: inv.token });
    await pa.goto("/");
    await pb.goto("/");
    await pa.getByRole("button", { name: /后台联动房间/ }).click();
    await pb.getByRole("button", { name: /后台联动房间/ }).click();
    await pc.goto("/admin");
    await expect(
      pc.getByRole("heading", { name: "概览", exact: true }),
    ).toBeVisible();
    await expect(pc.getByText("用户总数", { exact: true })).toBeVisible();
    await screenshot(pc, "overview-desktop");
    await test.step("原型房间列表冻结，两名前台保留历史但进入只读", async () => {
      await cmd(a, "message", {
        room_id: room,
        content: "冻结前的真实历史",
        client_message_id: randomUUID(),
      });
      await pc.goto("/admin/rooms");
      await pc.getByLabel("搜索记录").fill("后台联动房间");
      await pc.getByRole("button", { name: "查询", exact: true }).click();
      const row = pc.getByRole("row").filter({ hasText: "后台联动房间" });
      await row.getByRole("button", { name: "冻结", exact: true }).click();
      await confirm(pc);
      await expect(
        pa.getByRole("textbox", { name: "消息", exact: true }),
      ).toBeDisabled();
      await expect(
        pb.getByRole("textbox", { name: "消息", exact: true }),
      ).toBeDisabled();
      await expect(
        pb
          .getByRole("log", { name: "聊天消息" })
          .getByText("冻结前的真实历史", { exact: true }),
      ).toBeVisible();
      const denied = await a.request.post("/api/command", {
        headers: { "x-island-request": "1" },
        data: {
          command: "message",
          data: {
            room_id: room,
            content: "绕过只读",
            client_message_id: randomUUID(),
          },
        },
      });
      expect(denied.status()).toBe(403);
      await screenshot(pc, "rooms-desktop");
      await row.getByRole("button", { name: "恢复", exact: true }).click();
      await confirm(pc);
      await expect(
        pa.getByRole("textbox", { name: "消息", exact: true }),
      ).toBeEnabled();
    });
    await test.step("主持人转移与任务重新分配沿用 Participant", async () => {
      const state = await (await b.request.get(`/api/rooms/${room}`)).json();
      const target = state.participants.find(
        (p: any) => p.user_id === member.id,
      );
      await admin(c, "transfer_host", { id: room, participant_id: target.id });
      await expect(
        pa.getByRole("button", { name: "邀请", exact: true }),
      ).toBeHidden();
      await expect(
        pb.getByRole("button", { name: "邀请", exact: true }),
      ).toBeVisible();
      const task = (
        await cmd(b, "create_task", {
          room_id: room,
          title: "后台重新分配",
          assignee_ids: [target.id],
        })
      ).id;
      const original = state.participants.find(
        (p: any) => p.user_id === host.id,
      );
      await admin(c, "assign_task", { id: task, assignee_ids: [original.id] });
      const tasks = (await (await a.request.get(`/api/rooms/${room}`)).json())
        .tasks;
      expect(tasks.find((t: any) => t.id === task).task_assignees).toEqual([
        { participant_id: original.id },
      ]);
    });
    await test.step("隔离真实上传文件，历史卡片保留，下载立即拒绝", async () => {
      const uploaded = await a.request.post(`/api/rooms/${room}/files`, {
        headers: { "x-island-request": "1" },
        multipart: {
          file: {
            name: "后台联动文件.txt",
            mimeType: "text/plain",
            buffer: Buffer.from("真实私有文件"),
          },
        },
      });
      expect(uploaded.ok(), await uploaded.text()).toBe(true);
      const file = (await uploaded.json()).id;
      await expect(
        pb
          .getByRole("log", { name: "聊天消息" })
          .getByText("后台联动文件.txt", { exact: true }),
      ).toBeVisible();
      await pc.goto("/admin/files");
      await pc.getByLabel("搜索记录").fill("后台联动文件");
      await pc.getByRole("button", { name: "查询", exact: true }).click();
      await pc
        .getByRole("row")
        .filter({ hasText: "后台联动文件.txt" })
        .getByRole("button", { name: "隔离", exact: true })
        .click();
      await confirm(pc);
      await expect(pb.getByText("文件已被隔离", { exact: true })).toBeVisible();
      expect((await b.request.get(`/api/files/${file}`)).status()).toBe(403);
      await screenshot(pc, "files-desktop");
      await admin(c, "file_status", { id: file, status: "normal" });
      expect((await b.request.get(`/api/files/${file}`)).status()).toBe(200);
    });
    await test.step("撤销邀请立即失效；任务功能 UI 与直接 API 同时禁用", async () => {
      await admin(c, "invite_update", { id: inv.id, revoke: true });
      const denied = await a.request.post("/api/command", {
        headers: { "x-island-request": "1" },
        data: { command: "join_invite", data: { token: inv.token } },
      });
      expect(denied.status()).toBe(403);
      await admin(c, "feature_flag", {
        key: "tasks",
        enabled: false,
        scope: "all",
        targets: [],
        rollout: 100,
      });
      await expect(
        pa.getByRole("button", { name: "任务", exact: true }),
      ).toHaveCount(0);
      const taskDenied = await b.request.post("/api/command", {
        headers: { "x-island-request": "1" },
        data: {
          command: "create_task",
          data: { room_id: room, title: "绕过开关" },
        },
      });
      expect(taskDenied.status()).toBe(403);
      await admin(c, "feature_flag", {
        key: "tasks",
        enabled: true,
        scope: "all",
        targets: [],
        rollout: 100,
      });
      await expect(
        pa.getByRole("button", { name: "任务", exact: true }).first(),
      ).toBeVisible();
    });
    await test.step("从前台举报进入后台，敏感查看与软删除都有 Audit", async () => {
      const m = (
        await cmd(a, "message", {
          room_id: room,
          content: "后台举报联动测试消息",
          client_message_id: randomUUID(),
        })
      ).id;
      await expect(
        pb
          .getByRole("log", { name: "聊天消息" })
          .getByText("后台举报联动测试消息", { exact: true }),
      ).toBeVisible();
      const messageBlock = pb
        .locator(".message")
        .filter({ hasText: "后台举报联动测试消息" });
      await messageBlock.hover();
      await messageBlock.getByRole("button", { name: /举报消息/ }).click();
      await pb.getByLabel("举报原因").fill("后台验收：举报这一条消息");
      await pb.getByRole("button", { name: "提交举报", exact: true }).click();
      await expect(pb.getByRole("dialog")).toBeHidden();
      await pc.goto("/admin/reports");
      await expect(
        pc.getByText("后台验收：举报这一条消息", { exact: true }),
      ).toBeVisible();
      const reports = await (await c.request.get("/api/admin/reports")).json();
      const r = reports.items.find((r: any) => r.target_id === m);
      const viewed = await admin(c, "content_view", { id: m });
      expect(viewed.context.some((x: any) => x.id === m)).toBe(true);
      await admin(c, "resolve_report", {
        id: r.id,
        resolution_action: "delete_message",
      });
      await expect(
        pb
          .getByRole("log", { name: "聊天消息" })
          .getByText("后台举报联动测试消息", { exact: true }),
      ).toBeHidden();
      await screenshot(pc, "reports-desktop");
      const audit = await (await c.request.get("/api/admin/audit")).json();
      expect(audit.items.some((a: any) => a.action === "content_view")).toBe(
        true,
      );
    });
    await test.step("封禁在线用户后会话失效，重新登录被拒绝", async () => {
      await pc.goto("/admin/users");
      await pc.getByLabel("搜索记录").fill("后台成员");
      await pc.getByRole("button", { name: "查询", exact: true }).click();
      const row = pc.getByRole("row").filter({ hasText: "后台成员" });
      await row.getByRole("button", { name: "查看", exact: true }).click();
      await expect(pc.getByRole("dialog")).toBeVisible();
      await screenshot(pc, "users-detail-desktop");
      await pc.getByRole("button", { name: "关闭详情" }).click();
      await admin(c, "restrict_user", { id: member.id, status: "banned" });
      await expect(
        pb.getByRole("button", { name: "个人资料", exact: true }),
      ).toBeHidden();
      const login = await b.request.post("/api/auth/login", {
        headers: { "x-island-request": "1" },
        data: { email: member.email, password },
      });
      expect(login.status()).toBe(403);
      expect((await b.request.get("/api/auth/me")).status()).toBe(401);
      await admin(c, "restrict_user", { id: member.id, status: "normal" });
    });
    await pc.goto("/admin/system");
    await expect(pc.getByText("数据库连接", { exact: true })).toBeVisible();
    await screenshot(pc, "system-desktop");
    await pc.goto("/admin/security");
    await expect(
      pc.getByRole("heading", { name: "管理员权限", exact: true }),
    ).toBeVisible();
    await screenshot(pc, "security-desktop");
    await pc.goto("/admin/audit");
    await screenshot(pc, "audit-desktop");
    await a.close();
    await b.close();
    await c.close();
  });
  test("品牌、SEO、上传策略、公告、注册与维护设置真实生效", async ({
    browser,
  }) => {
    const a = await browser.newContext({
        viewport: { width: 1600, height: 1000 },
      }),
      b = await browser.newContext();
    const user = await account(a, "运营设置管理员");
    await pool.query(
      "insert into admin_members(user_id,role) values($1,'super')",
      [user.id],
    );
    const pa = await a.newPage(),
      pb = await b.newPage();
    await pa.goto("/admin/operations");
    await expect(
      pa.getByRole("heading", { name: "网站品牌", exact: true }),
    ).toBeVisible();
    const brandPanel = pa.locator(".ad-panel").filter({
      has: pa.getByRole("heading", { name: "网站品牌", exact: true }),
    });
    await brandPanel
      .getByLabel("网站名称", { exact: true })
      .fill("协作岛测试站");
    await brandPanel
      .getByLabel("首页简介", { exact: true })
      .fill("品牌配置来自同源数据库");
    await brandPanel.getByRole("button", { name: "保存设置" }).click();
    await confirm(pa);
    await pb.goto("/");
    await expect(pb.locator(".brand").first()).toContainText("协作岛测试站");
    await expect(
      pb.getByText("品牌配置来自同源数据库", { exact: true }),
    ).toBeVisible();
    const info = initialSettings.find((s) => s.key === "information").value;
    await admin(a, "settings", {
      key: "information",
      value: {
        ...info,
        title: "协作岛后台 SEO 验收",
        description: "数据库管理的网站描述",
        icp: "测试备案信息",
        footer: "后台验收页脚",
      },
    });
    await pb.reload();
    await expect(pb).toHaveTitle("协作岛后台 SEO 验收");
    expect(
      await pb.locator('meta[name="description"]').getAttribute("content"),
    ).toBe("数据库管理的网站描述");
    await expect(pb.getByText("后台验收页脚", { exact: true })).toBeVisible();
    await admin(a, "announcement", {
      title: "后台验收公告",
      content: "真实公告已同步到前台",
      starts_at: new Date(Date.now() - 1000).toISOString(),
      ends_at: "",
      position: "all",
      dismissible: true,
      enabled: true,
    });
    await expect(
      pb.getByText("真实公告已同步到前台", { exact: true }),
    ).toBeVisible();
    await pb.getByRole("button", { name: "关闭公告 后台验收公告" }).click();
    await expect(
      pb.getByText("真实公告已同步到前台", { exact: true }),
    ).toBeHidden();
    const ops = initialSettings.find((s) => s.key === "operations").value;
    await admin(a, "settings", {
      key: "operations",
      value: { ...ops, registration: false },
    });
    await expect(
      pb.getByRole("button", { name: "注册", exact: true }),
    ).toBeDisabled();
    const registration = await b.request.post("/api/auth/register", {
      headers: { "x-island-request": "1" },
      data: {
        email: `closed-${suffix}@admin-e2e.invalid`,
        password,
        display_name: "关闭注册",
      },
    });
    expect(registration.status()).toBe(403);
    const room = (
      await cmd(a, "create_room", { name: "上传策略测试", icon: "🏝️" })
    ).id;
    roomIds.push(room);
    await admin(a, "settings", {
      key: "operations",
      value: { ...ops, max_file_mb: 1, allowed_extensions: ["png", "pdf"] },
    });
    const upload = await a.request.post(`/api/rooms/${room}/files`, {
      headers: { "x-island-request": "1" },
      multipart: {
        file: {
          name: "被禁用.txt",
          mimeType: "text/plain",
          buffer: Buffer.from("文件类型禁用"),
        },
      },
    });
    expect(upload.status()).toBe(400);
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
      "base64",
    );
    const logo = await a.request.post("/api/admin/brand", {
      headers: { "x-island-request": "1" },
      multipart: {
        reason: "品牌资源上传验收",
        file: { name: "logo.png", mimeType: "image/png", buffer: png },
      },
    });
    expect(logo.ok(), await logo.text()).toBe(true);
    const asset = (await logo.json()).url;
    brandIds.push(asset.split("/").at(-1));
    await admin(a, "settings", {
      key: "brand",
      value: {
        ...initialSettings.find((s) => s.key === "brand").value,
        name: "协作岛测试站",
        logo: asset,
        favicon: asset,
      },
    });
    await expect(pb.locator("img.site-logo").first()).toHaveAttribute(
      "src",
      asset,
    );
    await expect(pb.locator('link[rel="icon"]')).toHaveAttribute("href", asset);
    const invalid = await a.request.post("/api/admin/command", {
      headers: { "x-island-request": "1" },
      data: {
        action: "settings",
        data: {
          key: "analytics",
          value: {
            ...initialSettings.find((s) => s.key === "analytics").value,
            ga_enabled: true,
            ga_id: "<script>alert(1)</script>",
          },
          reason: "拒绝统计脚本注入",
          confirm: true,
        },
      },
    });
    expect(invalid.status()).toBe(400);
    expect(
      await pb
        .locator('script[src*="googletagmanager"],script[src*="hm.baidu.com"]')
        .count(),
    ).toBe(0);
    await pa.reload();
    await screenshot(pa, "operations-desktop");
    await admin(a, "settings", {
      key: "operations",
      value: { ...ops, maintenance: true },
    });
    const ordinary = await browser.newContext();
    await accountForMaintenance(ordinary);
    await expect(
      pb.getByRole("heading", { name: "网站维护中", exact: true }),
    ).toBeVisible();
    expect(
      (
        await ordinary.request.post("/api/command", {
          headers: { "x-island-request": "1" },
          data: {
            command: "create_room",
            data: { name: "维护中", icon: "🏝️" },
          },
        })
      ).status(),
    ).toBe(503);
    expect((await a.request.get("/api/admin/overview")).status()).toBe(200);
    await admin(a, "settings", { key: "operations", value: ops });
    await ordinary.close();
    await a.close();
    await b.close();
    async function accountForMaintenance(ctx: BrowserContext) {
      const memberEmail = emails[1];
      const res = await ctx.request.post("/api/auth/login", {
        headers: { "x-island-request": "1" },
        data: { email: memberEmail, password },
      });
      expect(res.ok(), await res.text()).toBe(true);
      return res.json();
    }
  });
  test("管理员角色、敏感访问、IP、CSV 与手机应急页面", async ({ browser }) => {
    const a = await browser.newContext({
        viewport: { width: 390, height: 844 },
      }),
      b = await browser.newContext(),
      c = await browser.newContext(),
      d = await browser.newContext();
    const superUser = await account(a, "手机超级管理员"),
      ops = await account(b, "运营管理员"),
      tech = await account(c, "技术管理员");
    await account(d, "无后台权限");
    await pool.query(
      "insert into admin_members(user_id,role) values($1,'super'),($2,'operations'),($3,'technical')",
      [superUser.id, ops.id, tech.id],
    );
    expect((await d.request.get("/api/admin/overview")).status()).toBe(403);
    expect((await b.request.get("/api/admin/system")).status()).toBe(403);
    expect((await c.request.get("/api/admin/reports")).status()).toBe(403);
    const denied = await c.request.post("/api/admin/command", {
      headers: { "x-island-request": "1" },
      data: {
        action: "restrict_user",
        data: {
          id: ops.id,
          status: "banned",
          reason: "验证技术角色边界",
          confirm: true,
        },
      },
    });
    expect(denied.status()).toBe(403);
    expect((await a.request.get("/api/admin/content")).status()).toBe(200);
    expect(
      (await (await a.request.get("/api/admin/content")).json()).items,
    ).toEqual([]);
    const csrf = await a.request.post("/api/admin/command", {
      data: { action: "cleanup", data: { reason: "校验 CSRF", confirm: true } },
    });
    expect(csrf.status()).toBe(403);
    const origin = await a.request.post("/api/admin/command", {
      headers: { "x-island-request": "1", origin: "https://evil.invalid" },
      data: { action: "cleanup", data: { reason: "校验来源", confirm: true } },
    });
    expect(origin.status()).toBe(403);
    const csv = await a.request.get("/api/admin/users?format=csv");
    expect(csv.status()).toBe(200);
    expect(csv.headers()["content-type"]).toContain("text/csv");
    expect(await csv.text()).not.toContain("password");
    const rule = await admin(a, "ip_rule", {
      network: "203.0.113.0/24",
      expires_at: new Date(Date.now() + 86400000).toISOString(),
    });
    expect(rule.data.network).toBe("203.0.113.0/24");
    await admin(a, "delete_ip_rule", { id: rule.data.id });
    const pa = await a.newPage();
    await pa.goto("/admin");
    await expect(
      pa.getByRole("heading", { name: "概览", exact: true }),
    ).toBeVisible();
    await expect(pa.getByText("用户总数", { exact: true })).toBeVisible();
    await screenshot(pa, "overview-mobile");
    await pa.getByRole("button", { name: "展开导航" }).click();
    await pa.getByRole("link", { name: "用户", exact: true }).click();
    await expect(
      pa.getByRole("heading", { name: "用户", exact: true }),
    ).toBeVisible();
    await screenshot(pa, "users-mobile");
    expect(
      await pa.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    const agent = await a.request.get("/api/admin/agents");
    expect(agent.status()).toBe(403);
    await expect(pa.getByRole("link", { name: /Agent/ })).toBeHidden();
    await a.close();
    await b.close();
    await c.close();
    await d.close();
  });
  test("系统 Event 游标、运营 CSV 与安全清理维护工具", async ({ browser }) => {
    const a = await browser.newContext();
    const user = await account(a, "维护验收管理员");
    await pool.query(
      "insert into admin_members(user_id,role) values($1,'super')",
      [user.id],
    );
    const room = (
      await cmd(a, "create_room", { name: "维护工具验收", icon: "🏝️" })
    ).id;
    roomIds.push(room);
    const response = await a.request.get(
      `/api/admin/events?room_id=${room}&actor_id=${user.id}&event_type=room.created`,
    );
    expect(response.ok(), await response.text()).toBe(true);
    const events = (await response.json()).items;
    expect(events).toHaveLength(1);
    const restored = await a.request.get(
      `/api/admin/events?room_id=${room}&after=${Number(events[0].id) - 1}`,
    );
    expect(restored.ok(), await restored.text()).toBe(true);
    const feed = (await restored.json()).items;
    expect(feed.every((e: any) => e.room_id === room)).toBe(true);
    expect(feed.map((e: any) => Number(e.id))).toEqual(
      feed.map((e: any) => Number(e.id)).sort((a: number, b: number) => a - b),
    );
    const csv = await a.request.get("/api/admin/overview?format=csv");
    expect(csv.headers()["content-type"]).toContain("text/csv");
    expect(await csv.text()).toContain("registrations");
    const fs = await import("node:fs/promises"),
      path = await import("node:path");
    const oldPath = `${room}/${randomUUID()}`,
      recentPath = `${room}/${randomUUID()}`;
    await fs.mkdir(path.resolve(".data/files", room), { recursive: true });
    for (const name of [oldPath, recentPath]) {
      await fs.writeFile(path.resolve(".data/files", name), "孤立对象清理验收");
      await pool.query(
        "insert into storage.objects(bucket_id,name,metadata) values('room-files',$1,'{}')",
        [name],
      );
    }
    await pool.query(
      "update storage.objects set created_at=now()-interval '2 days' where name=$1",
      [oldPath],
    );
    const upload = await a.request.post(`/api/rooms/${room}/files`, {
      headers: { "x-island-request": "1" },
      multipart: {
        file: {
          name: "有引用文件.txt",
          mimeType: "text/plain",
          buffer: Buffer.from("活动引用不可删除"),
        },
      },
    });
    expect(upload.ok(), await upload.text()).toBe(true);
    const active = (await upload.json()).id;
    await pool.query(
      "update storage.objects set created_at=now()-interval '2 days' where name=$1",
      [`${room}/${active}`],
    );
    await admin(a, "orphan_cleanup", {});
    expect(
      (
        await pool.query("select 1 from storage.objects where name=$1", [
          oldPath,
        ])
      ).rowCount,
    ).toBe(0);
    await expect(
      fs.access(path.resolve(".data/files", oldPath)),
    ).rejects.toThrow();
    expect(
      (
        await pool.query("select 1 from storage.objects where name=$1", [
          recentPath,
        ])
      ).rowCount,
    ).toBe(1);
    expect((await a.request.get(`/api/files/${active}`)).status()).toBe(200);
    await pool.query(
      "insert into auth.local_sessions(token_hash,user_id,expires_at) values($1,$2,now()-interval '1 day')",
      [randomUUID(), user.id],
    );
    await admin(a, "cleanup", {});
    expect(
      (
        await pool.query(
          "select 1 from auth.local_sessions where user_id=$1 and expires_at<now()",
          [user.id],
        )
      ).rowCount,
    ).toBe(0);
    const metrics = await a.request.get("/api/admin/system");
    expect(metrics.ok(), await metrics.text()).toBe(true);
    expect((await metrics.json()).capacity.pending_cleanup).toBe(0);
    await a.close();
  });
});

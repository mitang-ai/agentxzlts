import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { Pool } from "pg";
import { resolve } from "node:path";
import { unlink } from "node:fs/promises";
const suffix = Date.now();
const fixtureEmails: string[] = [];
test.afterAll(async () => {
  const db = new Pool({
    connectionString:
      process.env.DATABASE_URL ||
      "postgresql://island:local-development-only@127.0.0.1:55432/postgres",
  });
  try {
    const ids = (
      await db.query("select id from profiles where email=any($1)", [
        fixtureEmails,
      ])
    ).rows.map((r) => r.id);
    const objects = (
      await db.query(
        "select storage_path from files where room_id in(select id from rooms where created_by=any($1::uuid[]))",
        [ids],
      )
    ).rows;
    await db.query("delete from rooms where created_by=any($1::uuid[])", [ids]);
    for (const o of objects) {
      await unlink(
        resolve(process.env.E2E_STORAGE_DIR || ".data/files", o.storage_path),
      ).catch(() => {});
      await db.query("delete from storage.objects where name=$1", [
        o.storage_path,
      ]);
      await db.query("delete from storage_cleanup_jobs where path=$1", [
        o.storage_path,
      ]);
    }
    await db.query(
      "delete from realtime_connections where user_id=any($1::uuid[])",
      [ids],
    );
    await db.query(
      "delete from realtime_stream_log where user_id=any($1::uuid[])",
      [ids],
    );
    await db.query("delete from login_events where user_id=any($1::uuid[])", [
      ids,
    ]);
    await db.query("delete from auth.users where id=any($1::uuid[])", [ids]);
  } finally {
    await db.end();
  }
});
async function capture(page: Page, path: string) {
  await page
    .locator(".toast")
    .getByRole("button", { name: "关闭通知" })
    .click({ timeout: 500 })
    .catch(() => {});
  await page.mouse.move(0, 0);
  await page.screenshot({ path, fullPage: true });
}

async function register(page: Page, name: string, email: string) {
  fixtureEmails.push(email);
  await page.goto("/");
  if (name === "Teddy") {
    await expect(
      page.getByRole("button", { name: "注册", exact: true }),
    ).toBeVisible();
    await capture(page, "docs/screenshots/auth-desktop.png");
  }
  await page.getByRole("button", { name: "注册", exact: true }).click();
  await page.getByLabel("昵称", { exact: true }).fill(name);
  await page.getByLabel("邮箱 / 登录账号", { exact: true }).fill(email);
  await page.getByLabel("密码", { exact: true }).fill("Island-Testing-2026");
  await page.getByRole("button", { name: "创建账号" }).click();
  await expect(page.getByRole("button", { name: "个人资料" })).toBeVisible();
}
async function command(
  context: BrowserContext,
  name: string,
  data: Record<string, unknown>,
) {
  const response = await context.request.post("/api/command", {
    headers: { "x-island-request": "1" },
    data: { command: name, data },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}
async function send(page: Page, text: string) {
  await page.getByRole("textbox", { name: "消息", exact: true }).fill(text);
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
}
async function roomId(context: BrowserContext) {
  const response = await context.request.get("/api/rooms");
  return (await response.json()).rooms[0].id as string;
}
test("完整双账号协作：邀请、实时、重连、回复、任务、文件、主持人和退出", async ({
  browser,
}) => {
  const a = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const b = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const outsider = await browser.newContext();
  const pa = await a.newPage();
  const pb = await b.newPage();
  const pc = await outsider.newPage();
  await test.step("两个账号注册，无验证码", async () => {
    await register(pa, "Teddy", `teddy-${suffix}@example.com`);
    await register(pb, "小王", `wang-${suffix}@example.com`);
    await register(pc, "旁观者", `outside-${suffix}@example.com`);
  });
  const cookie = (await a.cookies()).find((c) => c.name === "island_session");
  expect(cookie?.httpOnly).toBe(true);
  expect(cookie?.sameSite).toBe("Lax");
  await test.step("创建房间并从真实邀请加入", async () => {
    await pa
      .getByRole("button", { name: "创建房间", exact: true })
      .first()
      .click();
    await pa.getByLabel("房间名称").fill("周末旅行");
    await pa.getByRole("button", { name: "图标 ⛺" }).click();
    await pa
      .getByRole("dialog")
      .getByRole("button", { name: "创建房间", exact: true })
      .click();
    await expect(
      pa.getByRole("heading", { name: "周末旅行", exact: true }),
    ).toBeVisible();
    await pa.getByRole("button", { name: "邀请", exact: true }).click();
    await pa.getByRole("button", { name: "生成邀请链接", exact: true }).click();
    const url = await pa.getByLabel("生成的邀请链接").inputValue();
    await pa.getByRole("button", { name: "关闭", exact: true }).click();
    await pb.getByRole("button", { name: "加入房间", exact: true }).click();
    await pb.getByLabel("邀请链接或邀请令牌").fill(url);
    await pb
      .getByRole("dialog")
      .getByRole("button", { name: "加入房间", exact: true })
      .click();
    await expect(
      pb.getByRole("heading", { name: "周末旅行", exact: true }),
    ).toBeVisible();
  });
  const room = await roomId(a);
  await test.step("跨浏览器实时聊天与历史持久化", async () => {
    await send(pa, "周末去海边怎么样？我来安排路线。");
    await expect(
      pb
        .getByRole("log")
        .getByText("周末去海边怎么样？我来安排路线。", { exact: true }),
    ).toBeVisible();
    await send(pb, "可以，我看看民宿。");
    await expect(
      pa.getByRole("log").getByText("可以，我看看民宿。", { exact: true }),
    ).toBeVisible();
    await pb.reload();
    await pb
      .getByRole("button")
      .filter({ hasText: "周末旅行" })
      .first()
      .click();
    await expect(
      pb.getByRole("log").getByText("可以，我看看民宿。", { exact: true }),
    ).toBeVisible();
  });
  await test.step("断网恢复补齐遗漏消息", async () => {
    await b.setOffline(true);
    await expect(pb.getByText("暂时断开", { exact: true })).toBeVisible();
    await send(pa, "你离线时，我已经整理了三条路线。");
    await b.setOffline(false);
    await expect(
      pb
        .getByRole("log")
        .getByText("你离线时，我已经整理了三条路线。", { exact: true }),
    ).toBeVisible();
    await expect(pb.getByText("已连接", { exact: true })).toBeVisible();
  });
  await test.step("回复、提及、表情、回应与撤回", async () => {
    const message = pa
      .locator(".message")
      .filter({ has: pa.getByText("可以，我看看民宿。", { exact: true }) });
    await message.hover();
    await message.getByTitle("回复", { exact: true }).click();
    await pa.getByRole("button", { name: "提及成员" }).click();
    await pa
      .locator(".mention-picker")
      .getByRole("option", { name: /小王/ })
      .click();
    await pa.getByRole("textbox", { name: "消息", exact: true }).press("End");
    await pa
      .getByRole("textbox", { name: "消息", exact: true })
      .pressSequentially("记得确认入住时间 ");
    await pa.getByRole("button", { name: "选择表情" }).click();
    await pa.getByRole("button", { name: "😊", exact: true }).click();
    await pa.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(
      pb.locator(".message-text").filter({ hasText: "记得确认入住时间" }),
    ).toBeVisible();
    await expect(pb.locator(".reply-quote")).toContainText(
      "可以，我看看民宿。",
    );
    await message.hover();
    await message.getByTitle("回应", { exact: true }).click();
    await expect(pb.locator(".reactions")).toContainText("👍");
    await send(pa, "这是一条待撤回的消息");
    const withdraw = pa
      .locator(".message")
      .filter({ hasText: "这是一条待撤回的消息" });
    await withdraw.hover();
    await withdraw.getByTitle("撤回消息").click();
    await pa
      .getByRole("dialog")
      .getByRole("button", { name: "确认", exact: true })
      .click();
    await expect(
      pb.getByRole("log").getByText("这条消息已撤回", { exact: true }),
    ).toBeVisible();
  });
  await test.step("发送失败保留消息，重试成功且不重复", async () => {
    let fail = true;
    await pa.route("**/api/command", async (route) => {
      const data = route.request().postDataJSON();
      if (data?.command === "message" && fail) {
        fail = false;
        await route.abort("failed");
      } else await route.continue();
    });
    await send(pa, "失败后也不会丢失的消息");
    await expect(
      pa.getByRole("button", { name: "发送失败，点击重试" }),
    ).toBeVisible();
    await pa.getByRole("button", { name: "发送失败，点击重试" }).click();
    await expect(
      pb.getByRole("log").getByText("失败后也不会丢失的消息", { exact: true }),
    ).toBeVisible();
    await pa.unroute("**/api/command");
    const result = await (await a.request.get(`/api/rooms/${room}`)).json();
    expect(
      result.messages.filter(
        (m: { content: string }) => m.content === "失败后也不会丢失的消息",
      ),
    ).toHaveLength(1);
  });
  await capture(pa, "docs/screenshots/chat-desktop.png");
  let taskId: string;
  await test.step("消息创建多人任务并实时更新状态", async () => {
    const message = pa
      .locator(".message")
      .filter({ hasText: "周末去海边怎么样？我来安排路线。" });
    await message.hover();
    await message.getByTitle("创建任务", { exact: true }).click();
    await pa.getByLabel("任务名称").fill("整理周末旅行路线");
    await pa
      .getByLabel("描述", { exact: true })
      .fill("比较交通与住宿，周五前确认最终方案。");
    await pa.getByRole("checkbox", { name: "小王", exact: true }).check();
    await pa.getByRole("button", { name: "创建任务", exact: true }).click();
    await pb
      .locator(".tabs")
      .getByRole("button", { name: "任务", exact: true })
      .click();
    await expect(
      pb.getByRole("button").filter({ hasText: "整理周末旅行路线" }).first(),
    ).toBeVisible();
    await pb
      .locator(".task-card")
      .filter({ hasText: "整理周末旅行路线" })
      .click();
    await pb.getByLabel("状态", { exact: true }).selectOption("in_progress");
    await pb.getByRole("button", { name: "保存修改" }).click();
    await pa
      .locator(".tabs")
      .getByRole("button", { name: "任务", exact: true })
      .click();
    await expect(pa.locator(".task-column.in_progress")).toContainText(
      "整理周末旅行路线",
    );
    const data = await (await a.request.get(`/api/rooms/${room}`)).json();
    const task = data.tasks[0];
    taskId = task.id;
    expect(task.task_assignees).toHaveLength(2);
    expect(task.source_message_id).toBeTruthy();
    await capture(pa, "docs/screenshots/tasks-desktop.png");
  });
  let fileId: string;
  await test.step("文件真实上传下载、附件关联、非成员拒绝", async () => {
    await pa.locator("input[type=file]").setInputFiles({
      name: "旅行计划.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("协作岛旅行计划：周末海边两日。"),
    });
    await expect(pa.getByRole("status")).toContainText("文件上传成功");
    await pb
      .locator(".tabs")
      .getByRole("button", { name: "文件", exact: true })
      .click();
    await expect(
      pb.getByRole("link", { name: "旅行计划.txt", exact: true }),
    ).toBeVisible();
    const state = await (await a.request.get(`/api/rooms/${room}`)).json();
    fileId = state.files[0].id;
    const download = await b.request.get(`/api/files/${fileId}`);
    expect(download.ok()).toBe(true);
    expect(await download.text()).toContain("周末海边两日");
    expect((await outsider.request.get(`/api/files/${fileId}`)).status()).toBe(
      403,
    );
    expect((await outsider.request.get(`/api/rooms/${room}`)).status()).toBe(
      403,
    );
    await pa
      .locator(".task-card")
      .filter({ hasText: "整理周末旅行路线" })
      .click();
    await pa
      .locator(".attachment-picker")
      .getByText("旅行计划.txt", { exact: true })
      .click();
    await pa.getByRole("button", { name: "保存修改" }).click();
    await pa
      .locator(".tabs")
      .getByRole("button", { name: "文件", exact: true })
      .click();
    await capture(pa, "docs/screenshots/files-desktop.png");
  });
  await test.step("服务端安全检查与 Event Cursor", async () => {
    expect(
      (
        await a.request.post("/api/command", {
          data: { command: "invite", data: { room_id: room } },
        })
      ).status(),
    ).toBe(403);
    expect(
      (
        await a.request.post("/api/command", {
          headers: { "x-island-request": "1", origin: "https://evil.invalid" },
          data: { command: "invite", data: { room_id: room } },
        })
      ).status(),
    ).toBe(403);
    const invalid = await a.request.post(`/api/rooms/${room}/files`, {
      headers: { "x-island-request": "1" },
      multipart: {
        file: {
          name: "fake.png",
          mimeType: "image/png",
          buffer: Buffer.from("not a PNG"),
        },
      },
    });
    expect(invalid.status()).toBe(400);
    const all = await (
      await a.request.get(`/api/rooms/${room}/events?after=0`)
    ).json();
    expect(all.events.map((e: { type: string }) => e.type)).toEqual(
      expect.arrayContaining([
        "room.created",
        "participant.joined",
        "message.created",
        "message.updated",
        "message.deleted",
        "task.created",
        "task.assigned",
        "task.updated",
        "file.created",
      ]),
    );
    const cut = all.events[4].id;
    const tail = await (
      await a.request.get(`/api/rooms/${room}/events?after=${cut}`)
    ).json();
    expect(tail.events.map((e: { id: number }) => e.id)).toEqual(
      all.events.slice(5).map((e: { id: number }) => e.id),
    );
  });
  await test.step("转移主持人，旧主持人立即失去权限", async () => {
    await pa.getByRole("button", { name: "成员", exact: true }).click();
    await capture(pa, "docs/screenshots/members-desktop.png");
    await pa.getByRole("button", { name: "转移主持人", exact: true }).click();
    await pa
      .getByRole("dialog")
      .last()
      .getByRole("button", { name: "确认", exact: true })
      .click();
    await pa.getByRole("button", { name: "关闭", exact: true }).click();
    await expect(
      pa
        .locator(".header-actions")
        .getByRole("button", { name: "邀请", exact: true }),
    ).toHaveCount(0);
    await expect(
      pb
        .locator(".header-actions")
        .getByRole("button", { name: "邀请", exact: true }),
    ).toBeVisible();
    const denied = await a.request.post("/api/command", {
      headers: { "x-island-request": "1" },
      data: { command: "invite", data: { room_id: room } },
    });
    expect(denied.status()).toBe(403);
    await command(b, "update_task", {
      room_id: room,
      task_id: taskId!,
      status: "completed",
    });
  });
  await test.step("普通成员退出，读取和下载立即失效", async () => {
    await command(a, "leave_room", { room_id: room });
    expect((await a.request.get(`/api/files/${fileId}`)).status()).toBe(403);
    await command(b, "delete_room", { room_id: room });
  });
  await Promise.all([a.close(), b.close(), outsider.close()]);
});
test("移动端单页流程：注册、房间、聊天、任务、文件、返回和登录", async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  await page.goto("/");
  await capture(page, "docs/screenshots/auth-mobile.png");
  await register(page, "小岛", `mobile-${suffix}@example.com`);
  await page.getByRole("button", { name: "创建房间", exact: true }).click();
  await page.getByLabel("房间名称").fill("学习小组");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "创建房间", exact: true })
    .click();
  await send(page, "今天一起学习 TypeScript 😊");
  await expect(
    page
      .getByRole("log")
      .getByText("今天一起学习 TypeScript 😊", { exact: true }),
  ).toBeVisible();
  await capture(page, "docs/screenshots/chat-mobile.png");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page
    .locator(".tabs")
    .getByRole("button", { name: "任务", exact: true })
    .click();
  await page.getByRole("button", { name: "新建任务", exact: true }).click();
  await page.getByLabel("任务名称").fill("读完类型系统");
  await page.getByRole("checkbox", { name: "小岛", exact: true }).check();
  await page.getByRole("button", { name: "创建任务", exact: true }).click();
  await expect(page.locator(".task-card")).toContainText("读完类型系统");
  await capture(page, "docs/screenshots/tasks-mobile.png");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page
    .locator(".tabs")
    .getByRole("button", { name: "文件", exact: true })
    .click();
  await expect(page.getByText("还没有共享文件", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "返回房间列表", exact: true }).click();
  await expect(page.locator(".room-list")).toBeVisible();
  await page.getByRole("button", { name: "任务", exact: true }).click();
  await expect(page.getByRole("heading", { name: "我的任务" })).toBeVisible();
  await expect(page.locator(".aggregate-task")).toContainText("读完类型系统");
  await page.getByRole("button", { name: "个人资料" }).click();
  await page.getByRole("button", { name: "退出登录", exact: true }).click();
  await page
    .getByLabel("邮箱 / 登录账号", { exact: true })
    .fill(`mobile-${suffix}@example.com`);
  await page.getByLabel("密码", { exact: true }).fill("Island-Testing-2026");
  await page.getByRole("button", { name: "登录协作岛" }).click();
  await expect(page.locator(".room-list")).toContainText("学习小组");
  const id = await roomId(context);
  await command(context, "delete_room", { room_id: id });
  await context.close();
});

test("历史分页、持久化引用、未读与鉴权图片预览", async ({ browser }) => {
  const a = await browser.newContext();
  const b = await browser.newContext();
  const pa = await a.newPage();
  const pb = await b.newPage();
  await register(pa, "历史成员甲", `teddy-history-${suffix}@example.com`);
  await register(pb, "历史成员乙", `wang-history-${suffix}@example.com`);
  const room = (
    await command(a, "create_room", { name: "历史记录验收", icon: "📚" })
  ).id;
  const token = (
    await command(a, "invite", { room_id: room, hours: 1, max_uses: 1 })
  ).token;
  await command(b, "join_invite", { token });
  let first: string = "";
  for (let i = 0; i < 105; i++) {
    const result = await command(a, "message", {
      room_id: room,
      content: `分页消息 ${i}`,
      client_message_id: crypto.randomUUID(),
    });
    if (i === 0) first = result.id;
  }
  await command(a, "message", {
    room_id: room,
    content: "引用最早的消息",
    client_message_id: crypto.randomUUID(),
    reply_to_message_id: first,
  });
  const unread = await (await b.request.get("/api/rooms")).json();
  expect(unread.rooms[0].unread_count).toBe(106);
  await pb.reload();
  await pb.locator(".room-item").filter({ hasText: "历史记录验收" }).click();
  await expect(pb.locator(".reply-quote")).toContainText("分页消息 0");
  await expect(
    pb.getByRole("button", { name: "加载更早的消息" }),
  ).toBeVisible();
  await pb.getByRole("button", { name: "加载更早的消息" }).click();
  await expect(
    pb.getByRole("log").getByText("分页消息 0", { exact: true }),
  ).toBeVisible();
  const history = await (await b.request.get(`/api/rooms/${room}`)).json();
  expect(history.messages).toHaveLength(100);
  expect(history.has_more).toBe(true);
  const earliest = history.messages[0];
  const older = await (
    await b.request.get(
      `/api/rooms/${room}?before=${encodeURIComponent(earliest.created_at + "|" + earliest.id)}`,
    )
  ).json();
  expect(older.messages).toHaveLength(7);
  expect(
    new Set([...history.messages, ...older.messages].map((m) => m.id)).size,
  ).toBe(107);
  await expect
    .poll(
      async () =>
        (await (await b.request.get("/api/rooms")).json()).rooms[0]
          .unread_count,
    )
    .toBe(0);
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC",
    "base64",
  );
  const uploaded = await a.request.post(`/api/rooms/${room}/files`, {
    headers: { "x-island-request": "1" },
    multipart: {
      file: { name: "小岛.png", mimeType: "image/png", buffer: png },
    },
  });
  expect(uploaded.ok(), await uploaded.text()).toBe(true);
  const file = (await uploaded.json()).id;
  const preview = await b.request.get(`/api/files/${file}?preview=1`);
  expect(preview.headers()["content-type"]).toBe("image/png");
  expect((await preview.body()).equals(png)).toBe(true);
  await expect(pb.getByRole("img", { name: "小岛.png" })).toBeVisible();
  await expect
    .poll(() =>
      pb
        .getByRole("img", { name: "小岛.png" })
        .evaluate((img: HTMLImageElement) => img.naturalWidth),
    )
    .toBe(1);
  const state = await (await b.request.get(`/api/rooms/${room}`)).json();
  expect(
    state.participants.find((p) => p.display_name === "历史成员乙")
      .last_active_at,
  ).toBeTruthy();
  await command(a, "delete_room", { room_id: room });
  await a.close();
  await b.close();
});

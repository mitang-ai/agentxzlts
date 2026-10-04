import { test, expect } from "@playwright/test";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";

test("公开操作指南、LLM复制、Markdown导航和真实下载发布状态", async ({
  page,
  context,
}) => {
  await page.goto("/guide");
  await expect(
    page.getByRole("heading", { name: "协作岛操作指南", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "操作指南目录" }),
  ).toBeVisible();
  const metadata = await context.request.get("/api/desktop/release");
  expect(metadata.headers()["cache-control"]).toContain("no-store");
  if (metadata.status() === 200) {
    const release = await metadata.json();
    expect(release.platform).toBe("win32");
    expect(release.arch).toBe("x64");
    expect(release.sha256).toMatch(/^[a-f0-9]{64}$/);
    await expect(
      page.getByRole("link", { name: "直接下载 Windows EXE", exact: true }),
    ).toHaveAttribute("href", release.url);
    if (release.installScriptSha256) {
      await expect(
        page.getByRole("link", { name: "下载安装引导", exact: true }),
      ).toHaveAttribute("href", "/desktop/install.ps1");
      await context.grantPermissions(["clipboard-read", "clipboard-write"]);
      await page
        .getByRole("button", { name: "复制一键安装命令", exact: true })
        .click();
      await expect
        .poll(() => page.evaluate(() => navigator.clipboard.readText()))
        .toContain(release.installScriptSha256);
    }
    if (!release.signed)
      await expect(
        page.getByText("本版本未进行 Windows 代码签名", { exact: false }),
      ).toBeVisible();
  } else {
    expect(metadata.status()).toBe(404);
    expect((await metadata.json()).code).toBe("DESKTOP_NOT_PUBLISHED");
    await expect(
      page.getByText("Windows 客户端尚未发布", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "直接下载 Windows EXE", exact: true }),
    ).toHaveCount(0);
  }
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.getByRole("button", { name: "复制完整文档", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toContain("关闭或退出桌面界面不应默认停止");
  await page
    .getByRole("button", { name: "复制 LLM 阅读指令", exact: true })
    .click();
  const prompt = await page.evaluate(() => navigator.clipboard.readText());
  expect(prompt).toContain("/guide/llm");
  expect(prompt.length).toBeLessThan(220);
  const markdown = await context.request.get("/guide/llm");
  expect(markdown.status()).toBe(200);
  expect(markdown.headers()["content-type"]).toContain("text/markdown");
  expect(markdown.headers()["cache-control"]).toContain("no-store");
  expect(await markdown.text()).toContain("普通 MCP");
  expect(await markdown.text()).toContain(
    "安装、配对、房间批准、执行器就绪、任务完成必须分别验证",
  );
  await page.screenshot({ path: "test-results/desktop-guide-desktop.png" });
  await page
    .getByRole("navigation", { name: "操作指南目录" })
    .getByRole("link", { name: /刷新与退出/ })
    .click();
  await expect(page).toHaveURL(/#refresh$/);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    )
    .toBe(true);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: "test-results/desktop-guide-mobile.png" });
});

test("左下刷新和桌面事件保留聊天草稿、回复与 Agent 编辑，不生成新配对", async ({
  page,
  context,
  baseURL,
}) => {
  expect(new URL(baseURL!).hostname).toBe("localhost");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const email = `${randomUUID()}@desktop-refresh.invalid`;
  let room: string | undefined;
  async function post(path: string, data: unknown) {
    const response = await context.request.post(`/api/${path}`, {
      headers: { origin: baseURL!, "x-island-request": "1" },
      data,
    });
    expect(response.status(), await response.text()).toBe(200);
    return response.json();
  }
  try {
    await post("auth/register", {
      email,
      password: "Desktop-Refresh-Fixture-2026",
      display_name: "桌面刷新验收",
    });
    room = (
      await post("command", {
        command: "create_room",
        data: { name: "桌面刷新测试房间" },
      })
    ).id;
    await post("command", {
      command: "message",
      data: {
        room_id: room,
        content: "用于保留回复的消息",
        client_message_id: randomUUID(),
      },
    });
    const invitation = await post("my-agents/pairing", {});
    await post("agent-node/pair", {
      code: invitation.code,
      node_name: "桌面编辑测试设备",
      agent_name: "刷新编辑测试 Agent",
      adapter: "cli",
      fingerprint: randomUUID(),
      capabilities: {},
    });
    await page.goto("/");
    await page.getByRole("button", { name: /桌面刷新测试房间/ }).click();
    const composer = page.getByRole("textbox", { name: "消息", exact: true });
    await expect(
      page.getByRole("heading", { name: "桌面刷新测试房间", exact: true }),
    ).toBeVisible();
    const message = page
      .locator(".message")
      .filter({ hasText: "用于保留回复的消息" });
    await message.hover();
    await message.getByRole("button", { name: /回复消息/ }).click();
    await composer.fill("刷新时不要丢失的草稿 @");
    let pairingCalls = 0;
    page.on("request", (request) => {
      if (request.method() === "POST" && request.url().includes("/pairing"))
        pairingCalls++;
    });
    const before = await context.request
      .get("/api/my-agents")
      .then((r) => r.json());
    await page.getByRole("button", { name: "刷新界面", exact: true }).click();
    await expect(composer).toHaveValue("刷新时不要丢失的草稿 @");
    await expect(page.locator(".reply-composer")).toContainText(
      "用于保留回复的消息",
    );
    await expect(
      page.getByRole("button", { name: "取消回复", exact: true }),
    ).toBeVisible();
    const canceled = await page.evaluate(() => {
      (window as unknown as Record<string, unknown>).refreshSentinel =
        "same-document";
      return !window.dispatchEvent(
        new Event("island-desktop-refresh", { cancelable: true }),
      );
    });
    expect(canceled).toBe(true);
    await expect(composer).toHaveValue("刷新时不要丢失的草稿 @");
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as unknown as Record<string, unknown>).refreshSentinel,
        ),
      )
      .toBe("same-document");
    // User profile is another local editor and must not be remounted by refresh.
    await page.getByRole("button", { name: "个人资料", exact: true }).click();
    await page
      .getByRole("dialog")
      .getByLabel("昵称", { exact: true })
      .fill("尚未保存的新昵称");
    await page.evaluate(() =>
      window.dispatchEvent(
        new Event("island-desktop-refresh", { cancelable: true }),
      ),
    );
    await expect(
      page.getByRole("dialog").getByLabel("昵称", { exact: true }),
    ).toHaveValue("尚未保存的新昵称");
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "关闭", exact: true })
      .click();
    await page.getByRole("button", { name: "我的 Agent", exact: true }).click();
    const device = page
      .locator(".agent-device")
      .filter({ hasText: "刷新编辑测试 Agent" });
    await device.locator("summary").click();
    await device
      .getByLabel("Agent 昵称", { exact: true })
      .fill("尚未保存的 Agent 昵称");
    await device.getByRole("combobox").selectOption(room);
    await page
      .getByLabel("允许本地客户端在专用目录开发", { exact: false })
      .check();
    const refreshed = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/my-agents") &&
        response.request().method() === "GET",
    );
    await page.evaluate(() =>
      window.dispatchEvent(
        new Event("island-desktop-refresh", { cancelable: true }),
      ),
    );
    await refreshed;
    await expect(device.getByLabel("Agent 昵称", { exact: true })).toHaveValue(
      "尚未保存的 Agent 昵称",
    );
    await expect(device.getByRole("combobox")).toHaveValue(room);
    await expect(
      page.getByLabel("允许本地客户端在专用目录开发", { exact: false }),
    ).toBeChecked();
    const after = await context.request
      .get("/api/my-agents")
      .then((r) => r.json());
    expect(after.invites.length).toBe(before.invites.length);
    expect(pairingCalls).toBe(0);
    await expect(
      page.getByRole("link", { name: "Windows 客户端下载", exact: true }),
    ).toHaveAttribute("target", "_blank");
  } finally {
    await page.goto("about:blank");
    if (room) await pool.query("delete from rooms where id=$1", [room]);
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

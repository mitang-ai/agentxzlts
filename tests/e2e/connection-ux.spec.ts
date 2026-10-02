import { test, expect } from "@playwright/test";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { rm, mkdir } from "node:fs/promises";
// @ts-ignore
import { writeArchive } from "../../packages/agents/archive.mjs";

test("连续复制自动换码、失效记录单删/清空、需求设计文件上传和仅附件发布", async ({
  page,
  context,
}) => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const email = `${randomUUID()}@ux-browser.invalid`;
  let room: string | undefined;
  try {
    await page.goto("/");
    await page.getByRole("button", { name: "注册", exact: true }).click();
    await page.getByLabel("昵称", { exact: true }).fill("体验验收管理者");
    await page.getByLabel("邮箱", { exact: true }).fill(email);
    await page
      .getByLabel("密码", { exact: true })
      .fill("Island-UX-Browser-2026");
    await page.getByRole("button", { name: "创建账号" }).click();
    await expect(page.getByRole("button", { name: "个人资料" })).toBeVisible();
    await page
      .getByRole("button", { name: "创建房间", exact: true })
      .first()
      .click();
    await page.getByLabel("房间名称").fill("本地连接体验验收");
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "创建房间", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "本地连接体验验收", exact: true }),
    ).toBeVisible();
    room = (
      await pool.query(
        "select r.id from rooms r join participants p on p.id=r.host_participant_id join profiles u on u.id=p.user_id where u.email=$1",
        [email],
      )
    ).rows[0].id;
    await page.getByRole("button", { name: "联机席位", exact: true }).click();
    const panel = page.getByRole("region", { name: "联机席位与 Agent 协作" });
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const pairings: any[] = [];
    // 必须在消费旧码之前再次复制，否则旧缓存行为也会通过测试。
    for (let i = 0; i < 3; i++) {
      const response = page.waitForResponse(
        (r) =>
          r.url().endsWith(`/api/rooms/${room}/agents/pairing`) &&
          r.request().method() === "POST",
      );
      await panel
        .getByRole("button", { name: "复制一键连接提示词", exact: true })
        .click();
      const pairing = await (await response).json();
      pairings.push(pairing);
      await expect(
        panel.getByLabel("一键连接提示词", { exact: true }),
      ).toHaveValue(new RegExp(pairing.id));
      await expect
        .poll(() => page.evaluate(() => navigator.clipboard.readText()))
        .toContain(pairing.id);
    }
    expect(new Set(pairings.map((p) => p.id)).size).toBe(3);
    expect(new Set(pairings.map((p) => p.code)).size).toBe(3);
    const nodes: any[] = [];
    for (let i = 0; i < 3; i++) {
      const response = await context.request.post("/api/agent-node/pair", {
        data: {
          code: pairings[i].code,
          node_name: "体验设备" + i,
          agent_name: "体验 Agent " + i,
          adapter: "cli",
          fingerprint: randomUUID(),
          capabilities: {},
        },
      });
      expect(response.status()).toBe(200);
      nodes.push(await response.json());
    }
    await panel.getByRole("button", { name: "刷新联机席位" }).click();
    for (let i = 0; i < 3; i++)
      await panel
        .getByRole("button", { name: "批准 体验 Agent " + i, exact: true })
        .click();
    page.on("dialog", (dialog) => dialog.accept());
    for (let i = 0; i < 2; i++)
      await panel
        .getByRole("button", {
          name: `撤销 体验 Agent ${i} 的设备`,
          exact: true,
        })
        .click();
    await panel
      .getByRole("button", { name: "删除 体验 Agent 0 的记录", exact: true })
      .click();
    await expect(
      panel.getByLabel("体验 Agent 0 的联机席位", { exact: true }),
    ).toHaveCount(0);
    await panel
      .getByRole("button", { name: "一键删除失效记录", exact: true })
      .click();
    await expect(
      panel.getByLabel("体验 Agent 1 的联机席位", { exact: true }),
    ).toHaveCount(0);
    await expect(
      panel.getByLabel("体验 Agent 2 的联机席位", { exact: true }),
    ).toBeVisible();
    await panel
      .getByRole("button", { name: "选定 体验 Agent 2 为 Agent 主持人" })
      .click();
    await expect(
      panel.getByLabel("上传开发需求文件", { exact: true }),
    ).toBeEnabled();
    const txt = Buffer.from("必须保留现有用户和聊天记录。");
    const md = Buffer.from("# 验收标准\n每次复制获得不同连接。");
    const word = await writeArchive(
      new Map([
        [
          "[Content_Types].xml",
          Buffer.from(
            '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
          ),
        ],
        [
          "word/document.xml",
          Buffer.from(
            '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>文档上传设计</w:t></w:r></w:p></w:body></w:document>',
          ),
        ],
      ]),
    );
    const pdf = Buffer.from(
      "%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n",
    );
    await panel.getByLabel("上传开发需求文件", { exact: true }).setInputFiles([
      { name: "开发需求.txt", mimeType: "text/plain", buffer: txt },
      { name: "验收.md", mimeType: "", buffer: md },
    ]);
    await expect(
      panel.getByRole("button", {
        name: "移除开发需求文件 验收.md",
        exact: true,
      }),
    ).toBeEnabled();
    await panel.getByLabel("上传设计文档文件", { exact: true }).setInputFiles([
      {
        name: "设计.docx",
        mimeType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        buffer: word,
      },
      { name: "补充.pdf", mimeType: "application/pdf", buffer: pdf },
    ]);
    await expect(
      panel.getByRole("button", {
        name: "移除设计文档文件 补充.pdf",
        exact: true,
      }),
    ).toBeEnabled();
    await expect(panel.getByLabel("开发需求", { exact: true })).toHaveValue("");
    await expect(panel.getByLabel("设计文档", { exact: true })).toHaveValue("");
    await panel
      .getByRole("button", { name: "发布需求与设计", exact: true })
      .click();
    await expect(panel.locator(".brief-version")).toHaveText("v1");
    const result = await (
      await context.request.get(`/api/rooms/${room}/agents`)
    ).json();
    expect(result.seats).toHaveLength(1);
    expect(result.brief.requirements_file_ids).toHaveLength(2);
    expect(result.brief.design_file_ids).toHaveLength(2);
    expect(result.brief.file_ids).toHaveLength(4);
    const files = (
      await pool.query("select id,name from files where room_id=$1", [room])
    ).rows;
    for (const [name, expected] of [
      ["开发需求.txt", txt],
      ["验收.md", md],
      ["设计.docx", word],
      ["补充.pdf", pdf],
    ] as const) {
      const downloaded = await context.request.get(
        `/api/files/${files.find((f) => f.name === name).id}`,
      );
      expect(downloaded.status()).toBe(200);
      expect(await downloaded.body()).toEqual(expected);
    }
    // 刷新重新读取后，已删除席位不回来，附件分类不丢失。
    await page.reload();
    await page.getByRole("button", { name: /本地连接体验验收/ }).click();
    await page.getByRole("button", { name: "联机席位", exact: true }).click();
    await expect(
      panel.getByLabel("体验 Agent 0 的联机席位", { exact: true }),
    ).toHaveCount(0);
    await expect(
      panel.getByLabel("体验 Agent 2 的联机席位", { exact: true }),
    ).toBeVisible();
    await panel.getByText("发布新的需求版本", { exact: true }).click();
    await panel
      .getByRole("button", { name: "移除开发需求文件 验收.md", exact: true })
      .click();
    await panel
      .getByRole("button", { name: "发布需求与设计", exact: true })
      .click();
    await expect(panel.locator(".brief-version")).toHaveText("v2");
    const next = await (
      await context.request.get(`/api/rooms/${room}/agents`)
    ).json();
    expect(next.brief.file_ids).toHaveLength(3);
    expect(next.brief.requirements_file_ids).toHaveLength(1);
    await expect(
      (
        await context.request.get(
          `/api/files/${files.find((f) => f.name === "验收.md").id}`,
        )
      ).status(),
    ).toBe(200);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(
      panel.getByLabel("上传开发需求文件", { exact: true }),
    ).toBeVisible();
    expect(
      await panel.evaluate(
        (element) => element.scrollWidth <= element.clientWidth + 1,
      ),
    ).toBe(true);
    await mkdir(resolve(".data/ux-check/screenshots"), { recursive: true });
    await page.screenshot({
      path: ".data/ux-check/screenshots/connection-ux-mobile.png",
      fullPage: true,
    });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.screenshot({
      path: ".data/ux-check/screenshots/connection-ux-desktop.png",
      fullPage: true,
    });
  } finally {
    if (room) {
      await pool.query("delete from rooms where id=$1", [room]);
      await pool.query("delete from storage.objects where name like $1", [
        `${room}/%`,
      ]);
      await pool.query("delete from storage_cleanup_jobs where path like $1", [
        `${room}/%`,
      ]);
      if (process.env.E2E_STORAGE_DIR)
        await rm(resolve(process.env.E2E_STORAGE_DIR, room), {
          recursive: true,
          force: true,
        });
    }
    await pool.query("delete from auth.users where email=$1", [email]);
    await pool.end();
  }
});

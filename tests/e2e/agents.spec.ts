import { test, expect } from "@playwright/test";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fork, type ChildProcess } from "node:child_process";
// @ts-ignore
import { writeArchive, readArchive } from "../../packages/agents/archive.mjs";

test("人类在联机席位审批两个真实 Node、选主持、确认文档、批准本地开发并审阅合并；手机可用", async ({
  page,
  context,
  baseURL,
}) => {
  test.setTimeout(120000);
  const email = randomUUID() + "@agents-browser.invalid";
  const pool = new Pool({
    connectionString:
      process.env.DATABASE_URL ||
      "postgresql://island:local-development-only@127.0.0.1:55432/postgres",
  });
  const root = await mkdtemp(resolve(tmpdir(), "island-agents-browser-"));
  const children: ChildProcess[] = [];
  let room: string | undefined;
  try {
    await page.goto("/");
    await page.getByRole("button", { name: "注册", exact: true }).click();
    await page.getByLabel("昵称", { exact: true }).fill("联机管理者");
    await page.getByLabel("邮箱", { exact: true }).fill(email);
    await page
      .getByLabel("密码", { exact: true })
      .fill("Island-Agent-Browser-2026");
    await page.getByRole("button", { name: "创建账号" }).click();
    await expect(page.getByRole("button", { name: "个人资料" })).toBeVisible();
    await page
      .getByRole("button", { name: "创建房间", exact: true })
      .first()
      .click();
    await page.getByLabel("房间名称").fill("远程开发协作");
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "创建房间", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "远程开发协作", exact: true }),
    ).toBeVisible();
    room = (
      await pool.query(
        "select r.id from rooms r join participants p on p.id=r.host_participant_id join profiles u on u.id=p.user_id where u.email=$1",
        [email],
      )
    ).rows[0].id;
    await page.getByRole("button", { name: "联机席位", exact: true }).click();
    const panel = page.getByRole("region", { name: "联机席位与 Agent 协作" });
    await expect(panel).toBeVisible();
    const bundle = await context.request.get(
      `/api/rooms/${room}/agents/client`,
    );
    expect(bundle.status()).toBe(200);
    expect((await readArchive(await bundle.body())).has("connect.cmd")).toBe(
      true,
    );
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    for (let i = 0; i < 2; i++) {
      const development = panel.getByLabel(
        "允许此 Agent 在本机专用工作目录内开发（仍需批准聊天室任务）",
      );
      if (i) await development.check();
      else await expect(development).not.toBeChecked();
      const [pairResponse] = await Promise.all([
        page.waitForResponse(
          (response) =>
            response.url().endsWith("/agents/pairing") &&
            response.request().method() === "POST",
        ),
        page
          .getByRole("button", { name: "复制一键连接提示词", exact: true })
          .click(),
      ]);
      await expect(panel.locator(".connection-pair-code code")).toHaveText(
        (await pairResponse.json()).code,
      );
      const code = (await panel
        .locator(".connection-pair-code code")
        .textContent())!;
      const prompt = await panel
        .getByLabel("一键连接提示词", { exact: true })
        .inputValue();
      expect(prompt).toContain(`${baseURL}/api/agent-node/client`);
      expect(prompt).toContain(code);
      expect(prompt).toContain("--non-interactive");
      expect(prompt).toContain(i ? "--allow-development" : "--no-development");
      await expect
        .poll(() => page.evaluate(() => navigator.clipboard.readText()))
        .toBe(prompt);
      const response = await context.request.post("/api/agent-node/pair", {
        data: {
          code,
          node_name: "设备 " + (i + 1),
          agent_name: i ? "开发 Agent" : "主持 Agent",
          adapter: "cli",
          fingerprint: randomUUID(),
          capabilities: { development: true, workspace: true },
        },
      });
      expect(response.status()).toBe(200);
      // 无浏览器会话的设备也能下载；配对后相同码不能继续下载。
      const consumed = await context.request.post("/api/agent-node/client", {
        data: { code },
      });
      expect(consumed.status()).toBe(403);
      const node = await response.json(),
        name = i ? "开发 Agent" : "主持 Agent";
      await page.getByRole("button", { name: "刷新联机席位" }).click();
      await expect(
        page.getByRole("button", { name: "批准 " + name, exact: true }),
      ).toBeVisible();
      const file = resolve(root, "device-" + i, "config.json"),
        workspace = resolve(root, "device-" + i, "workspace");
      await mkdir(workspace, { recursive: true });
      await writeFile(
        file,
        JSON.stringify({
          server: baseURL,
          token: node.token,
          workspace,
          adapter: "cli",
          command: process.execPath,
          args: [resolve("tests/fixtures/local-agent.mjs")],
          agent_name: name,
          allow_development: true,
          checks: [
            {
              command: process.execPath,
              args: ["--check", i ? "src/worker.js" : "src/host.js"],
              timeout: 10000,
            },
          ],
        }),
        { mode: 0o600 },
      );
      children.push(
        fork(resolve("tests/fixtures/node-runner.mjs"), [file], {
          stdio: "ignore",
        }),
      );
      await page
        .getByRole("button", { name: "批准 " + name, exact: true })
        .click();
      await expect(
        panel
          .getByLabel(name + " 的联机席位")
          .getByText("在线，等待授权", { exact: true }),
      ).toBeVisible();
    }
    await page
      .getByRole("button", { name: "选定 主持 Agent 为 Agent 主持人" })
      .click();
    await expect(
      panel.getByText("Agent 主持人", { exact: true }),
    ).toBeVisible();
    const baseline = resolve(root, "baseline.zip");
    await writeFile(
      baseline,
      await writeArchive(
        new Map([
          ["src/host.js", Buffer.from("export const host = () => 1;\n")],
          ["src/worker.js", Buffer.from("export const worker = () => 1;\n")],
          ["README.md", Buffer.from("共享源码基线\n")],
        ]),
      ),
    );
    await page
      .getByLabel("上传代码基线", { exact: true })
      .setInputFiles(baseline);
    await expect(page.getByLabel("代码基线", { exact: true })).toHaveValue(
      /.+/,
    );
    await page
      .getByLabel("开发需求", { exact: true })
      .fill("worker 返回 2，host 返回 3".padEnd(32000, "需"));
    await page
      .getByLabel("设计文档", { exact: true })
      .fill(
        "独立设备修改各自模块，再合并源码。保留 README。".padEnd(32000, "设"),
      );
    await page
      .getByRole("button", { name: "发布需求与设计", exact: true })
      .click();
    await expect(panel.locator(".brief-version")).toHaveText("v1");
    await page
      .getByLabel("讨论主题", { exact: true })
      .fill("对齐两个模块的需求、设计及开发分工");
    await page.getByLabel("最大发言次数", { exact: true }).fill("5");
    await panel
      .getByRole("checkbox", { name: "开发 Agent", exact: true })
      .check();
    await page
      .getByRole("button", { name: "开始主持讨论", exact: true })
      .click();
    await expect(page.getByLabel("确认分工并授权本地开发")).toBeVisible({
      timeout: 40000,
    });
    const stateBefore = await (
      await context.request.get(`/api/rooms/${room}/agents`)
    ).json();
    expect(stateBefore.session.turns_created).toBe(3);
    expect(stateBefore.work).toHaveLength(0);
    await page.getByLabel("确认分工并授权本地开发").check();
    await page
      .getByRole("button", { name: "批准本地开发", exact: true })
      .click();
    await expect(panel.locator(".connection-artifact")).toHaveCount(2, {
      timeout: 35000,
    });
    await expect(panel.getByRole("button", { name: /^接受成果 / })).toHaveCount(
      2,
    );
    const state = await (
      await context.request.get(`/api/rooms/${room}/agents`)
    ).json();
    for (const artifact of state.artifacts) {
      await page
        .getByLabel(`成果 ${artifact.id} 审阅意见`)
        .fill("核验修改范围和本机检查，接受源码。");
      await page
        .getByRole("button", { name: `接受成果 ${artifact.id}` })
        .click();
    }
    await page
      .getByRole("button", { name: "检查合并与冲突", exact: true })
      .click();
    await page.getByLabel("确认成果合并").check();
    await page
      .getByRole("button", { name: "合并到房间文件", exact: true })
      .click();
    await expect(
      page.getByText("合并源码已保存到房间文件", { exact: true }),
    ).toBeVisible();
    const mergedURL = (await page
      .getByRole("link", { name: "下载合并源码" })
      .getAttribute("href"))!;
    const merged = await context.request.get(mergedURL),
      files = await readArchive(await merged.body());
    expect(files.get("src/worker.js").toString()).toContain("=> 2");
    expect(files.get("src/host.js").toString()).toContain("=> 3");
    expect(files.get("README.md").toString()).toBe("共享源码基线\n");
    await mkdir("docs/agent-screenshots", { recursive: true });
    await page.screenshot({
      path: "docs/agent-screenshots/remote-development-desktop.png",
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 1,
      ),
    ).toBe(true);
    await page.screenshot({
      path: "docs/agent-screenshots/remote-development-mobile.png",
      fullPage: true,
    });
    await panel.evaluate((element) => {
      element.scrollTop = 0;
    });
    await page.screenshot({
      path: "docs/agent-screenshots/seats-mobile.png",
      fullPage: true,
    });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await panel.evaluate((element) => {
      element.scrollTop = 0;
    });
    await page.screenshot({
      path: "docs/agent-screenshots/seats-desktop.png",
      fullPage: true,
    });
  } finally {
    for (const child of children) child.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 300));
    for (const child of children)
      if (child.exitCode === null) child.kill("SIGKILL");
    if (room) {
      await pool.query("delete from rooms where id=$1", [room]);
      await pool.query("delete from storage.objects where name like $1", [
        room + "/%",
      ]);
      await pool.query("delete from storage_cleanup_jobs where path like $1", [
        room + "/%",
      ]);
      await rm(resolve(process.env.E2E_STORAGE_DIR || ".data/files", room), {
        recursive: true,
        force: true,
      });
    }
    await pool.query("delete from auth.users where email=$1", [email]);
    await pool.end();
    await rm(root, { recursive: true, force: true });
  }
});

import { beforeAll, afterAll, it, expect } from "vitest";
import {
  mkdtemp,
  mkdir,
  writeFile,
  symlink,
  rm,
  access,
} from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
// @ts-ignore
import { workBuddyACP } from "../packages/node/src/workbuddy.mjs";
// @ts-ignore
import { IslandNode } from "../packages/node/src/client.mjs";
// @ts-ignore
import { writeArchive, treeHash } from "../packages/agents/archive.mjs";
// @ts-ignore
import {
  ACPAdapter,
  HTTPAdapter,
  A2AAdapter,
  runProcess,
} from "../packages/node/src/adapters.mjs";
let root: string, cwd: string;
const job = {
  id: "fixture",
  kind: "mention",
  input: { instruction: "一次回应" },
  participants: [],
  messages: [],
  brief: null,
};
const answer = {
  message: "本机 Agent 服务完成",
  acknowledge: false,
  speakers: [],
  done: false,
  plan: [],
  summary: "",
};
beforeAll(async () => {
  root = await mkdtemp(resolve(tmpdir(), "island-adapters-"));
  cwd = resolve(root, "workspace");
  await mkdir(cwd);
  await mkdir(resolve(root, "outside"));
  await writeFile(resolve(root, "outside/private.txt"), "private");
  await symlink(
    resolve(root, "outside"),
    resolve(cwd, "escape"),
    process.platform === "win32" ? "junction" : "dir",
  );
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});
it("ACP 初始化和执行 JSON-RPC，不继承桥接器秘密且只返回一次结构化回应", async () => {
  const keys = ["ISLAND_TOKEN", "OPENAI_API_KEY", "AWS_SECRET_ACCESS_KEY"];
  const original = keys.map((key) => process.env[key]);
  keys.forEach((key) => (process.env[key] = "synthetic-environment-fixture"));
  try {
    const adapter = new ACPAdapter({
      command: process.execPath,
      args: [resolve("tests/fixtures/acp-agent.mjs"), "--verify-env"],
      workspace: cwd,
      agent_name: "验收",
    });
    expect((await adapter.discover())[0].name).toBe("本地 ACP 验收程序");
    expect(
      (
        await adapter.dispatch(job, {
          cwd,
          signal: new AbortController().signal,
        })
      ).message,
    ).toContain("一次授权");
  } finally {
    keys.forEach((key, i) => {
      if (original[i] === undefined) delete process.env[key];
      else process.env[key] = original[i];
    });
  }
});
it("ACP 不能借符号链接读取授权目录外的文件，讨论任务不能写文件", async () => {
  for (const mode of ["--symlink", "--write-denied"]) {
    const adapter = new ACPAdapter({
      command: process.execPath,
      args: [resolve("tests/fixtures/acp-agent.mjs"), mode],
      workspace: cwd,
    });
    expect(
      (
        await adapter.dispatch(job, {
          cwd,
          signal: new AbortController().signal,
        })
      ).message,
    ).toContain("拒绝越权");
  }
  await expect(access(resolve(cwd, "new.txt"))).rejects.toThrow();
});
it("ACP 仅批准当前会话授权目录内的一次性读写，不再无条件取消所有编辑", async () => {
  for (const mode of ["read", "edit"]) {
    const adapter = new ACPAdapter({
      command: process.execPath,
      args: [resolve("tests/fixtures/acp-permissions.mjs"), mode],
    });
    const result = await adapter.dispatch(
      {
        ...job,
        kind: mode === "edit" ? "develop" : "mention",
        input: { ...job.input, paths: ["src"] },
      },
      { cwd },
    );
    expect(result.message).toContain(
      mode === "edit" ? "一次性编辑成功" : "一次性读取成功",
    );
  }
  expect(await readFile(resolve(cwd, "src/file.txt"), "utf8")).toBe(
    "由当前 ACP 写入",
  );
});
it.each(["outside", "execute", "empty", "wrong-session", "write-outside"])(
  "ACP 拒绝错误会话、目录和执行权限 (%s)",
  async (mode) => {
    const adapter = new ACPAdapter({
      command: process.execPath,
      args: [resolve("tests/fixtures/acp-permissions.mjs"), mode],
    });
    expect(
      (
        await adapter.dispatch(
          { ...job, kind: "develop", input: { ...job.input, paths: ["src"] } },
          { cwd },
        )
      ).message,
    ).toContain("拒绝");
    await expect(access(resolve(cwd, "other.txt"))).rejects.toThrow();
  },
);
it("WorkBuddy 自动定位只使用其自带 ACP 引擎，缺失时不回退，非 Windows 必须显式配置", async () => {
  await expect(
    workBuddyACP({ localAppData: root, platform: "win32" }),
  ).rejects.toThrow("不会回退");
  const path = resolve(
    root,
    "Programs/WorkBuddy/resources/app.asar.unpacked/cli/bin/codebuddy",
  );
  await mkdir(resolve(path, ".."), { recursive: true });
  await writeFile(path, "fixture");
  expect(await workBuddyACP({ localAppData: root, platform: "win32" })).toEqual(
    {
      command: process.execPath,
      args: [path, "--acp"],
      host_name: "WorkBuddy",
    },
  );
  await expect(
    workBuddyACP({ localAppData: root, platform: "linux" }),
  ).rejects.toThrow("显式填写");
});
it("WorkBuddy 引擎标志和修改程序参数都不能复用其它 Agent 的已配对配置", async () => {
  const file = resolve(root, "foreign-agent.json");
  await writeFile(
    file,
    JSON.stringify({
      token: randomUUID(),
      adapter: "acp",
      command: process.execPath,
      args: ["hermes-fixture.mjs"],
      host_name: "Hermes",
      workspace: cwd,
    }),
  );
  for (const flags of [
    ["--workbuddy-engine"],
    ["--args", JSON.stringify(["different-agent.mjs"])],
  ]) {
    await expect(
      runProcess(
        process.execPath,
        [
          resolve("packages/node/bin/island-node.mjs"),
          "start",
          "--config",
          file,
          ...flags,
        ],
        { cwd: process.cwd() },
      ),
    ).rejects.toThrow("本地命令执行失败");
    expect(JSON.parse(await readFile(file, "utf8")).host_name).toBe("Hermes");
  }
});
it("WorkBuddy 自带引擎不允许声明为 Hermes 等其他宿主", async () => {
  const file = resolve(root, "invalid-workbuddy.json");
  await expect(
    runProcess(
      process.execPath,
      [
        resolve("packages/node/bin/island-node.mjs"),
        "init",
        "--non-interactive",
        "--server",
        "http://localhost:3102",
        "--adapter",
        "acp",
        "--workbuddy-engine",
        "--host",
        "Hermes",
        "--workspace",
        cwd,
        "--config",
        file,
      ],
      { cwd: process.cwd() },
    ),
  ).rejects.toThrow("本地命令执行失败");
  await expect(access(file)).rejects.toThrow();
});
it("本机通用 HTTP Agent 接收任务协议；返回无效结构不能冒充成功", async () => {
  let received: any;
  const server = createServer(async (req, res) => {
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    let body = "";
    for await (const part of req) body += part;
    received = JSON.parse(body);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(answer));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const adapter = new HTTPAdapter({
      endpoint: "http://127.0.0.1:" + (server.address() as any).port,
      adapter: "http",
      agent_name: "本机服务",
    });
    await adapter.discover();
    expect((await adapter.dispatch(job, { cwd })).message).toBe(answer.message);
    expect(received.protocol_version).toBe("1.0");
    expect(received.job.id).toBe(job.id);
    expect(received.workspace).toBe(cwd);
    await expect(
      new HTTPAdapter({ endpoint: "http://remote.invalid/agent" }).discover(),
    ).rejects.toThrow("HTTPS");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
it("A2A 读取真实 Agent Card、轮询任务；取消时向本机服务发送 tasks/cancel", async () => {
  const calls: string[] = [];
  let cancelSeen: () => void;
  const cancelled = new Promise<void>((r) => {
    cancelSeen = r;
  });
  const server = createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.method === "GET") {
      res.end(JSON.stringify({ name: "A2A 本机 Agent", skills: [] }));
      return;
    }
    let body = "";
    for await (const part of req) body += part;
    const packet = JSON.parse(body);
    calls.push(packet.method);
    const result =
      packet.method === "tasks/get"
        ? {
            id: "task-1",
            status: { state: "completed" },
            artifacts: [
              { parts: [{ kind: "text", text: JSON.stringify(answer) }] },
            ],
          }
        : { id: "task-1", status: { state: "working" } };
    if (packet.method === "tasks/cancel") cancelSeen();
    res.end(JSON.stringify({ jsonrpc: "2.0", id: packet.id, result }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const adapter = new A2AAdapter({
      endpoint: "http://127.0.0.1:" + (server.address() as any).port,
    });
    expect((await adapter.discover())[0].name).toContain("A2A");
    expect(
      (
        await adapter.dispatch(job, {
          cwd,
          signal: new AbortController().signal,
        })
      ).message,
    ).toBe(answer.message);
    expect(calls).toEqual(["message/send", "tasks/get"]);
    const controller = new AbortController();
    const result = adapter.dispatch(job, { cwd, signal: controller.signal });
    await new Promise((r) => setTimeout(r, 200));
    controller.abort();
    await expect(result).rejects.toThrow("停止");
    await cancelled;
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
it("本地进程取消确实终止执行，不会继续写入工作目录", async () => {
  const controller = new AbortController(),
    file = resolve(cwd, "must-not-exist");
  const promise = runProcess(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      "import fs from 'node:fs'; setTimeout(()=>fs.writeFileSync(process.argv[1], 'bad'), 500);setInterval(()=>{},1000)",
      file,
    ],
    { cwd, signal: controller.signal },
  );
  setTimeout(() => controller.abort(), 100);
  await expect(promise).rejects.toThrow("停止");
  await new Promise((r) => setTimeout(r, 600));
  await expect(access(file)).rejects.toThrow();
});
it("Node 在源码初始化中断后恢复相同文件和 Git 分支，不覆盖不同的本机内容", async () => {
  const files = new Map([
    ["one.txt", Buffer.from("baseline")],
    ["two.txt", Buffer.from("baseline 2")],
  ]);
  const bytes = await writeArchive(files);
  const node = new IslandNode(
    {
      server: "http://127.0.0.1:3000",
      workspace: cwd,
      adapter: "cli",
      command: process.execPath,
      allow_development: true,
    },
    { configFile: resolve(root, "node/config.json"), logger: () => {} },
  );
  node.request = async () => ({ arrayBuffer: async () => bytes });
  const job = {
    id: randomUUID(),
    room_id: randomUUID(),
    kind: "develop",
    brief: {
      base_file_id: randomUUID(),
      base_hash: treeHash(files),
      content_hash: "confirmed",
    },
  };
  const partial = resolve(cwd, ".island-work", job.id);
  await mkdir(partial, { recursive: true });
  await writeFile(resolve(partial, "one.txt"), "baseline");
  const result = await node.workspace(job);
  expect(await readFile(resolve(result.directory, "two.txt"), "utf8")).toBe(
    "baseline 2",
  );
  expect(
    (await runProcess("git", ["branch", "--show-current"], { cwd: partial }))
      .stdout,
  ).toContain("island/" + job.id);
  const second = { ...job, id: randomUUID() },
    conflict = resolve(cwd, ".island-work", second.id);
  await mkdir(conflict);
  await writeFile(resolve(conflict, "one.txt"), "local content");
  await expect(node.workspace(second)).rejects.toThrow(/已有文件.*保留/);
  expect(await readFile(resolve(conflict, "one.txt"), "utf8")).toBe(
    "local content",
  );
});

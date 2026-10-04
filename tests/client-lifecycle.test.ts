import { it, expect } from "vitest";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
  realpath,
  cp,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { createRequire } from "node:module";
import { WebSocketServer } from "ws";
// @ts-ignore Executable Node modules.
import {
  windowsLaunch,
  selectWindowsExecutable,
} from "../packages/node/src/windows-command.mjs";
// @ts-ignore
import {
  taskWorkspace,
  materializeFile,
} from "../packages/node/src/workspace.mjs";
// @ts-ignore
import {
  serveRuntime,
  controlRequest,
  runtimeStatus,
  startBackground,
} from "../packages/node/src/runtime.mjs";
// @ts-ignore
import { HostAdapter } from "../packages/node/src/host-adapter.mjs";
// @ts-ignore
import { CLIAdapter } from "../packages/node/src/adapters.mjs";
// @ts-ignore
import {
  inventoryClients,
  archiveClient,
  cleanClientCache,
} from "../packages/node/src/maintenance.mjs";
// @ts-ignore
import { installationLock } from "../packages/node/src/installation.mjs";
// @ts-ignore
import { writeJSON } from "../packages/node/src/io.mjs";
// @ts-ignore Downloadable production client, not a hand-written launcher fixture.
import { nodeClientBundle } from "../packages/agents/client-bundle.mjs";
// @ts-ignore
import { readArchive } from "../packages/agents/archive.mjs";
// @ts-ignore
import { IslandNode } from "../packages/node/src/client.mjs";
const entry = resolve("packages/node/bin/island-node.mjs");
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const task = () => ({
  id: randomUUID(),
  room_id: randomUUID(),
  kind: "mention",
  input: { instruction: "请回答" },
  participants: [],
  messages: [],
  hard_deadline: new Date(Date.now() + 60000).toISOString(),
});
async function eventually(fn: () => Promise<boolean>, timeout = 15000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (await fn()) return;
    await pause(100);
  }
  throw Error("本地验收超时");
}

it("Windows 忽略 Unix shim，解析 npm 真正入口而非 node.exe 探测分支；参数不进 shell", () => {
  expect(
    selectWindowsExecutable(["/npm/codex", "/npm/codex.cmd", "/app/codex.exe"]),
  ).toBe("/npm/codex.cmd");
  const command = resolve("fixture", "codex.cmd"),
    js = resolve(dirname(command), "node_modules/codex/bin/main.js");
  const launch = windowsLaunch(command, ["argument with spaces", "x&y"], {
    exists: (p: string) => [command, js].includes(p),
    node: "node-test.exe",
    read: () =>
      'IF EXIST "%dp0%\\node.exe" (SET "_prog=%dp0%\\node.exe")\n"%_prog%" "%dp0%\\node_modules\\codex\\bin\\main.js" %*',
  });
  expect(launch).toEqual({
    command: "node-test.exe",
    args: [js, "argument with spaces", "x&y"],
  });
  expect(() =>
    windowsLaunch(command, [], {
      exists: () => true,
      read: () => "echo unsafe",
    }),
  ).toThrow(/无法识别/);
});

it("房间/任务目录独立，异常 UUID 与中间链接不制造越界文件；旧目录保持可恢复", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "island-workspaces-")),
    outside = await mkdtemp(resolve(tmpdir(), "island-outside-"));
  try {
    const a = task(),
      b = { ...a, room_id: randomUUID() };
    const dirA = await taskWorkspace(root, a),
      dirB = await taskWorkspace(root, b);
    expect(dirA).not.toBe(dirB);
    expect(dirA).toBe(
      resolve(
        await realpath(root),
        ".island-work",
        "rooms",
        a.room_id,
        "tasks",
        a.id,
      ),
    );
    await materializeFile(dirA, "src/example.txt", Buffer.from("baseline"));
    await materializeFile(dirA, "src/example.txt", Buffer.from("baseline"));
    await expect(
      materializeFile(dirA, "src/example.txt", Buffer.from("overwrite")),
    ).rejects.toThrow(/保留/);
    await expect(
      taskWorkspace(root, { ...a, id: "../../outside" }),
    ).rejects.toThrow(/标识/);
    await expect(
      materializeFile(dirA, "../escape.txt", Buffer.from("bad")),
    ).rejects.toThrow();
    await symlink(
      outside,
      resolve(dirA, "unsafe"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(
      materializeFile(dirA, "unsafe/private.txt", Buffer.from("bad")),
    ).rejects.toThrow(/链接/);
    await expect(
      readFile(resolve(outside, "private.txt")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await taskWorkspace(root, a, { legacy: true })).toBe(
      resolve(await realpath(root), ".island-work", a.id),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

it("安装短锁串行准备依赖，活锁不被抢占且配置不受影响", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "island-install-lock-"));
  try {
    const release = await installationLock(root);
    await expect(installationLock(root, { timeout: 50 })).rejects.toThrow(
      /另一个安装/,
    );
    await release();
    await (
      await installationLock(root)
    )();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("旧客户端诊断只扫描协作岛，缓存清理默认预览，离线归档保留身份和成果且拒绝越界/活锁", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "island-maintenance-")),
    id = randomUUID();
  const install = resolve(root, ".island-node/clients", id),
    file = resolve(install, ".data/connections", id, "config.json");
  try {
    await writeJSON(file, {
      token: "PRIVATE-DEVICE-CREDENTIAL",
      node_id: randomUUID(),
      agent_name: "旧安装",
      adapter: "cli",
    });
    await writeJSON(resolve(install, "package.json"), {
      name: "island-node-client",
    });
    await writeJSON(resolve(install, ".data/npm-cache/test.json"), {
      cache: true,
    });
    await writeJSON(resolve(install, "workspace/result.json"), {
      preserved: true,
    });
    const list = await inventoryClients(resolve(root, ".island-node/clients"));
    expect(list).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain("PRIVATE-DEVICE-CREDENTIAL");
    expect((await cleanClientCache(install)).changed).toBe(false);
    expect((await cleanClientCache(install, { confirm: true })).changed).toBe(
      true,
    );
    expect(JSON.parse(await readFile(file, "utf8")).token).toBe(
      "PRIVATE-DEVICE-CREDENTIAL",
    );
    await expect(archiveClient(root, file, { confirm: true })).rejects.toThrow(
      /客户端安装/,
    );
    expect((await archiveClient(install, file)).changed).toBe(false);
    const { acquireInstance } =
      await import("../packages/node/src/instances.mjs");
    const lease = await acquireInstance(file);
    await expect(
      archiveClient(install, file, { confirm: true }),
    ).rejects.toMatchObject({ code: "ELOCKED" });
    await lease.release();
    const external = resolve(root, "not-an-archive");
    await mkdir(external);
    const archivePath = resolve(root, ".island-node/archives");
    await symlink(
      external,
      archivePath,
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(
      archiveClient(install, file, { confirm: true }),
    ).rejects.toThrow(/归档目录包含链接/);
    expect(JSON.parse(await readFile(file, "utf8")).token).toBe(
      "PRIVATE-DEVICE-CREDENTIAL",
    );
    await rm(archivePath, { recursive: true });
    const archived = await archiveClient(install, file, { confirm: true });
    expect(archived.changed).toBe(true);
    expect(
      JSON.parse(
        await readFile(
          resolve(archived.archive, ".data/connections", id, "config.json"),
          "utf8",
        ),
      ).token,
    ).toBe("PRIVATE-DEVICE-CREDENTIAL");
    expect(
      JSON.parse(
        await readFile(
          resolve(archived.archive, "workspace/result.json"),
          "utf8",
        ),
      ),
    ).toEqual({ preserved: true });
    await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("支持 ephemeral 的 Codex 按独立任务执行，不恢复其它聊天或积累永久对话记录", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "island-codex-args-"));
  try {
    const executable = resolve(root, "codex.mjs");
    await writeFile(
      executable,
      'import{writeFileSync}from"node:fs";const a=process.argv.slice(2);if(a.includes("--version"))console.log("fixture");else if(a.includes("--help"))console.log("--ephemeral");else{writeFileSync("args.json",JSON.stringify(a));const i=a.indexOf("--output-last-message");writeFileSync(a[i+1],JSON.stringify({message:"test"}));console.log(JSON.stringify({type:"thread.started",thread_id:"not-persisted"}))}',
    );
    const adapter = new CLIAdapter({
      adapter: "codex",
      command: executable,
      agent_name: "test",
    });
    await adapter.discover();
    await adapter.resume("old-saved-session");
    expect(
      (await adapter.dispatch(task(), { cwd: root })).local_session_id,
    ).toBeUndefined();
    const args = JSON.parse(await readFile(resolve(root, "args.json"), "utf8"));
    expect(args).toContain("--ephemeral");
    expect(args).not.toContain("resume");
    expect(args).not.toContain("--last");
    expect(
      args.slice(args.indexOf("--sandbox"), args.indexOf("--sandbox") + 2),
    ).toEqual(["--sandbox", "read-only"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("本机管理要令牌和实例证明；多聊天共享连接，只投递给唯一消费者，取消可恢复", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "island-runtime-")),
    file = resolve(root, "config.json");
  const adapter = new HostAdapter({ adapter: "mcp" });
  const node: any = {
    config: { adapter: "mcp" },
    adapter,
    stopped: false,
    connectionStatus: {
      connected: true,
      state: "approved",
      room_id: randomUUID(),
      last_sync_at: new Date().toISOString(),
    },
    stop() {
      this.stopped = true;
      void adapter.disconnect();
    },
  };
  const close = await serveRuntime(node, file);
  try {
    const ctrl = JSON.parse(await readFile(file + ".control.json", "utf8"));
    expect(
      (await fetch(`http://127.0.0.1:${ctrl.port}/stop`, { method: "POST" }))
        .status,
    ).toBe(403);
    expect(
      (
        await fetch(`http://127.0.0.1:${ctrl.port}/stop`, {
          method: "POST",
          headers: {
            authorization: "Bearer " + ctrl.secret,
            origin: "https://untrusted.invalid",
          },
        })
      ).status,
    ).toBe(403);
    expect((await runtimeStatus(file)).automatic).toBe(false);
    node.connectionStatus.connected = false;
    await expect(startBackground(file, entry, { timeout: 20 })).rejects.toThrow(
      /尚未确认连接成功/,
    );
    await expect(readFile(file + ".runtime.log")).rejects.toMatchObject({
      code: "ENOENT",
    });
    node.connectionStatus.connected = true;
    const first = randomUUID(),
      second = randomUUID(),
      waiting = controlRequest(file, "wait", { consumer: first, seconds: 1 });
    await eventually(async () => adapter.accepting());
    await expect(
      controlRequest(file, "wait", { consumer: second, seconds: 1 }),
    ).rejects.toThrow(/已有对话/);
    const job = task(),
      controller = new AbortController(),
      dispatched = adapter.dispatch(job, {
        cwd: root,
        signal: controller.signal,
      });
    const payload = await waiting;
    await expect(
      controlRequest(file, "complete", {
        consumer: second,
        task_id: job.id,
        delivery_id: payload.delivery_id,
        result: { message: "wrong" },
      }),
    ).rejects.toThrow(/另一个/);
    const completed = controlRequest(file, "complete", {
      consumer: first,
      task_id: job.id,
      delivery_id: payload.delivery_id,
      result: { message: "right" },
    });
    expect((await dispatched).message).toBe("right");
    adapter.confirmed(job.id);
    expect((await completed).confirmed).toBe(true);
    const cancel = new AbortController(),
      cancelled = controlRequest(
        file,
        "wait",
        { consumer: second, seconds: 5 },
        { signal: cancel.signal },
      );
    await eventually(async () => adapter.accepting());
    cancel.abort();
    await expect(cancelled).rejects.toThrow();
    await eventually(async () => !adapter.accepting());
    expect(
      await controlRequest(file, "wait", { consumer: first, seconds: 1 }),
    ).toBeNull();
    node.connectionStatus.room_id = randomUUID();
    await node.onRoomChanged();
    await expect(
      controlRequest(file, "wait", { consumer: first, seconds: 1 }),
    ).rejects.toThrow(/房间已切换/);
    await expect(
      controlRequest(file, "status", {}, { instance: randomUUID() }),
    ).rejects.toThrow(/重启/);
    await controlRequest(file, "stop");
    expect(node.stopped).toBe(true);
    expect(JSON.stringify(await runtimeStatus(file))).not.toContain(
      ctrl.secret,
    );
  } finally {
    node.stop();
    await close();
    await rm(root, { recursive: true, force: true });
  }
});

it("真实常驻 CLI 不依赖安装对话：空闲后收到 @ 自动执行/回传、重复启动不重复连接、精准停止", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "island-daemon-e2e-")),
    file = resolve(root, "config.json"),
    workspace = resolve(root, "workspace");
  const server = createServer(),
    wire = new WebSocketServer({ server });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as any).port}`;
  const job = { ...task(), lease: "LOCAL-TEST-LEASE-ONLY" },
    room = job.room_id;
  let queued = false,
    claimed = false,
    completed: any = null,
    connections = 0;
  wire.on("connection", (socket) => {
    connections++;
    socket.send(
      JSON.stringify({
        type: "welcome",
        data: {
          state: "approved",
          room_id: room,
          participant_id: randomUUID(),
        },
      }),
    );
    socket.on("message", (bytes) => {
      const packet = JSON.parse(bytes.toString());
      const data =
        packet.type === "sync"
          ? { state: "approved", muted: false, cursor: 0 }
          : packet.type === "claim" && queued && !claimed
            ? ((claimed = true), job)
            : packet.type === "complete"
              ? ((completed = packet.data.result), { ok: true })
              : null;
      socket.send(
        JSON.stringify({ type: "result", request_id: packet.request_id, data }),
      );
    });
  });
  try {
    await mkdir(workspace);
    const agent = resolve(root, "agent.mjs");
    await writeFile(
      agent,
      'if(process.argv.includes("--version")){console.log("fixture 1")}else{let s="";for await(const b of process.stdin)s+=b;console.log(JSON.stringify({message:"自动回应成功",acknowledge:false,done:true}))}',
    );
    await writeJSON(file, {
      server: url,
      token: "local-fixture-only",
      node_id: randomUUID(),
      workspace,
      adapter: "cli",
      command: process.execPath,
      args: [agent],
      agent_name: "验收机器人",
    });
    expect((await startBackground(file, entry)).connected).toBe(true);
    await pause(250);
    queued = true;
    await eventually(async () => completed?.message === "自动回应成功");
    expect(claimed).toBe(true);
    expect((await startBackground(file, entry)).automatic).toBe(true);
    expect(connections).toBe(1);
    // 初始化不得保留旧 token 却改写已有适配器。
    const before = await readFile(file, "utf8");
    const init = spawn(
      process.execPath,
      [
        entry,
        "init",
        "--non-interactive",
        "--config",
        file,
        "--adapter",
        "mcp",
      ],
      { windowsHide: true, stdio: "ignore" },
    );
    expect((await once(init, "exit"))[0]).toBe(1);
    expect(await readFile(file, "utf8")).toBe(before);
    await controlRequest(file, "stop");
    await eventually(async () => !(await runtimeStatus(file)));
  } finally {
    if (await runtimeStatus(file)) await controlRequest(file, "stop");
    for (const socket of wire.clients) socket.terminate();
    wire.close();
    server.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30000);

it("MCP 等待超时后才准备好的任务，未交付宿主时不冒充执行就绪", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "island-undelivered-"));
  const controller = new AbortController();
  const node = new IslandNode(
    { adapter: "mcp", server: "http://localhost:3106", workspace: root },
    { configFile: resolve(root, "config.json"), logger: () => {} },
  );
  const job = task();
  let accepting: boolean | undefined;
  node.ws = { readyState: 1 };
  node.active = { job };
  node.executing = true;
  node.savedCursor = 0;
  node.updateStatus = async () => {};
  node.rpc = async (type: string, data: any) => {
    expect(type).toBe("sync");
    accepting = data.accepting;
    return { state: "approved", muted: false, cursor: 0 };
  };
  try {
    expect(await node.adapter.waitTask(0.001)).toBeNull();
    const dispatched = node.adapter.dispatch(job, {
      cwd: root,
      signal: controller.signal,
    });
    const cancelled = dispatched.catch((error: Error) => error);
    await node.tick();
    expect(accepting).toBe(false);
    const aborted = new AbortController();
    aborted.abort();
    expect(await node.adapter.waitTask(1, aborted.signal)).toBeNull();
    await node.tick();
    expect(accepting).toBe(false);
    expect((await node.adapter.waitTask(1)).task_id).toBe(job.id);
    await node.tick();
    expect(accepting).toBe(true);
    controller.abort();
    expect(await cancelled).toMatchObject({ message: "任务授权已停止。" });
    await node.tick();
    expect(accepting).toBe(false);
  } finally {
    controller.abort();
    await node.adapter.disconnect();
    await rm(root, { recursive: true, force: true });
  }
});

it("房间切换的异步清理完成前不领取新房间任务", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "island-room-transition-"));
  const server = createServer(),
    wire = new WebSocketServer({ server });
  let syncing = 0,
    entered!: () => void,
    release!: () => void;
  const held = new Promise<void>((r) => (entered = r)),
    gate = new Promise<void>((r) => (release = r));
  wire.on("connection", (socket) => {
    socket.send(
      JSON.stringify({
        type: "welcome",
        data: { room_id: randomUUID(), state: "approved" },
      }),
    );
    socket.on("message", (bytes) => {
      const packet = JSON.parse(bytes.toString());
      if (packet.type === "sync") syncing++;
      socket.send(
        JSON.stringify({
          type: "result",
          request_id: packet.request_id,
          data:
            packet.type === "sync" ? { state: "approved", cursor: 0 } : null,
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const node = new IslandNode(
    {
      server: `http://127.0.0.1:${(server.address() as any).port}`,
      adapter: "cli",
      command: process.execPath,
      token: "transition-fixture-only",
    },
    { configFile: resolve(root, "config.json"), logger: () => {} },
  );
  node.connectionStatus.room_id = randomUUID();
  node.onRoomChanged = async () => {
    entered();
    await gate;
  };
  const connecting = node.connect();
  try {
    await held;
    await pause(100);
    expect(syncing).toBe(0);
    release();
    await eventually(async () => syncing > 0);
  } finally {
    release();
    node.stop();
    await connecting;
    await eventually(async () => !node.ticking);
    await node.statusQueue;
    wire.close();
    server.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("两个真实 MCP stdio 对话共享一个设备进程，不能抢占领取或代答，关闭工具窗口不关设备", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "island-mcp-supervisor-")),
    file = resolve(root, "config.json");
  const server = createServer(),
    wire = new WebSocketServer({ server });
  const job = { ...task(), lease: "MCP-FIXTURE-LEASE-ONLY" };
  let queued = false,
    claimed = false,
    accepting = false,
    completed: any = null,
    connections = 0;
  wire.on("connection", (socket) => {
    connections++;
    socket.send(
      JSON.stringify({
        type: "welcome",
        data: {
          state: "approved",
          room_id: job.room_id,
          participant_id: randomUUID(),
        },
      }),
    );
    socket.on("message", (bytes) => {
      const packet = JSON.parse(bytes.toString());
      if (packet.type === "sync") accepting = packet.data.accepting;
      const data =
        packet.type === "sync"
          ? { state: "approved", muted: false, cursor: 0 }
          : packet.type === "claim" && queued && !claimed
            ? ((claimed = true), job)
            : packet.type === "complete"
              ? ((completed = packet.data.result), { ok: true })
              : null;
      socket.send(
        JSON.stringify({ type: "result", request_id: packet.request_id, data }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const children: any[] = [];
  async function proxy() {
    const child = spawn(process.execPath, [entry, "mcp", "--config", file], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.push(child);
    child.stdin.on("error", () => {});
    let sequence = 0,
      errors = "";
    child.stderr.on("data", (b) => (errors += b));
    const pending = new Map();
    createInterface({ input: child.stdout }).on("line", (line) => {
      const p = JSON.parse(line),
        waiter = pending.get(p.id);
      if (waiter) {
        clearTimeout(waiter.timer);
        pending.delete(p.id);
        waiter.resolve(p);
      }
    });
    const call = (method: string, params: any = {}) =>
      new Promise<any>((resolve, reject) => {
        const id = ++sequence,
          timer = setTimeout(() => {
            pending.delete(id);
            reject(Error(method + "超时 " + errors));
          }, 18000);
        pending.set(id, { resolve, timer });
        child.stdin.write(
          JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
        );
      });
    expect(
      (
        await call("initialize", {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test", version: "1" },
        })
      ).error,
    ).toBeUndefined();
    child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) +
        "\n",
    );
    const tool = (name: string, args = {}) =>
      call("tools/call", { name, arguments: args });
    return { child, tool };
  }
  try {
    await mkdir(resolve(root, "workspace"));
    await writeJSON(file, {
      server: `http://127.0.0.1:${(server.address() as any).port}`,
      token: "local-mcp-fixture-only",
      node_id: randomUUID(),
      workspace: resolve(root, "workspace"),
      adapter: "mcp",
      host_name: "fixture",
      agent_name: "fixture",
    });
    const [a, b] = await Promise.all([proxy(), proxy()]);
    await eventually(async () =>
      Boolean((await runtimeStatus(file))?.connected),
    );
    expect(connections).toBe(1);
    const waiting = a.tool("island_wait_task", { wait_seconds: 12 });
    await eventually(async () => accepting);
    expect(
      (await b.tool("island_wait_task", { wait_seconds: 1 })).result.isError,
    ).toBe(true);
    queued = true;
    const packet = await waiting;
    expect(packet.result.isError).not.toBe(true);
    const delivery = JSON.parse(packet.result.content[0].text);
    const args = {
      task_id: delivery.task_id,
      delivery_id: delivery.delivery_id,
      result: { message: "唯一回传" },
    };
    expect((await b.tool("island_complete_task", args)).result.isError).toBe(
      true,
    );
    const done = await a.tool("island_complete_task", args);
    expect(JSON.parse(done.result.content[0].text).confirmed).toBe(true);
    expect(completed.message).toBe("唯一回传");
    const exited = once(a.child, "exit");
    a.child.stdin.end();
    await exited;
    expect((await runtimeStatus(file)).connected).toBe(true);
    expect(
      JSON.parse((await b.tool("island_status")).result.content[0].text)
        .automatic_wake,
    ).toBe(false);
  } finally {
    for (const child of children)
      if (child.exitCode === null) child.stdin.end();
    if (await runtimeStatus(file)) await controlRequest(file, "stop");
    for (const socket of wire.clients) socket.terminate();
    wire.close();
    server.close();
    await eventually(async () =>
      children.every((child) => child.exitCode !== null),
    );
    await rm(root, { recursive: true, force: true });
  }
}, 30000);

it.runIf(process.platform === "win32")(
  "下载客户端的 PowerShell 5.1 启动器保留 JSON/空格参数，实际配对并常驻连接",
  async () => {
    const root = await mkdtemp(resolve(tmpdir(), "island downloaded client "));
    const file = resolve(
      root,
      ".data/connections",
      randomUUID(),
      "config.json",
    );
    let pairing: any,
      connections = 0;
    const server = createServer(async (req, res) => {
      let body = "";
      for await (const b of req) body += b;
      if (req.url !== "/api/agent-node/pair") {
        res.writeHead(404).end();
        return;
      }
      pairing = JSON.parse(body);
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          node_id: randomUUID(),
          token: "local-windows-fixture-only",
          participant_id: null,
          room_id: null,
        }),
      );
    });
    const wire = new WebSocketServer({ server });
    wire.on("connection", (socket) => {
      connections++;
      socket.send(
        JSON.stringify({
          type: "welcome",
          data: { state: "registered", room_id: null, participant_id: null },
        }),
      );
      socket.on("message", (bytes) => {
        const packet = JSON.parse(bytes.toString());
        socket.send(
          JSON.stringify({
            type: "result",
            request_id: packet.request_id,
            data: { state: "registered", cursor: 0 },
          }),
        );
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    async function script(name: string, args: string[]) {
      const quote = (value: string) => "'" + value.replaceAll("'", "''") + "'";
      const child = spawn(
        "powershell.exe",
        [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          "& " +
            quote(resolve(root, "scripts", name)) +
            " " +
            args.map(quote).join(" "),
        ],
        { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
      );
      let output = "";
      child.stdout.on("data", (b) => (output += b));
      child.stderr.on("data", (b) => (output += b));
      const [code] = await once(child, "exit");
      expect(code, output).toBe(0);
    }
    try {
      for (const [name, bytes] of await readArchive(
        await nodeClientBundle(process.cwd()),
      )) {
        const path = resolve(root, name);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, bytes);
      }
      // Bootstrap dependency downloading is covered by Linux ZIP integration; here isolate PS argv fidelity.
      const lock = JSON.parse(
        await readFile(resolve(root, "package-lock.json"), "utf8"),
      );
      for (const path of Object.keys(lock.packages)
        .filter((p) => p.startsWith("node_modules/"))
        .sort((a, b) => a.length - b.length)) {
        const at = path.lastIndexOf("node_modules/"),
          name = path.slice(at + "node_modules/".length);
        const require = createRequire(
          resolve(process.cwd(), path.slice(0, at), "package.json"),
        );
        let source = dirname(require.resolve(name));
        for (let level = 0; level < 8; level++) {
          try {
            if (
              JSON.parse(
                await readFile(resolve(source, "package.json"), "utf8"),
              ).name === name
            )
              break;
          } catch (e: any) {
            if (e.code !== "ENOENT") throw e;
          }
          source = dirname(source);
        }
        expect(
          JSON.parse(await readFile(resolve(source, "package.json"), "utf8"))
            .name,
        ).toBe(name);
        await cp(source, resolve(root, path), {
          recursive: true,
          dereference: true,
        });
      }
      const agent = resolve(root, "my local agent.mjs");
      await writeFile(agent, 'console.log("fixture")');
      const args = [
        agent,
        'literal "quotes", 中文 and spaces',
        "path-with-backslash\\",
      ];
      await script("node-bootstrap.ps1", [
        "--hub",
        "--non-interactive",
        "--background",
        "--server",
        `http://127.0.0.1:${(server.address() as any).port}`,
        "--code",
        "LOCAL-PAIRING-CODE-ONLY",
        "--config",
        file,
        "--adapter",
        "cli",
        "--command",
        process.execPath,
        "--args",
        JSON.stringify(args),
        "--workspace",
        resolve(root, "my workspace"),
        "--agent-name",
        "本地验收",
      ]);
      expect(pairing).toBeTruthy();
      expect(pairing.adapter).toBe("cli");
      expect(JSON.parse(await readFile(file, "utf8")).args).toEqual(args);
      expect((await runtimeStatus(file)).connected).toBe(true);
      expect(connections).toBe(1);
      const registry = resolve(root, ".data/hub/registry.json");
      const hub = await controlRequest(registry, "status");
      expect(hub.agents).toHaveLength(1);
      expect((await runtimeStatus(file)).pid).toBe(hub.pid);
      await script("node-manage.ps1", ["stop", "--config", file]);
      await eventually(async () => !(await runtimeStatus(file)));
      await script("node-manage.ps1", ["hub-stop"]);
      await eventually(async () => {
        try {
          process.kill(hub.pid, 0);
          return false;
        } catch {
          return true;
        }
      });
    } finally {
      if (await runtimeStatus(file)) await controlRequest(file, "stop");
      const registry = resolve(root, ".data/hub/registry.json");
      const hub = await runtimeStatus(registry);
      if (hub) {
        await controlRequest(registry, "stop");
        await eventually(async () => {
          try {
            process.kill(hub.pid, 0);
            return false;
          } catch {
            return true;
          }
        });
      }
      for (const socket of wire.clients) socket.terminate();
      wire.close();
      server.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  30000,
);

import { it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";
// @ts-ignore Executable client ES modules.
import { createAdapter } from "../packages/node/src/adapters.mjs";
// @ts-ignore
import { serveHostMCP } from "../packages/node/src/host-mcp.mjs";

const job = () => ({
  id: randomUUID(),
  kind: "mention",
  input: { instruction: "请回答" },
  participants: [],
  messages: [],
  hard_deadline: new Date(Date.now() + 60000).toISOString(),
});
it("未选类型和错误的 WorkBuddy 路由必须报错，不回退到 Codex CLI", () => {
  expect(() => createAdapter({})).toThrow(/明确选择/);
  expect(() => createAdapter({ adapter: "workbuddy" })).toThrow(/明确选择/);
  expect(() => createAdapter({ adapter: "cli" })).toThrow(/真实程序/);
  expect(() =>
    createAdapter({ adapter: "codex", host_name: "WorkBuddy" }),
  ).toThrow(/不能交给/);
  expect(() =>
    createAdapter({ adapter: "codex", agent_name: "WorkBuddy" }),
  ).toThrow(/不能交给/);
  expect(
    createAdapter({ adapter: "mcp", host_name: "WorkBuddy" }).constructor.name,
  ).toBe("HostAdapter");
});
it("宿主领取/回传绑定任务和投递 ID，只在服务器确认后成功，重复不重复回复", async () => {
  const adapter = createAdapter({ adapter: "mcp" }),
    task = job(),
    controller = new AbortController();
  expect(adapter.accepting()).toBe(false);
  const waiting = adapter.waitTask(1);
  expect(adapter.accepting()).toBe(true);
  const dispatched = adapter.dispatch(task, {
    cwd: "test-workspace",
    signal: controller.signal,
  });
  const payload = await waiting;
  expect(payload.task_id).toBe(task.id);
  expect(adapter.accepting()).toBe(false);
  await expect(
    adapter.complete(task.id, randomUUID(), { message: "wrong" }),
  ).rejects.toThrow(/不属于/);
  let confirmed = false;
  const complete = adapter
    .complete(task.id, payload.delivery_id, { message: "本宿主的回答" })
    .then((r: any) => {
      confirmed = true;
      return r;
    });
  expect((await dispatched).message).toBe("本宿主的回答");
  expect(confirmed).toBe(false);
  adapter.confirmed(task.id);
  expect(await complete).toMatchObject({ confirmed: true });
  expect(
    await adapter.complete(task.id, payload.delivery_id, {
      message: "本宿主的回答",
    }),
  ).toMatchObject({ confirmed: true });
  await expect(
    adapter.complete(task.id, payload.delivery_id, { message: "换一个结果" }),
  ).rejects.toThrow(/不一致/);
});
it("取消任务让旧投递失效，不继续接受结果", async () => {
  const adapter = createAdapter({ adapter: "mcp" }),
    task = job(),
    controller = new AbortController();
  const dispatched = adapter.dispatch(task, {
    cwd: "test",
    signal: controller.signal,
  });
  const rejected = expect(dispatched).rejects.toThrow(/停止/);
  const payload = await adapter.waitTask(1);
  controller.abort();
  await rejected;
  await expect(
    adapter.complete(task.id, payload.delivery_id, { message: "过期回传" }),
  ).rejects.toThrow(/失效/);
  expect(await adapter.waitTask(0.001)).toBeNull();
});
it("真实 stdio 协议握手、工具列表、错误及取消；stdout 不暴露凭据", async () => {
  const input = new PassThrough(),
    output = new PassThrough(),
    packets: any[] = [];
  output.on("data", (b) => packets.push(JSON.parse(b.toString())));
  const adapter = createAdapter({ adapter: "mcp" });
  const node = {
    adapter,
    config: { token: "PRIVATE-MCP-TEST-TOKEN", host_name: "WorkBuddy" },
    connectionStatus: { connected: true, state: "approved" },
    stop() {
      this.stopped = true;
      void adapter.disconnect();
    },
    stopped: false,
  };
  const serving = serveHostMCP(node, { input, output });
  const send = (id: number | undefined, method: string, params = {}) =>
    input.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  send(1, "initialize", {
    protocolVersion: "2025-06-18",
    clientInfo: { name: "WorkBuddy", version: "test" },
  });
  send(undefined, "notifications/initialized");
  send(2, "tools/list");
  send(3, "tools/call", { name: "island_status", arguments: {} });
  send(4, "tools/call", {
    name: "island_wait_task",
    arguments: { wait_seconds: 1 },
  });
  send(undefined, "notifications/cancelled", { requestId: 4 });
  send(5, "tools/call", { name: "island_complete_task", arguments: {} });
  await new Promise((r) => setTimeout(r, 20));
  input.end();
  await serving;
  expect(
    packets.find((p) => p.id === 1).result.capabilities.tools,
  ).toBeDefined();
  expect(packets.find((p) => p.id === 2).result.tools).toHaveLength(4);
  expect(packets.find((p) => p.id === 4).result.content[0].text).toBe("null");
  expect(packets.find((p) => p.id === 5).result.isError).toBe(true);
  expect(JSON.stringify(packets)).not.toContain(node.config.token);
});

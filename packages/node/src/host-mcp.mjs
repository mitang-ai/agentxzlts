import { z } from "zod";
import {
  turnResultSchema,
  WIRE_MAX_BYTES,
  boundedError,
} from "../../agents/protocol.mjs";

const identity = { task_id: z.uuid(), delivery_id: z.uuid() };
const schemas = {
  island_status: z.object({}).strict(),
  island_wait_task: z
    .object({ wait_seconds: z.number().int().min(1).max(25).default(20) })
    .strict(),
  island_complete_task: z
    .object({ ...identity, result: turnResultSchema })
    .strict(),
  island_fail_task: z
    .object({ ...identity, error: z.string().trim().min(1).max(600) })
    .strict(),
};
const descriptions = {
  island_status: "查看当前宿主的专用联机状态，不暴露设备密钥。",
  island_wait_task:
    "等待房间点名或已授权任务（最多 25 秒）。任务由你当前宿主自行处理，禁止交给其它 Agent CLI。没有任务则停止本轮等待，不保证宿主自动后台唤醒。",
  island_complete_task:
    "回传当前任务的结构化结果，等待服务器确认。使用任务的 task_id 和 delivery_id，不得冒充其它席位。",
  island_fail_task:
    "无法读取文档或执行任务时报告具体失败原因，不假称对齐或完成。",
};
export async function serveHostMCP(
  node,
  { input = process.stdin, output = process.stdout } = {},
) {
  let initialized = false,
    ready = false,
    buffer = "",
    closed = false,
    inflight = 0;
  const calls = new Map();
  const send = (id, result, error) => {
    if (!closed)
      output.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          ...(error ? { error } : { result }),
        }) + "\n",
      );
  };
  const text = (data) => ({
    content: [{ type: "text", text: JSON.stringify(data) }],
  });
  async function handle(packet) {
    const id = packet?.id;
    if (packet?.jsonrpc !== "2.0" || typeof packet.method !== "string") {
      send(id ?? null, null, { code: -32600, message: "Invalid request" });
      return;
    }
    if (id === undefined) {
      if (packet.method === "notifications/initialized") ready = initialized;
      if (packet.method === "notifications/cancelled")
        calls.get(packet.params?.requestId)?.abort();
      return;
    }
    if (inflight >= 16 || calls.has(id)) {
      send(id, null, {
        code: -32600,
        message: "Too many or duplicate requests",
      });
      return;
    }
    const controller = new AbortController();
    calls.set(id, controller);
    inflight++;
    try {
      if (packet.method === "initialize") {
        if (initialized) throw Error("Already initialized");
        initialized = true;
        const versions = [
          "2024-11-05",
          "2025-03-26",
          "2025-06-18",
          "2025-11-25",
        ];
        send(id, {
          protocolVersion: versions.includes(packet.params?.protocolVersion)
            ? packet.params.protocolVersion
            : "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "island-host-bridge", version: "1.0.0" },
          instructions:
            "这是当前宿主的独立聊天室席位。调用 island_wait_task 获取授权，自己执行并回传，不调用其它 Agent CLI；不得无限后台等待。",
        });
      } else if (packet.method === "ping") send(id, {});
      else if (!ready)
        send(id, null, { code: -32002, message: "Not initialized" });
      else if (packet.method === "tools/list")
        send(id, {
          tools: Object.entries(schemas).map(([name, schema]) => ({
            name,
            description: descriptions[name],
            inputSchema: z.toJSONSchema(schema),
          })),
        });
      else if (packet.method === "tools/call") {
        const name = packet.params?.name,
          schema = schemas[name];
        if (!schema) {
          send(id, null, { code: -32602, message: "Unknown tool" });
          return;
        }
        try {
          const args = schema.parse(packet.params.arguments || {});
          let result;
          if (name === "island_status")
            result = {
              host: node.config.host_name || node.config.agent_name,
              adapter: "mcp",
              participant_id: node.config.participant_id,
              room_id: node.config.room_id,
              connected: !!node.connectionStatus.connected,
              state: node.connectionStatus.state,
              muted: node.connectionStatus.muted,
              pending_task: node.adapter.pending?.job.id || null,
            };
          else if (name === "island_wait_task") {
            if (node.stopped)
              throw Error("设备已停止或撤销，请检查专用配置并重新配对。");
            result = await node.adapter.waitTask(
              args.wait_seconds,
              controller.signal,
            );
          } else if (name === "island_complete_task")
            result = await node.adapter.complete(
              args.task_id,
              args.delivery_id,
              args.result,
            );
          else
            result = node.adapter.fail(
              args.task_id,
              args.delivery_id,
              args.error,
            );
          send(id, text(result));
        } catch (error) {
          send(id, { ...text({ error: boundedError(error) }), isError: true });
        }
      } else send(id, null, { code: -32601, message: "Method not found" });
    } catch (error) {
      send(id, null, { code: -32602, message: boundedError(error) });
    } finally {
      calls.delete(id);
      inflight--;
    }
  }
  input.setEncoding("utf8");
  return new Promise((resolve) => {
    const close = () => {
      if (closed) return;
      closed = true;
      for (const controller of calls.values()) controller.abort();
      node.stop();
      resolve();
    };
    input.on("data", (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > WIRE_MAX_BYTES) {
        send(null, null, { code: -32600, message: "Message too large" });
        close();
        return;
      }
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        try {
          void handle(JSON.parse(line));
        } catch {
          send(null, null, { code: -32700, message: "Parse error" });
        }
      }
    });
    input.once("end", close);
    input.once("error", close);
  });
}

import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin });
const mode = process.argv[2];
const send = (x) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...x }) + "\n");
const pending = new Map();
let next = 100;
const request = (method, params) =>
  new Promise((yes) => {
    const id = next++;
    pending.set(id, yes);
    send({ id, method, params });
  });
lines.on("line", async (line) => {
  const p = JSON.parse(line);
  if (p.method === "initialize")
    send({
      id: p.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: {},
        agentInfo: { name: "ACP 权限夹具" },
      },
    });
  else if (p.method === "session/new")
    send({ id: p.id, result: { sessionId: "scoped-session" } });
  else if (p.method === "session/prompt") {
    let message;
    const sessionId =
      mode === "wrong-session" ? "other-session" : "scoped-session";
    if (mode === "write-outside") {
      const response = await request("fs/write_text_file", {
        sessionId,
        path: "other.txt",
        content: "not allowed",
      });
      message = response.error ? "拒绝越界写入" : "错误：允许越界";
    } else {
      const kind =
        mode === "read" ? "read" : mode === "execute" ? "execute" : "edit";
      const locations =
        mode === "empty"
          ? []
          : [{ path: mode === "outside" ? "../private.txt" : "src/file.txt" }];
      const permission = await request("session/request_permission", {
        sessionId,
        toolCall: { kind, locations },
        options: [
          { kind: "allow_always", optionId: "always", name: "永远允许" },
          { kind: "allow_once", optionId: "once", name: "仅此一次" },
        ],
      });
      if (
        permission.result?.outcome?.outcome === "selected" &&
        permission.result.outcome.optionId === "once"
      ) {
        if (kind === "edit") {
          const write = await request("fs/write_text_file", {
            sessionId,
            path: "src/file.txt",
            content: "由当前 ACP 写入",
          });
          message = write.error ? "错误：写入失败" : "范围内一次性编辑成功";
        } else message = "范围内一次性读取成功";
      } else message = "拒绝未授权请求";
    }
    send({
      method: "session/update",
      params: {
        sessionId: "scoped-session",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: JSON.stringify({ message }) },
        },
      },
    });
    send({ id: p.id, result: { stopReason: "end_turn" } });
  } else if (pending.has(p.id)) {
    pending.get(p.id)(p);
    pending.delete(p.id);
  }
});

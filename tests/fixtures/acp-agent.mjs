import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin });
const send = (packet) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...packet }) + "\n");
const answer = {
  message: "ACP 已完成一次授权",
  acknowledge: false,
  speakers: [],
  done: false,
  plan: [],
  summary: "",
};
let prompt, expectedError;
for await (const line of lines) {
  const packet = JSON.parse(line);
  if (packet.method === "initialize")
    send({
      id: packet.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: {},
        agentInfo: { name: "本地 ACP 验收程序", version: "1.0" },
      },
    });
  if (packet.method === "session/new")
    send({ id: packet.id, result: { sessionId: "fixture-session" } });
  if (packet.method === "session/prompt") {
    prompt = packet.id;
    if (process.argv.includes("--symlink")) {
      expectedError = true;
      send({
        id: 100,
        method: "fs/read_text_file",
        params: { sessionId: "fixture-session", path: "escape/private.txt" },
      });
    } else if (process.argv.includes("--write-denied")) {
      expectedError = true;
      send({
        id: 100,
        method: "fs/write_text_file",
        params: {
          sessionId: "fixture-session",
          path: "new.txt",
          content: "not allowed",
        },
      });
    } else {
      send({
        method: "session/update",
        params: {
          sessionId: "fixture-session",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: JSON.stringify(answer) },
          },
        },
      });
      send({ id: prompt, result: { stopReason: "end_turn" } });
    }
  }
  if (packet.id === 100 && (packet.result || packet.error)) {
    if (expectedError && !packet.error) {
      send({
        id: prompt,
        error: { code: -32000, message: "危险请求居然获得授权" },
      });
    } else {
      send({
        method: "session/update",
        params: {
          sessionId: "fixture-session",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: JSON.stringify({
                ...answer,
                message: "文件边界已拒绝越权",
              }),
            },
          },
        },
      });
      send({ id: prompt, result: { stopReason: "end_turn" } });
    }
  }
}

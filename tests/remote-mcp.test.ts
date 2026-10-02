import {
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  describe,
  it,
  expect,
} from "vitest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { createServer, request } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { createStorage } from "../packages/runtime/storage.mjs";
// @ts-ignore
import { attachGateway } from "../packages/agents/gateway.mjs";
// @ts-ignore
import { RemoteAgentSession } from "../packages/agents/remote-mcp.mjs";
// @ts-ignore
import { AgentService } from "../packages/agents/service.mjs";
// @ts-ignore
import { IslandNode } from "../packages/node/src/client.mjs";

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ||
    "postgresql://island:local-development-only@127.0.0.1:55432/postgres",
});
const users = [randomUUID(), randomUUID()];
let root: string,
  gateway: any,
  server: any,
  origin: string,
  room: string,
  otherRoom: string;
const clients: Client[] = [];
async function command(user: string, action: string, data: any) {
  const db = await pool.connect();
  try {
    await db.query("begin");
    await db.query("select set_config('request.jwt.claim.sub',$1,true)", [
      user,
    ]);
    const r = (
      await db.query("select island_command($1,$2) result", [
        action,
        JSON.stringify(data),
      ])
    ).rows[0].result;
    await db.query("commit");
    return r;
  } catch (e) {
    await db.query("rollback");
    throw e;
  } finally {
    db.release();
  }
}
async function device(owner = users[0], target = room, host = "WorkBuddy") {
  return gateway.service.createRemoteConnection(owner, target, {
    host_name: host,
    agent_name: host,
  });
}
async function approve(node: any) {
  await gateway.service.seatAction(users[0], room, "approve", {
    participant_id: node.participant_id,
  });
}
async function clientFor(token: string, legacy = false) {
  const client = new Client(
    {
      name: legacy ? "2025-client-fixture" : "2026-client-fixture",
      version: "1.0.0",
    },
    legacy ? { supportedProtocolVersions: ["2025-03-26"] } : {},
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL(origin + "/mcp"), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  clients.push(client);
  return client;
}
async function call(client: Client, name: string, args: Record<string, any>) {
  const result = await client.callTool({ name, arguments: args });
  return {
    ...JSON.parse((result.content as any)[0].text),
    isError: result.isError === true,
  };
}
async function open(client: Client) {
  return call(client, "island_open", { client_id: randomUUID() });
}
async function mention(
  node: any,
  content = "请回应这一条，不要转交其它 Agent",
) {
  return command(users[0], "message", {
    room_id: room,
    content,
    client_message_id: randomUUID(),
    mentioned_participant_ids: [node.participant_id],
  });
}
beforeAll(async () => {
  root = await mkdtemp(resolve(tmpdir(), "island-remote-mcp-"));
  for (let i = 0; i < users.length; i++)
    await pool.query(
      "insert into auth.users(id,email,raw_user_meta_data) values($1,$2,$3)",
      [
        users[i],
        `${users[i]}@remote-mcp.invalid`,
        JSON.stringify({ display_name: `成员 ${i + 1}` }),
      ],
    );
  server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  origin = `http://127.0.0.1:${server.address().port}`;
  gateway = attachGateway(
    server,
    pool,
    createStorage(pool, { STORAGE_DIR: root }),
    { APP_ORIGIN: origin },
  );
  server.on("request", async (req: any, res: any) => {
    if (!(await gateway.handleHTTP(req, res))) {
      res.writeHead(404);
      res.end();
    }
  });
  server.on(
    "upgrade",
    (req: any, socket: any, head: any) =>
      void gateway.upgrade(req, socket, head),
  );
});
beforeEach(async () => {
  room = (await command(users[0], "create_room", { name: "远程 MCP 隔离验收" }))
    .id;
  otherRoom = (await command(users[0], "create_room", { name: "禁止跨房间" }))
    .id;
  const invite = await command(users[0], "invite", {
    room_id: room,
    hours: 1,
    max_uses: 1,
  });
  await command(users[1], "join_invite", { token: invite.token });
});
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  await pool.query("delete from rooms where id=any($1)", [
    [room, otherRoom].filter(Boolean),
  ]);
  await pool.query("delete from agent_nodes where owner_user_id=any($1)", [
    users,
  ]);
});
afterAll(async () => {
  await gateway?.close();
  await new Promise<void>((r) => server?.close(() => r()));
  await pool.query("delete from auth.users where id=any($1)", [users]);
  await pool.end();
  if (root) await rm(root, { recursive: true, force: true });
});
describe.sequential("通用远程 MCP 的真实 HTTP 协议、身份与最终业务状态", () => {
  it("原 WS 客户端遇到 Gateway 遗留租约只等待一次，租约过期后恢复；新副本不抢占", async () => {
    const pairing = await gateway.service.createPairing(users[0], room);
    const wire = await gateway.service.pair({
      code: pairing.code,
      node_name: "WS恢复",
      agent_name: "WS恢复",
      adapter: "cli",
      fingerprint: randomUUID(),
      capabilities: {},
    });
    const previous = await gateway.service.connect(wire.token);
    const node = new IslandNode(
      {
        server: origin,
        token: wire.token,
        adapter: "cli",
        command: process.execPath,
        workspace: root,
      },
      {
        configFile: resolve(root, randomUUID(), "config.json"),
        logger: () => {},
      },
    );
    node.hasConnected = true;
    await expect(node.connect()).rejects.toThrow("409");
    expect(node.stopped).toBe(false);
    expect(node.retry).toBe(46000);
    await expect(node.connect()).rejects.toThrow("409");
    expect(node.stopped).toBe(true);
    const recovering = new IslandNode(
      {
        server: origin,
        token: wire.token,
        adapter: "cli",
        command: process.execPath,
        workspace: root,
      },
      {
        configFile: resolve(root, randomUUID(), "config.json"),
        logger: () => {},
      },
    );
    await pool.query(
      "update agent_nodes set last_seen_at=now()-interval '46 seconds' where id=$1",
      [wire.node_id],
    );
    const connected = recovering.connect();
    try {
      for (let i = 0; i < 100 && !recovering.connectionStatus.connected; i++)
        await new Promise((r) => setTimeout(r, 20));
      expect(recovering.connectionStatus.connected).toBe(true);
      expect(recovering.connectionStatus.session_id).not.toBe(
        previous.session_id,
      );
    } finally {
      recovering.stop();
      await connected;
    }
  });
  it("同房间 Markdown 资源可读，大文档明确拒绝而不是截断伪成功", async () => {
    const node = await device();
    await approve(node);
    const c = await clientFor(node.token),
      conn = await open(c);
    for (const large of [false, true]) {
      const fid = randomUUID(),
        bytes = Buffer.from(
          large ? "x".repeat(256 * 1024 + 1) : "# 需求\n真实文档内容",
        ),
        path = `${room}/${fid}`;
      await gateway.service.storage.storeFile(path, bytes, "text/markdown");
      await command(users[0], "register_file", {
        id: fid,
        room_id: room,
        name: "需求.md",
        mime_type: "text/markdown",
        size: bytes.length,
        storage_path: path,
      });
      const result = await c.callTool({
        name: "island_read_document",
        arguments: { connection_id: conn.connection_id, file_id: fid },
      });
      if (large) {
        expect(result.isError).toBe(true);
        expect(JSON.parse((result.content as any)[0].text).status).toBe(413);
      } else
        expect((result.content as any)[0].resource.text).toBe(bytes.toString());
    }
  });
  it.each([false, true])(
    "新旧 SDK 协议都能完成点名、领取、回传，并在消息表只写入一次 (legacy=%s)",
    async (legacy) => {
      const node = await device();
      await approve(node);
      const client = await clientFor(node.token, legacy),
        conn = await open(client);
      expect((await client.listTools()).tools.map((t) => t.name)).toContain(
        "island_wait_task",
      );
      await mention(node);
      const first = await call(client, "island_wait_task", {
        connection_id: conn.connection_id,
        timeout_seconds: 0,
      });
      expect(first.task.kind).toBe("mention");
      expect(first.task.lease).toBeUndefined();
      expect(JSON.stringify(first)).not.toContain(node.token);
      const again = await call(client, "island_wait_task", {
        connection_id: conn.connection_id,
        timeout_seconds: 0,
      });
      expect(again.task.delivery_id).toBe(first.task.delivery_id);
      expect(
        (
          await call(client, "island_task_progress", {
            connection_id: conn.connection_id,
            delivery_id: first.task.delivery_id,
          })
        ).ok,
      ).toBe(true);
      const result = {
        connection_id: conn.connection_id,
        delivery_id: first.task.delivery_id,
        result: { message: "由当前 Agent 原生回传" },
      };
      expect((await call(client, "island_complete_task", result)).ok).toBe(
        true,
      );
      expect(
        (await call(client, "island_complete_task", result)).duplicate,
      ).toBe(true);
      expect(
        (
          await pool.query(
            "select count(*) n from messages where room_id=$1 and sender_participant_id=$2 and content=$3",
            [room, node.participant_id, result.result.message],
          )
        ).rows[0].n,
      ).toBe("1");
      expect(
        (
          await pool.query(
            "select status from agent_turns where remote_delivery_id=$1",
            [first.task.delivery_id],
          )
        ).rows[0].status,
      ).toBe("completed");
    },
  );
  it("房间成员可查看对方所属用户、连接中和已连接状态，列表不泄露密钥", async () => {
    const n1 = await device(),
      n2 = await device(users[1], room, "豆包工作"),
      n3 = await device(users[0], otherRoom, "其它房间");
    await approve(n1);
    await approve(n2);
    const code = await gateway.service.createPairing(users[1], room);
    await gateway.service.authorizeClientDownload(code.code);
    const c = await clientFor(n1.token);
    const conn = await open(c);
    const state = await gateway.service.state(users[1], room);
    expect(state.seats).toHaveLength(2);
    expect(
      state.seats.find((s: any) => s.node_id === n1.node_id),
    ).toMatchObject({
      owner_name: "成员 1",
      is_connected: true,
      model_ready: false,
    });
    expect(
      state.seats.find((s: any) => s.node_id === n2.node_id),
    ).toMatchObject({ owner_name: "成员 2", is_connected: false });
    expect(
      state.pairings.find((p: any) => p.id === code.id).download_started_at,
    ).toBeTruthy();
    const context = await call(c, "island_read_context", {
      connection_id: conn.connection_id,
    });
    expect(context.seats.map((s: any) => s.owner_name)).toEqual([
      "成员 1",
      "成员 2",
    ]);
    for (const secret of [n1.token, n2.token, n3.token, code.code])
      expect(JSON.stringify(state) + JSON.stringify(context)).not.toContain(
        secret,
      );
  });
  it("待批准席位不泄露历史；两个身份不能互用交付；禁止跨房间读取文件", async () => {
    const n1 = await device(),
      n2 = await device(users[1], room, "豆包工作");
    const c1 = await clientFor(n1.token),
      c2 = await clientFor(n2.token),
      conn1 = await open(c1),
      conn2 = await open(c2);
    expect(
      (
        await call(c1, "island_read_context", {
          connection_id: conn1.connection_id,
        })
      ).messages,
    ).toBeUndefined();
    await approve(n1);
    await approve(n2);
    await mention(n1);
    const task = (
      await call(c1, "island_wait_task", {
        connection_id: conn1.connection_id,
        timeout_seconds: 0,
      })
    ).task;
    const wrong = await call(c2, "island_complete_task", {
      connection_id: conn2.connection_id,
      delivery_id: task.delivery_id,
      result: { message: "冒充" },
    });
    expect(wrong).toMatchObject({ isError: true, status: 409 });
    const fid = randomUUID();
    await gateway.service.storage.storeFile(
      `${otherRoom}/${fid}`,
      Buffer.from("private"),
      "text/plain",
    );
    await command(users[0], "register_file", {
      id: fid,
      room_id: otherRoom,
      name: "private.txt",
      mime_type: "text/plain",
      size: 7,
      storage_path: `${otherRoom}/${fid}`,
    });
    expect(
      (
        await call(c1, "island_read_document", {
          connection_id: conn1.connection_id,
          file_id: fid,
        })
      ).isError,
    ).toBe(true);
    expect(
      (
        await pool.query(
          "select status from agent_turns where remote_delivery_id=$1",
          [task.delivery_id],
        )
      ).rows[0].status,
    ).toBe("leased");
  });
  it("数据库在多个 Gateway 实例间拒绝抢占；独立 CLI 和远程 MCP 凭据不能交叉使用", async () => {
    const node = await device();
    const remote = new RemoteAgentSession(gateway.service, node.token);
    const conn = await remote.open({ client_id: randomUUID() });
    const other = new AgentService(pool, gateway.service.storage);
    await expect(
      other.connect(node.token, {
        transport: "remote-mcp",
        clientId: randomUUID(),
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(other.connect(node.token)).rejects.toMatchObject({
      status: 403,
    });
    const pairing = await gateway.service.createPairing(users[0], room);
    const wire = await gateway.service.pair({
      code: pairing.code,
      node_name: "本地",
      agent_name: "本地",
      adapter: "mcp",
      fingerprint: randomUUID(),
      capabilities: {},
    });
    await expect(
      new RemoteAgentSession(other, wire.token).authorize(),
    ).rejects.toMatchObject({ status: 403 });
    const opened = await other.connect(wire.token);
    const raced = await Promise.allSettled([
      other.connect(wire.token),
      gateway.service.connect(wire.token),
    ]);
    expect(
      raced.every(
        (r) => r.status === "rejected" && (r.reason as any).status === 409,
      ),
    ).toBe(true);
    expect(
      (
        await pool.query("select session_id from agent_nodes where id=$1", [
          wire.node_id,
        ])
      ).rows[0].session_id,
    ).toBe(opened.session_id);
    expect(
      (
        await pool.query("select session_id from agent_nodes where id=$1", [
          node.node_id,
        ])
      ).rows[0].session_id,
    ).toBe(conn.connection_id);
  });
  it("同一连接拒绝并发消费者，无任务等待结束不能冒充模型就绪", async () => {
    const node = await device();
    await approve(node);
    const remote = new RemoteAgentSession(gateway.service, node.token),
      conn = await remote.open({ client_id: randomUUID() });
    const pending = remote.wait(conn.connection_id, 1);
    await new Promise((r) => setTimeout(r, 100));
    await expect(remote.wait(conn.connection_id, 0)).rejects.toMatchObject({
      status: 409,
    });
    expect(
      (await gateway.service.state(users[0], room)).seats[0].model_ready,
    ).toBe(true);
    expect((await pending).task).toBeNull();
    const after = (await gateway.service.state(users[0], room)).seats[0];
    expect(after.is_connected).toBe(true);
    expect(after.model_ready).toBe(false);
  });
  it("过期租约不能靠进度请求复活，重连后旧交付不能写入；撤销立即阻断", async () => {
    const node = await device();
    await approve(node);
    const remote = new RemoteAgentSession(gateway.service, node.token),
      conn = await remote.open({ client_id: randomUUID() });
    await mention(node);
    const task = (await remote.wait(conn.connection_id, 0)).task;
    await pool.query(
      "update agent_turns set lease_until=now()-interval '1 second' where remote_delivery_id=$1",
      [task.delivery_id],
    );
    await expect(
      remote.progress(conn.connection_id, task.delivery_id),
    ).rejects.toMatchObject({ status: 409 });
    await pool.query(
      "update agent_nodes set last_seen_at=now()-interval '46 seconds' where id=$1",
      [node.node_id],
    );
    const next = await remote.open({ client_id: randomUUID() });
    expect(next.connection_id).not.toBe(conn.connection_id);
    await expect(
      remote.complete({
        connection_id: conn.connection_id,
        delivery_id: task.delivery_id,
        result: { message: "迟到" },
      }),
    ).rejects.toMatchObject({ status: 401 });
    await gateway.service.seatAction(users[0], room, "revoke", {
      participant_id: node.participant_id,
    });
    expect(
      (
        await fetch(origin + "/mcp", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${node.token}`,
            "Content-Type": "application/json",
          },
          body: "{}",
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await pool.query(
          "select count(*) n from messages where room_id=$1 and sender_participant_id=$2",
          [room, node.participant_id],
        )
      ).rows[0].n,
    ).toBe("0");
  });
  it("HTTP 拒绝错误来源、伪造 Host、无凭据和超大请求；协议发现不产生在线连接", async () => {
    const node = await device();
    const c = await clientFor(node.token);
    await c.listTools();
    expect(
      (await gateway.service.state(users[0], room)).seats[0].is_connected,
    ).not.toBe(true);
    const headers = {
      Authorization: `Bearer ${node.token}`,
      "Content-Type": "application/json",
    };
    expect(
      (
        await fetch(origin + "/mcp", {
          method: "POST",
          headers: { ...headers, Origin: "https://evil.invalid" },
          body: "{}",
        })
      ).status,
    ).toBe(403);
    const wrongHost = await new Promise<number>((yes, no) => {
      const req = request(
        origin + "/mcp",
        { method: "POST", headers: { ...headers, host: "evil.invalid" } },
        (res) => {
          res.resume();
          yes(res.statusCode!);
        },
      );
      req.once("error", no);
      req.end("{}");
    });
    expect(wrongHost).toBe(403);
    expect(
      (await fetch(origin + "/mcp", { method: "POST", body: "{}" })).status,
    ).toBe(401);
    expect(
      (
        await fetch(origin + "/mcp", {
          method: "POST",
          headers,
          body: JSON.stringify({ large: "a".repeat(2 * 1024 * 1024) }),
        })
      ).status,
    ).toBe(413);
  });
});

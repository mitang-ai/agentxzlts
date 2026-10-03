import { beforeAll, afterAll, it, expect } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
// @ts-ignore Executable service.
import { AgentService } from "../packages/agents/service.mjs";
// @ts-ignore
import { participantPresence } from "../packages/agents/presence.mjs";
import { createStorage } from "../packages/runtime/storage.mjs";
const pool = new Pool({ connectionString: process.env.DATABASE_URL }),
  users = [randomUUID(), randomUUID(), randomUUID()];
let service: any, root: string, room: string;
async function human(user: string, command: string, data: any) {
  const db = await pool.connect();
  try {
    await db.query("begin");
    await db.query("select set_config('request.jwt.claim.sub',$1,true)", [
      user,
    ]);
    const result = (
      await db.query("select island_command($1,$2) result", [
        command,
        JSON.stringify(data),
      ])
    ).rows[0].result;
    await db.query("commit");
    return result;
  } catch (error) {
    await db.query("rollback");
    throw error;
  } finally {
    db.release();
  }
}
beforeAll(async () => {
  root = await mkdtemp(resolve(tmpdir(), "island-consistency-"));
  service = new AgentService(pool, createStorage(pool, { STORAGE_DIR: root }));
  for (const id of users)
    await pool.query(
      "insert into auth.users(id,email,raw_user_meta_data) values($1,$2,$3)",
      [
        id,
        id + "@consistency.invalid",
        JSON.stringify({ display_name: "审批验收用户" }),
      ],
    );
  room = (await human(users[0], "create_room", { name: "统一入席审批房间" }))
    .id;
  const invite = await human(users[0], "invite", {
    room_id: room,
    hours: 1,
    max_uses: 2,
  });
  await human(users[1], "join_invite", { token: invite.token });
});
afterAll(async () => {
  if (room) await pool.query("delete from rooms where id=$1", [room]);
  await pool.query("delete from auth.users where id=any($1)", [users]);
  await pool.end();
  if (root) await rm(root, { recursive: true, force: true });
});

it("旧房间邀请重新生成改为用户级邀请，不再创建新房间绑定身份", async () => {
  const old = await service.createPairing(users[1], room);
  const fresh = await service.invitationAction(users[1], {
    id: old.id,
    action: "regenerate",
  });
  expect(
    (
      await pool.query("select room_id from agent_pairings where id=$1", [
        fresh.id,
      ])
    ).rows[0].room_id,
  ).toBeNull();
  await expect(
    service.pair({
      code: old.code,
      node_name: "旧邀请",
      agent_name: "旧邀请",
      adapter: "cli",
      fingerprint: randomUUID(),
      capabilities: {},
    }),
  ).rejects.toMatchObject({ status: 403 });
  await service.invitationAction(users[1], { id: fresh.id, action: "revoke" });
});

it("添加房间等待设备锁期间被撤销，不能根据旧快照创建新席位", async () => {
  const invite = await service.createPairing(users[1]);
  const node = await service.pair({
    code: invite.code,
    node_name: "撤销竞态验收",
    agent_name: "撤销竞态验收",
    adapter: "cli",
    fingerprint: randomUUID(),
    capabilities: {},
  });
  let release!: () => void,
    captured!: () => void,
    paused = false;
  const gate = new Promise<void>((r) => (release = r)),
    held = new Promise<void>((r) => (captured = r));
  const wrapped = {
    async connect() {
      const db = await pool.connect();
      return {
        release: () => db.release(),
        async query(sql: string, parameters?: any[]) {
          const result = await db.query(sql, parameters);
          if (
            !paused &&
            sql.includes("from agent_nodes where id=$1 and owner_user_id=$2")
          ) {
            paused = true;
            captured();
            await gate;
          }
          return result;
        },
      };
    },
  };
  const controlled = new AgentService(wrapped, service.storage);
  const adding = controlled.addAgentToRoom(users[1], room, node.node_id);
  const outcome = adding.then(
    (result: any) => result,
    (error: any) => error,
  );
  try {
    await held;
    await service.revokeMyAgent(users[1], node.node_id);
    release();
    expect(await outcome).toMatchObject({ status: 403 });
    expect(
      (
        await pool.query("select 1 from agent_seats where node_id=$1", [
          node.node_id,
        ])
      ).rowCount,
    ).toBe(0);
  } finally {
    release();
    await outcome;
  }
});

it("多房间修改期间新增席位时回滚，不反向补锁；原操作重试完整同步昵称", async () => {
  const invite = await service.createPairing(users[1]);
  const node = await service.pair({
    code: invite.code,
    node_name: "房间集合竞态",
    agent_name: "修改前",
    adapter: "cli",
    fingerprint: randomUUID(),
    capabilities: {},
  });
  let release!: () => void,
    captured!: () => void,
    paused = false;
  const gate = new Promise<void>((r) => (release = r)),
    held = new Promise<void>((r) => (captured = r));
  const wrapped = {
    async connect() {
      const db = await pool.connect();
      return {
        release: () => db.release(),
        async query(sql: string, parameters?: any[]) {
          const result = await db.query(sql, parameters);
          if (
            !paused &&
            sql.startsWith("select distinct p.room_id from agent_seats")
          ) {
            paused = true;
            captured();
            await gate;
          }
          return result;
        },
      };
    },
  };
  const controlled = new AgentService(wrapped, service.storage);
  const request = { node_id: node.node_id, agent_name: "修改后" };
  const updating = controlled.updateAgent(users[1], request);
  const outcome = updating.then(
    (result: any) => result,
    (error: any) => error,
  );
  try {
    await held;
    const seat = await service.addAgentToRoom(users[1], room, node.node_id);
    release();
    expect(await outcome).toMatchObject({ status: 503 });
    expect(
      (
        await pool.query("select agent_name from agent_nodes where id=$1", [
          node.node_id,
        ])
      ).rows[0].agent_name,
    ).toBe("修改前");
    await service.updateAgent(users[1], request);
    expect(
      (
        await pool.query("select display_name from participants where id=$1", [
          seat.participant_id,
        ])
      ).rows[0].display_name,
    ).toBe("修改后");
  } finally {
    release();
    await outcome;
    await service.revokeMyAgent(users[1], node.node_id);
  }
});

it("我的 Agent 汇总主持人审批别人的设备；普通成员与外人不可审批，不泄露凭据和私有发送", async () => {
  const invite = await service.createPairing(users[1]);
  const node = await service.pair({
    code: invite.code,
    node_name: "PRIVATE-DEVICE-NAME",
    agent_name: "来宾 Agent",
    adapter: "cli",
    fingerprint: randomUUID(),
    capabilities: { egress_v2: true },
  });
  const seat = await service.addAgentToRoom(users[1], room, node.node_id);
  const mine = await service.myAgents(users[0]);
  expect(mine.approvals).toHaveLength(1);
  expect(mine.approvals[0]).toMatchObject({
    room_id: room,
    participant_id: seat.participant_id,
    display_name: "来宾 Agent",
  });
  const publicSummary = JSON.stringify(mine.approvals);
  for (const secret of [
    invite.code,
    node.token,
    "PRIVATE-DEVICE-NAME",
    "token_hash",
    "code_cipher",
    "payload_cipher",
  ])
    expect(publicSummary).not.toContain(secret);
  expect((await service.myAgents(users[1])).approvals).toHaveLength(0);
  expect((await service.myAgents(users[2])).approvals).toHaveLength(0);
  for (const user of [users[1], users[2]])
    await expect(
      service.seatAction(user, room, "approve", {
        participant_id: seat.participant_id,
      }),
    ).rejects.toMatchObject({ status: 403 });
  await service.seatAction(users[0], room, "approve", {
    participant_id: seat.participant_id,
  });
  expect((await service.myAgents(users[0])).approvals).toHaveLength(0);
  await service.updateAgent(users[1], {
    node_id: node.node_id,
    agent_name: "来宾 Agent",
    privacy_mode: "review",
  });
  const connection = await service.connect(node.token);
  await human(users[0], "message", {
    room_id: room,
    content: "请回答",
    client_message_id: randomUUID(),
    mentioned_participant_ids: [seat.participant_id],
  });
  const job = await service.claim(node.token, connection.session_id);
  const publication = await service.complete(
    node.token,
    job.id,
    job.lease,
    { message: "本人可见的待审结果" },
    connection.session_id,
  );
  expect(publication.pending_review).toBe(true);
  expect((await service.myAgents(users[0])).reviews).toHaveLength(0);
  expect((await service.myAgents(users[1])).reviews).toHaveLength(1);
  await service.revokeMyAgent(users[1], node.node_id);
});

it("MCP 只有连接没有消费者不显示在线，真实监听/静音/撤销影响同一权威状态", async () => {
  const node = await service.createRemoteConnection(users[1], null, {
    host_name: "验收 MCP",
    agent_name: "手动助手",
  });
  const seat = await service.addAgentToRoom(users[1], room, node.node_id);
  await service.seatAction(users[0], room, "approve", {
    participant_id: seat.participant_id,
  });
  const connection = await service.connect(node.token, {
    transport: "remote-mcp",
    clientId: randomUUID(),
  });
  const state = async () =>
    (await service.state(users[0], room)).seats.find(
      (s: any) => s.participant_id === seat.participant_id,
    );
  const online = async () =>
    (await participantPresence(pool, [{ id: seat.participant_id }], room))[0]
      .online;
  expect(await state()).toMatchObject({
    is_connected: true,
    model_ready: false,
    is_online: false,
  });
  expect(await online()).toBe(false);
  await service.nodeSync(node.token, connection.session_id, 0, null, true);
  expect(await state()).toMatchObject({ is_online: true });
  expect(await online()).toBe(true);
  await service.nodeSync(node.token, connection.session_id, 0, null, false);
  expect(await state()).toMatchObject({ is_online: false });
  expect(await online()).toBe(false);
  await service.nodeSync(node.token, connection.session_id, 0, null, true);
  await service.seatAction(users[0], room, "mute", {
    participant_id: seat.participant_id,
    muted: true,
  });
  expect(await state()).toMatchObject({ is_online: false });
  expect(await online()).toBe(false);
  await service.revokeMyAgent(users[1], node.node_id);
  expect(await online()).toBe(false);
});

it("大厅连接与添加房间并发时不使用旧授权快照，原身份可安全重试", async () => {
  const invite = await service.createPairing(users[1]);
  const node = await service.pair({
    code: invite.code,
    node_name: "大厅竞态",
    agent_name: "切换验收",
    adapter: "cli",
    fingerprint: randomUUID(),
    capabilities: {},
  });
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((r) => (release = r)),
    held = new Promise<void>((r) => (entered = r));
  const wrapped = {
    async connect() {
      const db = await pool.connect();
      return {
        release: () => db.release(),
        async query(sql: string, params?: any[]) {
          if (
            sql.includes("live from agent_nodes") &&
            sql.includes("for update")
          ) {
            entered();
            await gate;
          }
          return db.query(sql, params);
        },
      };
    },
  };
  const racing = new AgentService(
    wrapped as any,
    createStorage(pool, { STORAGE_DIR: root }),
  );
  const connecting = expect(racing.connect(node.token)).rejects.toMatchObject({
    status: 503,
  });
  try {
    await held;
    const seat = await service.addAgentToRoom(users[1], room, node.node_id);
    release();
    await connecting;
    expect(await service.connect(node.token)).toMatchObject({
      room_id: room,
      participant_id: seat.participant_id,
      state: "pending",
    });
    await service.revokeMyAgent(users[1], node.node_id);
  } finally {
    release();
  }
});

it("断线清理与硬删除房间并发不死锁，设备回到大厅而不残留假在线", async () => {
  const extra = (
    await human(users[0], "create_room", { name: "并发清理隔离房间" })
  ).id;
  const invite = await service.createPairing(users[0]);
  const node = await service.pair({
    code: invite.code,
    node_name: "并发设备",
    agent_name: "并发验收",
    adapter: "cli",
    fingerprint: randomUUID(),
    capabilities: {},
  });
  const seat = await service.addAgentToRoom(users[0], extra, node.node_id);
  await service.seatAction(users[0], extra, "approve", {
    participant_id: seat.participant_id,
  });
  const connection = await service.connect(node.token);
  let release!: () => void, locked!: () => void;
  const gate = new Promise<void>((r) => (release = r)),
    held = new Promise<void>((r) => (locked = r));
  const wrapped = {
    async connect() {
      const db = await pool.connect();
      return {
        release: () => db.release(),
        async query(sql: string, parameters?: any[]) {
          const result = await db.query(sql, parameters);
          if (
            sql.startsWith(
              "update agent_nodes set last_seen_at=null,session_id=null",
            )
          ) {
            locked();
            await gate;
          }
          return result;
        },
      };
    },
  };
  const controlled = new AgentService(wrapped, service.storage);
  const disconnect = controlled.disconnected(node.token, connection.session_id);
  await held;
  const deleted = pool.query("delete from rooms where id=$1", [extra]);
  await new Promise((r) => setTimeout(r, 80));
  release();
  await Promise.all([disconnect, deleted]);
  expect(
    (
      await pool.query(
        "select active_seat_id,session_id from agent_nodes where id=$1",
        [node.node_id],
      )
    ).rows[0],
  ).toEqual({ active_seat_id: null, session_id: null });
});

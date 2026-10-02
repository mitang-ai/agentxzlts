import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
// @ts-ignore Server-side ES modules.
import { AgentService } from "../packages/agents/service.mjs";
// @ts-ignore
import { IslandNode } from "../packages/node/src/client.mjs";
// @ts-ignore
import { nodeClientBundle } from "../packages/agents/client-bundle.mjs";
// @ts-ignore
import { readArchive } from "../packages/agents/archive.mjs";
import { createStorage } from "../packages/runtime/storage.mjs";
import { participantPresence } from "../packages/agents/presence.mjs";
const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ||
    "postgresql://island:local-development-only@127.0.0.1:55432/postgres",
});
const users = [randomUUID(), randomUUID()];
let root: string, service: any, room: string, otherRoom: string;
async function command(user: string, action: string, data: any) {
  const db = await pool.connect();
  try {
    await db.query("begin");
    await db.query("select set_config('request.jwt.claim.sub',$1,true)", [
      user,
    ]);
    const result = (
      await db.query("select island_command($1,$2) result", [
        action,
        JSON.stringify(data),
      ])
    ).rows[0].result;
    await db.query("commit");
    return result;
  } catch (e) {
    await db.query("rollback");
    throw e;
  } finally {
    db.release();
  }
}
async function pair(target = room) {
  const code = await service.createPairing(users[0], target);
  return service.pair({
    code: code.code,
    node_name: "测试设备",
    agent_name: "测试 Agent",
    adapter: "cli",
    fingerprint: randomUUID(),
    capabilities: {},
  });
}
async function file(name: string, mime: string, target = room) {
  const id = randomUUID(),
    bytes = Buffer.from("文档内容"),
    path = `${target}/${id}`;
  await service.storage.storeFile(path, bytes, mime);
  await command(users[0], "register_file", {
    id,
    room_id: target,
    storage_path: path,
    name,
    mime_type: mime,
    size: bytes.length,
  });
  return id;
}
beforeAll(async () => {
  root = await mkdtemp(resolve(tmpdir(), "island-connection-ux-"));
  service = new AgentService(pool, createStorage(pool, { STORAGE_DIR: root }));
  for (const user of users)
    await pool.query(
      "insert into auth.users(id,email,raw_user_meta_data) values($1,$2,$3)",
      [
        user,
        `${user}@connection-ux.invalid`,
        JSON.stringify({ display_name: "验收用户" }),
      ],
    );
  room = (
    await command(users[0], "create_room", { name: "连接体验验收", icon: "🏝️" })
  ).id;
  otherRoom = (
    await command(users[0], "create_room", { name: "另一房间", icon: "🏝️" })
  ).id;
  const invite = await command(users[0], "invite", {
    room_id: room,
    hours: 1,
    max_uses: 2,
  });
  await command(users[1], "join_invite", { token: invite.token });
});
afterAll(async () => {
  for (const id of [room, otherRoom].filter(Boolean)) {
    await pool.query("delete from rooms where id=$1", [id]);
    await pool.query("delete from storage.objects where name like $1", [
      `${id}/%`,
    ]);
    await pool.query("delete from storage_cleanup_jobs where path like $1", [
      `${id}/%`,
    ]);
  }
  await pool.query("delete from auth.users where id=any($1)", [users]);
  await pool.end();
  if (root) await rm(root, { recursive: true, force: true });
});
describe.sequential("连接、记录清理与文件需求", () => {
  it("在线以服务器有效连接为准，支持多标签页、过期与断线", async () => {
    const participants = (
      await pool.query("select * from participants where room_id=$1", [room])
    ).rows;
    const member = participants.find((p) => p.user_id === users[1]),
      connections = [randomUUID(), randomUUID()];
    try {
      await pool.query(
        "update participants set last_active_at=null where id=$1",
        [member.id],
      );
      for (const connection of connections)
        await pool.query(
          "insert into realtime_connections(id,user_id,room_id) values($1,$2,$3)",
          [connection, users[1], room],
        );
      expect(
        (await participantPresence(pool, participants, room)).find(
          (p) => p.id === member.id,
        )?.online,
      ).toBe(true);
      await pool.query("delete from realtime_connections where id=$1", [
        connections[0],
      ]);
      expect(
        (await participantPresence(pool, participants, room)).find(
          (p) => p.id === member.id,
        )?.online,
      ).toBe(true);
      await pool.query(
        "update realtime_connections set last_seen_at=now()-interval '21 seconds' where id=$1",
        [connections[1]],
      );
      expect(
        (await participantPresence(pool, participants, room)).find(
          (p) => p.id === member.id,
        )?.online,
      ).toBe(false);
      await pool.query("delete from realtime_connections where id=$1", [
        connections[1],
      ]);
      expect(
        (await participantPresence(pool, participants, room)).find(
          (p) => p.id === member.id,
        )?.online,
      ).toBe(false);
    } finally {
      await pool.query(
        "delete from realtime_connections where id=any($1::uuid[])",
        [connections],
      );
    }
  });
  it("Agent 在线必须有已批准席位、有效会话与未过期心跳", async () => {
    const node = await pair();
    const online = async () =>
      (await participantPresence(pool, [{ id: node.participant_id }], room))[0]
        .online;
    try {
      await pool.query(
        "update agent_nodes set session_id=$2,last_seen_at=now() where id=$1",
        [node.node_id, randomUUID()],
      );
      expect(await online()).toBe(false); // 待批准席位不能显示在线。
      await service.seatAction(users[0], room, "approve", {
        participant_id: node.participant_id,
      });
      expect(await online()).toBe(true);
      await pool.query(
        "update agent_nodes set last_seen_at=now()-interval '46 seconds' where id=$1",
        [node.node_id],
      );
      expect(await online()).toBe(false);
      await pool.query(
        "update agent_nodes set last_seen_at=now(),session_id=null where id=$1",
        [node.node_id],
      );
      expect(await online()).toBe(false);
      await pool.query(
        "update agent_nodes set session_id=$2,expires_at=now()-interval '1 second' where id=$1",
        [node.node_id, randomUUID()],
      );
      expect(await online()).toBe(false);
    } finally {
      await pool.query("delete from participants where id=$1", [
        node.participant_id,
      ]);
      await pool.query("delete from agent_pairings where node_id=$1", [
        node.node_id,
      ]);
      await pool.query("delete from agent_nodes where id=$1", [node.node_id]);
    }
  });
  it("服务器拒绝把 WorkBuddy 绑定到 Codex，保留原码供正确的 MCP 宿主配对", async () => {
    const pairing = await service.createPairing(users[0], room);
    const input = {
      code: pairing.code,
      node_name: "宿主设备",
      agent_name: "WorkBuddy",
      adapter: "codex",
      fingerprint: randomUUID(),
      capabilities: { host_name: "WorkBuddy" },
    };
    await expect(service.pair(input)).rejects.toMatchObject({ status: 400 });
    const node = await service.pair({ ...input, adapter: "mcp" });
    try {
      const state = await service.state(users[0], room);
      expect(
        state.seats.find((s: any) => s.participant_id === node.participant_id),
      ).toMatchObject({
        adapter: "mcp",
        capabilities: { host_name: "WorkBuddy" },
      });
      const files = await readArchive(await nodeClientBundle(process.cwd()));
      expect(files.has("packages/node/src/host-adapter.mjs")).toBe(true);
      expect(files.has("packages/node/src/host-mcp.mjs")).toBe(true);
    } finally {
      await pool.query("delete from participants where id=$1", [
        node.participant_id,
      ]);
      await pool.query("delete from agent_pairings where id=$1", [pairing.id]);
      await pool.query("delete from agent_nodes where id=$1", [node.node_id]);
    }
  });
  it("自己的待连接邀请跨房间显示，单删释放配额且删除的码失效", async () => {
    const a = await service.createPairing(users[0], room),
      b = await service.createPairing(users[0], otherRoom);
    const rows = (await service.state(users[0], room)).my_pairings;
    expect(rows.map((p: any) => p.id)).toEqual(
      expect.arrayContaining([a.id, b.id]),
    );
    expect(
      rows.every(
        (p: any) =>
          !("code" in p) && !("code_hash" in p) && p.created_at && p.room_name,
      ),
    ).toBe(true);
    expect((await service.state(users[1], room)).my_pairings).toEqual([]);
    await expect(
      service.deletePairings(users[1], { pairing_ids: [a.id] }),
    ).rejects.toMatchObject({ status: 409 });
    await service.deletePairings(users[0], { pairing_ids: [a.id] });
    await expect(service.authorizeClientDownload(a.code)).rejects.toMatchObject(
      { status: 403 },
    );
    await service.authorizeClientDownload(b.code);
    await service.deletePairings(users[0], { all: true });
  });
  it("一键清理只删除当前账号未使用邀请，不删除已连接的设备", async () => {
    const used = await service.createPairing(users[0], room);
    const node = await service.pair({
      code: used.code,
      node_name: "保留设备",
      agent_name: "保留 Agent",
      adapter: "cli",
      fingerprint: randomUUID(),
      capabilities: {},
    });
    const a = await service.createPairing(users[0], room),
      b = await service.createPairing(users[0], otherRoom),
      foreign = await service.createPairing(users[1], room);
    await expect(
      service.deletePairings(users[0], { pairing_ids: [used.id] }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      service.deletePairings(users[0], { pairing_ids: [a.id, foreign.id] }),
    ).rejects.toMatchObject({ status: 409 });
    await service.authorizeClientDownload(a.code); // 部分匹配也必须回滚，不能假称删除成功。
    const result = await service.deletePairings(users[0], { all: true });
    expect(result.deleted_ids).toEqual(expect.arrayContaining([a.id, b.id]));
    expect(
      (await pool.query("select id from agent_pairings where id=$1", [used.id]))
        .rowCount,
    ).toBe(1);
    expect(
      (
        await pool.query("select id from agent_nodes where id=$1", [
          node.node_id,
        ])
      ).rowCount,
    ).toBe(1);
    await service.authorizeClientDownload(foreign.code);
    await service.deletePairings(users[1], { all: true });
    // 本用例专用已连接设备在断言后清理，不能污染后续席位数量断言。
    await pool.query("delete from participants where id=$1", [
      node.participant_id,
    ]);
    await pool.query("delete from agent_pairings where id=$1", [used.id]);
    await pool.query("delete from agent_nodes where id=$1", [node.node_id]);
  });
  it("跨房间并发生成不能突破账号的五个未使用配额，清理后可重新生成", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 7 }, (_, i) =>
        service.createPairing(users[0], i % 2 ? room : otherRoom),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(5);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(2);
    expect((await service.state(users[0], room)).my_pairings).toHaveLength(5);
    await service.deletePairings(users[0], { all: true });
    const next = await service.createPairing(users[0], room);
    expect(next.id).toBeTruthy();
    await service.deletePairings(users[0], { all: true });
  });
  it("实际客户端包的 shell 入口始终无 BOM 且使用 LF，不受 Windows 检出换行影响", async () => {
    const bundle = await readArchive(await nodeClientBundle(process.cwd()));
    expect(bundle.has("packages/node/src/workbuddy.mjs")).toBe(true);
    expect(bundle.get("connect.sh").toString()).toMatch(
      /^#!\/usr\/bin\/env bash\n/,
    );
    expect(bundle.get("connect.sh").toString()).not.toContain("\r");
    expect(bundle.get("scripts/node-bootstrap.ps1").subarray(0, 3)).toEqual(
      Buffer.from([0xef, 0xbb, 0xbf]),
    );
  });
  it("连续生成的配对码彼此独立且旧码仍可使用", async () => {
    const codes = await Promise.all([
      service.createPairing(users[0], room),
      service.createPairing(users[0], room),
      service.createPairing(users[0], room),
    ]);
    expect(new Set(codes.map((code: any) => code.id)).size).toBe(3);
    expect(new Set(codes.map((code: any) => code.code)).size).toBe(3);
    for (const code of codes) {
      await service.authorizeClientDownload(code.code);
      await service.revokePairing(users[0], room, code.id);
    }
  });
  it("单删和批量删除仅作用于本房间失效席位，保留聊天和已撤销凭据", async () => {
    const active = await pair(),
      pending = await pair(),
      single = await pair(),
      bulk = await pair(),
      rejected = await pair(),
      outside = await pair(otherRoom);
    await service.seatAction(users[0], room, "approve", {
      participant_id: active.participant_id,
    });
    await service.seatAction(users[0], room, "approve", {
      participant_id: single.participant_id,
    });
    const message = await pool.query(
      "insert into messages(room_id,sender_participant_id,content,type) values($1,$2,'应保留的历史','text') returning id",
      [room, single.participant_id],
    );
    for (const seat of [single, bulk])
      await service.seatAction(users[0], room, "revoke", {
        participant_id: seat.participant_id,
      });
    await service.seatAction(users[0], room, "reject", {
      participant_id: rejected.participant_id,
    });
    await service.seatAction(users[0], otherRoom, "revoke", {
      participant_id: outside.participant_id,
    });
    await expect(
      service.deleteSeats(users[1], room, { all: true }),
    ).rejects.toThrow("管理者");
    await expect(
      service.deleteSeats(users[0], room, {
        participant_id: active.participant_id,
      }),
    ).rejects.toThrow("先撤销");
    await expect(
      service.deleteSeats(users[0], room, {
        participant_id: pending.participant_id,
      }),
    ).rejects.toThrow("先撤销");
    await expect(
      service.deleteSeats(users[0], room, {
        participant_id: outside.participant_id,
      }),
    ).rejects.toThrow("不存在");
    expect(
      (
        await service.deleteSeats(users[0], room, {
          participant_id: single.participant_id,
        })
      ).deleted,
    ).toBe(1);
    expect(
      (await service.state(users[0], room)).seats.some(
        (s: any) => s.participant_id === single.participant_id,
      ),
    ).toBe(false);
    await expect(service.connect(single.token)).rejects.toThrow("撤销");
    expect(
      (
        await pool.query("select 1 from messages where id=$1", [
          message.rows[0].id,
        ])
      ).rowCount,
    ).toBe(1);
    expect(
      (await service.deleteSeats(users[0], room, { all: true })).deleted,
    ).toBe(2);
    expect(
      (await service.deleteSeats(users[0], room, { all: true })).deleted,
    ).toBe(0);
    expect(
      (await service.state(users[0], room)).seats
        .map((s: any) => s.participant_id)
        .sort(),
    ).toEqual([active.participant_id, pending.participant_id].sort());
    expect((await service.state(users[0], otherRoom)).seats).toHaveLength(1);
  });
  it("文件可以替代两项正文，校验房间归属、隔离、数量、版本及 Agent 文档元数据", async () => {
    const req = await file("需求.txt", "text/plain"),
      design = await file("设计.pdf", "application/pdf"),
      other = await file("外部.md", "text/markdown", otherRoom);
    const input = { requirements_file_ids: [req], design_file_ids: [design] };
    await expect(service.publishBrief(users[1], room, input)).rejects.toThrow(
      "管理者",
    );
    await expect(service.publishBrief(users[0], room, {})).rejects.toThrow(
      "开发需求",
    );
    await expect(
      service.publishBrief(users[0], room, { requirements: "需求" }),
    ).rejects.toThrow("设计文档");
    await expect(
      service.publishBrief(users[0], room, {
        ...input,
        design_file_ids: [other],
      }),
    ).rejects.toThrow("不属于");
    await pool.query("update files set status='quarantined' where id=$1", [
      design,
    ]);
    await expect(service.publishBrief(users[0], room, input)).rejects.toThrow(
      "隔离",
    );
    await pool.query("update files set status='normal' where id=$1", [design]);
    await expect(
      service.publishBrief(users[0], room, {
        ...input,
        file_ids: Array.from({ length: 20 }, () => randomUUID()),
      }),
    ).rejects.toThrow("20");
    const brief = await service.publishBrief(users[0], room, input);
    expect(brief.requirements).toBe("");
    expect(brief.design).toBe("");
    expect(brief.file_ids).toEqual([req, design]);
    const db = await pool.connect();
    try {
      const context = await service.context(
        db,
        { room_id: room },
        { participant_id: randomUUID(), room: { name: "验收" } },
      );
      expect(context.brief.documents.map((f: any) => f.name).sort()).toEqual(
        ["设计.pdf", "需求.txt"].sort(),
      );
      expect(context.brief.requirements_file_ids).toEqual([req]);
    } finally {
      db.release();
    }
    const next = await service.publishBrief(users[0], room, {
      requirements: "新正文",
      design: "新设计",
      file_ids: [req],
    });
    expect(next.revision).toBe(brief.revision + 1);
    expect(next.content_hash).not.toBe(brief.content_hash);
    expect(next.requirements_file_ids).toEqual([]);
  });
  it("Node 下载附件保留格式扩展名，原文件名不能注入本机路径", async () => {
    const workspace = resolve(root, "workspace");
    await mkdir(workspace);
    const node = new IslandNode(
      {
        server: "http://localhost:3000",
        workspace,
        adapter: "cli",
        agent_name: "本地测试",
        command: process.execPath,
      },
      { configFile: resolve(root, "node-config.json") },
    );
    node.request = async () => new Response("真实附件字节");
    const ids = [randomUUID(), randomUUID()];
    const result = await node.workspace({
      id: randomUUID(),
      kind: "align",
      brief: {
        file_ids: ids,
        documents: [
          { id: ids[0], name: "../../需求.docx" },
          { id: ids[1], name: "设计.pdf" },
        ],
      },
    });
    expect(result.documents[0]).toMatch(/\.docx$/);
    expect(result.documents[1]).toMatch(/\.pdf$/);
    for (const path of result.documents) {
      expect(path.startsWith(result.directory)).toBe(true);
      expect(await readFile(path, "utf8")).toBe("真实附件字节");
    }
  });
});

import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import sharp from "sharp";
// @ts-ignore Executable services.
import { AgentService } from "../packages/agents/service.mjs";
// @ts-ignore
import {
  privacyFindings,
  redactPrivateText,
  safeResult,
  artifactFindings,
  childEnvironment,
} from "../packages/agents/privacy.mjs";
// @ts-ignore
import {
  uploadAvatar,
  readAvatar,
  normalizeAvatar,
} from "../packages/agents/avatars.mjs";
// @ts-ignore
import { digest } from "../packages/agents/archive.mjs";
import { createStorage } from "../packages/runtime/storage.mjs";
const pool = new Pool({ connectionString: process.env.DATABASE_URL }),
  users = [randomUUID(), randomUUID()];
let service: any,
  root: string,
  room: string,
  room2: string,
  node: any,
  connection: any,
  seat1: any,
  seat2: any,
  invite: any;
async function human(user: string, command: string, data: any) {
  const db = await pool.connect();
  try {
    await db.query("begin");
    await db.query("select set_config('request.jwt.claim.sub',$1,true)", [
      user,
    ]);
    const r = (
      await db.query("select island_command($1,$2) result", [
        command,
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
async function job() {
  await human(users[0], "message", {
    room_id: room,
    content: "请回答本轮问题",
    client_message_id: randomUUID(),
    mentioned_participant_ids: [seat1.participant_id],
  });
  return service.claim(node.token, connection.session_id);
}
beforeAll(async () => {
  root = await mkdtemp(resolve(tmpdir(), "island-privacy-"));
  service = new AgentService(pool, createStorage(pool, { STORAGE_DIR: root }));
  for (const u of users)
    await pool.query(
      "insert into auth.users(id,email,raw_user_meta_data) values($1,$2,$3)",
      [
        u,
        u + "@privacy.invalid",
        JSON.stringify({ display_name: "隐私测试用户" }),
      ],
    );
  room = (await human(users[0], "create_room", { name: "隐私房间 A" })).id;
  room2 = (await human(users[0], "create_room", { name: "隐私房间 B" })).id;
});
afterAll(async () => {
  await pool.query("delete from rooms where id=any($1)", [
    [room, room2].filter(Boolean),
  ]);
  await pool.query("delete from auth.users where id=any($1)", [users]);
  await pool.end();
  await rm(root, { recursive: true, force: true });
});
describe.sequential("程序级发送边界与用户级 Agent 注册", () => {
  it("安装文档可重复读取但不消费邀请，码加密且只有所有者可恢复", async () => {
    invite = await service.createPairing(users[0]);
    const token = invite.document_path.split("/").at(-1).replace(".md", "");
    const doc = await service.readEnrollment(
      invite.id,
      token,
      "https://island.invalid",
    );
    expect(doc).toContain("SHA-256");
    expect(doc).toContain(invite.code);
    expect(doc).toContain("不等于操作系统沙箱");
    expect(
      await service.readEnrollment(invite.id, token, "https://island.invalid"),
    ).toBe(doc);
    const stored = (
      await pool.query("select * from agent_pairings where id=$1", [invite.id])
    ).rows[0];
    expect(stored.used_at).toBeNull();
    expect(stored.code_cipher).not.toContain(invite.code);
    expect(stored.doc_cipher).not.toContain(token);
    const mine = await service.myAgents(users[0]);
    expect(mine.invites.find((p: any) => p.id === invite.id).code).toBe(
      invite.code,
    );
    expect((await service.myAgents(users[1])).invites).toHaveLength(0);
    await expect(
      service.readEnrollment(
        invite.id,
        "z".repeat(43),
        "https://island.invalid",
      ),
    ).rejects.toMatchObject({ status: 410 });
  });
  it("先注册到协作岛，在大厅连接；每个房间独立审批且身份不重复", async () => {
    await expect(
      service.pair({
        code: invite.code,
        node_name: "test",
        agent_name: "公开昵称",
        adapter: "cli",
        fingerprint: randomUUID(),
        capabilities: { host_name: "C:\\Users\\private-person\\host" },
      }),
    ).rejects.toMatchObject({ status: 400 });
    node = await service.pair({
      code: invite.code,
      node_name: "私有设备别名",
      agent_name: "共同开发者",
      adapter: "cli",
      fingerprint: randomUUID(),
      capabilities: { egress_v2: true, development: true, workspace: true },
    });
    expect(node.room_id).toBeNull();
    expect(
      (
        await pool.query("select capabilities from agent_nodes where id=$1", [
          node.node_id,
        ])
      ).rows[0].capabilities,
    ).toMatchObject({ development: false, workspace: false });
    const lobby = await service.connect(node.token);
    expect(lobby.state).toBe("registered");
    await service.disconnected(node.token, lobby.session_id);
    const used = (await service.myAgents(users[0])).invites.find(
      (p: any) => p.id === invite.id,
    );
    expect(used.status).toBe("used");
    expect(used.code).toBeNull();
    expect(used.document_path).toBeNull();
    seat1 = await service.addAgentToRoom(users[0], room, node.node_id);
    seat2 = await service.addAgentToRoom(users[0], room2, node.node_id);
    expect(seat1.participant_id).not.toBe(seat2.participant_id);
    await expect(
      service.addAgentToRoom(users[0], room, node.node_id),
    ).rejects.toMatchObject({ status: 409 });
    await service.seatAction(users[0], room, "approve", {
      participant_id: seat1.participant_id,
    });
    await service.seatAction(users[0], room2, "approve", {
      participant_id: seat2.participant_id,
    });
    connection = await service.connect(node.token);
    const state = await service.state(users[0], room);
    expect(state.seats[0].node_name).toBe("共同开发者");
    expect(state.seats[0]).not.toHaveProperty("fingerprint");
    expect((await service.state(users[0], room2)).seats[0].is_connected).toBe(
      false,
    );
  });
  it("默认消息自动发布且不重复，文件审核默认关闭；程序检测不随人工审核关闭", async () => {
    const mine = (await service.myAgents(users[0])).nodes.find(
      (n: any) => n.id === node.node_id,
    );
    expect(mine).toMatchObject({
      privacy_mode: "filtered",
      file_review: false,
    });
    expect(await service.policy()).toMatchObject({
      force_review: false,
      force_file_review: false,
    });
    const j = await job();
    await expect(
      service.complete(
        node.token,
        j.id,
        j.lease,
        { message: "/home/private-test/not-public" },
        connection.session_id,
      ),
    ).rejects.toMatchObject({ status: 400 });
    const result = { message: "默认直接发送的安全回复" };
    const published = await service.complete(
      node.token,
      j.id,
      j.lease,
      result,
      connection.session_id,
    );
    expect(published.pending_review).not.toBe(true);
    expect((await service.myAgents(users[0])).reviews).toHaveLength(0);
    expect(
      (
        await service.complete(
          node.token,
          j.id,
          j.lease,
          result,
          connection.session_id,
        )
      ).duplicate,
    ).toBe(true);
    expect(
      (
        await pool.query(
          "select count(*)::int n from messages where client_message_id=$1",
          [j.id],
        )
      ).rows[0].n,
    ).toBe(1);
  });
  it("消息与文件审核可独立开启、关闭，只有所有者能设置，资料修改不重置审核", async () => {
    await expect(
      service.updateAgent(users[1], {
        node_id: node.node_id,
        agent_name: "越权",
        privacy_mode: "review",
        file_review: true,
      }),
    ).rejects.toMatchObject({ status: 404 });
    const settings = async () =>
      (await service.myAgents(users[0])).nodes.find(
        (n: any) => n.id === node.node_id,
      );
    await service.updateAgent(users[0], {
      node_id: node.node_id,
      agent_name: "共同开发者",
      privacy_mode: "filtered",
      file_review: true,
    });
    expect(await settings()).toMatchObject({
      privacy_mode: "filtered",
      file_review: true,
    });
    await service.updateAgent(users[0], {
      node_id: node.node_id,
      agent_name: "共同开发者",
      privacy_mode: "review",
      file_review: false,
    });
    expect(await settings()).toMatchObject({
      privacy_mode: "review",
      file_review: false,
    });
    await service.updateAgent(users[0], {
      node_id: node.node_id,
      agent_name: "共同开发者",
    });
    expect(await settings()).toMatchObject({
      privacy_mode: "review",
      file_review: false,
    });
  });
  it("开启消息审核后未确认不出现在房间；只有本人可放行且幂等", async () => {
    const j = await job();
    expect(j).toBeTruthy();
    await expect(
      service.complete(
        node.token,
        j.id,
        j.lease,
        { message: "C:\\Users\\secret-person\\private.txt" },
        connection.session_id,
      ),
    ).rejects.toMatchObject({ status: 400 });
    const staged = await service.complete(
      node.token,
      j.id,
      j.lease,
      { message: "这是只发给本人审核的测试回复" },
      connection.session_id,
    );
    expect(staged.pending_review).toBe(true);
    expect(
      (
        await pool.query("select 1 from messages where client_message_id=$1", [
          j.id,
        ])
      ).rowCount,
    ).toBe(0);
    const record = (
      await pool.query("select * from agent_private_reviews where id=$1", [
        staged.review_id,
      ])
    ).rows[0];
    expect(record.payload_cipher).not.toContain("测试回复");
    expect(
      (
        await pool.query("select result,status from agent_turns where id=$1", [
          j.id,
        ])
      ).rows[0],
    ).toMatchObject({ result: null, status: "awaiting_review" });
    await service.updateAgent(users[0], {
      node_id: node.node_id,
      agent_name: "共同开发者",
      privacy_mode: "filtered",
    });
    // Turning review off only affects later submissions, not already-private content.
    expect(
      (await service.myAgents(users[0])).reviews.some(
        (r: any) => r.id === staged.review_id,
      ),
    ).toBe(true);
    expect(
      (
        await pool.query("select 1 from messages where client_message_id=$1", [
          j.id,
        ])
      ).rowCount,
    ).toBe(0);
    expect(await service.claim(node.token, connection.session_id)).toBeNull();
    await expect(
      service.selectAgentRoom(users[0], {
        node_id: node.node_id,
        participant_id: seat2.participant_id,
        fresh_context: true,
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      service.reviewPrivate(users[1], { id: staged.review_id, approve: true }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      service.reviewPrivate(users[0], {
        id: staged.review_id,
        approve: true,
        result: { message: "api_key=secret-test-123456789" },
      }),
    ).rejects.toMatchObject({ status: 400 });
    await service.reviewPrivate(users[0], {
      id: staged.review_id,
      approve: true,
      result: { message: "经过本人检查后的公开回复" },
    });
    expect(
      (
        await pool.query(
          "select content from messages where client_message_id=$1",
          [j.id],
        )
      ).rows[0].content,
    ).toBe("经过本人检查后的公开回复");
    expect(
      (
        await service.reviewPrivate(users[0], {
          id: staged.review_id,
          approve: true,
        })
      ).duplicate,
    ).toBe(true);
    expect(
      (
        await pool.query(
          "select payload_cipher from agent_private_reviews where id=$1",
          [staged.review_id],
        )
      ).rows[0].payload_cipher,
    ).toBe("");
    await service.updateAgent(users[0], {
      node_id: node.node_id,
      agent_name: "共同开发者",
      privacy_mode: "review",
    });
  });
  it("主持人不能代替其他所有者审批；撤销或静音后旧审核不能恢复发送", async () => {
    const j = await job(),
      staged = await service.complete(
        node.token,
        j.id,
        j.lease,
        { message: "暂存回复" },
        connection.session_id,
      );
    await service.seatAction(users[0], room, "mute", {
      participant_id: seat1.participant_id,
      muted: true,
    });
    await expect(
      service.reviewPrivate(users[0], { id: staged.review_id, approve: true }),
    ).rejects.toMatchObject({ status: 403 });
    expect(
      (
        await pool.query("select 1 from messages where client_message_id=$1", [
          j.id,
        ])
      ).rowCount,
    ).toBe(0);
    await service.seatAction(users[0], room, "mute", {
      participant_id: seat1.participant_id,
      muted: false,
    });
    await service.housekeeping();
    expect(
      (
        await pool.query(
          "select status,payload_cipher from agent_private_reviews where id=$1",
          [staged.review_id],
        )
      ).rows[0],
    ).toMatchObject({ status: "expired", payload_cipher: "" });
  });
  it("头像统一重新编码，拒绝 SVG 和越权引用，昵称头像同步到各房间", async () => {
    const png = await sharp({
      create: { width: 100, height: 80, channels: 3, background: "#00aa77" },
    })
      .png()
      .toBuffer();
    const a = await uploadAvatar(service, users[0], png),
      id = a.avatar_url.split("/").at(-1);
    const bytes = await readAvatar(service, users[0], id);
    const m = await sharp(bytes).metadata();
    expect(m.format).toBe("webp");
    expect(m.width).toBe(256);
    expect(m.exif).toBeUndefined();
    await expect(
      normalizeAvatar(
        Buffer.from(
          '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>',
        ),
      ),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      service.updateAgent(users[1], {
        node_id: node.node_id,
        agent_name: "冒充者",
        avatar_url: a.avatar_url,
      }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      service.transaction((db: any) =>
        service.verifyAvatar(db, users[1], a.avatar_url),
      ),
    ).rejects.toMatchObject({ status: 400 });
    await service.updateAgent(users[0], {
      node_id: node.node_id,
      agent_name: "新的公开昵称",
      avatar_url: a.avatar_url,
    });
    expect((await service.state(users[0], room2)).seats[0]).toMatchObject({
      display_name: "新的公开昵称",
      avatar_url: a.avatar_url,
    });
  });
  it("单房间撤销不撤销协作岛凭据，跨房间切换作废旧连接，整台撤销覆盖所有席位", async () => {
    await service.seatAction(users[0], room, "revoke", {
      participant_id: seat1.participant_id,
    });
    expect(
      (
        await pool.query("select revoked_at from agent_nodes where id=$1", [
          node.node_id,
        ])
      ).rows[0].revoked_at,
    ).toBeNull();
    await service.selectAgentRoom(users[0], {
      node_id: node.node_id,
      participant_id: seat2.participant_id,
      fresh_context: true,
    });
    await expect(
      service.nodeSync(node.token, connection.session_id),
    ).rejects.toMatchObject({ status: 401 });
    const next = await service.connect(node.token);
    expect(next.room_id).toBe(room2);
    await expect(
      service.nodeDownload(node.token, randomUUID(), next.session_id),
    ).rejects.toMatchObject({ status: 404 });
    await service.revokeMyAgent(users[0], node.node_id);
    await expect(service.connect(node.token)).rejects.toMatchObject({
      status: 401,
    });
    expect(
      (
        await pool.query(
          "select count(*) n from agent_seats where node_id=$1 and state<>'revoked'",
          [node.node_id],
        )
      ).rows[0].n,
    ).toBe("0");
  });
  it("邀请撤销、过期和删除失效，不暴露已使用的码", async () => {
    const p = await service.createPairing(users[0]);
    await service.invitationAction(users[0], { id: p.id, action: "revoke" });
    expect(
      (await service.myAgents(users[0])).invites.find(
        (v: any) => v.id === p.id,
      ),
    ).toMatchObject({ status: "revoked", code: null });
    await expect(
      service.pair({
        code: p.code,
        node_name: "test",
        agent_name: "test",
        adapter: "cli",
        fingerprint: randomUUID(),
      }),
    ).rejects.toMatchObject({ status: 403 });
    await service.invitationAction(users[0], { id: p.id, action: "delete" });
    expect(
      (await service.myAgents(users[0])).invites.some(
        (v: any) => v.id === p.id,
      ),
    ).toBe(false);
  });
  it("后台策略只允许技术/超级管理员调整，配额立即执行且审计不含私有正文", async () => {
    const original = await service.policy();
    await pool.query(
      "insert into admin_members(user_id,role) values($1,'operations')",
      [users[1]],
    );
    await expect(service.adminPolicy(users[1])).rejects.toMatchObject({
      status: 403,
    });
    await pool.query(
      "update admin_members set role='technical' where user_id=$1",
      [users[1]],
    );
    try {
      const policy = { ...original, max_agents: 1, force_review: false };
      await service.adminPolicy(users[1], {
        value: policy,
        reason: "验证最小账号配额",
      });
      const p = await service.createPairing(users[0], room2),
        n = await service.pair({
          code: p.code,
          node_name: "私有测试",
          agent_name: "自动发送选择",
          adapter: "cli",
          fingerprint: randomUUID(),
          capabilities: { egress_v2: true },
        });
      const p2 = await service.createPairing(users[0], room2);
      await expect(
        service.pair({
          code: p2.code,
          node_name: "another",
          agent_name: "another",
          adapter: "cli",
          fingerprint: randomUUID(),
        }),
      ).rejects.toMatchObject({ status: 429 });
      await service.updateAgent(users[0], {
        node_id: n.node_id,
        agent_name: "自动发送选择",
        privacy_mode: "filtered",
      });
      await service.seatAction(users[0], room2, "approve", {
        participant_id: n.participant_id,
      });
      const conn = await service.connect(n.token);
      await human(users[0], "message", {
        room_id: room2,
        content: "测试实时平台护栏",
        client_message_id: randomUUID(),
        mentioned_participant_ids: [n.participant_id],
      });
      const j = await service.claim(n.token, conn.session_id);
      // Changing the floor affects an already-connected device, not just new connections.
      await service.adminPolicy(users[1], {
        value: { ...original, force_review: true, force_file_review: true },
        reason: "启用强制本人发送确认",
      });
      expect(
        (
          await service.complete(
            n.token,
            j.id,
            j.lease,
            { message: "即使选了自动发送也应等待本人" },
            conn.session_id,
          )
        ).pending_review,
      ).toBe(true);
      await expect(
        service.updateAgent(users[0], {
          node_id: n.node_id,
          agent_name: "自动发送选择",
          file_review: false,
        }),
      ).rejects.toMatchObject({ status: 403 });
      const report = await service.adminPolicy(users[1]);
      expect(report).not.toHaveProperty("reviews");
      expect(report.counts.length).toBeGreaterThan(0);
      const log = (
        await pool.query(
          "select before,after from admin_audit_logs where action='agent.policy' and admin_id=$1 order by created_at desc limit 1",
          [users[1]],
        )
      ).rows[0];
      expect(log.after.force_review).toBe(true);
      expect(JSON.stringify(log)).not.toContain("即使选了自动发送");
    } finally {
      await pool.query(
        "update agent_security_policy set value=$1 where id=true",
        [JSON.stringify(original)],
      );
    }
  });
});
describe("本机预检与程序护栏", () => {
  it("元数据和常见 IPv6 / 链路本地地址也经过检测", () => {
    for (const value of [
      "http://[::1]/",
      "fd12:3456::1",
      "fe80::abcd",
      "169.254.169.254",
      "Bearer private-test-token-12345678",
    ]) {
      expect(privacyFindings(value).length).toBeGreaterThan(0);
      expect(privacyFindings(redactPrivateText(value))).toEqual([]);
    }
  });
  it("脱敏所有结构化字符串（消息、检查日志、分工摘要）而非只看正文", () => {
    const r = safeResult(
      {
        message: "项目在 C:\\Users\\person\\repo\\src\\a.ts",
        checks: [{ output: "api_key=secret-123456789", command: "test" }],
        summary: "/home/private/name/settings.json",
      },
      ["C:\\Users\\person\\repo"],
    );
    expect(r.message).not.toContain("person");
    expect(privacyFindings(r)).toEqual([]);
    expect(r.checks[0].output).not.toContain("secret-123");
  });
  it("凭据不进入子进程环境，成果包含私有文件时拦截", () => {
    expect(
      childEnvironment({
        PATH: "safe",
        ISLAND_TOKEN: "hidden",
        OPENAI_API_KEY: "hidden",
      }),
    ).toEqual({ PATH: "safe" });
    expect(
      artifactFindings(new Map([["files/.ssh/id_rsa", Buffer.from("data")]])),
    ).toContain("private_file");
    expect(
      artifactFindings(
        new Map([
          [
            "files/src/a.js",
            Buffer.from('const api_key="super-secret-123456";'),
          ],
        ]),
      ),
    ).toContain("secret");
  });
});

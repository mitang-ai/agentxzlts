import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
// @ts-ignore Executable server-side ES modules.
import { AgentService } from "../packages/agents/service.mjs";
// @ts-ignore
import {
  writeArchive,
  readArchive,
  packArtifact,
  treeHash,
  safePath,
  mergeArtifacts,
  unpackArtifact,
  digest,
} from "../packages/agents/archive.mjs";
import { createStorage } from "../packages/runtime/storage.mjs";
const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ||
    "postgresql://island:local-development-only@127.0.0.1:55432/postgres",
});
const users = [randomUUID(), randomUUID(), randomUUID()];
let service: any,
  root: string,
  room: string,
  host: string,
  brief: any,
  session: any,
  worker: any,
  chair: any,
  workerConnection: any,
  chairConnection: any,
  developWorker: any,
  developChair: any,
  artifactWorker: any,
  artifactChair: any;
const base = new Map([
  ["src/worker.js", Buffer.from("export const worker = () => 1;\n")],
  ["src/host.js", Buffer.from("export const host = () => 1;\n")],
  ["README.md", Buffer.from("确认的基线\n")],
]);
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
  } catch (e) {
    await db.query("rollback");
    throw e;
  } finally {
    db.release();
  }
}
async function claim(n: any, c: any) {
  return service.claim(n.token, c.session_id);
}
async function complete(n: any, c: any, job: any, result: any) {
  const response = await service.complete(
    n.token,
    job.id,
    job.lease,
    result,
    c.session_id,
  );
  if (response.pending_review && response.review_id) {
    expect(
      (
        await pool.query("select 1 from messages where client_message_id=$1", [
          job.id,
        ])
      ).rowCount,
    ).toBe(0);
    const owner = (
      await pool.query("select owner_user_id from agent_nodes where id=$1", [
        n.node_id,
      ])
    ).rows[0].owner_user_id;
    await service.reviewPrivate(owner, {
      id: response.review_id,
      approve: true,
    });
  }
  return response;
}
beforeAll(async () => {
  root = await mkdtemp(resolve(tmpdir(), "island-agents-test-"));
  service = new AgentService(pool, createStorage(pool, { STORAGE_DIR: root }));
  for (const [i, u] of users.entries())
    await pool.query(
      "insert into auth.users(id,email,raw_user_meta_data) values($1,$2,$3)",
      [
        u,
        u + "@agents.invalid",
        JSON.stringify({ display_name: "联机用户" + i }),
      ],
    );
  room = (
    await human(users[0], "create_room", {
      name: "真实 Agent 事务",
      icon: "🏝️",
    })
  ).id;
  host = (
    await pool.query("select host_participant_id from rooms where id=$1", [
      room,
    ])
  ).rows[0].host_participant_id;
  const invitation = await human(users[0], "invite", {
    room_id: room,
    hours: 1,
    max_uses: 5,
  });
  await human(users[1], "join_invite", { token: invitation.token });
});
afterAll(async () => {
  if (room) {
    await pool.query("delete from rooms where id=$1", [room]);
    await pool.query("delete from storage.objects where name like $1", [
      room + "/%",
    ]);
    await pool.query("delete from storage_cleanup_jobs where path like $1", [
      room + "/%",
    ]);
  }
  await pool.query("delete from auth.users where id=any($1)", [users]);
  await pool.end();
  await rm(root, { recursive: true, force: true });
});
describe.sequential("真实远端 Agent 权限、有界主持、需求对齐与源码合并", () => {
  it("配对码只保存哈希、一次使用，未审批的设备不能取得发言授权", async () => {
    const pairing = await service.createPairing(users[1], room);
    const stored = (
      await pool.query("select code_hash from agent_pairings where id=$1", [
        pairing.id,
      ])
    ).rows[0];
    expect(stored.code_hash).not.toBe(pairing.code);
    // 下载客户端不消耗配对码，随后仍能实际配对。
    await service.authorizeClientDownload(pairing.code);
    await service.authorizeClientDownload(pairing.code);
    worker = await service.pair({
      code: pairing.code,
      node_name: "异地设备 B",
      agent_name: "开发 Agent",
      adapter: "cli",
      fingerprint: randomUUID(),
      capabilities: { development: true, workspace: true },
    });
    await expect(
      service.pair({
        code: pairing.code,
        node_name: "重复",
        agent_name: "重复",
        adapter: "cli",
        fingerprint: randomUUID(),
      }),
    ).rejects.toThrow("已使用");
    workerConnection = await service.connect(worker.token);
    await expect(service.authorizeClientDownload(pairing.code)).rejects.toThrow(
      "已使用",
    );
    await expect(claim(worker, workerConnection)).rejects.toThrow("未批准");
    await expect(
      service.seatAction(users[1], room, "approve", {
        participant_id: worker.participant_id,
      }),
    ).rejects.toThrow("人类房间管理者");
    await expect(service.state(users[2], room)).rejects.toThrow("权限");
  });
  it("客户端自动下载拒绝无效、过期、撤销的配对码及被冻结的房间", async () => {
    await expect(
      service.authorizeClientDownload("invalid-pairing-code-123456"),
    ).rejects.toThrow("配对码");
    const expired = await service.createPairing(users[0], room);
    await pool.query(
      "update agent_pairings set expires_at=now()-interval '1 second' where id=$1",
      [expired.id],
    );
    await expect(service.authorizeClientDownload(expired.code)).rejects.toThrow(
      "已过期",
    );
    const revoked = await service.createPairing(users[0], room);
    await service.revokePairing(users[0], room, revoked.id);
    await expect(service.authorizeClientDownload(revoked.code)).rejects.toThrow(
      "无效",
    );
    const frozen = await service.createPairing(users[0], room);
    try {
      await pool.query("update rooms set status='frozen' where id=$1", [room]);
      await expect(
        service.authorizeClientDownload(frozen.code),
      ).rejects.toThrow("冻结");
    } finally {
      await pool.query("update rooms set status='active' where id=$1", [room]);
      await service.revokePairing(users[0], room, frozen.id);
    }
  });
  it("人类批准 Agent、选定讨论主持人，仍然保留人类房间管理权限", async () => {
    await service.seatAction(users[0], room, "approve", {
      participant_id: worker.participant_id,
    });
    const p = await service.createPairing(users[0], room);
    chair = await service.pair({
      code: p.code,
      node_name: "异地设备 A",
      agent_name: "主持 Agent",
      adapter: "codex",
      fingerprint: randomUUID(),
      capabilities: { development: true, workspace: true },
    });
    await service.seatAction(users[0], room, "approve", {
      participant_id: chair.participant_id,
    });
    chairConnection = await service.connect(chair.token);
    await service.seatAction(users[0], room, "host", {
      participant_id: chair.participant_id,
    });
    const r = (await pool.query("select * from rooms where id=$1", [room]))
      .rows[0];
    expect(r.host_participant_id).toBe(host);
    expect(r.agent_host_participant_id).toBe(chair.participant_id);
    expect(JSON.stringify(await service.state(users[1], room))).not.toContain(
      worker.token,
    );
  });
  it("普通消息不唤起 Agent，人类明确 @ 只产生一次响应，Agent 回复不触发接龙", async () => {
    await human(users[1], "message", {
      room_id: room,
      content: "普通消息",
      client_message_id: randomUUID(),
    });
    expect(await claim(worker, workerConnection)).toBeNull();
    const clientId = randomUUID();
    await human(users[1], "message", {
      room_id: room,
      content: "@开发 Agent 请解释分工",
      mentioned_participant_ids: [worker.participant_id],
      client_message_id: clientId,
    });
    await human(users[1], "message", {
      room_id: room,
      content: "@开发 Agent 请解释分工",
      mentioned_participant_ids: [worker.participant_id],
      client_message_id: clientId,
    });
    const job = await claim(worker, workerConnection);
    expect(job.kind).toBe("mention");
    await expect(
      complete(chair, chairConnection, job, { message: "冒充" }),
    ).rejects.toThrow("授权");
    await complete(worker, workerConnection, job, {
      message: "本轮已回复，等待下一次点名。",
    });
    expect(
      (await complete(worker, workerConnection, job, { message: "重复" }))
        .duplicate,
    ).toBe(true);
    expect(await claim(worker, workerConnection)).toBeNull();
    expect(await claim(chair, chairConnection)).toBeNull();
    expect(
      Number(
        (
          await pool.query(
            "select count(*) n from messages where sender_participant_id=$1 and type='text'",
            [worker.participant_id],
          )
        ).rows[0].n,
      ),
    ).toBe(1);
  });
  it("静音即时撤销运行授权，迟到结果不能写入；解除静音不会自动开始聊天", async () => {
    await human(users[0], "message", {
      room_id: room,
      content: "@开发 Agent 再次点名",
      mentioned_participant_ids: [worker.participant_id],
      client_message_id: randomUUID(),
    });
    const job = await claim(worker, workerConnection);
    await service.seatAction(users[0], room, "mute", {
      participant_id: worker.participant_id,
      muted: true,
    });
    expect(
      (
        await service.nodeSync(worker.token, workerConnection.session_id, 0, {
          id: job.id,
          lease: job.lease,
        })
      ).cancelled,
    ).toBe(job.id);
    await expect(
      complete(worker, workerConnection, job, { message: "不应发送" }),
    ).rejects.toThrow("静音");
    await service.seatAction(users[0], room, "mute", {
      participant_id: worker.participant_id,
      muted: false,
    });
    expect(await claim(worker, workerConnection)).toBeNull();
  });
  it("发布需求设计、文件与真实代码基线，非管理者不能改版本", async () => {
    const bytes = await writeArchive(base),
      fid = randomUUID(),
      path = room + "/" + fid;
    await service.storage.storeFile(path, bytes, "application/zip");
    await human(users[0], "register_file", {
      room_id: room,
      id: fid,
      storage_path: path,
      name: "baseline.zip",
      mime_type: "application/zip",
      size: bytes.length,
    });
    await expect(
      service.publishBrief(users[1], room, {
        requirements: "需求",
        design: "设计",
        base_file_id: fid,
      }),
    ).rejects.toThrow("管理者");
    brief = await service.publishBrief(users[0], room, {
      requirements: "实现主持与开发模块",
      design: "两个文件分别由不同设备开发",
      base_file_id: fid,
    });
    expect(brief.base_hash).toBe(treeHash(base));
    expect(brief.revision).toBe(1);
    session = await service.startSession(users[0], room, {
      topic: "按确认文档开发两个模块",
      max_turns: 5,
      attendee_ids: [worker.participant_id],
      minutes: 10,
    });
  });
  it("主持人逐次点名，普通 Agent 不可越权调度或创建分工，预算由服务端计数", async () => {
    const first = await claim(chair, chairConnection);
    expect(first.kind).toBe("host");
    await complete(chair, chairConnection, first, {
      message: "围绕两个模块讨论，先请开发 Agent 给出方案。",
      speakers: [
        {
          participant_id: worker.participant_id,
          instruction: "说明开发模块方案",
        },
      ],
    });
    expect(await claim(chair, chairConnection)).toBeNull();
    const speaking = await claim(worker, workerConnection);
    await expect(
      complete(worker, workerConnection, speaking, {
        message: "越权",
        speakers: [
          { participant_id: chair.participant_id, instruction: "无限回复" },
        ],
      }),
    ).rejects.toThrow("只有选定");
    await complete(worker, workerConnection, speaking, {
      message: "建议每个模块独立文件，按同一基线实现。",
    });
    const final = await claim(chair, chairConnection);
    expect(final.kind).toBe("host");
    await complete(chair, chairConnection, final, {
      message: "讨论收敛，提出分工。",
      done: true,
      plan: [
        {
          title: "开发模块",
          description: "把 worker 的返回值改为 2",
          assignee_id: worker.participant_id,
          paths: ["src/worker.js"],
        },
        {
          title: "主持模块",
          description: "把 host 的返回值改为 3",
          assignee_id: chair.participant_id,
          paths: ["src/host.js"],
        },
      ],
    });
    const state = await service.state(users[0], room);
    expect(state.session.stage).toBe("aligning");
    expect(state.session.turns_created).toBe(3);
    expect(state.session.max_turns).toBe(5);
    await expect(
      service.sessionAction(users[0], room, "approve-plan", {
        session_id: session.id,
        confirm: true,
      }),
    ).rejects.toThrow("确认");
  });
  it("全体 Agent 对齐同一版本之后仍须人类批准，随后不同设备任务可以同时取得授权", async () => {
    const a = await claim(chair, chairConnection),
      b = await claim(worker, workerConnection);
    expect(a.kind).toBe("align");
    expect(b.kind).toBe("align");
    await complete(chair, chairConnection, a, {
      message: "需求和分工已对齐。",
      acknowledge: true,
    });
    expect((await service.state(users[0], room)).session.stage).toBe(
      "aligning",
    );
    await complete(worker, workerConnection, b, { acknowledge: true });
    expect((await service.state(users[0], room)).session.stage).toBe("ready");
    await expect(
      service.sessionAction(users[1], room, "approve-plan", {
        session_id: session.id,
        confirm: true,
      }),
    ).rejects.toThrow("管理者");
    await service.sessionAction(users[0], room, "approve-plan", {
      session_id: session.id,
      confirm: true,
    });
    developChair = await claim(chair, chairConnection);
    developWorker = await claim(worker, workerConnection);
    expect(developChair.kind).toBe("develop");
    expect(developWorker.kind).toBe("develop");
    expect(developWorker.brief.content_hash).toBe(brief.content_hash);
    expect(
      (
        await pool.query(
          "select count(*)::int n from agent_turns where session_id=$1 and status='leased'",
          [session.id],
        )
      ).rows[0].n,
    ).toBe(2);
  });
  it("真实成果回传校验任务、基线和修改范围；重复提交不产生重复文件", async () => {
    const current = new Map(base);
    current.set(
      "src/worker.js",
      Buffer.from("export const worker = () => 2;\n"),
    );
    const bad = await packArtifact(
      base,
      current,
      { brief_hash: "错误版本", task_id: developWorker.task_id },
      ["src/worker.js"],
    );
    await expect(
      service.uploadArtifact(
        worker.token,
        developWorker.id,
        developWorker.lease,
        bad,
      ),
    ).rejects.toThrow("所有者批准");
    await expect(
      unpackArtifact(
        bad,
        base,
        { brief_hash: brief.content_hash, task_id: developWorker.task_id },
        ["src/worker.js"],
      ),
    ).rejects.toThrow("不一致");
    await expect(
      packArtifact(
        base,
        current,
        { brief_hash: brief.content_hash, task_id: developWorker.task_id },
        ["src/host.js"],
      ),
    ).rejects.toThrow("分工范围");
    const bytes = await packArtifact(
      base,
      current,
      { brief_hash: brief.content_hash, task_id: developWorker.task_id },
      ["src/worker.js"],
    );
    const permit = await service.proposeArtifact(
      worker.token,
      developWorker.id,
      developWorker.lease,
      { sha256: digest(bytes), size: bytes.length, paths: ["src/worker.js"] },
    );
    await service.reviewPrivate(users[1], {
      id: permit.review_id,
      approve: true,
    });
    artifactWorker = await service.uploadArtifact(
      worker.token,
      developWorker.id,
      developWorker.lease,
      bytes,
    );
    expect(
      (
        await service.uploadArtifact(
          worker.token,
          developWorker.id,
          developWorker.lease,
          bytes,
        )
      ).id,
    ).toBe(artifactWorker.id);
    await complete(worker, workerConnection, developWorker, {
      message: "本地开发完成，源码已回传。",
      artifact_id: artifactWorker.id,
    });
    const other = new Map(base);
    other.set("src/host.js", Buffer.from("export const host = () => 3;\n"));
    const hostBytes = await packArtifact(
      base,
      other,
      { brief_hash: brief.content_hash, task_id: developChair.task_id },
      ["src/host.js"],
    );
    const hostPermit = await service.proposeArtifact(
      chair.token,
      developChair.id,
      developChair.lease,
      {
        sha256: digest(hostBytes),
        size: hostBytes.length,
        paths: ["src/host.js"],
      },
    );
    await service.reviewPrivate(users[0], {
      id: hostPermit.review_id,
      approve: true,
    });
    artifactChair = await service.uploadArtifact(
      chair.token,
      developChair.id,
      developChair.lease,
      hostBytes,
    );
    await complete(chair, chairConnection, developChair, {
      artifact_id: artifactChair.id,
    });
    expect((await service.state(users[0], room)).session.stage).toBe("review");
  });
  it("未审阅成果不能合并，接受之后合并到房间私有文件，普通成员通过同一房间授权访问", async () => {
    await expect(
      service.mergePreview(users[0], room, session.id),
    ).rejects.toThrow("审阅");
    await service.reviewArtifact(users[0], room, {
      artifact_id: artifactWorker.id,
      accept: true,
      note: "已审阅开发模块",
    });
    await service.reviewArtifact(users[0], room, {
      artifact_id: artifactChair.id,
      accept: true,
      note: "已审阅主持模块",
    });
    expect(
      (await service.mergePreview(users[0], room, session.id)).conflicts,
    ).toEqual([]);
    await expect(
      service.merge(users[1], room, { session_id: session.id, confirm: true }),
    ).rejects.toThrow("管理者");
    const merged = await service.merge(users[0], room, {
      session_id: session.id,
      confirm: true,
    });
    const file = await service.nodeDownload(worker.token, merged.id),
      files = await readArchive(file.bytes);
    expect(files.get("src/worker.js").toString()).toContain("=> 2");
    expect(files.get("src/host.js").toString()).toContain("=> 3");
    expect(files.get("README.md").toString()).toBe(
      base.get("README.md")!.toString(),
    );
    expect((await service.state(users[1], room)).session.stage).toBe(
      "completed",
    );
  });
  it("冲突需要明确选择，路径穿越、未知决策和伪造散列被拒绝", () => {
    expect(() => safePath("../outside")).toThrow("路径");
    expect(() => safePath("C:/secret")).toThrow("路径");
    const original = new Map([["a.txt", Buffer.from("base")]]),
      artifacts = [
        {
          id: "one",
          manifest: {
            changes: [{ path: "a.txt", sha256: digest(Buffer.from("one")) }],
          },
          files: new Map([["files/a.txt", Buffer.from("one")]]),
        },
        {
          id: "two",
          manifest: {
            changes: [{ path: "a.txt", sha256: digest(Buffer.from("two")) }],
          },
          files: new Map([["files/a.txt", Buffer.from("two")]]),
        },
      ];
    expect(mergeArtifacts(original, artifacts).conflicts).toHaveLength(1);
    expect(
      mergeArtifacts(original, artifacts, { "a.txt": "two" })
        .files.get("a.txt")
        .toString(),
    ).toBe("two");
    expect(
      mergeArtifacts(original, artifacts, { "a.txt": "baseline" })
        .files.get("a.txt")
        .toString(),
    ).toBe("base");
    expect(() =>
      mergeArtifacts(original, artifacts, { unknown: "one" }),
    ).toThrow("未知");
  });
  it("人类停止之后在途结果失效，设备撤销后不能订阅或下载文件", async () => {
    const next = await service.startSession(users[0], room, {
      topic: "停止验证",
      max_turns: 3,
      attendee_ids: [worker.participant_id],
    });
    const job = await claim(chair, chairConnection);
    await service.sessionAction(users[0], room, "stop", {
      session_id: next.id,
    });
    await expect(
      complete(chair, chairConnection, job, { message: "迟到" }),
    ).rejects.toThrow("授权");
    await service.seatAction(users[0], room, "revoke", {
      participant_id: worker.participant_id,
    });
    await expect(service.connect(worker.token)).rejects.toThrow("撤销");
  });
  it("主持人选择停止时保持安静；人类要求继续仍不能突破发言预算", async () => {
    const next = await service.startSession(users[0], room, {
      topic: "有限讨论",
      max_turns: 3,
      attendee_ids: [chair.participant_id],
    });
    for (let i = 0; i < 3; i++) {
      const turn = await claim(chair, chairConnection);
      expect(turn.kind).toBe("host");
      await complete(chair, chairConnection, turn, {
        message: "本轮无需其他发言，等待人类决策。",
      });
      expect(await claim(chair, chairConnection)).toBeNull();
      if (i < 2)
        await service.sessionAction(users[0], room, "resume", {
          session_id: next.id,
        });
    }
    await expect(
      service.sessionAction(users[0], room, "resume", { session_id: next.id }),
    ).rejects.toThrow("预算");
    expect((await service.state(users[0], room)).session.turns_created).toBe(3);
    await service.sessionAction(users[0], room, "stop", {
      session_id: next.id,
    });
  });
  it("断线任务最多尝试三次，旧租约不能提交；会话到时暂停且取消在途任务", async () => {
    const next = await service.startSession(users[0], room, {
      topic: "租约重试上限",
      max_turns: 3,
      attendee_ids: [chair.participant_id],
    });
    for (let i = 1; i <= 3; i++) {
      const turn = await claim(chair, chairConnection);
      expect(
        (
          await pool.query("select attempt from agent_turns where id=$1", [
            turn.id,
          ])
        ).rows[0].attempt,
      ).toBe(i);
      await pool.query(
        "update agent_turns set lease_until=now()-interval '1 second' where id=$1",
        [turn.id],
      );
      await service.housekeeping();
      await expect(
        complete(chair, chairConnection, turn, { message: "旧租约" }),
      ).rejects.toThrow("授权");
    }
    expect(await claim(chair, chairConnection)).toBeNull();
    expect((await service.state(users[0], room)).session.stage).toBe("paused");
    await service.sessionAction(users[0], room, "stop", {
      session_id: next.id,
    });
    const deadline = await service.startSession(users[0], room, {
      topic: "时间上限",
      max_turns: 3,
      attendee_ids: [chair.participant_id],
    });
    const leased = await claim(chair, chairConnection);
    await pool.query(
      "update collaboration_sessions set deadline=now()-interval '1 second' where id=$1",
      [deadline.id],
    );
    await service.housekeeping();
    expect((await service.state(users[0], room)).session.stage).toBe("paused");
    await expect(
      complete(chair, chairConnection, leased, { message: "超时" }),
    ).rejects.toThrow("授权");
    await service.sessionAction(users[0], room, "stop", {
      session_id: deadline.id,
    });
  });
  it("设备所属人离开房间即失去联机权限，后台技术管理员可以紧急撤销并记录审计", async () => {
    const code = await service.createPairing(users[1], room),
      n = await service.pair({
        code: code.code,
        node_name: "离房设备",
        agent_name: "离房 Agent",
        adapter: "cli",
        fingerprint: randomUUID(),
        capabilities: {},
      });
    await service.seatAction(users[0], room, "approve", {
      participant_id: n.participant_id,
    });
    await human(users[1], "leave_room", { room_id: room });
    await expect(service.connect(n.token)).rejects.toThrow(/成员|权限|离开/);
    await expect(
      service.adminRevoke(users[0], chair.node_id, "无后台授权"),
    ).rejects.toThrow("管理员权限");
    await pool.query(
      "insert into admin_members(user_id,role) values($1,'technical')",
      [users[2]],
    );
    await service.adminRevoke(
      users[2],
      chair.node_id,
      "设备所有者要求紧急撤销",
    );
    await expect(service.connect(chair.token)).rejects.toThrow("撤销");
    const audit = (
      await pool.query(
        "select * from admin_audit_logs where admin_id=$1 and action='agent.revoke'",
        [users[2]],
      )
    ).rows;
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toContain(chair.token);
    await pool.query("delete from admin_audit_logs where admin_id=$1", [
      users[2],
    ]);
  });
});

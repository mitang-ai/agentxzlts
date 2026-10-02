import { randomUUID, randomBytes } from "node:crypto";
import { z } from "zod";
import {
  digest,
  readArchive,
  writeArchive,
  treeHash,
  safePath,
  unpackArtifact,
  mergeArtifacts,
} from "./archive.mjs";
import {
  fail,
  turnResultSchema,
  boundedError,
  AgentError,
} from "./protocol.mjs";
const id = z.uuid();
const name = z.string().trim().min(1).max(60);
const secret = () => randomBytes(32).toString("base64url");
const inactive = ["completed", "stopped"];
export class AgentService {
  constructor(pool, storage) {
    this.pool = pool;
    this.storage = storage;
  }
  async transaction(fn) {
    const db = await this.pool.connect();
    try {
      await db.query("begin");
      await db.query("select pg_advisory_xact_lock_shared(91820261001)");
      const result = await fn(db);
      await db.query("commit");
      return result;
    } catch (e) {
      await db.query("rollback");
      throw e;
    } finally {
      db.release();
    }
  }
  async room(db, roomId, userId, { manager = false, write = false } = {}) {
    id.parse(roomId);
    id.parse(userId);
    const room = (
      await db.query("select * from rooms where id=$1 for update", [roomId])
    ).rows[0];
    const member = (
      await db.query(
        "select p.*,effective_status(p.user_id) account_status from participants p where p.room_id=$1 and p.user_id=$2 and p.type='human' and p.status='active'",
        [roomId, userId],
      )
    ).rows[0];
    if (
      !room ||
      room.status === "deleted" ||
      !member ||
      member.account_status === "banned"
    )
      fail(403, "没有访问此房间的权限。");
    if (manager && room.host_participant_id !== member.id)
      fail(403, "只有人类房间管理者可以执行此操作。");
    if (write && room.status !== "active") fail(403, "房间已冻结，当前只读。");
    return { room, member };
  }
  async enabled(db, userId, roomId) {
    const row = (
      await db.query(
        "select flag_enabled('agents',$1,$2) agents,(select (value->>'maintenance')::boolean from site_settings where key='operations') maintenance",
        [userId, roomId],
      )
    ).rows[0];
    if (!row.agents || row.maintenance)
      fail(
        403,
        row.maintenance ? "网站维护中，Agent 已暂停。" : "Agent 功能已停用。",
      );
  }
  async emit(db, r, type, actor, entity, payload = {}) {
    await db.query("select emit($1,$2,$3,$4,$5)", [
      r,
      type,
      actor,
      entity,
      JSON.stringify(payload),
    ]);
  }
  async createPairing(userId, roomId) {
    return this.transaction(async (db) => {
      const { member } = await this.room(db, roomId, userId, { write: true });
      await this.enabled(db, userId, roomId);
      // 配额是账号级的，不同房间同时生成也必须串行核验。
      await db.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
        `agent-pairings:${userId}`,
      ]);
      if (
        Number(
          (
            await db.query(
              "select count(*) n from agent_pairings where owner_user_id=$1 and used_at is null and expires_at>now() and revoked_at is null",
              [userId],
            )
          ).rows[0].n,
        ) >= 5
      )
        fail(429, "未使用的配对码过多，请撤销旧码后再试。");
      const code = secret(),
        row = (
          await db.query(
            "insert into agent_pairings(room_id,owner_user_id,code_hash) values($1,$2,$3) returning id,expires_at",
            [roomId, userId, digest(code)],
          )
        ).rows[0];
      await this.emit(db, roomId, "agent.pairing.created", member.id, row.id);
      return { ...row, code };
    });
  }
  async pairingAccess(db, code) {
    z.string().min(20).max(128).parse(code);
    const pairing = (
      await db.query("select * from agent_pairings where code_hash=$1", [
        digest(code),
      ])
    ).rows[0];
    if (!pairing) fail(403, "配对码无效或已使用。");
    const { room } = await this.room(
      db,
      pairing.room_id,
      pairing.owner_user_id,
      {
        write: true,
      },
    );
    await this.enabled(db, pairing.owner_user_id, room.id);
    const locked = (
      await db.query("select * from agent_pairings where id=$1 for update", [
        pairing.id,
      ])
    ).rows[0];
    if (
      !locked ||
      locked.used_at ||
      locked.revoked_at ||
      new Date(locked.expires_at) <= new Date()
    )
      fail(403, "配对码无效、已使用或已过期。");
    return { pairing: locked, room };
  }
  async authorizeClientDownload(code) {
    await this.transaction((db) => this.pairingAccess(db, code));
  }
  async pair(input) {
    const data = z
      .object({
        code: z.string().min(20).max(128),
        node_name: name,
        agent_name: z.string().trim().min(1).max(40),
        adapter: z.enum([
          "mcp",
          "codex",
          "claude",
          "opencode",
          "cli",
          "acp",
          "a2a",
          "http",
        ]),
        fingerprint: z.string().min(16).max(128),
        capabilities: z
          .object({
            development: z.boolean().default(false),
            workspace: z.boolean().default(false),
            host_name: z.string().trim().min(1).max(80).optional(),
          })
          .default({ development: false, workspace: false }),
      })
      .parse(input);
    if (
      /work\s*buddy|hermes|openclaw/i.test(
        data.capabilities.host_name || data.agent_name,
      ) &&
      ["codex", "claude", "opencode"].includes(data.adapter)
    )
      fail(
        400,
        "当前宿主不能绑定到其它 Agent CLI，请选择 mcp 或当前产品的真实接口。",
      );
    const token = secret();
    return this.transaction(async (db) => {
      const { pairing, room } = await this.pairingAccess(db, data.code);
      if (
        Number(
          (
            await db.query(
              "select count(*) n from agent_seats s join participants p on p.id=s.participant_id where p.room_id=$1 and s.state in ('pending','approved')",
              [room.id],
            )
          ).rows[0].n,
        ) >= 12
      )
        fail(409, "一个房间最多 12 个待批准或已批准 Agent 席位。");
      const node = (
        await db.query(
          "insert into agent_nodes(owner_user_id,name,agent_name,adapter,token_hash,fingerprint,capabilities) values($1,$2,$3,$4,$5,$6,$7) returning id,expires_at",
          [
            pairing.owner_user_id,
            data.node_name,
            data.agent_name,
            data.adapter,
            digest(token),
            data.fingerprint,
            JSON.stringify(data.capabilities),
          ],
        )
      ).rows[0];
      const participant = (
        await db.query(
          "insert into participants(room_id,type,display_name,status) values($1,'agent',$2,'left') returning id",
          [room.id, data.agent_name],
        )
      ).rows[0];
      await db.query(
        "insert into agent_seats(participant_id,node_id) values($1,$2)",
        [participant.id, node.id],
      );
      await db.query(
        "update agent_pairings set used_at=now(),node_id=$2 where id=$1",
        [pairing.id, node.id],
      );
      await this.emit(
        db,
        room.id,
        "agent.pairing.requested",
        null,
        participant.id,
      );
      return {
        node_id: node.id,
        token,
        expires_at: node.expires_at,
        participant_id: participant.id,
        room_id: room.id,
        state: "pending",
      };
    });
  }
  async node(db, token, { sessionId } = {}) {
    if (typeof token !== "string" || token.length < 20 || token.length > 128)
      fail(401, "Node 凭据无效。");
    const n = (
      await db.query(
        "select * from agent_nodes where token_hash=$1 and revoked_at is null and expires_at>now()",
        [digest(token)],
      )
    ).rows[0];
    if (!n || (sessionId && n.session_id !== sessionId))
      fail(401, "Node 凭据已撤销、过期或连接已被替代。");
    if (
      (await db.query("select effective_status($1) status", [n.owner_user_id]))
        .rows[0].status === "banned"
    )
      fail(403, "设备所属账号已被封禁。");
    return n;
  }
  async nodeSeat(db, n, { approved = true, write = false } = {}) {
    const seat = (
      await db.query(
        "select s.*,p.room_id,p.display_name,p.status,p.last_read_event_id from agent_seats s join participants p on p.id=s.participant_id where s.node_id=$1",
        [n.id],
      )
    ).rows[0];
    if (!seat) fail(403, "联机席位不存在。");
    const { room } = await this.room(db, seat.room_id, n.owner_user_id, {
      write,
    });
    await this.enabled(db, n.owner_user_id, room.id);
    if (
      approved &&
      (seat.state !== "approved" || seat.status !== "active" || seat.muted)
    )
      fail(403, seat.muted ? "席位已静音。" : "席位未批准或已撤销。");
    if (["rejected", "revoked"].includes(seat.state))
      fail(403, "联机席位已撤销。");
    return { ...seat, room };
  }
  async connect(token) {
    return this.transaction(async (db) => {
      const n = await this.node(db, token),
        s = await this.nodeSeat(db, n, { approved: false }),
        sessionId = randomUUID();
      await db.query(
        "update agent_nodes set session_id=$2,last_seen_at=now() where id=$1",
        [n.id, sessionId],
      );
      if (s.state === "approved")
        await db.query(
          "update participants set last_active_at=now() where id=$1",
          [s.participant_id],
        );
      await this.emit(
        db,
        s.room_id,
        "agent.connection.changed",
        null,
        s.participant_id,
      );
      return {
        node_id: n.id,
        session_id: sessionId,
        room_id: s.room_id,
        participant_id: s.participant_id,
        state: s.state,
        muted: s.muted,
      };
    });
  }
  async disconnected(token, sessionId) {
    return this.transaction(async (db) => {
      const n = await this.node(db, token, { sessionId });
      const cleared = await db.query(
        "update agent_nodes set last_seen_at=null,session_id=null where id=$1 and session_id=$2 returning id",
        [n.id, sessionId],
      );
      if (!cleared.rowCount) return;
      const s = (
        await db.query(
          "select p.id,p.room_id from agent_seats s join participants p on p.id=s.participant_id where node_id=$1",
          [n.id],
        )
      ).rows[0];
      if (s) {
        await db.query(
          "update participants set last_active_at=null where id=$1",
          [s.id],
        );
        await this.emit(db, s.room_id, "agent.connection.changed", null, s.id);
      }
    });
  }
  async state(userId, roomId) {
    return this.transaction(async (db) => {
      const { room, member } = await this.room(db, roomId, userId);
      const seats = (
        await db.query(
          "select s.*,p.display_name,p.status,p.type,p.last_active_at,n.name node_name,n.adapter,n.capabilities,n.owner_user_id,n.expires_at,n.revoked_at,n.last_seen_at,n.fingerprint,coalesce((select kind from agent_turns j where j.participant_id=p.id and j.status='leased'),'idle') activity from agent_seats s join participants p on p.id=s.participant_id join agent_nodes n on n.id=s.node_id where p.room_id=$1 and s.deleted_at is null order by s.created_at",
          [roomId],
        )
      ).rows;
      const brief =
        (
          await db.query(
            "select * from collaboration_briefs where room_id=$1 order by revision desc limit 1",
            [roomId],
          )
        ).rows[0] || null;
      const acks = brief
        ? (
            await db.query(
              "select * from collaboration_acks where brief_id=$1",
              [brief.id],
            )
          ).rows
        : [];
      const session =
        (
          await db.query(
            "select * from collaboration_sessions where room_id=$1 order by created_at desc limit 1",
            [roomId],
          )
        ).rows[0] || null;
      const work = session
        ? (
            await db.query(
              "select w.*,t.title,t.description,t.status from collaboration_work w join tasks t on t.id=w.task_id where session_id=$1 order by t.created_at",
              [session.id],
            )
          ).rows
        : [];
      const turns = (
        await db.query(
          "select id,participant_id,session_id,kind,task_id,status,attempt,error,created_at,completed_at,sequence from agent_turns where room_id=$1 order by sequence desc limit 60",
          [roomId],
        )
      ).rows;
      const artifacts = (
        await db.query(
          "select a.*,f.name,f.size from collaboration_artifacts a join files f on f.id=a.file_id where a.room_id=$1 order by a.created_at desc limit 100",
          [roomId],
        )
      ).rows;
      const pairings = (
        await db.query(
          "select id,expires_at,used_at,revoked_at,owner_user_id from agent_pairings where room_id=$1 and expires_at>now() order by created_at desc",
          [roomId],
        )
      ).rows;
      const myPairings = (
        await db.query(
          `select p.id,p.room_id,r.name room_name,p.created_at,p.expires_at
         from agent_pairings p join rooms r on r.id=p.room_id
         where p.owner_user_id=$1 and p.used_at is null and p.revoked_at is null
         and p.expires_at>now() order by p.created_at desc,p.id`,
          [userId],
        )
      ).rows;
      return {
        seats,
        brief,
        acks,
        session,
        work,
        turns,
        artifacts,
        pairings,
        my_pairings: myPairings,
        manager: room.host_participant_id === member.id,
        me: member.id,
        agent_host_participant_id: room.agent_host_participant_id,
      };
    });
  }
  async seatAction(userId, roomId, action, input) {
    return this.transaction(async (db) => {
      const { room, member } = await this.room(db, roomId, userId, {
        manager: true,
        write: !["revoke", "mute"].includes(action),
      });
      const seat = (
        await db.query(
          "select s.*,p.display_name,p.room_id from agent_seats s join participants p on p.id=s.participant_id where s.participant_id=$1 and p.room_id=$2 and s.deleted_at is null",
          [id.parse(input.participant_id), roomId],
        )
      ).rows[0];
      if (!seat) fail(404, "联机席位不存在。");
      if (action === "approve") {
        await this.enabled(db, userId, roomId);
        if (seat.state !== "pending") fail(409, "该席位不是待批准状态。");
        await db.query(
          "update agent_seats set state='approved',approved_by=$2,approved_at=now() where participant_id=$1",
          [seat.participant_id, userId],
        );
        await db.query(
          "update participants set status='active',joined_at=now() where id=$1",
          [seat.participant_id],
        );
        await this.emit(
          db,
          roomId,
          "participant.joined",
          member.id,
          seat.participant_id,
        );
      } else if (action === "reject" || action === "revoke") {
        await db.query(
          "update agent_seats set state=$2 where participant_id=$1",
          [seat.participant_id, action === "reject" ? "rejected" : "revoked"],
        );
        await db.query(
          "update agent_nodes set revoked_at=now(),session_id=null,last_seen_at=null where id=$1",
          [seat.node_id],
        );
        await db.query(
          "update participants set status='left',last_active_at=null where id=$1",
          [seat.participant_id],
        );
        await db.query(
          "update agent_turns set status='cancelled',lease_hash=null,error='席位已撤销' where participant_id=$1 and status in ('queued','leased')",
          [seat.participant_id],
        );
        if (room.agent_host_participant_id === seat.participant_id)
          await db.query(
            "update rooms set agent_host_participant_id=null where id=$1",
            [roomId],
          );
        await this.pauseAffected(
          db,
          roomId,
          seat.participant_id,
          "联机席位被撤销。",
        );
        await this.emit(
          db,
          roomId,
          "participant.left",
          member.id,
          seat.participant_id,
        );
      } else if (action === "mute") {
        const muted = z.boolean().parse(input.muted);
        await db.query(
          "update agent_seats set muted=$2 where participant_id=$1",
          [seat.participant_id, muted],
        );
        if (muted) {
          await db.query(
            "update agent_turns set status='cancelled',lease_hash=null,error='席位已静音' where participant_id=$1 and status in ('queued','leased')",
            [seat.participant_id],
          );
          await this.pauseAffected(
            db,
            roomId,
            seat.participant_id,
            "参与者已静音，请调整后继续。",
          );
        }
      } else if (action === "host") {
        await this.enabled(db, userId, roomId);
        if (seat.state !== "approved" || seat.muted)
          fail(409, "请选择已批准且未静音的 Agent。");
        if (
          (
            await db.query(
              "select 1 from collaboration_sessions where room_id=$1 and stage not in ('completed','stopped')",
              [roomId],
            )
          ).rowCount
        )
          fail(409, "请先停止当前协作，再更换 Agent 主持人。");
        await db.query(
          "update rooms set agent_host_participant_id=$2 where id=$1",
          [roomId, seat.participant_id],
        );
        await this.emit(
          db,
          roomId,
          "agent.host.selected",
          member.id,
          seat.participant_id,
        );
      } else fail(400, "席位操作无效。");
      await this.emit(
        db,
        roomId,
        "agent.seat.updated",
        member.id,
        seat.participant_id,
      );
      return { ok: true };
    });
  }
  async pauseAffected(db, roomId, participantId, error) {
    const sessions = (
      await db.query(
        "select * from collaboration_sessions where room_id=$1 and $2=any(attendee_ids) and stage not in ('completed','stopped','paused')",
        [roomId, participantId],
      )
    ).rows;
    for (const session of sessions) await this.pause(db, session, error);
  }
  async deleteSeats(userId, roomId, input) {
    const d = z
      .union([
        z
          .object({ participant_id: id, all: z.literal(false).optional() })
          .strict(),
        z.object({ all: z.literal(true) }).strict(),
      ])
      .parse(input);
    return this.transaction(async (db) => {
      const { member } = await this.room(db, roomId, userId, { manager: true });
      if (!d.all) {
        const seat = (
          await db.query(
            "select s.* from agent_seats s join participants p on p.id=s.participant_id where p.room_id=$1 and s.participant_id=$2 and s.deleted_at is null",
            [roomId, d.participant_id],
          )
        ).rows[0];
        if (!seat) fail(404, "联机席位不存在。");
        if (!["rejected", "revoked"].includes(seat.state))
          fail(409, "请先撤销或拒绝此 Agent，再删除记录。");
      }
      // 仅移除列表记录，保留参与者、聊天和任务历史及已撤销的凭据状态。
      const removed = await db.query(
        "update agent_seats s set deleted_at=now() from participants p where p.id=s.participant_id and p.room_id=$1 and s.deleted_at is null and s.state in ('rejected','revoked') and ($2::uuid is null or s.participant_id=$2) returning s.participant_id",
        [roomId, d.all ? null : d.participant_id],
      );
      for (const seat of removed.rows)
        await this.emit(
          db,
          roomId,
          "agent.seat.deleted",
          member.id,
          seat.participant_id,
        );
      return { ok: true, deleted: removed.rowCount };
    });
  }
  async revokePairing(userId, roomId, pairingId) {
    return this.transaction(async (db) => {
      const { room } = await this.room(db, roomId, userId);
      const p = (
        await db.query(
          "select * from agent_pairings where id=$1 and room_id=$2",
          [id.parse(pairingId), roomId],
        )
      ).rows[0];
      if (
        !p ||
        (p.owner_user_id !== userId &&
          room.host_participant_id !==
            (
              await db.query(
                "select id from participants where room_id=$1 and user_id=$2",
                [roomId, userId],
              )
            ).rows[0].id)
      )
        fail(403, "无权撤销此配对码。");
      await db.query("update agent_pairings set revoked_at=now() where id=$1", [
        p.id,
      ]);
      return { ok: true };
    });
  }
  async deletePairings(userId, input) {
    id.parse(userId);
    const data = z
      .object({
        all: z.boolean().optional(),
        pairing_ids: z.array(id).min(1).max(100).optional(),
      })
      .refine(
        (v) => (v.all === true ? !v.pairing_ids : Boolean(v.pairing_ids)),
        "请选择要删除的邀请码",
      )
      .parse(input);
    return this.transaction(async (db) => {
      await db.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
        `agent-pairings:${userId}`,
      ]);
      const result = await db.query(
        `delete from agent_pairings where owner_user_id=$1 and used_at is null
         ${data.all ? "" : "and id=any($2::uuid[])"} returning id`,
        data.all ? [userId] : [userId, data.pairing_ids],
      );
      if (!data.all && result.rowCount !== data.pairing_ids.length)
        fail(409, "邀请码不存在、已使用或不属于你。");
      return { deleted_ids: result.rows.map((row) => row.id) };
    });
  }
  async file(db, roomId, fileId) {
    const f = (
      await db.query(
        "select * from files where id=$1 and room_id=$2 and status='normal'",
        [fileId, roomId],
      )
    ).rows[0];
    if (!f) fail(404, "文件不存在、已隔离或不属于此房间。");
    return f;
  }
  async publishBrief(userId, roomId, input) {
    const d = z
      .object({
        requirements: z.string().trim().max(32000).default(""),
        design: z.string().trim().max(32000).default(""),
        requirements_file_ids: z.array(id).max(20).default([]),
        design_file_ids: z.array(id).max(20).default([]),
        file_ids: z.array(id).max(20).default([]),
        base_file_id: id.nullable().default(null),
      })
      .parse(input);
    if (!d.requirements && !d.requirements_file_ids.length)
      fail(400, "请填写开发需求或上传需求文件。");
    if (!d.design && !d.design_file_ids.length)
      fail(400, "请填写设计文档或上传设计文件。");
    d.file_ids = [
      ...new Set([
        ...d.file_ids,
        ...d.requirements_file_ids,
        ...d.design_file_ids,
      ]),
    ];
    if (d.file_ids.length > 20) fail(400, "需求与设计最多关联 20 个文件。");
    return this.transaction(async (db) => {
      const { member } = await this.room(db, roomId, userId, {
        manager: true,
        write: true,
      });
      await this.enabled(db, userId, roomId);
      if (
        (
          await db.query(
            "select 1 from collaboration_sessions where room_id=$1 and stage in ('developing','review')",
            [roomId],
          )
        ).rowCount
      )
        fail(409, "开发或审阅中不能换需求版本，请先停止本轮协作。");
      for (const fid of d.file_ids) await this.file(db, roomId, fid);
      let baseHash = null;
      if (d.base_file_id) {
        const f = await this.file(db, roomId, d.base_file_id);
        if (f.mime_type !== "application/zip")
          fail(400, "代码基线必须是 ZIP 源码包。");
        const base = await readArchive(
          await this.storage.loadFile(f.storage_path),
        );
        if (!base.size) fail(400, "代码基线不能为空。");
        if (
          [...base.keys()].some((path) =>
            path
              .split("/")
              .some(
                (part) =>
                  ["node_modules", ".data", ".island-work"].includes(part) ||
                  part.startsWith(".island-output") ||
                  (/^\.env/.test(part) && part !== ".env.example"),
              ),
          )
        )
          fail(
            400,
            "基线应为源码，不能含本地配置、依赖目录或开发凭据；环境模板请使用 .env.example。",
          );
        baseHash = treeHash(base);
      }
      await db.query(
        "update collaboration_sessions set stage='stopped',error='需求设计已更新，需要重新对齐',updated_at=now() where room_id=$1 and stage not in ('completed','stopped')",
        [roomId],
      );
      await db.query(
        "update agent_turns set status='cancelled',lease_hash=null,error='需求设计已更新' where room_id=$1 and status in ('queued','leased')",
        [roomId],
      );
      const revision = Number(
        (
          await db.query(
            "select coalesce(max(revision),0)+1 revision from collaboration_briefs where room_id=$1",
            [roomId],
          )
        ).rows[0].revision,
      );
      const hash = digest(JSON.stringify({ ...d, base_hash: baseHash }));
      const brief = (
        await db.query(
          "insert into collaboration_briefs(room_id,revision,requirements,design,file_ids,base_file_id,base_hash,content_hash,published_by,requirements_file_ids,design_file_ids) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning *",
          [
            roomId,
            revision,
            d.requirements,
            d.design,
            d.file_ids,
            d.base_file_id,
            baseHash,
            hash,
            member.id,
            d.requirements_file_ids,
            d.design_file_ids,
          ],
        )
      ).rows[0];
      await db.query(
        "insert into collaboration_acks(brief_id,participant_id,content_hash) values($1,$2,$3)",
        [brief.id, member.id, hash],
      );
      await this.emit(
        db,
        roomId,
        "collaboration.brief.published",
        member.id,
        brief.id,
        { revision },
      );
      return brief;
    });
  }
  async acknowledge(userId, roomId, briefId) {
    return this.transaction(async (db) => {
      const { member } = await this.room(db, roomId, userId, { write: true });
      const brief = (
        await db.query(
          "select * from collaboration_briefs where room_id=$1 order by revision desc limit 1",
          [roomId],
        )
      ).rows[0];
      if (!brief || brief.id !== id.parse(briefId))
        fail(409, "需求版本已变化，请重新阅读。");
      await this.ack(db, brief, member.id);
      return { ok: true };
    });
  }
  async ack(db, brief, participantId) {
    await db.query(
      "insert into collaboration_acks(brief_id,participant_id,content_hash) values($1,$2,$3) on conflict(brief_id,participant_id) do update set content_hash=excluded.content_hash,created_at=now()",
      [brief.id, participantId, brief.content_hash],
    );
    await this.emit(
      db,
      brief.room_id,
      "collaboration.acknowledged",
      participantId,
      brief.id,
    );
  }
  async queue(
    db,
    roomId,
    participantId,
    kind,
    input = {},
    session = null,
    taskId = null,
  ) {
    if (session && ["host", "speak"].includes(kind)) {
      if (session.turns_created >= session.max_turns)
        fail(409, "本轮发言预算已用完，等待人类管理者处理。");
      await db.query(
        "update collaboration_sessions set turns_created=turns_created+1 where id=$1",
        [session.id],
      );
      session.turns_created++;
    }
    const turn = (
      await db.query(
        "insert into agent_turns(room_id,participant_id,kind,input,session_id,task_id) values($1,$2,$3,$4,$5,$6) returning *",
        [
          roomId,
          participantId,
          kind,
          JSON.stringify(input),
          session?.id || null,
          taskId,
        ],
      )
    ).rows[0];
    await this.emit(db, roomId, "agent.turn.queued", participantId, turn.id, {
      kind,
    });
    return turn;
  }
  async startSession(userId, roomId, input) {
    const data = z
      .object({
        topic: z.string().trim().min(1).max(2000),
        max_turns: z.number().int().min(3).max(40).default(12),
        attendee_ids: z.array(id).min(1).max(8),
        minutes: z.number().int().min(5).max(60).default(30),
      })
      .parse(input);
    return this.transaction(async (db) => {
      const { room, member } = await this.room(db, roomId, userId, {
        manager: true,
        write: true,
      });
      await this.enabled(db, userId, roomId);
      const brief = (
        await db.query(
          "select * from collaboration_briefs where room_id=$1 order by revision desc limit 1",
          [roomId],
        )
      ).rows[0];
      if (!brief) fail(409, "请先发布需求和设计文档。");
      if (!room.agent_host_participant_id) fail(409, "请先选定 Agent 主持人。");
      const attendees = [
        ...new Set([room.agent_host_participant_id, ...data.attendee_ids]),
      ];
      if (attendees.length > 8)
        fail(400, "每轮协作最多 8 位 Agent（包含主持人）。");
      await this.checkAttendees(db, roomId, attendees);
      if (
        (
          await db.query(
            "select 1 from collaboration_sessions where room_id=$1 and stage not in ('completed','stopped')",
            [roomId],
          )
        ).rowCount
      )
        fail(409, "已有协作进行中，请先停止。");
      const session = (
        await db.query(
          "insert into collaboration_sessions(room_id,brief_id,host_participant_id,attendee_ids,topic,max_turns,deadline) values($1,$2,$3,$4,$5,$6,now()+make_interval(mins=>$7)) returning *",
          [
            roomId,
            brief.id,
            room.agent_host_participant_id,
            attendees,
            data.topic,
            data.max_turns,
            data.minutes,
          ],
        )
      ).rows[0];
      await this.queue(
        db,
        roomId,
        session.host_participant_id,
        "host",
        {
          instruction:
            "围绕主题主持讨论，明确点名需要发言的参与者；收敛讨论后给出分工方案。",
        },
        session,
      );
      await this.emit(
        db,
        roomId,
        "collaboration.started",
        member.id,
        session.id,
      );
      return session;
    });
  }
  async checkAttendees(db, roomId, ids) {
    const rows = (
      await db.query(
        "select p.id from participants p join agent_seats s on s.participant_id=p.id join agent_nodes n on n.id=s.node_id join participants owner on owner.room_id=p.room_id and owner.user_id=n.owner_user_id and owner.status='active' where p.room_id=$1 and p.id=any($2::uuid[]) and p.status='active' and s.state='approved' and not s.muted and n.revoked_at is null and n.expires_at>now() and effective_status(n.owner_user_id)<>'banned' and flag_enabled('agents',n.owner_user_id,p.room_id)",
        [roomId, ids],
      )
    ).rows;
    if (rows.length !== ids.length)
      fail(409, "参与者未批准、已静音、被撤销或失去权限。");
  }
  validatePlan(plan, session) {
    const parsed = turnResultSchema.shape.plan.parse(plan);
    if (!parsed.length) fail(400, "分工方案至少包含一项任务。");
    for (const task of parsed) {
      if (!session.attendee_ids.includes(task.assignee_id))
        fail(400, "分工负责人必须是本轮参与者。");
      task.paths = [
        ...new Set(
          task.paths.map((p) => {
            if (p === "*") return p;
            return safePath(p.replace(/\/$/, ""));
          }),
        ),
      ];
    }
    return parsed;
  }
  async beginAlignment(db, session, plan) {
    const validated = this.validatePlan(plan, session);
    await db.query(
      "delete from collaboration_acks where brief_id=$1 and participant_id=any($2::uuid[])",
      [session.brief_id, session.attendee_ids],
    );
    await db.query(
      "update collaboration_sessions set stage='aligning',plan=$2,plan_version=plan_version+1,updated_at=now(),error=null where id=$1",
      [session.id, JSON.stringify(validated)],
    );
    session.stage = "aligning";
    session.plan = validated;
    await db.query(
      "update agent_turns set status='cancelled',lease_hash=null,error='讨论已收敛' where session_id=$1 and kind in ('host','speak') and status='queued'",
      [session.id],
    );
    for (const pid of session.attendee_ids)
      await this.queue(
        db,
        session.room_id,
        pid,
        "align",
        {
          instruction:
            "核对本轮需求、设计、代码基线和分工。认可后 acknowledge=true；有冲突则拒绝并说明，不能开始开发。",
        },
        session,
      );
    await this.emit(
      db,
      session.room_id,
      "collaboration.plan.proposed",
      session.host_participant_id,
      session.id,
    );
  }
  async sessionAction(userId, roomId, action, input) {
    return this.transaction(async (db) => {
      const { room, member } = await this.room(db, roomId, userId, {
        manager: true,
        write: action !== "stop",
      });
      const session = (
        await db.query(
          "select * from collaboration_sessions where id=$1 and room_id=$2 for update",
          [id.parse(input.session_id), roomId],
        )
      ).rows[0];
      if (!session || inactive.includes(session.stage))
        fail(409, "本轮协作已经结束或不存在。");
      if (action === "stop" || action === "pause") {
        await db.query(
          "update collaboration_sessions set previous_stage=stage,stage=$2,error=$3,updated_at=now() where id=$1",
          [
            session.id,
            action === "stop" ? "stopped" : "paused",
            action === "stop"
              ? "人类管理者停止了本轮协作。"
              : "人类管理者暂停了本轮协作。",
          ],
        );
        await db.query(
          "update agent_turns set status='cancelled',lease_hash=null,error=$2 where session_id=$1 and status in ('queued','leased')",
          [session.id, action === "stop" ? "协作已停止" : "协作已暂停"],
        );
      } else if (action === "resume") {
        await this.enabled(db, userId, roomId);
        await this.checkAttendees(db, roomId, session.attendee_ids);
        if (session.stage !== "paused") fail(409, "协作不处于暂停状态。");
        const stage = [
          "discussing",
          "aligning",
          "ready",
          "developing",
          "review",
        ].includes(session.previous_stage)
          ? session.previous_stage
          : "discussing";
        await db.query(
          "update collaboration_sessions set stage=$2,error=null,deadline=now()+interval '30 minutes',updated_at=now() where id=$1",
          [session.id, stage],
        );
        await db.query(
          "update agent_turns set status='queued',attempt=0,lease_hash=null,lease_until=null,hard_deadline=null,error=null,queued_until=now()+interval '30 minutes' where session_id=$1 and status in ('cancelled','failed','expired')",
          [session.id],
        );
        if (stage === "aligning")
          for (const pid of session.attendee_ids) {
            if (
              !(
                await db.query(
                  "select 1 from agent_turns where session_id=$1 and participant_id=$2 and kind='align' and status in ('queued','leased')",
                  [session.id, pid],
                )
              ).rowCount &&
              !(
                await db.query(
                  "select 1 from collaboration_acks where brief_id=$1 and participant_id=$2",
                  [session.brief_id, pid],
                )
              ).rowCount
            )
              await this.queue(
                db,
                roomId,
                pid,
                "align",
                { instruction: "重新核对需求、设计与分工，明确确认或拒绝。" },
                session,
              );
          }
        if (
          stage === "discussing" &&
          !(
            await db.query(
              "select 1 from agent_turns where session_id=$1 and status in ('queued','leased')",
              [session.id],
            )
          ).rowCount
        ) {
          if (session.turns_created >= session.max_turns)
            fail(
              409,
              "本轮发言预算已用完，请停止后创建新一轮，或补充分工让 Agent 确认。",
            );
          await this.queue(
            db,
            roomId,
            session.host_participant_id,
            "host",
            {
              instruction:
                "人类管理者要求继续本轮主持，请根据已有讨论收敛到分工；没有必要发言时明确停止。",
              final: session.turns_created >= session.max_turns - 1,
            },
            session,
          );
        }
      } else if (action === "plan") {
        await this.enabled(db, userId, roomId);
        if (["developing", "review"].includes(session.stage))
          fail(409, "开发中不能直接改分工，请停止并创建新一轮。");
        await db.query(
          "delete from collaboration_acks where brief_id=$1 and participant_id=any($2::uuid[])",
          [session.brief_id, session.attendee_ids],
        );
        await this.beginAlignment(db, session, input.plan);
      } else if (action === "approve-plan") {
        await this.enabled(db, userId, roomId);
        await this.checkAttendees(db, roomId, session.attendee_ids);
        if (session.stage !== "ready")
          fail(409, "所有参与 Agent 确认需求、设计和分工后才可以批准开发。");
        if (input.confirm !== true)
          fail(400, "请明确确认本轮分工与本地开发授权。");
        const brief = (
          await db.query("select * from collaboration_briefs where id=$1", [
            session.brief_id,
          ])
        ).rows[0];
        if (!brief.base_file_id)
          fail(409, "开发前需要上传并选定 ZIP 代码基线。");
        const plan = this.validatePlan(session.plan, session);
        for (const task of plan) {
          const capability = (
            await db.query(
              "select n.capabilities from agent_seats s join agent_nodes n on n.id=s.node_id where participant_id=$1",
              [task.assignee_id],
            )
          ).rows[0].capabilities;
          if (!capability.development || !capability.workspace)
            fail(409, "分工负责人尚未在本机授权工作目录与开发权限。");
        }
        for (const task of plan) {
          const result = (
            await db.query(
              "select island_actor_command($1,'create_task',$2) result",
              [
                session.host_participant_id,
                JSON.stringify({
                  room_id: roomId,
                  title: task.title,
                  description: task.description,
                  assignee_ids: [task.assignee_id],
                  file_ids: brief.file_ids,
                }),
              ],
            )
          ).rows[0].result;
          await db.query(
            "insert into collaboration_work(task_id,session_id,assignee_id,paths,brief_hash) values($1,$2,$3,$4,$5)",
            [
              result.id,
              session.id,
              task.assignee_id,
              task.paths,
              brief.content_hash,
            ],
          );
          await this.queue(
            db,
            roomId,
            task.assignee_id,
            "develop",
            {
              instruction: task.description,
              title: task.title,
              paths: task.paths,
            },
            session,
            result.id,
          );
        }
        await db.query(
          "update collaboration_sessions set stage='developing',plan_approved_by=$2,deadline=now()+interval '2 hours',updated_at=now() where id=$1",
          [session.id, member.id],
        );
        await this.emit(
          db,
          roomId,
          "collaboration.development.started",
          member.id,
          session.id,
        );
      } else fail(400, "协作操作无效。");
      await this.emit(
        db,
        roomId,
        "collaboration.session.updated",
        member.id,
        session.id,
      );
      return { ok: true };
    });
  }
  async nodeSync(token, sessionId, after = 0, active = null) {
    return this.transaction(async (db) => {
      const n = await this.node(db, token, { sessionId }),
        seat = await this.nodeSeat(db, n, { approved: false });
      await db.query("update agent_nodes set last_seen_at=now() where id=$1", [
        n.id,
      ]);
      if (seat.state === "approved")
        await db.query(
          "update participants set last_active_at=now() where id=$1",
          [seat.participant_id],
        );
      let cancelled = null;
      if (active) {
        const job = (
          await db.query(
            "select * from agent_turns where id=$1 and participant_id=$2",
            [id.parse(active.id), seat.participant_id],
          )
        ).rows[0];
        const stopped = job?.session_id
          ? (
              await db.query(
                "select 1 from collaboration_sessions where id=$1 and stage in ('paused','stopped','completed')",
                [job.session_id],
              )
            ).rowCount
          : false;
        if (
          stopped ||
          !job ||
          job.status !== "leased" ||
          job.lease_hash !== digest(active.lease || "") ||
          seat.muted ||
          new Date(job.hard_deadline) <= new Date()
        )
          cancelled = active.id;
        else
          await db.query(
            "update agent_turns set lease_until=least(hard_deadline,now()+interval '45 seconds') where id=$1",
            [job.id],
          );
      }
      const events =
        seat.state === "approved"
          ? (
              await db.query(
                "select * from events where room_id=$1 and id>$2 order by id limit 200",
                [seat.room_id, z.number().int().min(0).parse(after)],
              )
            ).rows
          : [];
      const cursor = events.length ? Number(events.at(-1).id) : after;
      return {
        state: seat.state,
        muted: seat.muted,
        events,
        cursor,
        cancelled,
      };
    });
  }
  async claim(token, sessionId) {
    return this.transaction(async (db) => {
      const n = await this.node(db, token, { sessionId }),
        seat = await this.nodeSeat(db, n, { write: true });
      if (
        (
          await db.query(
            "select 1 from agent_turns where participant_id=$1 and status='leased'",
            [seat.participant_id],
          )
        ).rowCount
      )
        return null;
      const turn = (
        await db.query(
          "select j.* from agent_turns j left join collaboration_sessions s on s.id=j.session_id where j.participant_id=$1 and j.status='queued' and j.queued_until>now() and (j.session_id is null or s.stage not in ('paused','stopped','completed')) and (j.kind in ('align','develop') or not exists(select 1 from agent_turns earlier where earlier.session_id=j.session_id and earlier.sequence<j.sequence and earlier.status in ('queued','leased'))) order by j.sequence limit 1 for update of j skip locked",
          [seat.participant_id],
        )
      ).rows[0];
      if (!turn) return null;
      if (turn.session_id) {
        const session = (
          await db.query("select * from collaboration_sessions where id=$1", [
            turn.session_id,
          ])
        ).rows[0];
        if (session.host_participant_id !== seat.room.agent_host_participant_id)
          fail(409, "Agent 主持人已变化，等待管理者调整。");
        if (turn.kind === "develop") {
          if (session.stage !== "developing" || !session.plan_approved_by)
            fail(409, "开发方案尚未批准。");
          const acknowledged = (
            await db.query(
              "select count(*) n from collaboration_acks a join collaboration_briefs b on b.id=a.brief_id and a.content_hash=b.content_hash where a.brief_id=$1 and participant_id=any($2::uuid[])",
              [session.brief_id, session.attendee_ids],
            )
          ).rows[0].n;
          if (Number(acknowledged) !== session.attendee_ids.length)
            fail(409, "需求对齐已失效，禁止开始开发。");
        }
      }
      const lease = secret(),
        seconds = turn.kind === "develop" ? 1200 : 300;
      const job = (
        await db.query(
          "update agent_turns set status='leased',attempt=attempt+1,lease_hash=$2,lease_until=now()+interval '45 seconds',hard_deadline=now()+make_interval(secs=>$3) where id=$1 returning *",
          [turn.id, digest(lease), seconds],
        )
      ).rows[0];
      if (turn.task_id) {
        await db.query(
          "update collaboration_work set state='running',attempt=attempt+1 where task_id=$1",
          [turn.task_id],
        );
        await db.query("select island_actor_command($1,'update_task',$2)", [
          seat.participant_id,
          JSON.stringify({
            room_id: seat.room_id,
            task_id: turn.task_id,
            status: "in_progress",
          }),
        ]);
      }
      const context = await this.context(db, job, seat);
      await this.emit(
        db,
        seat.room_id,
        "agent.turn.started",
        seat.participant_id,
        job.id,
        { kind: job.kind },
      );
      return {
        id: job.id,
        kind: job.kind,
        task_id: job.task_id,
        session_id: job.session_id,
        input: job.input,
        lease,
        hard_deadline: job.hard_deadline,
        ...context,
      };
    });
  }
  async context(db, job, seat) {
    const session = job.session_id
      ? (
          await db.query("select * from collaboration_sessions where id=$1", [
            job.session_id,
          ])
        ).rows[0]
      : null;
    const brief =
      (
        await db.query(
          session
            ? "select * from collaboration_briefs where id=$1"
            : "select * from collaboration_briefs where room_id=$1 order by revision desc limit 1",
          [session?.brief_id || job.room_id],
        )
      ).rows[0] || null;
    if (brief) {
      brief.documents = (
        await db.query(
          "select id,name,mime_type from files where room_id=$1 and id=any($2) and status='normal'",
          [job.room_id, brief.file_ids],
        )
      ).rows;
    }
    const participants = (
      await db.query(
        "select id,type,display_name from participants where room_id=$1 and status='active'",
        [job.room_id],
      )
    ).rows;
    const history = (
      await db.query(
        "select sender_participant_id,content,type,created_at,mentioned_participant_ids from messages where room_id=$1 and deleted_at is null order by created_at desc,id desc limit 50",
        [job.room_id],
      )
    ).rows;
    const messages = [];
    let historyBytes = 0;
    for (const message of history) {
      const bounded = {
        ...message,
        content:
          typeof message.content === "string"
            ? message.content.slice(-6000)
            : message.content,
      };
      const size = Buffer.byteLength(JSON.stringify(bounded));
      if (historyBytes + size > 64 * 1024) break;
      messages.unshift(bounded);
      historyBytes += size;
    }
    return {
      participant_id: seat.participant_id,
      room_id: job.room_id,
      room_name: seat.room.name,
      session,
      brief,
      participants,
      messages,
      history_truncated:
        messages.length !== history.length ||
        history.some((message) => message.content?.length > 6000),
      protocol_version: "1.0",
    };
  }
  async activeJob(
    db,
    token,
    turnId,
    lease,
    { sessionId, completed = false } = {},
  ) {
    const n = await this.node(db, token, { sessionId }),
      seat = await this.nodeSeat(db, n, { write: true });
    const job = (
      await db.query(
        "select * from agent_turns where id=$1 and participant_id=$2 for update",
        [id.parse(turnId), seat.participant_id],
      )
    ).rows[0];
    if (!job || !lease || job.lease_hash !== digest(lease))
      fail(409, "发言或开发授权已失效。");
    if (completed && job.status === "completed") return { n, seat, job };
    if (
      job.status !== "leased" ||
      new Date(job.lease_until) <= new Date() ||
      new Date(job.hard_deadline) <= new Date()
    )
      fail(409, "本次任务已结束、超时或授权已失效。");
    if (job.session_id) {
      const s = (
        await db.query("select * from collaboration_sessions where id=$1", [
          job.session_id,
        ])
      ).rows[0];
      if (
        !s ||
        ["paused", "stopped", "completed"].includes(s.stage) ||
        s.host_participant_id !== seat.room.agent_host_participant_id
      )
        fail(409, "协作已暂停、停止或主持人已变化。");
    }
    return { n, seat, job };
  }
  async complete(token, turnId, lease, raw, sessionId) {
    const result = turnResultSchema.parse(raw);
    return this.transaction(async (db) => {
      const { seat, job } = await this.activeJob(db, token, turnId, lease, {
        sessionId,
        completed: true,
      });
      if (job.status === "completed") return { ok: true, duplicate: true };
      const session = job.session_id
        ? (
            await db.query(
              "select * from collaboration_sessions where id=$1 for update",
              [job.session_id],
            )
          ).rows[0]
        : null;
      const brief = session
        ? (
            await db.query("select * from collaboration_briefs where id=$1", [
              session.brief_id,
            ])
          ).rows[0]
        : null;
      if (result.speakers.length && job.kind !== "host")
        fail(403, "只有选定的 Agent 主持人可以安排下一位发言者。");
      if (result.plan.length && job.kind !== "host")
        fail(403, "只有选定的 Agent 主持人可以提出分工。");
      if (job.kind === "develop") {
        const artifact = (
          await db.query(
            "select * from collaboration_artifacts where id=$1 and turn_id=$2 and brief_hash=$3",
            [result.artifact_id, job.id, brief.content_hash],
          )
        ).rows[0];
        if (!artifact) fail(409, "请先回传与当前需求版本对应的本地开发成果。");
        await db.query(
          "update collaboration_work set state='submitted' where task_id=$1",
          [job.task_id],
        );
      }
      if (result.message) {
        const reply = job.source_message_id
          ? { reply_to_message_id: job.source_message_id }
          : {};
        await db.query("select island_actor_command($1,'message',$2)", [
          seat.participant_id,
          JSON.stringify({
            room_id: job.room_id,
            content: result.message,
            client_message_id: job.id,
            ...reply,
          }),
        ]);
      }
      if (result.acknowledge && brief)
        await this.ack(db, brief, seat.participant_id);
      await db.query(
        "update agent_turns set status='completed',result=$2,completed_at=now() where id=$1",
        [job.id, JSON.stringify(result)],
      );
      await this.emit(
        db,
        job.room_id,
        "agent.turn.completed",
        seat.participant_id,
        job.id,
        { kind: job.kind },
      );
      if (session) await this.advance(db, session, job, result);
      return { ok: true };
    });
  }
  async advance(db, session, job, result) {
    if (job.kind === "host") {
      if (result.done || result.plan.length) {
        if (!result.plan.length) {
          await this.pause(
            db,
            session,
            "主持人尚未给出分工方案，请管理者补充或重新主持。",
          );
          return;
        }
        await this.beginAlignment(db, session, result.plan);
        return;
      }
      const speakers = [
        ...new Map(result.speakers.map((s) => [s.participant_id, s])).values(),
      ];
      if (!speakers.length) {
        await this.pause(
          db,
          session,
          "主持人选择了结束发言，等待人类管理者补充分工或继续。",
        );
        return;
      }
      if (
        speakers.some(
          (s) =>
            s.participant_id === session.host_participant_id ||
            !session.attendee_ids.includes(s.participant_id),
        )
      )
        fail(400, "下一位发言者必须是本轮其他参与 Agent。");
      await this.checkAttendees(
        db,
        session.room_id,
        speakers.map((s) => s.participant_id),
      );
      // 为最后的主持人收敛保留一次发言，绝不让 Agent 自行延长预算。
      const available = session.max_turns - session.turns_created - 1;
      if (available <= 0) {
        await this.pause(
          db,
          session,
          "讨论发言预算已耗尽，请管理者确认分工或重新开始。",
        );
        return;
      }
      for (const speaker of speakers.slice(0, available))
        await this.queue(
          db,
          session.room_id,
          speaker.participant_id,
          "speak",
          { instruction: speaker.instruction },
          session,
        );
    } else if (job.kind === "speak") {
      const waiting = (
        await db.query(
          "select 1 from agent_turns where session_id=$1 and kind='speak' and status in ('queued','leased')",
          [session.id],
        )
      ).rowCount;
      if (!waiting) {
        if (session.turns_created >= session.max_turns) {
          await this.pause(db, session, "讨论预算已耗尽。");
          return;
        }
        await this.queue(
          db,
          session.room_id,
          session.host_participant_id,
          "host",
          {
            instruction:
              session.turns_created >= session.max_turns - 1
                ? "这是最后一次主持发言，必须收敛并提出分工，或明确停止等待人类。"
                : "汇总已点名参与者的意见，决定必要的下一位发言者或提出分工方案。",
            final: session.turns_created >= session.max_turns - 1,
          },
          session,
        );
      }
    } else if (job.kind === "align") {
      if (!result.acknowledge) {
        await this.pause(
          db,
          session,
          "有 Agent 未认可需求、设计或分工；请处理反馈后继续。",
        );
        return;
      }
      const count = Number(
        (
          await db.query(
            "select count(*) n from collaboration_acks where brief_id=$1 and participant_id=any($2::uuid[])",
            [session.brief_id, session.attendee_ids],
          )
        ).rows[0].n,
      );
      if (count === session.attendee_ids.length) {
        await db.query(
          "update collaboration_sessions set stage='ready',updated_at=now() where id=$1",
          [session.id],
        );
        await this.emit(
          db,
          session.room_id,
          "collaboration.aligned",
          job.participant_id,
          session.id,
        );
      }
    } else if (job.kind === "develop") {
      const remaining = (
        await db.query(
          "select 1 from collaboration_work where session_id=$1 and state in ('pending','running')",
          [session.id],
        )
      ).rowCount;
      if (!remaining) {
        await db.query(
          "update collaboration_sessions set stage='review',updated_at=now() where id=$1",
          [session.id],
        );
        await this.emit(
          db,
          session.room_id,
          "collaboration.review.ready",
          job.participant_id,
          session.id,
        );
      }
    }
  }
  async pause(db, session, error) {
    await db.query(
      "update collaboration_sessions set previous_stage=stage,stage='paused',error=$2,updated_at=now() where id=$1",
      [session.id, error],
    );
    await db.query(
      "update agent_turns set status='cancelled',lease_hash=null,error=$2 where session_id=$1 and status in ('queued','leased')",
      [session.id, error],
    );
    await this.emit(
      db,
      session.room_id,
      "collaboration.paused",
      null,
      session.id,
      { reason: error },
    );
  }
  async failTurn(token, turnId, lease, error, sessionId) {
    return this.transaction(async (db) => {
      const { job, seat } = await this.activeJob(db, token, turnId, lease, {
        sessionId,
      });
      const message = boundedError(error);
      await db.query(
        "update agent_turns set status='failed',error=$2,completed_at=now() where id=$1",
        [job.id, message],
      );
      if (job.session_id) {
        const s = (
          await db.query("select * from collaboration_sessions where id=$1", [
            job.session_id,
          ])
        ).rows[0];
        await this.pause(db, s, "本地 Agent 执行失败：" + message);
      }
      await this.emit(
        db,
        job.room_id,
        "agent.turn.failed",
        seat.participant_id,
        job.id,
        { error: message },
      );
      return { ok: true };
    });
  }
  async adminRevoke(adminId, nodeId, reason) {
    return this.transaction(async (db) => {
      const role = (
        await db.query(
          "select role from admin_members where user_id=$1 and effective_status($1)<>'banned'",
          [id.parse(adminId)],
        )
      ).rows[0]?.role;
      if (!["super", "technical"].includes(role))
        fail(403, "需要超级或技术管理员权限。");
      z.string().trim().min(3).max(2000).parse(reason);
      const target = (
        await db.query(
          "select s.participant_id,p.room_id,n.id node_id from agent_nodes n join agent_seats s on s.node_id=n.id join participants p on p.id=s.participant_id where n.id=$1",
          [id.parse(nodeId)],
        )
      ).rows[0];
      if (!target) fail(404, "设备不存在。");
      await db.query("select id from rooms where id=$1 for update", [
        target.room_id,
      ]);
      const previous = (
        await db.query(
          "select revoked_at from agent_nodes where id=$1 for update",
          [target.node_id],
        )
      ).rows[0];
      if (previous.revoked_at) return { ok: true, already_revoked: true };
      await db.query(
        "update agent_nodes set revoked_at=now(),session_id=null,last_seen_at=null where id=$1",
        [target.node_id],
      );
      await db.query(
        "update agent_seats set state='revoked' where participant_id=$1",
        [target.participant_id],
      );
      await db.query(
        "update participants set status='left',last_active_at=null where id=$1",
        [target.participant_id],
      );
      await db.query(
        "update agent_turns set status='cancelled',lease_hash=null,error='平台管理员撤销设备' where participant_id=$1 and status in ('queued','leased')",
        [target.participant_id],
      );
      await this.pauseAffected(
        db,
        target.room_id,
        target.participant_id,
        "平台管理员撤销了参与设备。",
      );
      await db.query(
        "insert into admin_audit_logs(admin_id,action,target_type,target_id,reason,trace_id) values($1,'agent.revoke','agent_node',$2,$3,$4)",
        [adminId, nodeId, reason, randomUUID()],
      );
      await this.emit(
        db,
        target.room_id,
        "agent.seat.updated",
        null,
        target.participant_id,
      );
      return { ok: true };
    });
  }
  async nodeDownload(token, fileId) {
    return this.transaction(async (db) => {
      const n = await this.node(db, token),
        seat = await this.nodeSeat(db, n);
      const file = await this.file(db, seat.room_id, id.parse(fileId));
      return { file, bytes: await this.storage.loadFile(file.storage_path) };
    });
  }
  async uploadArtifact(token, turnId, lease, bytes) {
    return this.transaction(async (db) => {
      const { job, seat } = await this.activeJob(db, token, turnId, lease);
      if (job.kind !== "develop" || !job.task_id)
        fail(403, "当前没有回传开发成果的授权。");
      const previous = (
        await db.query(
          "select id,file_id from collaboration_artifacts where turn_id=$1",
          [job.id],
        )
      ).rows[0];
      if (previous) return previous;
      const work = (
        await db.query("select * from collaboration_work where task_id=$1", [
          job.task_id,
        ])
      ).rows[0];
      const session = (
        await db.query("select * from collaboration_sessions where id=$1", [
          job.session_id,
        ])
      ).rows[0];
      const brief = (
        await db.query("select * from collaboration_briefs where id=$1", [
          session.brief_id,
        ])
      ).rows[0];
      const source = await this.file(db, seat.room_id, brief.base_file_id),
        base = await readArchive(
          await this.storage.loadFile(source.storage_path),
        );
      if (treeHash(base) !== brief.base_hash) fail(409, "代码基线已变化。");
      const { manifest } = await unpackArtifact(
        bytes,
        base,
        { brief_hash: brief.content_hash, task_id: job.task_id },
        work.paths,
      );
      const fileId = randomUUID(),
        path = seat.room_id + "/" + fileId;
      await this.storage.storeFile(path, bytes, "application/zip", db);
      try {
        await db.query("select island_actor_command($1,'register_file',$2)", [
          seat.participant_id,
          JSON.stringify({
            id: fileId,
            room_id: seat.room_id,
            storage_path: path,
            name: "开发成果-" + job.task_id.slice(0, 8) + ".zip",
            mime_type: "application/zip",
            size: bytes.length,
          }),
        ]);
        const artifact = (
          await db.query(
            "insert into collaboration_artifacts(room_id,session_id,task_id,turn_id,file_id,brief_hash,manifest) values($1,$2,$3,$4,$5,$6,$7) returning id,file_id",
            [
              seat.room_id,
              job.session_id,
              job.task_id,
              job.id,
              fileId,
              brief.content_hash,
              JSON.stringify(manifest),
            ],
          )
        ).rows[0];
        await this.emit(
          db,
          seat.room_id,
          "collaboration.artifact.submitted",
          seat.participant_id,
          artifact.id,
        );
        return artifact;
      } catch (e) {
        await this.storage.removeFile(path, db).catch(() => {});
        throw e;
      }
    });
  }
  async reviewArtifact(userId, roomId, input) {
    return this.transaction(async (db) => {
      const { member } = await this.room(db, roomId, userId, {
        manager: true,
        write: true,
      });
      const data = z
        .object({
          artifact_id: id,
          accept: z.boolean(),
          note: z.string().trim().min(1).max(2000),
        })
        .parse(input);
      const artifact = (
        await db.query(
          "select a.*,j.status turn_status from collaboration_artifacts a join agent_turns j on j.id=a.turn_id where a.id=$1 and a.room_id=$2 for update of a",
          [data.artifact_id, roomId],
        )
      ).rows[0];
      if (!artifact || artifact.turn_status !== "completed")
        fail(409, "成果尚未完成回传或不存在。");
      if (artifact.state === "merged") fail(409, "成果已合并。");
      const file = await this.file(db, roomId, artifact.file_id);
      await db.query(
        "update collaboration_artifacts set state=$2,review_note=$3,reviewed_by=$4,reviewed_at=now() where id=$1",
        [
          artifact.id,
          data.accept ? "accepted" : "rejected",
          data.note,
          member.id,
        ],
      );
      await db.query(
        "update collaboration_work set state=$2 where task_id=$1",
        [artifact.task_id, data.accept ? "accepted" : "rejected"],
      );
      if (data.accept) {
        await db.query(
          "update tasks set status='completed',completed_at=now(),updated_at=now() where id=$1",
          [artifact.task_id],
        );
        await this.emit(
          db,
          roomId,
          "task.completed",
          member.id,
          artifact.task_id,
        );
      }
      await this.emit(
        db,
        roomId,
        "collaboration.artifact.reviewed",
        member.id,
        artifact.id,
      );
      return { ok: true };
    });
  }
  async retryWork(userId, roomId, taskId) {
    return this.transaction(async (db) => {
      const { member } = await this.room(db, roomId, userId, {
        manager: true,
        write: true,
      });
      await this.enabled(db, userId, roomId);
      const work = (
        await db.query("select * from collaboration_work where task_id=$1", [
          id.parse(taskId),
        ])
      ).rows[0];
      const session = work
        ? (
            await db.query(
              "select * from collaboration_sessions where id=$1 and room_id=$2",
              [work.session_id, roomId],
            )
          ).rows[0]
        : null;
      if (
        !session ||
        inactive.includes(session.stage) ||
        !["rejected", "submitted"].includes(work.state)
      )
        fail(409, "任务未被退回或不能重新执行。");
      await this.checkAttendees(db, roomId, [work.assignee_id]);
      if (
        (
          await db.query(
            "select 1 from agent_turns where task_id=$1 and status in ('queued','leased')",
            [taskId],
          )
        ).rowCount
      )
        fail(409, "该任务仍在执行。");
      const task = (await db.query("select * from tasks where id=$1", [taskId]))
        .rows[0];
      await db.query(
        "update collaboration_work set state='pending' where task_id=$1",
        [taskId],
      );
      await db.query(
        "update tasks set status='in_progress',completed_at=null where id=$1",
        [taskId],
      );
      await db.query(
        "update collaboration_sessions set stage='developing',deadline=now()+interval '2 hours',updated_at=now() where id=$1",
        [session.id],
      );
      await this.queue(
        db,
        roomId,
        work.assignee_id,
        "develop",
        {
          title: task.title,
          instruction: task.description,
          paths: work.paths,
          review_feedback:
            (
              await db.query(
                "select review_note from collaboration_artifacts where task_id=$1 order by created_at desc limit 1",
                [taskId],
              )
            ).rows[0]?.review_note || "",
        },
        session,
        taskId,
      );
      await this.emit(
        db,
        roomId,
        "collaboration.work.retried",
        member.id,
        taskId,
      );
      return { ok: true };
    });
  }
  async mergeData(db, roomId, sessionId, resolutions = {}) {
    const session = (
      await db.query(
        "select * from collaboration_sessions where id=$1 and room_id=$2",
        [sessionId, roomId],
      )
    ).rows[0];
    if (!session || !["review", "completed"].includes(session.stage))
      fail(409, "本轮成果尚未进入合并审阅阶段。");
    const brief = (
      await db.query("select * from collaboration_briefs where id=$1", [
        session.brief_id,
      ])
    ).rows[0];
    const source = await this.file(db, roomId, brief.base_file_id),
      base = await readArchive(
        await this.storage.loadFile(source.storage_path),
      );
    if (treeHash(base) !== brief.base_hash) fail(409, "代码基线不一致。");
    const rows = (
      await db.query(
        "select a.*,w.paths from collaboration_artifacts a join collaboration_work w on w.task_id=a.task_id where a.session_id=$1 and a.state in ('accepted','merged') order by a.created_at",
        [session.id],
      )
    ).rows;
    const tasks = (
      await db.query("select * from collaboration_work where session_id=$1", [
        session.id,
      ])
    ).rows;
    const approvedTaskIds = new Set(rows.map((a) => a.task_id));
    if (
      !tasks.length ||
      tasks.some(
        (t) => t.state !== "accepted" || !approvedTaskIds.has(t.task_id),
      )
    )
      fail(409, "请先审阅并接受所有分工成果，退回的任务需要重新提交。");
    const artifacts = [];
    for (const a of rows) {
      const f = await this.file(db, roomId, a.file_id);
      const data = await unpackArtifact(
        await this.storage.loadFile(f.storage_path),
        base,
        { brief_hash: brief.content_hash, task_id: a.task_id },
        a.paths,
      );
      artifacts.push({ id: a.id, ...data });
    }
    return {
      session,
      brief,
      artifacts,
      ...mergeArtifacts(base, artifacts, resolutions),
    };
  }
  async mergePreview(userId, roomId, sessionId) {
    return this.transaction(async (db) => {
      await this.room(db, roomId, userId, { manager: true });
      const result = await this.mergeData(db, roomId, id.parse(sessionId));
      return {
        conflicts: result.conflicts,
        files: [...result.files].map(([path, bytes]) => ({
          path,
          size: bytes.length,
          sha256: digest(bytes),
        })),
        artifacts: result.artifacts.map((a) => ({
          id: a.id,
          changes: a.manifest.changes,
        })),
        hash: result.hash,
      };
    });
  }
  async merge(userId, roomId, input) {
    return this.transaction(async (db) => {
      const { member } = await this.room(db, roomId, userId, {
        manager: true,
        write: true,
      });
      await this.enabled(db, userId, roomId);
      const data = z
        .object({
          session_id: id,
          confirm: z.literal(true),
          resolutions: z.record(z.string(), z.string()).default({}),
        })
        .parse(input);
      const result = await this.mergeData(
        db,
        roomId,
        data.session_id,
        data.resolutions,
      );
      if (result.session.merged_file_id) {
        await this.file(db, roomId, result.session.merged_file_id);
        return { id: result.session.merged_file_id, duplicate: true };
      }
      if (result.conflicts.length)
        fail(409, "存在冲突，必须逐项选定版本再合并。");
      const bytes = await writeArchive(result.files),
        fid = randomUUID(),
        path = roomId + "/" + fid;
      await this.storage.storeFile(path, bytes, "application/zip", db);
      try {
        await db.query("select set_config('request.jwt.claim.sub',$1,true)", [
          userId,
        ]);
        await db.query("select island_command('register_file',$1)", [
          JSON.stringify({
            id: fid,
            room_id: roomId,
            storage_path: path,
            name: "协作合并源码-v" + result.brief.revision + ".zip",
            mime_type: "application/zip",
            size: bytes.length,
          }),
        ]);
        await db.query(
          "update collaboration_artifacts set state='merged' where session_id=$1 and state='accepted'",
          [data.session_id],
        );
        await db.query(
          "update collaboration_sessions set stage='completed',merged_file_id=$2,updated_at=now() where id=$1",
          [data.session_id, fid],
        );
        await this.emit(
          db,
          roomId,
          "collaboration.completed",
          member.id,
          data.session_id,
          { file_id: fid, tree_hash: result.hash },
        );
        return { id: fid, hash: result.hash };
      } catch (e) {
        await this.storage.removeFile(path, db).catch(() => {});
        throw e;
      }
    });
  }
  async housekeeping() {
    const rooms = (
      await this.pool.query(
        "select distinct room_id from agent_turns where status in ('queued','leased') union select room_id from collaboration_sessions where stage not in ('completed','stopped','paused')",
      )
    ).rows;
    for (const { room_id: r } of rooms)
      await this.transaction(async (db) => {
        const room = (
          await db.query("select * from rooms where id=$1 for update", [r])
        ).rows[0];
        if (!room) return;
        const expired = (
          await db.query(
            "select * from agent_turns where room_id=$1 and ((status='leased' and lease_until<=now()) or (status='queued' and queued_until<=now())) for update",
            [r],
          )
        ).rows;
        for (const j of expired) {
          const retry = j.status === "leased" && j.attempt < 3;
          await db.query(
            "update agent_turns set status=$2,lease_hash=null,error=$3,lease_until=null where id=$1",
            [
              j.id,
              retry ? "queued" : "expired",
              retry ? "连接中断，等待恢复" : "等待或执行超时",
            ],
          );
          if (!retry && j.session_id) {
            const s = (
              await db.query(
                "select * from collaboration_sessions where id=$1",
                [j.session_id],
              )
            ).rows[0];
            if (s && !inactive.includes(s.stage) && s.stage !== "paused")
              await this.pause(
                db,
                s,
                "有 Agent 长时间离线或任务超时，请调整后继续。",
              );
          }
          await this.emit(db, r, "agent.turn.updated", j.participant_id, j.id);
        }
        const sessions = (
          await db.query(
            "select * from collaboration_sessions where room_id=$1 and stage not in ('completed','stopped','paused')",
            [r],
          )
        ).rows;
        for (const s of sessions) {
          let error = null;
          if (new Date(s.deadline) <= new Date())
            error = "本轮协作已达到时间上限，等待人类管理者处理。";
          else if (room.status !== "active") error = "房间被冻结或不可用。";
          else
            try {
              await this.checkAttendees(db, r, s.attendee_ids);
              for (const pid of s.attendee_ids) {
                const owner = (
                  await db.query(
                    "select n.owner_user_id from agent_seats x join agent_nodes n on n.id=x.node_id where participant_id=$1",
                    [pid],
                  )
                ).rows[0];
                await this.enabled(db, owner.owner_user_id, r);
              }
            } catch (e) {
              error = boundedError(e);
            }
          if (error) {
            await this.pause(db, s, error);
            await db.query(
              "update agent_turns set status='cancelled',lease_hash=null,error=$2 where session_id=$1 and status in ('queued','leased')",
              [s.id, error],
            );
          }
        }
      }).catch((e) => console.error("Agent 调度维护失败：" + boundedError(e)));
  }
}

export { AgentError };

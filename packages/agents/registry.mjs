import { randomUUID, randomBytes } from "node:crypto";
import { z } from "zod";
import { digest, safePath } from "./archive.mjs";
import { fail, turnResultSchema } from "./protocol.mjs";
import { privacyFindings, safeResult, privateFile } from "./privacy.mjs";
import { enrollmentDocument } from "./enrollment.mjs";
const id = z.uuid();
export const policySchema = z
  .object({
    force_review: z.boolean(),
    force_file_review: z.boolean().default(false),
    allow_remote_mcp: z.boolean(),
    max_agents: z.number().int().min(1).max(50),
    max_pending_invites: z.number().int().min(1).max(20),
    invite_minutes: z.number().int().min(2).max(60),
    artifact_mb: z.number().int().min(1).max(30),
    avatar_uploads: z.boolean(),
    preview_enabled: z.boolean(),
  })
  .strict();
export const registryMethods = {
  async lockNodeRooms(db, nodeId) {
    const targets = (
      await db.query(
        "select distinct p.room_id from agent_seats s join participants p on p.id=s.participant_id where s.node_id=$1 order by p.room_id",
        [nodeId],
      )
    ).rows;
    for (const row of targets)
      await db.query("select id from rooms where id=$1 for update", [
        row.room_id,
      ]);
    const n = (
      await db.query("select * from agent_nodes where id=$1 for update", [
        nodeId,
      ])
    ).rows[0];
    if (!n) fail(404, "设备不存在。");
    const current = (
      await db.query(
        "select distinct p.room_id from agent_seats s join participants p on p.id=s.participant_id where s.node_id=$1 order by p.room_id",
        [nodeId],
      )
    ).rows;
    // 读房间集合与取得设备锁之间可能新增席位。此时回滚重试，不能反向追加房间锁。
    if (
      current.some(
        (row) => !targets.some((target) => target.room_id === row.room_id),
      )
    )
      fail(503, "设备房间授权正在变化，请稍后重试原操作。");
    return n;
  },
  async readEnrollment(pairingId, token, origin) {
    id.parse(pairingId);
    z.string().min(30).max(100).parse(token);
    return this.transaction(async (db) => {
      const p = (
        await db.query(
          "select * from agent_pairings where id=$1 and doc_token_hash=$2 and used_at is null and revoked_at is null and deleted_at is null and expires_at>now()",
          [pairingId, digest(token)],
        )
      ).rows[0];
      if (!p)
        fail(410, "此安装说明已使用、撤销或过期；已安装客户端请用原配置恢复。");
      await this.owner(db, p.owner_user_id);
      await this.enabled(db, p.owner_user_id, p.room_id);
      if (p.room_id)
        await this.room(db, p.room_id, p.owner_user_id, { write: true });
      return enrollmentDocument(
        p,
        await this.vault.open(p.code_cipher, `invite:${p.id}`),
        origin,
      );
    });
  },
  async policy(db = this.pool) {
    return (
      await db.query("select value from agent_security_policy where id=true")
    ).rows[0].value;
  },
  async owner(db, userId) {
    id.parse(userId);
    if (
      (await db.query("select effective_status($1) status", [userId])).rows[0]
        ?.status === "banned"
    )
      fail(403, "账号已停用。");
    if (
      !(await db.query("select 1 from profiles where id=$1", [userId])).rowCount
    )
      fail(401, "账号不存在。");
  },
  async ownedNode(db, userId, nodeId) {
    await this.owner(db, userId);
    const n = (
      await db.query(
        "select * from agent_nodes where id=$1 and owner_user_id=$2",
        [id.parse(nodeId), userId],
      )
    ).rows[0];
    if (!n) fail(404, "Agent 不存在或不属于你。");
    return n;
  },
  async myAgents(userId) {
    return this.transaction(async (db) => {
      await this.owner(db, userId);
      // Revoke expired recoverable invite material; previews never mark an invite used.
      await db.query(
        "update agent_pairings set code_cipher=null,doc_cipher=null where owner_user_id=$1 and (used_at is not null or revoked_at is not null or expires_at<=now())",
        [userId],
      );
      const nodes = (
        await db.query(
          `select id,agent_name,adapter,avatar_url,platform_scope,active_seat_id,privacy_mode,file_review,created_at,expires_at,revoked_at,
    coalesce(ready_until>now(),false) model_ready,
    (session_id is not null and revoked_at is null and expires_at>now() and last_seen_at>now()-interval '45 seconds') connected
    from agent_nodes where owner_user_id=$1 order by created_at desc`,
          [userId],
        )
      ).rows;
      const seats = (
        await db.query(
          `select s.*,p.room_id,r.name room_name,p.display_name from agent_seats s join participants p on p.id=s.participant_id
    join rooms r on r.id=p.room_id join agent_nodes n on n.id=s.node_id where n.owner_user_id=$1 and s.deleted_at is null order by s.created_at`,
          [userId],
        )
      ).rows;
      const invites = (
        await db.query(
          `select p.id,p.room_id,r.name room_name,p.created_at,p.expires_at,p.used_at,p.revoked_at,p.node_id,p.source,p.code_cipher,p.doc_cipher,n.agent_name,
    case when p.used_at is not null then 'used' when p.revoked_at is not null then 'revoked' when p.expires_at<=now() then 'expired' else 'pending' end status
    from agent_pairings p left join rooms r on r.id=p.room_id left join agent_nodes n on n.id=p.node_id where p.owner_user_id=$1 and p.deleted_at is null order by p.created_at desc limit 100`,
          [userId],
        )
      ).rows;
      for (const p of invites) {
        p.code = p.code_cipher
          ? await this.vault.open(p.code_cipher, `invite:${p.id}`)
          : null;
        const secret = p.doc_cipher
          ? await this.vault.open(p.doc_cipher, `doc:${p.id}`)
          : null;
        p.document_path = secret
          ? `/api/agent-enrollment/${p.id}/${secret}.md`
          : null;
        delete p.code_cipher;
        delete p.doc_cipher;
      }
      const reviews = (
        await db.query(
          `select v.*,n.agent_name,r.name room_name from agent_private_reviews v join agent_nodes n on n.id=v.node_id
    join agent_turns j on j.id=v.turn_id join rooms r on r.id=j.room_id where v.owner_user_id=$1 and v.status='pending'
    and v.expires_at>now() and j.status in ('leased','awaiting_review') order by v.created_at limit 50`,
          [userId],
        )
      ).rows;
      for (const r of reviews) {
        r.payload = await this.vault.open(r.payload_cipher, `review:${r.id}`);
        delete r.payload_cipher;
      }
      // 入席审批属于房间人类主持人，不属于设备所有者；只返回公开资料，绝不共享私有发送审核。
      const approvals = (
        await db.query(
          `select s.participant_id,p.room_id,r.name room_name,r.status room_status,p.display_name,n.agent_name,n.avatar_url,n.adapter,
          o.display_name owner_name,s.created_at from agent_seats s
          join participants p on p.id=s.participant_id join rooms r on r.id=p.room_id
          join participants host on host.id=r.host_participant_id
          join agent_nodes n on n.id=s.node_id join profiles o on o.id=n.owner_user_id
          where host.user_id=$1 and host.type='human' and host.status='active'
          and r.status<>'deleted' and s.state='pending' and s.deleted_at is null
          and n.revoked_at is null and n.expires_at>now() order by s.created_at`,
          [userId],
        )
      ).rows;
      return {
        nodes,
        seats,
        invites,
        reviews,
        approvals,
        policy: await this.policy(db),
      };
    });
  },
  async updateAgent(userId, input) {
    const d = z
      .object({
        node_id: id,
        agent_name: z.string().trim().min(1).max(40),
        avatar_url: z.string().max(100).nullable().default(null),
        privacy_mode: z.enum(["review", "filtered"]).optional(),
        file_review: z.boolean().optional(),
      })
      .strict()
      .parse(input);
    if (privacyFindings(d.agent_name).length)
      fail(400, "昵称不能包含本机路径或凭据。");
    return this.transaction(async (db) => {
      await this.ownedNode(db, userId, d.node_id);
      const n = await this.lockNodeRooms(db, d.node_id);
      await this.verifyAvatar(db, userId, d.avatar_url);
      const policy = await this.policy(db),
        mode = d.privacy_mode ?? n.privacy_mode,
        fileReview = d.file_review ?? n.file_review;
      if (d.privacy_mode === "filtered" && policy.force_review)
        fail(403, "平台要求本人确认发送，不能关闭。");
      if (d.file_review === false && policy.force_file_review)
        fail(403, "平台要求本人确认文件发送，不能关闭。");
      await db.query(
        "update agent_nodes set agent_name=$2,avatar_url=$3,privacy_mode=$4,file_review=$5 where id=$1",
        [n.id, d.agent_name, d.avatar_url, mode, fileReview],
      );
      const seats = (
        await db.query(
          "update participants p set display_name=$2,avatar_url=$3 from agent_seats s where p.id=s.participant_id and s.node_id=$1 returning p.id,p.room_id",
          [n.id, d.agent_name, d.avatar_url],
        )
      ).rows;
      for (const s of seats)
        await this.emit(db, s.room_id, "participant.updated", s.id, s.id);
      return { ok: true };
    });
  },
  async addAgentToRoom(userId, roomId, nodeId) {
    return this.transaction(async (db) => {
      await this.room(db, roomId, userId, { write: true });
      await this.enabled(db, userId, roomId);
      await this.ownedNode(db, userId, nodeId);
      const n = (
        await db.query("select * from agent_nodes where id=$1 for update", [
          nodeId,
        ])
      ).rows[0];
      if (!n) fail(404, "设备不存在。");
      if (!n.platform_scope)
        fail(409, "此设备是旧版单房间连接，请在“我的 Agent”重新注册独立连接。");
      if (n.revoked_at || new Date(n.expires_at) <= new Date())
        fail(403, "设备已撤销或过期。");
      if (
        (
          await db.query(
            `select 1 from agent_seats s join participants p on p.id=s.participant_id where s.node_id=$1 and p.room_id=$2 and s.state in ('pending','approved') and s.deleted_at is null`,
            [n.id, roomId],
          )
        ).rowCount
      )
        fail(409, "此 Agent 已在此房间。");
      if (
        Number(
          (
            await db.query(
              `select count(*) n from agent_seats s join participants p on p.id=s.participant_id where p.room_id=$1 and s.state in ('pending','approved')`,
              [roomId],
            )
          ).rows[0].n,
        ) >= 12
      )
        fail(409, "此房间的 Agent 席位已满。");
      const p = (
        await db.query(
          `insert into participants(room_id,type,display_name,avatar_url,status) values($1,'agent',$2,$3,'left') returning id`,
          [roomId, n.agent_name, n.avatar_url],
        )
      ).rows[0];
      await db.query(
        "insert into agent_seats(participant_id,node_id) values($1,$2)",
        [p.id, n.id],
      );
      if (!n.active_seat_id)
        await db.query(
          "update agent_nodes set active_seat_id=$2,session_id=null,last_seen_at=null,ready_until=null where id=$1",
          [n.id, p.id],
        );
      await this.emit(db, roomId, "agent.pairing.requested", null, p.id);
      return { ok: true, participant_id: p.id };
    });
  },
  async selectAgentRoom(userId, input) {
    const d = z
      .object({
        node_id: id,
        participant_id: id,
        fresh_context: z.literal(true),
      })
      .strict()
      .parse(input);
    return this.transaction(async (db) => {
      const target = (
        await db.query(
          "select p.room_id from agent_seats s join participants p on p.id=s.participant_id where s.participant_id=$1 and s.node_id=$2 and s.deleted_at is null",
          [d.participant_id, d.node_id],
        )
      ).rows[0];
      if (!target) fail(404, "房间授权不存在。");
      await this.ownedNode(db, userId, d.node_id);
      const n = await this.lockNodeRooms(db, d.node_id);
      await this.room(db, target.room_id, userId, { write: true });
      if (
        n.revoked_at ||
        !n.platform_scope ||
        new Date(n.expires_at) <= new Date()
      )
        fail(403, "设备不能切换房间。");
      if (
        (
          await db.query(
            `select 1 from agent_turns j join agent_seats s on s.participant_id=j.participant_id where s.node_id=$1 and j.status in ('leased','awaiting_review')`,
            [n.id],
          )
        ).rowCount
      )
        fail(409, "请先完成或取消当前任务及待审核发送，再切换房间。");
      const s = (
        await db.query("select * from agent_seats where participant_id=$1", [
          d.participant_id,
        ])
      ).rows[0];
      if (s.state !== "approved" || s.muted)
        fail(403, "请先让房间主持人批准并取消静音。");
      // One device, one active consumer, one room context. Old MCP receipts are invalidated.
      await db.query(
        "update agent_nodes set active_seat_id=$2,session_id=null,last_seen_at=null,ready_until=null,connection_client_id=null where id=$1",
        [n.id, d.participant_id],
      );
      await db.query(
        "update participants p set last_active_at=null from agent_seats s where s.node_id=$1 and p.id=s.participant_id",
        [n.id],
      );
      return { ok: true, reconnect: true };
    });
  },
  async revokeMyAgent(userId, nodeId) {
    return this.transaction(async (db) => {
      await this.ownedNode(db, userId, nodeId);
      return this.revokeDevice(db, nodeId, "设备所有者撤销设备");
    });
  },
  async revokeDevice(db, nodeId, reason) {
    const n = await this.lockNodeRooms(db, nodeId);
    const targets = (
      await db.query(
        "select s.participant_id,p.room_id from agent_seats s join participants p on p.id=s.participant_id where s.node_id=$1 order by p.room_id",
        [nodeId],
      )
    ).rows;
    if (n.revoked_at) return { ok: true, already_revoked: true };
    await db.query(
      "update agent_nodes set revoked_at=now(),session_id=null,last_seen_at=null,ready_until=null where id=$1",
      [nodeId],
    );
    for (const t of targets) {
      await db.query(
        "update agent_seats set state='revoked' where participant_id=$1",
        [t.participant_id],
      );
      await db.query(
        "update participants set status='left',last_active_at=null where id=$1",
        [t.participant_id],
      );
      await db.query(
        "update agent_turns set status='cancelled',lease_hash=null,error=$2 where participant_id=$1 and status in ('queued','leased','awaiting_review')",
        [t.participant_id, reason],
      );
      await db.query(
        "update rooms set agent_host_participant_id=null where id=$1 and agent_host_participant_id=$2",
        [t.room_id, t.participant_id],
      );
      await this.pauseAffected(db, t.room_id, t.participant_id, reason);
      await this.emit(
        db,
        t.room_id,
        "agent.seat.updated",
        null,
        t.participant_id,
      );
    }
    await db.query(
      "update agent_private_reviews set status='rejected',payload_cipher='' where node_id=$1 and status='pending'",
      [nodeId],
    );
    return { ok: true };
  },
  async invitationAction(userId, input) {
    const d = z
      .object({ id: id, action: z.enum(["revoke", "delete", "regenerate"]) })
      .strict()
      .parse(input);
    let development;
    await this.transaction(async (db) => {
      await this.owner(db, userId);
      const p = (
        await db.query(
          "select * from agent_pairings where id=$1 and owner_user_id=$2 and deleted_at is null for update",
          [d.id, userId],
        )
      ).rows[0];
      if (!p) fail(404, "邀请不存在。");
      if (d.action !== "delete" && p.used_at)
        fail(409, "此邀请已使用；如需断开请撤销设备。");
      development = p.development;
      await db.query(
        `update agent_pairings set revoked_at=coalesce(revoked_at,now()),code_cipher=null,doc_cipher=null${d.action === "delete" ? ",deleted_at=now()" : ""} where id=$1`,
        [p.id],
      );
    });
    if (d.action === "regenerate")
      return this.createPairing(userId, undefined, { development });
    return { ok: true };
  },
  async proposeArtifact(token, turnId, lease, input, sessionId) {
    const d = z
      .object({
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        size: z.number().int().positive(),
        paths: z.array(z.string().max(240)).max(500),
      })
      .strict()
      .parse(input);
    for (const p of d.paths) {
      safePath(p);
      if (privateFile(p) || privacyFindings(p).length)
        fail(400, "成果包含私有文件或真实路径，不能发送。");
    }
    return this.transaction(async (db) => {
      const { job, n } = await this.activeJob(db, token, turnId, lease, {
        sessionId,
      });
      if (job.kind !== "develop") fail(403, "当前未授权开发成果。");
      const policy = await this.policy(db),
        manual = policy.force_file_review || n.file_review,
        status = manual ? "pending" : "approved";
      if (d.size > policy.artifact_mb * 1048576)
        fail(413, "成果超过平台大小限制。");
      const old = (
        await db.query(
          "select * from agent_private_reviews where turn_id=$1 and kind='artifact'",
          [job.id],
        )
      ).rows[0];
      if (old) {
        if (old.payload_hash !== d.sha256)
          fail(409, "成果已变化，请取消本轮并重新提交审批。");
        return {
          review_id: old.id,
          status: old.status,
          approval_mode: old.approval_mode,
        };
      }
      const reviewId = randomUUID();
      await db.query(
        "insert into agent_private_reviews(id,owner_user_id,node_id,turn_id,kind,payload_cipher,payload_hash,expires_at,status,approval_mode) values($1,$2,$3,$4,'artifact',$5,$6,$7,$8,$9)",
        [
          reviewId,
          n.owner_user_id,
          n.id,
          job.id,
          await this.vault.seal(d, `review:${reviewId}`),
          d.sha256,
          job.hard_deadline,
          status,
          manual ? "manual" : "auto",
        ],
      );
      return {
        review_id: reviewId,
        status,
        approval_mode: manual ? "manual" : "auto",
      };
    });
  },
  async artifactPermit(token, turnId, lease, sessionId) {
    return this.transaction(async (db) => {
      const { job } = await this.activeJob(db, token, turnId, lease, {
        sessionId,
      });
      const r = (
        await db.query(
          "select id,status from agent_private_reviews where turn_id=$1 and kind='artifact' and expires_at>now()",
          [job.id],
        )
      ).rows[0];
      return r || { status: "missing" };
    });
  },
  async stageResult(db, n, job, result) {
    if (privacyFindings(result).length)
      fail(400, "发送护栏发现凭据、本机路径或私网信息，请在本机脱敏后再提交。");
    const policy = await this.policy(db);
    const unstructured =
      result.message ||
      result.summary ||
      result.plan.length ||
      result.speakers.length ||
      result.checks.length;
    if (
      !unstructured ||
      (!policy.force_review && n.privacy_mode === "filtered")
    )
      return null;
    const previous = (
      await db.query(
        "select id from agent_private_reviews where turn_id=$1 and kind='result'",
        [job.id],
      )
    ).rows[0];
    if (previous)
      return {
        ok: true,
        pending_review: true,
        review_id: previous.id,
        duplicate: true,
      };
    const reviewId = randomUUID(),
      cipher = await this.vault.seal(result, `review:${reviewId}`);
    await db.query(
      "insert into agent_private_reviews(id,owner_user_id,node_id,turn_id,kind,payload_cipher,payload_hash) values($1,$2,$3,$4,'result',$5,$6)",
      [
        reviewId,
        n.owner_user_id,
        n.id,
        job.id,
        cipher,
        digest(JSON.stringify(result)),
      ],
    );
    await db.query(
      "update agent_turns set status='awaiting_review',result=null where id=$1",
      [job.id],
    );
    return { ok: true, pending_review: true, review_id: reviewId };
  },
  async reviewPrivate(userId, input) {
    const d = z
      .object({
        id: id,
        approve: z.boolean(),
        result: turnResultSchema.optional(),
      })
      .strict()
      .parse(input);
    return this.transaction(async (db) => {
      await this.owner(db, userId);
      const meta = (
        await db.query(
          `select r.*,j.room_id,j.participant_id from agent_private_reviews r join agent_turns j on j.id=r.turn_id where r.id=$1 and r.owner_user_id=$2`,
          [d.id, userId],
        )
      ).rows[0];
      if (!meta) fail(404, "待审核发送不存在或不属于你。");
      await this.room(db, meta.room_id, userId, { write: d.approve });
      const r = (
        await db.query(
          "select * from agent_private_reviews where id=$1 for update",
          [meta.id],
        )
      ).rows[0];
      if (r.status !== "pending") return { ok: true, duplicate: true };
      const n = await this.ownedNode(db, userId, r.node_id),
        job = (
          await db.query("select * from agent_turns where id=$1 for update", [
            r.turn_id,
          ])
        ).rows[0];
      if (!d.approve) {
        await db.query(
          "update agent_private_reviews set status='rejected',payload_cipher='' where id=$1",
          [r.id],
        );
        await db.query(
          "update agent_turns set status='cancelled',lease_hash=null where id=$1 and status in ('leased','awaiting_review')",
          [job.id],
        );
        if (job.session_id)
          await this.pause(
            db,
            (
              await db.query(
                "select * from collaboration_sessions where id=$1",
                [job.session_id],
              )
            ).rows[0],
            "设备所有者拒绝了发送。",
          );
        return { ok: true };
      }
      if (
        n.revoked_at ||
        new Date(n.expires_at) <= new Date() ||
        new Date(r.expires_at) <= new Date()
      )
        fail(409, "设备或本次审核已过期。");
      const seat = await this.nodeSeat(db, n, { write: true });
      if (
        seat.participant_id !== job.participant_id ||
        (r.kind === "result"
          ? job.status !== "awaiting_review"
          : job.status !== "leased" ||
            new Date(job.lease_until) <= new Date() ||
            new Date(job.hard_deadline) <= new Date())
      )
        fail(409, "任务或房间授权已变化，不能放行。");
      if (job.session_id) {
        const s = (
          await db.query(
            "select * from collaboration_sessions where id=$1 for update",
            [job.session_id],
          )
        ).rows[0];
        if (
          !s ||
          ["paused", "stopped", "completed"].includes(s.stage) ||
          s.host_participant_id !== seat.room.agent_host_participant_id
        )
          fail(409, "当前协作已停止或主持人已变化。");
      }
      if (r.kind === "result") {
        const original = await this.vault.open(
            r.payload_cipher,
            `review:${r.id}`,
          ),
          result = d.result ? turnResultSchema.parse(d.result) : original;
        if (privacyFindings(result).length)
          fail(400, "仍含有敏感信息，请脱敏后确认。");
        await this.publishResult(db, seat, job, result);
      } else if (d.result) fail(400, "文件授权不能修改为消息授权。");
      await db.query(
        "update agent_private_reviews set status='approved',payload_cipher=case when kind='result' then '' else payload_cipher end where id=$1",
        [r.id],
      );
      return { ok: true };
    });
  },
  async verifyAvatar(db, userId, url) {
    if (!url) return;
    const match = /^\/api\/avatars\/([a-f0-9-]{36})$/.exec(url);
    if (
      !match ||
      (
        await db.query(
          "select 1 from avatar_assets where id=$1 and owner_user_id=$2",
          [id.parse(match[1]), userId],
        )
      ).rowCount !== 1
    )
      fail(400, "请上传并使用自己的站内头像。");
  },
  async adminPolicy(adminId, input) {
    return this.transaction(async (db) => {
      const role = (
        await db.query(
          "select role from admin_members where user_id=$1 and effective_status($1)<>'banned'",
          [id.parse(adminId)],
        )
      ).rows[0]?.role;
      if (!["super", "technical"].includes(role))
        fail(403, "需要超级或技术管理员权限。");
      if (input !== undefined) {
        const d = z
            .object({
              value: policySchema,
              reason: z.string().trim().min(3).max(200),
            })
            .strict()
            .parse(input),
          before = await this.policy(db);
        await db.query(
          "update agent_security_policy set value=$1,updated_at=now() where id=true",
          [JSON.stringify(d.value)],
        );
        await db.query(
          "insert into admin_audit_logs(admin_id,action,target_type,reason,before,after,trace_id) values($1,'agent.policy','agent_policy',$2,$3,$4,$5)",
          [
            adminId,
            d.reason,
            JSON.stringify(before),
            JSON.stringify(d.value),
            randomUUID(),
          ],
        );
      }
      const counts = (
        await db.query(
          "select kind,status,count(*)::int count from agent_private_reviews group by kind,status",
        )
      ).rows;
      return { policy: await this.policy(db), counts };
    });
  },
};

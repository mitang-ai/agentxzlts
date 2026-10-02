import "server-only";
import { pool, AppError, type Identity } from "./server";
import { settings } from "./control";
import { z } from "zod";
export type Filters = {
  q: string;
  status: string;
  from: string | null;
  to: string | null;
  page: number;
  limit: number;
  room: string | null;
  actor: string | null;
  entity: string | null;
  eventType: string;
  after: number | null;
};
export function filters(url: URL): Filters {
  const p = url.searchParams;
  const date = (k: string) => {
    const v = p.get(k);
    return v ? z.iso.datetime({ offset: true }).parse(v) : null;
  };
  const id = (k: string) => (p.get(k) ? z.uuid().parse(p.get(k)) : null);
  return {
    room: id("room_id"),
    actor: id("actor_id"),
    entity: id("entity_id"),
    eventType: (p.get("event_type") || "").slice(0, 80),
    after: p.has("after")
      ? z.coerce.number().int().min(0).parse(p.get("after"))
      : null,
    q: (p.get("q") || "").slice(0, 150),
    status: (p.get("status") || "").slice(0, 40),
    from: date("from"),
    to: date("to"),
    page: z.coerce
      .number()
      .int()
      .min(1)
      .max(100000)
      .parse(p.get("page") || 1),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(1000)
      .parse(p.get("limit") || 20),
  };
}
async function list(sql: string, f: Filters, args: unknown[] = []) {
  const n = args.length;
  const rows = (
    await pool.query(
      `select *,count(*) over()::int total from (${sql}) source limit $${n + 1} offset $${n + 2}`,
      [...args, f.limit, (f.page - 1) * f.limit],
    )
  ).rows;
  return {
    items: rows.map(({ total, ...r }) => r),
    total: rows[0]?.total || 0,
    page: f.page,
    limit: f.limit,
  };
}
export async function overview(f: Filters) {
  const from = f.from || new Date(Date.now() - 30 * 86400000).toISOString();
  const to = f.to || new Date().toISOString();
  const totals = (
    await pool.query(
      `select (select count(*)::int from profiles) users,(select count(*)::int from profiles where last_active_at>=date_trunc('day',now())) active_users,(select count(*)::int from rooms where status<>'deleted') rooms,(select count(distinct room_id)::int from events where created_at between $1 and $2) active_rooms,(select count(*)::int from messages) messages,(select count(*)::int from tasks) tasks,(select coalesce(sum(size),0)::bigint from files where status<>'deleted') storage,(select count(*)::int from reports where status in ('pending','processing')) pending_reports,(select count(*)::int from files where status='quarantined') quarantined_files,(select count(*)::int from login_events where not success and created_at>=now()-interval '24 hours') failed_logins`,
      [from, to],
    )
  ).rows[0];
  const trends = (
    await pool.query(
      `select d::date::text as "day",(select count(*)::int from profiles where created_at>=d and created_at<d+interval '1 day') registrations,(select count(distinct room_id)::int from events where created_at>=d and created_at<d+interval '1 day') active_rooms from generate_series(date_trunc('day',$1::timestamptz),date_trunc('day',$2::timestamptz),interval '1 day') d order by d limit 366`,
      [from, to],
    )
  ).rows;
  const funnel = (
    await pool.query(
      `select count(*)::int registered,count(*) filter(where exists(select 1 from participants p where p.user_id=profiles.id))::int joined,count(*) filter(where exists(select 1 from messages m join participants p on p.id=m.sender_participant_id where p.user_id=profiles.id and m.type='text'))::int messaged,count(*) filter(where exists(select 1 from tasks t join participants p on p.id=t.creator_participant_id where p.user_id=profiles.id))::int tasked from profiles where created_at between $1 and $2`,
      [from, to],
    )
  ).rows[0];
  const risks = (
    await pool.query(
      `select r.id,r.name, (select count(*) from messages where room_id=r.id and created_at>now()-interval '1 hour')::int hourly_messages,(select count(*) from reports where room_id=r.id and status in ('pending','processing'))::int reports,(select count(*) from participants where room_id=r.id and joined_at>now()-interval '1 hour')::int new_members,(select coalesce(sum(size),0) from files where room_id=r.id and created_at>now()-interval '1 hour')::bigint hourly_bytes from rooms r where r.status<>'deleted' and ((select count(*) from messages where room_id=r.id and created_at>now()-interval '1 hour')>500 or (select count(*) from reports where room_id=r.id and status in ('pending','processing'))>=3 or (select count(*) from participants where room_id=r.id and joined_at>now()-interval '1 hour')>100 or (select coalesce(sum(size),0) from files where room_id=r.id and created_at>now()-interval '1 hour')>1073741824) limit 20`,
    )
  ).rows;
  const audit = (
    await pool.query(
      "select a.*,p.display_name admin_name from admin_audit_logs a left join profiles p on p.id=a.admin_id order by a.id desc limit 8",
    )
  ).rows;
  return {
    totals,
    trends,
    funnel,
    risks,
    audit,
    window: { from, to },
    metric_definition:
      "活跃用户：当天至少完成一次有效业务动作；活跃房间：窗口内产生业务 Event。风险阈值：每小时消息>500、加入>100、上传>1GB 或待处理举报≥3。",
  };
}
export async function adminList(module: string, f: Filters) {
  const args = [`%${f.q}%`, f.status, f.from, f.to];
  const time = (col: string) =>
    `($3::timestamptz is null or ${col}>=$3) and ($4::timestamptz is null or ${col}<=$4)`;
  if (module === "agents")
    return list(
      `select p.id,p.display_name,p.room_id,r.name room_name,s.state,s.muted,n.id node_id,n.name node_name,n.adapter,n.last_seen_at,n.expires_at,n.revoked_at,(n.revoked_at is null and n.expires_at>now() and n.session_id is not null and n.last_seen_at>now()-interval '45 seconds') online,owner.display_name owner_name,(select count(*)::int from agent_turns j where j.participant_id=p.id and j.status='leased') active_turns from agent_seats s join participants p on p.id=s.participant_id join agent_nodes n on n.id=s.node_id join rooms r on r.id=p.room_id join profiles owner on owner.id=n.owner_user_id where (p.display_name ilike $1 or n.name ilike $1 or r.name ilike $1) and ($2='' or s.state=$2) and ${time("n.created_at")} order by n.created_at desc`,
      f,
      args,
    );
  if (module === "users")
    return list(
      `select p.*,effective_status(p.id) effective_status,(select count(*)::int from participants where user_id=p.id and status='active') joined_rooms,(select count(*)::int from rooms where created_by=p.id and status<>'deleted') created_rooms,(select count(*)::int from messages m join participants a on a.id=m.sender_participant_id where a.user_id=p.id) message_count,(select coalesce(sum(size),0) from files f join participants a on a.id=f.uploader_participant_id where a.user_id=p.id and f.status<>'deleted') storage_bytes,am.role admin_role from profiles p left join admin_members am on am.user_id=p.id where (p.email ilike $1 or p.display_name ilike $1 or p.id::text ilike $1) and ($2='' or effective_status(p.id)=$2) and ${time("p.created_at")} order by p.created_at desc`,
      f,
      args,
    );
  if (module === "rooms")
    return list(
      `select r.*,p.display_name host_name,(select count(*)::int from participants where room_id=r.id and status='active') members,(select count(*)::int from messages where room_id=r.id) message_count,(select count(*)::int from tasks where room_id=r.id) task_count,(select coalesce(sum(size),0) from files where room_id=r.id and status<>'deleted') storage_bytes,(select max(created_at) from events where room_id=r.id) last_active_at from rooms r left join participants p on p.id=r.host_participant_id where (r.name ilike $1 or r.id::text ilike $1) and ($2='' or r.status=$2) and ${time("r.created_at")} order by r.created_at desc`,
      f,
      args,
    );
  if (module === "files")
    return list(
      `select f.*,p.display_name uploader_name,p.user_id,r.name room_name from files f join participants p on p.id=f.uploader_participant_id join rooms r on r.id=f.room_id where (f.name ilike $1 or p.display_name ilike $1 or f.id::text ilike $1 or r.name ilike $1) and ($2='' or f.status=$2) and ${time("f.created_at")} order by f.created_at desc`,
      f,
      args,
    );
  if (module === "invites")
    return list(
      `select i.id,i.room_id,i.expires_at,i.max_uses,i.used_count,i.revoked_at,i.created_at,left(i.token_hash,12) fingerprint,r.name room_name,p.display_name creator_name,case when i.revoked_at is not null then 'revoked' when i.expires_at<=now() then 'expired' when i.used_count>=i.max_uses then 'exhausted' else 'active' end status from room_invites i join rooms r on r.id=i.room_id join participants p on p.id=i.created_by where (r.name ilike $1 or i.id::text ilike $1) and ($2='' or case when i.revoked_at is not null then 'revoked' when i.expires_at<=now() then 'expired' when i.used_count>=i.max_uses then 'exhausted' else 'active' end=$2) and ${time("i.created_at")} order by i.created_at desc`,
      f,
      args,
    );
  if (module === "reports")
    return list(
      `select t.*,p.display_name reporter_name,r.name room_name from reports t left join profiles p on p.id=t.reporter_id left join rooms r on r.id=t.room_id where (t.reason ilike $1 or t.target_id::text ilike $1 or r.name ilike $1) and ($2='' or t.status=$2) and ${time("t.created_at")} order by case t.status when 'pending' then 0 when 'processing' then 1 else 2 end,t.created_at desc`,
      f,
      args,
    );
  if (module === "audit")
    return list(
      `select a.*,p.display_name admin_name from admin_audit_logs a left join profiles p on p.id=a.admin_id where (a.action ilike $1 or a.reason ilike $1 or a.target_id ilike $1 or p.display_name ilike $1) and ($2='' or a.result=$2) and ${time("a.created_at")} order by a.id desc`,
      f,
      args,
    );
  if (module === "events")
    return list(
      `select e.id,e.type,e.room_id,e.actor_participant_id,e.entity_id,e.created_at,e.payload,p.display_name actor_name,p.user_id from events e left join participants p on p.id=e.actor_participant_id where (e.type ilike $1 or e.room_id::text ilike $1 or e.entity_id::text ilike $1 or e.actor_participant_id::text ilike $1 or p.display_name ilike $1) and ($2='' or e.type=$2) and ${time("e.created_at")} and ($5::uuid is null or e.room_id=$5) and ($6::uuid is null or e.actor_participant_id=$6 or p.user_id=$6) and ($7::uuid is null or e.entity_id=$7) and ($8='' or e.type=$8) and ($9::bigint is null or e.id>$9) order by case when $9::bigint is not null then e.id end asc,e.id desc`,
      f,
      [...args, f.room, f.actor, f.entity, f.eventType, f.after],
    );
  if (module === "errors")
    return list(
      `select * from request_metrics where status>=400 and (path ilike $1 or trace_id::text ilike $1) and ($2='' or status::text=$2) and ${time("created_at")} order by id desc`,
      f,
      args,
    );
  if (module === "content") {
    if (!f.q) return { items: [], total: 0, page: f.page, limit: f.limit };
    const id = z.uuid().parse(f.q);
    return list(
      `select m.id,m.room_id,m.sender_participant_id,m.type,m.created_at,m.deleted_at,p.display_name sender_name,r.name room_name from messages m join rooms r on r.id=m.room_id left join participants p on p.id=m.sender_participant_id where m.id=$1 or m.room_id=$1 order by m.created_at desc`,
      f,
      [id],
    );
  }
  throw new AppError(404, "管理模块不存在");
}
export async function userDetail(id: string) {
  z.uuid().parse(id);
  const user = (
    await pool.query(
      "select p.*,effective_status(p.id) effective_status from profiles p where id=$1",
      [id],
    )
  ).rows[0];
  if (!user) throw new AppError(404, "用户不存在");
  const sessions = (
    await pool.query(
      "select id,user_id,created_at,last_active_at,expires_at,ip,user_agent from auth.local_sessions where user_id=$1 and expires_at>now() order by last_active_at desc",
      [id],
    )
  ).rows;
  const activity = (
    await pool.query(
      "select e.id,e.type,e.room_id,e.created_at from events e join participants p on p.id=e.actor_participant_id where p.user_id=$1 order by e.id desc limit 15",
      [id],
    )
  ).rows;
  const restrictions = (
    await pool.query(
      "select id,action,before,after,reason,created_at from admin_audit_logs where target_id=$1 and target_type='user' order by id desc limit 20",
      [id],
    )
  ).rows;
  const usage = (
    await pool.query(
      `select (select count(*)::int from participants where user_id=$1 and status='active') joined_rooms,(select count(*)::int from rooms where created_by=$1 and status<>'deleted') created_rooms,(select count(*)::int from messages m join participants p on p.id=m.sender_participant_id where p.user_id=$1) messages,(select count(*)::int from tasks t join participants p on p.id=t.creator_participant_id where p.user_id=$1) tasks,(select coalesce(sum(size),0) from files f join participants p on p.id=f.uploader_participant_id where p.user_id=$1 and f.status<>'deleted') file_bytes`,
      [id],
    )
  ).rows[0];
  return { user, sessions, activity, restrictions, usage };
}
export async function roomDetail(id: string) {
  z.uuid().parse(id);
  const room = (await pool.query("select * from rooms where id=$1", [id]))
    .rows[0];
  if (!room) throw new AppError(404, "房间不存在");
  return {
    room,
    participants: (
      await pool.query(
        "select * from participants where room_id=$1 order by joined_at",
        [id],
      )
    ).rows,
    tasks: (
      await pool.query(
        "select t.*,coalesce((select jsonb_agg(participant_id) from task_assignees where task_id=t.id),'[]') assignee_ids from tasks t where room_id=$1 order by created_at desc limit 100",
        [id],
      )
    ).rows,
    files: (
      await pool.query(
        "select * from files where room_id=$1 order by created_at desc limit 100",
        [id],
      )
    ).rows,
  };
}
export async function operationData() {
  return {
    settings: await settings(),
    flags: (await pool.query("select * from feature_flags order by key")).rows,
    announcements: (
      await pool.query("select * from announcements order by created_at desc")
    ).rows,
  };
}
export async function securityData(user: Identity & { role: string }) {
  return {
    sessions:
      user.role === "technical"
        ? []
        : (
            await pool.query(
              "select s.id,s.user_id,s.created_at,s.last_active_at,s.expires_at,s.ip,s.user_agent,p.display_name,p.email from auth.local_sessions s join profiles p on p.id=s.user_id where s.expires_at>now() order by s.last_active_at desc limit 100",
            )
          ).rows,
    logins: (
      await pool.query(
        "select l.*,p.display_name from login_events l left join profiles p on p.id=l.user_id order by l.id desc limit 100",
      )
    ).rows,
    ip_rules:
      user.role === "operations"
        ? []
        : (await pool.query("select * from ip_rules order by created_at desc"))
            .rows,
    admins:
      user.role === "super"
        ? (
            await pool.query(
              "select m.*,p.display_name,p.email from admin_members m join profiles p on p.id=m.user_id",
            )
          ).rows
        : [],
    trust_proxy: process.env.TRUST_PROXY === "true",
    two_factor:
      "建议在生产部署的身份网关启用管理员 2FA；本应用当前采用密码与敏感操作二次确认。",
  };
}
export async function systemData() {
  const started = performance.now();
  await pool.query("select 1");
  const latency = +(performance.now() - started).toFixed(1);
  const metrics = (
    await pool.query(
      `select count(*)::int requests,coalesce(percentile_cont(0.95) within group(order by duration_ms),0)::int p95,count(*) filter(where status>=500)::int errors,coalesce(sum(bytes),0)::bigint measured_bytes from request_metrics where created_at>now()-interval '24 hours'`,
    )
  ).rows[0];
  const realtime = (
    await pool.query(
      `select (select count(*)::int from realtime_connections where last_seen_at>now()-interval '30 seconds') connections,(select count(distinct room_id)::int from realtime_connections where last_seen_at>now()-interval '30 seconds') rooms,(select count(*)::int from events where created_at>now()-interval '1 minute') events_per_minute,(select count(*)::int from participants where status='active' and last_active_at>now()-interval '60 seconds') presence,(select count(*)::int from realtime_stream_log where opened_at>now()-interval '24 hours') stream_opens_24h,(select count(*)::int from realtime_stream_log where opened_at>now()-interval '24 hours' and recovered_cursor) recovered_streams`,
    )
  ).rows[0];
  const capacity = (
    await pool.query(
      `select pg_database_size(current_database()) database_bytes,(select coalesce(sum(size),0) from files where status<>'deleted') stored_bytes,(select count(*)::int from storage.objects o where not exists(select 1 from files f where f.storage_path=o.name)) orphan_objects,(select count(*)::int from auth.local_sessions where expires_at<=now()) expired_sessions,(select count(*)::int from room_invites where expires_at<=now() or revoked_at is not null) expired_invites,(select count(*)::int from storage_cleanup_jobs) pending_cleanup,(select count(*)::int from pg_stat_activity where datname=current_database()) database_connections`,
    )
  ).rows[0];
  const auth = (
    await pool.query(
      `select count(*) filter(where success)::int success,count(*) filter(where not success)::int failed from login_events where created_at>now()-interval '24 hours'`,
    )
  ).rows[0];
  const storageOK = await import("node:fs/promises").then(async (fs) => {
    const path = await import("node:path");
    try {
      await fs.mkdir(
        path.resolve(
          /* turbopackIgnore: true */ process.env.STORAGE_DIR ||
            "../../.data/files",
        ),
        { recursive: true },
      );
      await fs.access(
        path.resolve(
          /* turbopackIgnore: true */ process.env.STORAGE_DIR ||
            "../../.data/files",
        ),
        6,
      );
      return true;
    } catch {
      return false;
    }
  });
  return {
    health: [
      { name: "Web", status: "normal", detail: "服务端管理接口已响应" },
      { name: "Database", status: "normal", detail: `查询 ${latency} ms` },
      {
        name: "Realtime",
        status: "normal",
        detail: "PostgreSQL LISTEN/NOTIFY + SSE；5 秒事件游标补偿",
      },
      {
        name: "Storage",
        status: process.env.SUPABASE_URL
          ? "unverified"
          : storageOK
            ? "normal"
            : "error",
        detail: process.env.SUPABASE_URL
          ? "外部对象存储需目标服务验证"
          : "私有文件目录可读写",
      },
      { name: "Auth", status: "normal", detail: "服务端 HttpOnly Session" },
    ],
    metrics,
    realtime,
    capacity,
    auth,
    incidents: (
      await pool.query(
        "select * from system_incidents order by id desc limit 30",
      )
    ).rows,
    backup: process.env.BACKUP_STATUS_URL || null,
    bandwidth:
      "仅计量已记录的下载字节，不代表云平台计费带宽；请在基础设施查看账单。",
  };
}
export function toCSV(items: Record<string, unknown>[]) {
  if (!items.length) return "\uFEFF无数据\r\n";
  const keys = Object.keys(items[0]);
  const cell = (v: unknown) => {
    let s =
      v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
    if (/^[=+@\-\t\r]/.test(s)) s = "'" + s;
    return '"' + s.replaceAll('"', '""') + '"';
  };
  return (
    "\uFEFF" +
    [
      keys.map(cell).join(","),
      ...items.map((r) => keys.map((k) => cell(r[k])).join(",")),
    ].join("\r\n")
  );
}

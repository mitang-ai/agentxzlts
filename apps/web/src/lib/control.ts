import "server-only";
import { isIP } from "node:net";
import { pool, identity, AppError, type Identity } from "./server";
import { permissions, type AdminRole } from "./admin-policy";
export function requestIp(req: Request) {
  if (process.env.TRUST_PROXY !== "true") return null;
  const value = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return value && isIP(value) ? value : null;
}
export async function checkIp(req: Request) {
  const ip = requestIp(req);
  if (
    ip &&
    (
      await pool.query(
        "select 1 from ip_rules where $1::inet <<= network and (expires_at is null or expires_at>now())",
        [ip],
      )
    ).rowCount
  )
    throw new AppError(403, "此来源暂时无法访问");
}
export async function settings() {
  return Object.fromEntries(
    (await pool.query("select key,value from site_settings")).rows.map((r) => [
      r.key,
      r.value,
    ]),
  );
}
export async function capabilities(
  user: Identity | null,
  room: string | null = null,
) {
  const flags = (
    await pool.query(
      "select key,flag_enabled(key,$1,$2) enabled from feature_flags",
      [user?.id || null, room],
    )
  ).rows;
  const status = user
    ? (await pool.query("select effective_status($1) status", [user.id]))
        .rows[0].status
    : "normal";
  const f = Object.fromEntries(flags.map((r) => [r.key, r.enabled]));
  return {
    ...f,
    post: status !== "limited_post",
    create_room: f.create_room && status !== "limited_room",
    uploads: f.uploads && status !== "limited_upload",
  };
}
export async function adminIdentity(module = "overview") {
  const user = await identity();
  const role = (
    await pool.query("select role from admin_members where user_id=$1", [
      user.id,
    ])
  ).rows[0]?.role as AdminRole | undefined;
  if (!role) throw new AppError(403, "需要网站管理员权限");
  if (!permissions[module]?.includes(role))
    throw new AppError(403, "当前管理员角色无权访问此模块");
  return { ...user, role };
}
export async function publicSite(after: number) {
  let user: Identity | null = null;
  try {
    user = await identity();
  } catch (e) {
    if (!(e instanceof AppError && e.status === 401)) throw e;
  }
  const config = await settings();
  const role = user
    ? (
        await pool.query("select role from admin_members where user_id=$1", [
          user.id,
        ])
      ).rows[0]?.role
    : null;
  const announcements = config.operations.announcements
    ? (
        await pool.query(
          "select * from announcements where enabled and starts_at<=now() and (ends_at is null or ends_at>now()) and position in ('all',$1) order by starts_at desc",
          [user ? "app" : "public"],
        )
      ).rows
    : [];
  const cursor = Number(
    (await pool.query("select coalesce(max(id),0) cursor from control_events"))
      .rows[0].cursor,
  );
  const events = (
    await pool.query(
      "select id,type,entity_id,payload from control_events where id>$1 and id<=$3 and (target_user_id=$2 or (target_user_id is null and type in ('settings.updated','flags.updated','announcements.updated'))) order by id limit 100",
      [after, user?.id || null, cursor],
    )
  ).rows;
  return {
    config,
    capabilities: await capabilities(user),
    announcements,
    user: user ? { ...user, admin_role: role } : null,
    cursor: events.length === 100 ? Number(events.at(-1).id) : cursor,
    events,
  };
}
export async function recordMetric(
  req: Request,
  status: number,
  started: number,
  trace: string,
  userId: string | null = null,
  bytes = 0,
) {
  await pool
    .query(
      "insert into request_metrics(path,method,status,duration_ms,trace_id,user_id,bytes) values($1,$2,$3,$4,$5,$6,$7)",
      [
        new URL(req.url).pathname,
        req.method,
        status,
        Math.round(performance.now() - started),
        trace,
        userId,
        bytes,
      ],
    )
    .catch(() => {});
  if (status >= 500)
    await pool
      .query(
        "insert into system_incidents(service,status,message) select 'Web','error',$1 where not exists(select 1 from system_incidents where message=$1 and created_at>now()-interval '1 minute')",
        [`${new URL(req.url).pathname} · HTTP ${status} · Trace ${trace}`],
      )
      .catch(() => {});
}
export async function loginEvent(
  req: Request,
  email: string,
  success: boolean,
  userId: string | null = null,
) {
  await pool.query(
    "insert into login_events(user_id,email,success,ip,user_agent) values($1,$2,$3,$4,$5)",
    [
      userId,
      email,
      success,
      requestIp(req),
      (req.headers.get("user-agent") || "").slice(0, 300),
    ],
  );
}

import pg from "pg";
import { randomUUID } from "node:crypto";
const email = process.argv[2]?.trim().toLowerCase();
if (!email)
  throw new Error(
    "先在网站注册，然后运行 npm run admin:init -- your@email.com",
  );
const pool = new pg.Pool({
  connectionString:
    process.env.DATABASE_URL ||
    "postgresql://island:local-development-only@127.0.0.1:55432/postgres",
});
const db = await pool.connect();
try {
  await db.query("begin");
  await db.query("select pg_advisory_xact_lock(91820261001)");
  if ((await db.query("select 1 from admin_members")).rowCount)
    throw new Error("管理员已初始化，请通过现有超级管理员在后台授予角色。");
  const user = (
    await db.query(
      "select id from profiles where lower(email)=$1 and status='normal'",
      [email],
    )
  ).rows[0];
  if (!user) throw new Error("该邮箱尚未注册，或账号状态异常。");
  await db.query("insert into admin_members(user_id,role) values($1,'super')", [
    user.id,
  ]);
  await db.query(
    "insert into admin_audit_logs(admin_id,action,target_type,target_id,reason,trace_id) values($1::uuid,'bootstrap_admin','administrator',$1::uuid::text,'服务器操作员初始化首位超级管理员',$2)",
    [user.id, randomUUID()],
  );
  await db.query("select control_emit('admin.updated',$1::uuid,$1::uuid::text)", [user.id]);
  await db.query("commit");
  console.log(
    "超级管理员已初始化。使用该账号登录 /admin；没有内置或默认管理员密码。",
  );
} catch (e) {
  await db.query("rollback");
  throw e;
} finally {
  db.release();
  await pool.end();
}

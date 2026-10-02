import type { Pool } from "pg";
import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { passwordHash } from "@island/runtime/password";
import { AgentError } from "@island/agents";

export async function generateUser(
  pool: Pool,
  adminId: string,
  input: unknown,
  meta: { ip: string | null; trace: string },
) {
  const { request_id } = z
    .object({ request_id: z.uuid() })
    .strict()
    .parse(input);
  const db = await pool.connect();
  try {
    await db.query("begin");
    const admin = (
      await db.query(
        "select role from admin_members where user_id=$1 and effective_status($1)<>'banned' for share",
        [z.uuid().parse(adminId)],
      )
    ).rows[0];
    if (!admin || !["super", "operations"].includes(admin.role))
      throw new AgentError(403, "需要超级或运营管理员权限。");
    // 请求幂等和管理员配额同时串行，双击/重试不能生成额外账号。
    await db.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
      "admin-create:" + adminId,
    ]);
    const previous = (
      await db.query(
        "select c.admin_id,p.id,p.email,p.display_name from admin_user_creations c join profiles p on p.id=c.user_id where c.request_id=$1",
        [request_id],
      )
    ).rows[0];
    if (previous) {
      if (previous.admin_id !== adminId)
        throw new AgentError(409, "此请求不属于当前管理员。");
      await db.query("commit");
      const { admin_id, ...user } = previous;
      return {
        user,
        password: null,
        created: false,
        message: "此请求已创建用户，密码仅在首次成功时显示，请从原结果保存。",
      };
    }
    const count = Number(
      (
        await db.query(
          "select count(*) n from admin_user_creations where admin_id=$1 and created_at>now()-interval '24 hours'",
          [adminId],
        )
      ).rows[0].n,
    );
    if (count >= 100)
      throw new AgentError(429, "每位管理员每天最多生成 100 个用户。");
    const id = randomUUID(),
      email = "member-" + id.replaceAll("-", "") + "@accounts.invalid";
    const display_name = "新用户 " + id.slice(0, 8),
      password = randomBytes(24).toString("base64url");
    await db.query(
      "insert into auth.users(id,email,raw_user_meta_data) values($1,$2,$3)",
      [id, email, JSON.stringify({ display_name })],
    );
    await db.query(
      "insert into auth.local_credentials(user_id,password_hash) values($1,$2)",
      [id, passwordHash(password)],
    );
    await db.query(
      "insert into admin_user_creations(request_id,admin_id,user_id) values($1,$2,$3)",
      [request_id, adminId, id],
    );
    const audit = (
      await db.query(
        "insert into admin_audit_logs(admin_id,action,target_type,target_id,reason,\"after\",ip,trace_id) values($1,'user.generate','user',$2,'管理员一键生成普通用户',$3,$4,$5) returning id",
        [
          adminId,
          id,
          JSON.stringify({ email, display_name, role: "user" }),
          meta.ip,
          meta.trace,
        ],
      )
    ).rows[0];
    await db.query("commit");
    return {
      user: { id, email, display_name },
      password,
      created: true,
      audit_id: audit.id,
    };
  } catch (error) {
    await db.query("rollback");
    throw error;
  } finally {
    db.release();
  }
}

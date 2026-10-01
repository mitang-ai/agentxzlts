import { randomUUID } from "node:crypto";
import {
  passwordHash,
  verifyPassword,
} from "../../packages/runtime/password.mjs";
export async function provision(config, input) {
  const { default: pg } = await import("pg");
  const { z } = await import("zod");
  const p = new pg.Pool({
    connectionString: config.env.DATABASE_URL,
    connectionTimeoutMillis: 5000,
  });
  let db;
  try {
    db = await p.connect();
    await db.query("begin");
    await db.query("select pg_advisory_xact_lock(91820261001)");
    const installation = (
      await db.query(
        "select * from app_installation where singleton for update",
      )
    ).rows[0];
    if (installation && installation.id !== config.installationId)
      throw Error("数据库已有安装身份，请重新检测并使用该数据库的安装配置。");
    if (installation?.phase === "complete" && input.operation !== "upgrade")
      throw Error("网站已安装，请使用升级流程；不会再次创建管理员。");
    const admins = Number(
      (await db.query("select count(*) n from admin_members")).rows[0].n,
    );
    let userId = null;
    if (!admins) {
      const parsed = z
        .object({
          email: z.email().max(254),
          password: z.string().min(8).max(128),
          nickname: z.string().trim().min(1).max(40),
        })
        .safeParse({
          ...input.admin,
          email: input.admin?.email?.trim().toLowerCase(),
        });
      if (!parsed.success)
        throw Error(
          "请填写管理员昵称、有效邮箱和密码；新账号至少 12 位，已有账号使用原密码。",
        );
      const a = parsed.data;
      const email = a.email;
      const user = (
        await db.query(
          "select p.id,p.status,c.password_hash from profiles p left join auth.local_credentials c on c.user_id=p.id where lower(p.email)=$1",
          [email],
        )
      ).rows[0];
      if (user) {
        if (
          user.status !== "normal" ||
          !verifyPassword(a.password, user.password_hash)
        )
          throw Error(
            "该邮箱已经注册，请填写原账号密码以授权，或使用新的管理员邮箱。",
          );
        userId = user.id;
      } else {
        if (a.password.length < 12) throw Error("新管理员密码须为 12–128 位。");
        userId = randomUUID();
        await db.query(
          "insert into auth.users(id,email,raw_user_meta_data) values($1,$2,$3)",
          [userId, email, JSON.stringify({ display_name: a.nickname.trim() })],
        );
        await db.query(
          "insert into auth.local_credentials(user_id,password_hash) values($1,$2)",
          [userId, passwordHash(a.password)],
        );
      }
      await db.query(
        "insert into admin_members(user_id,role) values($1,'super')",
        [userId],
      );
      await db.query(
        "insert into admin_audit_logs(admin_id,action,target_type,target_id,reason,trace_id) values($1::uuid,'bootstrap_admin','administrator',$1::uuid::text,'机器所有者通过安装向导初始化首位超级管理员',$2)",
        [userId, randomUUID()],
      );
      await db.query(
        "select control_emit('admin.updated',$1::uuid,$1::uuid::text)",
        [userId],
      );
    }
    if (
      input.updateBrand ||
      (!installation && input.operation !== "upgrade" && !input.preserveBrand)
    ) {
      const name = String(input.siteName || "").trim();
      if (!name || name.length > 60) throw Error("网站名称须为 1–60 个字符。");
      await db.query(
        "update site_settings set value=jsonb_set(value,'{name}',to_jsonb($1::text)),updated_at=now() where key='brand'",
        [name],
      );
      await db.query(
        "update site_settings set value=jsonb_set(value,'{title}',to_jsonb($1::text)),updated_at=now() where key='information'",
        [name + " · 一起把想法做成"],
      );
      await db.query("select control_emit('settings.updated',null,'brand')");
    }
    await db.query(
      "insert into app_installation(singleton,id,phase) values(true,$1,'provisioned') on conflict(singleton) do update set updated_at=now()",
      [config.installationId],
    );
    await db.query(
      "insert into admin_audit_logs(admin_id,action,target_type,target_id,reason,trace_id) values($1,'installation.provision','installation',$2,$3,$4)",
      [
        userId,
        config.installationId,
        input.operation === "upgrade"
          ? "机器所有者执行保留账号与业务数据的升级"
          : "机器所有者安装网站",
        randomUUID(),
      ],
    );
    await db.query("commit");
    return { createdAdmin: Boolean(userId), userId };
  } catch (e) {
    if (db) await db.query("rollback").catch(() => {});
    throw e;
  } finally {
    db?.release();
    await p.end();
  }
}
export async function finishInstallation(config) {
  const { default: pg } = await import("pg");
  const p = new pg.Pool({ connectionString: config.env.DATABASE_URL });
  try {
    await p.query(
      "update app_installation set phase='complete',completed_at=coalesce(completed_at,now()),updated_at=now() where id=$1",
      [config.installationId],
    );
  } finally {
    await p.end();
  }
}

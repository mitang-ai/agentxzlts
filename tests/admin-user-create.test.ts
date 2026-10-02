import { beforeAll, afterAll, it, expect } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { generateUser } from "../apps/web/src/lib/admin-user-create";
import { verifyPassword } from "../packages/runtime/password.mjs";
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const users = Array.from({ length: 4 }, () => randomUUID());
const generated: string[] = [];
const meta = () => ({ ip: "127.0.0.1", trace: randomUUID() });
beforeAll(async () => {
  for (const id of users)
    await pool.query(
      "insert into auth.users(id,email,raw_user_meta_data) values($1,$2,$3)",
      [
        id,
        id + "@admin-create.invalid",
        JSON.stringify({ display_name: "创建验收" }),
      ],
    );
  await pool.query(
    "insert into admin_members(user_id,role) values($1,'super'),($2,'operations'),($3,'technical')",
    users.slice(0, 3),
  );
});
afterAll(async () => {
  await pool.query(
    "delete from admin_audit_logs where admin_id=any($1::uuid[])",
    [users],
  );
  await pool.query("delete from auth.users where id=any($1::uuid[])", [
    [...users, ...generated],
  ]);
  await pool.end();
});
it("超级和运营管理员一键生成普通用户，密码只存哈希、无额外权限与会话", async () => {
  for (const admin of users.slice(0, 2)) {
    const result = await generateUser(
      pool,
      admin,
      { request_id: randomUUID() },
      meta(),
    );
    generated.push(result.user.id);
    expect(result.password!.length).toBeGreaterThanOrEqual(32);
    const stored = (
      await pool.query(
        "select password_hash from auth.local_credentials where user_id=$1",
        [result.user.id],
      )
    ).rows[0];
    expect(verifyPassword(result.password!, stored.password_hash)).toBe(true);
    expect(stored.password_hash).not.toContain(result.password!);
    expect(
      (
        await pool.query("select * from admin_members where user_id=$1", [
          result.user.id,
        ])
      ).rowCount,
    ).toBe(0);
    expect(
      (
        await pool.query("select * from auth.local_sessions where user_id=$1", [
          result.user.id,
        ])
      ).rowCount,
    ).toBe(0);
    const audit = (
      await pool.query("select * from admin_audit_logs where id=$1", [
        result.audit_id,
      ])
    ).rows[0];
    expect(audit.action).toBe("user.generate");
    expect(JSON.stringify(audit)).not.toContain(result.password!);
  }
});
it("普通用户/技术管理员无权创建，同请求并发只创建一次且不回显密码", async () => {
  for (const admin of users.slice(2))
    await expect(
      generateUser(pool, admin, { request_id: randomUUID() }, meta()),
    ).rejects.toMatchObject({ status: 403 });
  const request_id = randomUUID();
  const results = await Promise.all([
    generateUser(pool, users[0], { request_id }, meta()),
    generateUser(pool, users[0], { request_id }, meta()),
  ]);
  generated.push(results[0].user.id);
  expect(results[0].user.id).toBe(results[1].user.id);
  expect(results.filter((r) => r.password)).toHaveLength(1);
  await expect(
    generateUser(pool, users[1], { request_id }, meta()),
  ).rejects.toMatchObject({ status: 409 });
  await expect(
    generateUser(
      pool,
      users[0],
      { request_id: randomUUID(), role: "super" },
      meta(),
    ),
  ).rejects.toThrow();
});

import "server-only";
import { Pool, type PoolClient } from "pg";
import { cookies } from "next/headers";
import { createHash, randomBytes } from "node:crypto";
import { createStorage } from "@island/runtime/storage";
import { applyRuntimeConfig } from "@island/runtime";
import { passwordHash, verifyPassword } from "@island/runtime/password";
export { passwordHash, verifyPassword };
applyRuntimeConfig();
const globals = globalThis as unknown as {
  islandPool?: Pool;
  islandPoolErrorBound?: boolean;
};
export const pool = (globals.islandPool ??= new Pool({
  connectionString:
    process.env.DATABASE_URL ||
    "postgresql://island:local-development-only@127.0.0.1:55432/postgres",
  max: 15,
}));
if (!globals.islandPoolErrorBound) {
  // 数据库重启时丢失的空闲连接由连接池重建，不让它变成未处理异常。
  pool.on("error", () => console.error("Database idle connection lost"));
  globals.islandPoolErrorBound = true;
}
export const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export class AppError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export type Identity = {
  id: string;
  email: string;
  display_name: string;
  avatar_url: string | null;
  status?: string;
  restricted_until?: string | null;
};
export async function identity(): Promise<Identity> {
  const jar = await cookies();
  const token = jar.get("island_session")?.value;
  if (!token) throw new AppError(401, "请先登录");
  const { rows } = await pool.query(
    "select p.*,effective_status(p.id) status from auth.local_sessions s join profiles p on p.id=s.user_id where token_hash=$1 and expires_at>now() and effective_status(p.id)<>'banned'",
    [hash(token)],
  );
  if (!rows[0]) throw new AppError(401, "登录已过期，请重新登录");
  await pool.query(
    "update auth.local_sessions set last_active_at=now() where token_hash=$1 and last_active_at<now()-interval '1 minute'",
    [hash(token)],
  );
  return rows[0];
}
export async function setSession(
  userId: string,
  meta?: { ip: string | null; userAgent: string },
) {
  const token = randomBytes(32).toString("hex");
  await pool.query("delete from auth.local_sessions where expires_at<now();");
  await pool.query(
    "insert into auth.local_sessions(token_hash,user_id,expires_at,ip,user_agent) values($1,$2,now()+interval '30 days',$3,$4)",
    [
      hash(token),
      userId,
      meta?.ip || null,
      meta?.userAgent.slice(0, 300) || null,
    ],
  );
  const jar = await cookies();
  jar.set("island_session", token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.APP_ORIGIN?.startsWith("https://") || false,
    path: "/",
    maxAge: 30 * 86400,
  });
}
export async function userQuery<T>(
  user: Identity,
  fn: (db: PoolClient) => Promise<T>,
  snapshot = false,
): Promise<T> {
  const db = await pool.connect();
  try {
    await db.query(
      snapshot ? "begin isolation level repeatable read read only" : "begin",
    );
    await db.query("select set_config('request.jwt.claim.sub',$1,true)", [
      user.id,
    ]);
    await db.query("set local role authenticated");
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
export async function command(user: Identity, command: string, data: unknown) {
  return userQuery(
    user,
    async (db) =>
      (
        await db.query("select island_command($1,$2::jsonb) as result", [
          command,
          JSON.stringify(data),
        ])
      ).rows[0].result,
  );
}
export async function ensureRoom(user: Identity, id: string) {
  const member = await userQuery(
    user,
    async (db) =>
      (await db.query("select id from rooms where id=$1", [id])).rows[0],
  );
  if (!member) throw new AppError(403, "你没有访问这个房间的权限");
}
export const fileStorage = createStorage(pool);
export const { storeFile, loadFile, removeFile } = fileStorage;
// 检查魔数，避免用扩展名或浏览器声明的 MIME 伪装可执行内容。
export function validContent(bytes: Buffer, mime: string) {
  if (mime === "image/png")
    return bytes
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mime === "image/jpeg") return bytes[0] === 255 && bytes[1] === 216;
  if (mime === "image/gif")
    return bytes.subarray(0, 6).toString().startsWith("GIF8");
  if (mime === "image/webp")
    return (
      bytes.subarray(0, 4).toString() === "RIFF" &&
      bytes.subarray(8, 12).toString() === "WEBP"
    );
  if (mime === "application/pdf")
    return bytes.subarray(0, 5).toString() === "%PDF-";
  if (mime === "application/zip" || mime.includes("openxmlformats"))
    return bytes.subarray(0, 2).toString() === "PK";
  return !bytes.includes(0) && !bytes.subarray(0, 2).equals(Buffer.from("MZ"));
}

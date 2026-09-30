import pg from "pg";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
export async function migrate(connectionString) {
  const pool = new pg.Pool({ connectionString });
  const db = await pool.connect();
  try {
    await db.query("select pg_advisory_lock(91820260930)");
    await db.query(await readFile(resolve("database/bootstrap.sql"), "utf8"));
    await db.query(
      "create table if not exists public.island_migrations(name text primary key,checksum text not null,applied_at timestamptz not null default now())",
    );
    const files = (await readdir("supabase/migrations"))
      .filter((f) => f.endsWith(".sql"))
      .sort();
    for (const file of files) {
      const original = await readFile(
        resolve("supabase/migrations", file),
        "utf8",
      );
      const checksum = createHash("sha256").update(original).digest("hex");
      const { rows } = await db.query(
        "select checksum from island_migrations where name=$1",
        [file],
      );
      if (rows.length) {
        if (rows[0].checksum !== checksum)
          throw new Error(
            `Migration ${file} changed after applying; create a new migration instead.`,
          );
        continue;
      }
      const hasRealtime = (
        await db.query(
          "select 1 from pg_publication where pubname='supabase_realtime'",
        )
      ).rowCount;
      const sql = hasRealtime
        ? original
        : original.replace(
            /alter publication supabase_realtime add table public\.(events|participants);/g,
            "",
          );
      await db.query("begin");
      try {
        await db.query(sql);
        await db.query(
          "insert into island_migrations(name,checksum) values($1,$2)",
          [file, checksum],
        );
        await db.query("commit");
        console.log(`Applied ${file}`);
      } catch (e) {
        await db.query("rollback");
        throw e;
      }
    }
    await db.query(
      "grant usage on schema public,auth to authenticated;grant select on profiles,rooms,participants,messages,tasks,task_assignees,task_files,message_reactions,files,events,room_invites to authenticated;",
    );
  } finally {
    await db.query("select pg_advisory_unlock(91820260930)").catch(() => {});
    db.release();
    await pool.end();
  }
}
if (process.argv[1] === new URL(import.meta.url).pathname) {
  if (!process.env.DATABASE_URL)
    throw new Error("Set DATABASE_URL for the target PostgreSQL database");
  await migrate(process.env.DATABASE_URL);
}

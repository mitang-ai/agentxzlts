import { access, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
export async function startEmbedded(config) {
  if (config.mode !== "embedded") return null;
  if (process.getuid?.() === 0)
    throw Error(
      "内置 PostgreSQL 不能以 root 运行，请使用普通账号或已有数据库。",
    );
  const { default: EmbeddedPostgres } = await import("embedded-postgres");
  const env = config.env;
  const server = new EmbeddedPostgres({
    databaseDir: env.PG_DATA_DIR,
    user: env.PG_USER,
    password: env.PG_PASSWORD,
    port: Number(env.PG_PORT),
    persistent: true,
    createPostgresUser: false,
    onLog: () => {},
    onError: () => {},
  });
  await mkdir(env.PG_DATA_DIR, { recursive: true, mode: 0o700 });
  try {
    await access(resolve(env.PG_DATA_DIR, "PG_VERSION"));
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
    await server.initialise();
  }
  await server.start();
  return server;
}

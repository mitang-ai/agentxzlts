import EmbeddedPostgres from "embedded-postgres";
import { mkdir, access } from "node:fs/promises";
import { resolve } from "node:path";
import { migrate } from "./migrate.mjs";
const root = process.cwd();
const data = process.env.PG_DATA_DIR || resolve(root, ".data/postgres");
const port = Number(process.env.PG_PORT || 55432);
const server = new EmbeddedPostgres({
  databaseDir: data,
  user: "island",
  password: "local-development-only",
  port,
  persistent: true,
  createPostgresUser: false,
  onLog: (message) => {
    if (/ERROR|FATAL/.test(message)) console.error(message);
  },
  onError: console.error,
});
await mkdir(resolve(root, ".data"), { recursive: true });
try {
  await access(resolve(data, "PG_VERSION"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  await server.initialise();
}
await server.start();

try {
  await migrate(
    process.env.DATABASE_URL ||
      `postgresql://island:local-development-only@127.0.0.1:${port}/postgres`,
  );
  console.log(
    `PostgreSQL ready on 127.0.0.1:${port}. Persistent data: ${data}`,
  );
} catch (e) {
  console.error(e);
  await server.stop();
  process.exitCode = 1;
}
if (!process.exitCode) {
  let shuttingDown = false;
  const stop = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await server.stop();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  setInterval(() => {}, 60_000);
}

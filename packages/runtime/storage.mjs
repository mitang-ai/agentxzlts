import { resolve } from "node:path";
import { mkdir, writeFile, readFile, unlink } from "node:fs/promises";
export function createStorage(pool, env = process.env) {
  let remote;
  const client = async () => {
    if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return null;
    if (!remote) {
      const { createClient } = await import("@supabase/supabase-js");
      remote = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false },
      });
    }
    return remote;
  };
  const root = () =>
    resolve(/* turbopackIgnore: true */ env.STORAGE_DIR || "../../.data/files");
  const pathFor = (path) => {
    if (!/^[a-f0-9-]{36}\/[a-f0-9-]{36}$/.test(path))
      throw Error("私有文件路径无效。");
    return resolve(root(), path);
  };
  return {
    privacyRoot: resolve(root(), ".privacy"),
    async storeFile(path, bytes, type, db = pool) {
      const s = await client();
      if (s) {
        const { error } = await s.storage
          .from("room-files")
          .upload(path, bytes, { contentType: type });
        if (error) throw error;
      } else {
        const full = pathFor(path);
        await mkdir(resolve(full, ".."), { recursive: true });
        await writeFile(full, bytes, { flag: "wx" });
        await db.query(
          "insert into storage.objects(bucket_id,name,metadata) values('room-files',$1,$2) on conflict(name) do nothing",
          [path, JSON.stringify({ mimetype: type, size: bytes.length })],
        );
      }
    },
    async loadFile(path) {
      const s = await client();
      if (s) {
        const { data, error } = await s.storage
          .from("room-files")
          .download(path);
        if (error) throw error;
        return Buffer.from(await data.arrayBuffer());
      }
      return readFile(/* turbopackIgnore: true */ pathFor(path));
    },
    async removeFile(path, db = pool) {
      const s = await client();
      if (s) {
        const { error } = await s.storage.from("room-files").remove([path]);
        if (error) throw error;
      } else
        await unlink(pathFor(path)).catch((e) => {
          if (e.code !== "ENOENT") throw e;
        });
      await db.query("delete from storage.objects where name=$1", [path]);
      await db.query("delete from storage_cleanup_jobs where path=$1", [path]);
    },
  };
}

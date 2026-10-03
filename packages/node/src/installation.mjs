import {
  mkdir,
  lstat,
  unlink,
  rmdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

// 依赖未安装时不能依赖 proper-lockfile；单独的短安装锁保护同一安装目录的 npm ci。
export async function installationLock(root, { timeout = 60000 } = {}) {
  const parent = resolve(root, ".data"),
    dir = resolve(parent, "dependency-setup.lock"),
    owner = resolve(dir, "owner.json");
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const nonce = randomUUID(),
    until = Date.now() + timeout;
  while (true) {
    try {
      await mkdir(dir, { mode: 0o700 });
      await writeFile(owner, JSON.stringify({ pid: process.pid, nonce }), {
        mode: 0o600,
        flag: "wx",
      });
      return async () => {
        const current = JSON.parse(await readFile(owner, "utf8"));
        if (current.nonce !== nonce) throw Error("依赖安装锁已替换。");
        await unlink(owner);
        await rmdir(dir);
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if ((await lstat(dir)).isSymbolicLink())
        throw Error("安装锁不能是符号链接。");
      // 仅清理已经退出的安装进程留下的锁，不删除依赖、配置或活进程持有的锁。
      try {
        const text = await readFile(owner, "utf8"),
          old = JSON.parse(text);
        if (Number.isInteger(old.pid) && old.pid > 0) {
          try {
            process.kill(old.pid, 0);
          } catch (e) {
            if (
              e.code === "ESRCH" &&
              (await readFile(owner, "utf8")) === text
            ) {
              await unlink(owner);
              await rmdir(dir);
              continue;
            }
          }
        }
      } catch (e) {
        if (!["ENOENT", "ENOTEMPTY"].includes(e.code)) throw e;
      }
      if (Date.now() >= until)
        throw Error(
          "另一个安装进程仍在准备依赖；本次停止，保留原配置，不并发 npm ci。",
        );
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

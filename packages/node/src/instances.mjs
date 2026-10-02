import lockfile from "proper-lockfile";
import { resolve, dirname, basename } from "node:path";
import { realpath } from "node:fs/promises";
import { protectDirectory } from "./io.mjs";

// 跨进程原子锁：阻止重复配对、改写配置和重复执行；心跳使崩溃后的锁可恢复。
export async function acquireInstance(file, onCompromised = () => {}) {
  await protectDirectory(dirname(file));
  const canonical = resolve(await realpath(dirname(file)), basename(file));
  const release = await lockfile.lock(canonical, {
    realpath: false,
    stale: 30000,
    update: 10000,
    retries: 0,
    onCompromised,
  });
  return { file: canonical, release };
}

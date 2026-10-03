import { mkdir, lstat, realpath, writeFile, readFile } from "node:fs/promises";
import { resolve, relative, isAbsolute, dirname } from "node:path";
import { safePath, digest } from "../../agents/archive.mjs";

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export function checkTaskIdentity(job) {
  if (!uuid.test(job.id) || !uuid.test(job.room_id))
    throw Error("房间或任务标识无效，不能创建工作目录。");
}
export async function taskWorkspace(root, job, { legacy = false } = {}) {
  // 先校验再 mkdir，避免异常房间/任务 ID 在隔离检查之前制造越界目录。
  checkTaskIdentity(job);
  root = await realpath(root);
  let directory = root;
  // 不跟随中间目录的 symlink/junction；这仍不是抵御同一 OS 用户的操作系统沙箱。
  for (const segment of legacy
    ? [".island-work", job.id]
    : [".island-work", "rooms", job.room_id, "tasks", job.id]) {
    directory = resolve(directory, segment);
    try {
      await mkdir(directory, { mode: 0o700 });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const info = await lstat(directory),
      canonical = await realpath(directory),
      path = relative(root, canonical);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      path.startsWith("..") ||
      isAbsolute(path)
    )
      throw Error("工作目录包含越界链接或不是隔离目录，已停止。");
  }
  return directory;
}
export async function materializeFile(directory, path, bytes) {
  path = safePath(path);
  let parent = directory;
  for (const segment of path.split("/").slice(0, -1)) {
    parent = resolve(parent, segment);
    try {
      await mkdir(parent, { mode: 0o700 });
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
    const info = await lstat(parent);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw Error("文件路径包含链接，不能写入。");
  }
  const full = resolve(directory, path);
  try {
    await writeFile(full, bytes, { flag: "wx", mode: 0o600 });
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
    const info = await lstat(full);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      digest(await readFile(full)) !== digest(bytes)
    )
      throw Error("已有文件不是原始内容或包含链接，保留现场并停止。");
  }
  return full;
}

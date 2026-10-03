import { readdir, lstat, realpath, rename, rmdir, rm } from "node:fs/promises";
import { resolve, dirname, basename, relative, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { readJSON, protectDirectory } from "./io.mjs";
import { runtimeStatus } from "./runtime.mjs";
import { acquireInstance } from "./instances.mjs";
import { installationLock } from "./installation.mjs";
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export async function inventoryClients(
  root = resolve(homedir(), ".island-node/clients"),
) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
  const clients = [];
  for (const entry of entries.slice(0, 100)) {
    if (!entry.isDirectory() || !uuid.test(entry.name)) continue;
    const file = resolve(
      root,
      entry.name,
      ".data/connections",
      entry.name,
      "config.json",
    );
    try {
      if (
        (await lstat(file)).isSymbolicLink() ||
        (await realpath(file)) !== file
      )
        throw Error("配置路径包含链接，保留现场");
      const config = await readJSON(file);
      if (!config) continue;
      const status = await runtimeStatus(file);
      clients.push({
        installation: entry.name,
        node_id: config.node_id || null,
        agent: config.agent_name,
        adapter: config.adapter,
        managed: Boolean(status?.running),
        connected: Boolean(status?.connected),
        config_file: file,
        advice: status?.running
          ? "复用原配置；stop 精确停止"
          : "旧版或未运行；先检查原管理脚本，不按 PID 杀进程；离线后可 archive 归档",
      });
    } catch {
      clients.push({
        installation: entry.name,
        error: "配置不可读，保留目录，人工检查",
      });
    }
  }
  return clients;
}
async function installation(root) {
  if (
    (await readJSON(resolve(root, "package.json")))?.name !==
    "island-node-client"
  )
    throw Error("仅允许管理下载的独立客户端安装，不能清理项目仓库或其它软件。");
  if ((await lstat(root)).isSymbolicLink())
    throw Error("不能归档或清理链接形式的安装目录。");
  return realpath(root);
}
export async function cleanClientCache(root, { confirm = false } = {}) {
  root = await installation(root);
  const cache = resolve(root, ".data/npm-cache");
  let info;
  try {
    info = await lstat(cache);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  if (!info) return { changed: false, cache_present: false };
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (await realpath(cache)) !== cache
  )
    throw Error("缓存不是安装目录内的普通目录，拒绝清理。");
  if (!confirm)
    return {
      changed: false,
      cache_present: true,
      action:
        "仅清理本安装的 npm 下载缓存；加 --confirm 执行，配置/依赖/工作成果不动",
    };
  const release = await installationLock(root);
  try {
    // 最终绝对目标已核验在当前客户端安装目录内，绝不清理用户全局 npm 缓存。
    await rm(cache, { recursive: true, force: true });
    return { changed: true, cache_present: false };
  } finally {
    await release();
  }
}
export async function archiveClient(root, file, { confirm = false } = {}) {
  root = await installation(root);
  if (
    !uuid.test(basename(root)) ||
    basename(dirname(root)) !== "clients" ||
    basename(dirname(dirname(root))) !== ".island-node"
  )
    throw Error(
      "归档仅限 .island-node/clients/<安装 UUID>，不能移动其它目录。",
    );
  const canonicalConfig = resolve(
    await realpath(dirname(file)),
    basename(file),
  );
  if ((await lstat(file)).isSymbolicLink())
    throw Error("不能归档链接形式的配置文件。");
  if (
    canonicalConfig !==
    resolve(root, ".data/connections", basename(root), "config.json")
  )
    throw Error("配置不属于此安装的固定身份，拒绝移动。");
  const configs = await readdir(resolve(root, ".data/connections"));
  if (configs.some((name) => name !== basename(root)))
    throw Error("安装内包含其它身份，请分别检查，不能整目录归档。");
  if ((await runtimeStatus(file))?.running)
    throw Error("请先 stop 停止此客户端，再归档；不移动运行中的安装。");
  const lease = await acquireInstance(file);
  let destination,
    moved = false;
  try {
    if (!confirm)
      return {
        changed: false,
        action:
          "此安装已获离线锁；加 --confirm 移入 archives，保留凭据和成果，不删除",
      };
    const parent = resolve(dirname(dirname(root)), "archives");
    try {
      if ((await lstat(parent)).isSymbolicLink())
        throw Error("归档目录包含链接，拒绝移动到其它位置。");
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    await protectDirectory(parent);
    if (
      (await lstat(parent)).isSymbolicLink() ||
      (await realpath(parent)) !== parent
    )
      throw Error("归档目录包含链接，拒绝移动到其它位置。");
    destination = resolve(
      await realpath(parent),
      basename(root) + "." + new Date().toISOString().replace(/[:.]/g, "-"),
    );
    const scope = relative(await realpath(parent), destination);
    if (isAbsolute(scope) || scope.startsWith(".."))
      throw Error("归档目标越界。");
    // 单一 rename，不递归删除；失败时原安装保持原样。父目录已验证是此安装的归档目录。
    await rename(root, destination);
    moved = true;
    return {
      changed: true,
      archive: destination,
      restore:
        "停止同身份所有进程后，将此目录移回原 clients 路径；服务端授权未修改",
    };
  } finally {
    await lease.release().catch((e) => {
      if (!moved) throw e;
    });
    if (moved)
      await rmdir(
        resolve(
          destination,
          ".data/connections",
          basename(root),
          "config.json.lock",
        ),
      ).catch((e) => {
        if (e.code !== "ENOENT") throw e;
      });
  }
}

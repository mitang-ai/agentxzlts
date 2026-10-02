import { mkdir, writeFile, rename, readFile, chmod } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
export const configPath = () =>
  resolve(process.env.ISLAND_NODE_CONFIG || ".data/island-node/config.json");
export function codeConfigPath(code, server = "") {
  const key = createHash("sha256")
    .update(server + "\n" + code)
    .digest("hex");
  return resolve(".data/connections", key, "config.json");
}
export const codeHash = (code) =>
  createHash("sha256").update(code).digest("hex");
export async function readJSON(path, fallback = null) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return fallback;
    throw Error("本地 Node 配置无法读取，请检查文件。");
  }
}
const protectedDirectories = new Set();
export async function protectDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (protectedDirectories.has(directory)) return;
  if (process.platform === "win32") {
    const { stdout } = await promisify(execFile)("whoami.exe", [
      "/user",
      "/fo",
      "csv",
      "/nh",
    ]);
    const sid = /S-1-5-[0-9-]+/.exec(stdout)?.[0];
    if (!sid) throw Error("无法确认本机用户权限。");
    await promisify(execFile)(
      "icacls.exe",
      [
        directory,
        "/inheritance:r",
        "/grant:r",
        `*${sid}:(OI)(CI)F`,
        "*S-1-5-18:(OI)(CI)F",
      ],
      { windowsHide: true },
    );
  } else await chmod(directory, 0o700);
  protectedDirectories.add(directory);
}
export async function writeJSON(path, data) {
  await protectDirectory(dirname(path));
  const temp = path + "." + randomUUID() + ".tmp";
  await writeFile(temp, JSON.stringify(data, null, 2) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
  await rename(temp, path);
  await chmod(path, 0o600);
}
export function serverURL(value) {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw Error("请输入不带路径的完整协作岛网站地址。");
  if (
    url.protocol !== "https:" &&
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  )
    throw Error("异地连接必须使用 HTTPS 网站地址。");
  return url.origin;
}

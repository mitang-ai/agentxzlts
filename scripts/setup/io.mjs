import {
  mkdir,
  writeFile,
  rename,
  chmod,
  readFile,
  unlink,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { configPath, repositoryRoot } from "../../packages/runtime/config.mjs";
export const paths = () => {
  const root = repositoryRoot(),
    config = configPath(root),
    directory = dirname(config);
  if (directory === root || directory === dirname(directory))
    throw Error(
      "安装配置须放在独立私有目录，例如 .data/installation/config.json。",
    );
  return {
    root,
    config,
    directory,
    state: resolve(directory, "state.json"),
    session: resolve(directory, "setup-session.json"),
    lock: resolve(directory, "setup.lock"),
    runtime: resolve(directory, "runtime.json"),
    runtimeLock: resolve(directory, "runtime.lock"),
    logs: resolve(directory, "logs"),
  };
};
const protectedDirectories = new Map();
export async function protectDirectory(directory) {
  if (protectedDirectories.has(directory))
    return protectedDirectories.get(directory);
  const task = (async () => {
    if (process.platform !== "win32") {
      await chmod(directory, 0o700);
      return;
    }
    const exec = promisify(execFile),
      { stdout } = await exec("whoami.exe", ["/user", "/fo", "csv", "/nh"]);
    const sid = /S-1-5-[0-9-]+/.exec(stdout)?.[0];
    if (!sid) throw Error("无法验证当前 Windows 用户，请检查目录权限。");
    const q = (s) => "'" + s.replaceAll("'", "''") + "'";
    const command =
      "$ErrorActionPreference='Stop';$acl=New-Object System.Security.AccessControl.DirectorySecurity;$acl.SetAccessRuleProtection($true,$false);" +
      [sid, "S-1-5-18"]
        .map(
          (id) =>
            "$rule=New-Object System.Security.AccessControl.FileSystemAccessRule(" +
            q(id) +
            ",'FullControl','ContainerInherit,ObjectInherit','None','Allow');$acl.AddAccessRule($rule);",
        )
        .join("") +
      "Set-Acl -LiteralPath " +
      q(directory) +
      " -AclObject $acl";
    await exec("powershell.exe", [
      "-NoProfile",
      "-EncodedCommand",
      Buffer.from(command, "utf16le").toString("base64"),
    ]);
  })();
  protectedDirectories.set(directory, task);
  try {
    await task;
  } catch (e) {
    protectedDirectories.delete(directory);
    throw e;
  }
}
export async function atomicJSON(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await protectDirectory(dirname(path));
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, JSON.stringify(value, null, 2) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
    await rename(temp, path);
    await chmod(path, 0o600);
  } finally {
    await unlink(temp).catch(() => {});
  }
}
export async function readJSON(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return null;
    if (e instanceof SyntaxError)
      throw Error("安装状态文件无法解析，请检查文件或恢复备份。");
    throw e;
  }
}
export function cleanError(error, secrets = []) {
  const messages = {
    EACCES: "目录或服务权限不足，请选择可写目录或使用具备权限的运行账号。",
    ENOSPC: "磁盘空间不足，请释放空间后重试。",
    EADDRINUSE: "端口已被占用，请选择其他端口。",
    ECONNREFUSED: "连接被拒绝，请检查数据库或网站服务是否启动。",
    ENOTFOUND: "无法解析服务地址，请检查主机名。",
    "28P01": "数据库账号或密码不正确。",
    28000: "数据库拒绝认证，请检查账号和访问规则。",
    42501: "数据库权限不足，需要迁移所需的 Schema、角色、函数及授权权限。",
    "3D000": "数据库不存在，请填写已有专用数据库或启用创建数据库。",
    "42P04": "同名数据库已经存在，请重新检测。",
    23505: "该账号或对象已存在，请使用原账号或更换名称。",
  };
  let text =
    messages[error?.code] || String(error?.message || error || "操作失败");
  text = text
    .replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, "[数据库连接]")
    .replace(/https?:\/\/[^\s/@]+:[^\s/@]+@/gi, "[受保护连接]@");
  for (const secret of secrets
    .filter(Boolean)
    .sort((a, b) => b.length - a.length))
    text = text.split(secret).join("[已隐藏]");
  return text.slice(0, 600);
}

export async function acquireProcessLock(path) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await protectDirectory(dirname(path));
  const nonce = randomUUID();
  const create = () =>
    writeFile(path, JSON.stringify({ pid: process.pid, nonce }), {
      flag: "wx",
      mode: 0o600,
    });
  try {
    await create();
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
    const previous = await readJSON(path);
    try {
      process.kill(previous.pid, 0);
      throw Error("此配置已有启动进程，请等待或停止原进程。");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
    await unlink(path);
    await create();
  }
  return async () => {
    const current = await readJSON(path);
    if (current?.nonce === nonce) await unlink(path).catch(() => {});
  };
}

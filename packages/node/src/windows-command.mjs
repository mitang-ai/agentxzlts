import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname, isAbsolute } from "node:path";

// where.exe 也返回 Unix npm shim（无扩展名），不能把它交给 Windows CreateProcess。
export function selectWindowsExecutable(paths) {
  return paths
    .map((p) => p.trim())
    .find((p) => /\.(exe|cmd|mjs|cjs|js)$/i.test(p));
}
export function windowsLaunch(
  command,
  args,
  {
    find = (name) => {
      const result = spawnSync("where.exe", [name], {
        encoding: "utf8",
        windowsHide: true,
      });
      return result.status === 0 ? result.stdout.split(/\r?\n/) : [];
    },
    exists = existsSync,
    read = (file) => readFileSync(file, "utf8"),
    node = process.execPath,
  } = {},
) {
  let executable = isAbsolute(command)
    ? command
    : selectWindowsExecutable(find(command));
  if (
    executable &&
    !/\.[a-z0-9]+$/i.test(executable) &&
    exists(executable + ".cmd")
  )
    executable += ".cmd";
  if (!executable || !exists(executable))
    throw Error(
      "本机未找到所选 Agent 的 Windows 可执行入口，请指定真实 .exe 或 npm .cmd 路径。",
    );
  if (/\.cmd$/i.test(executable)) {
    // 忽略 npm shim 中探测用的 node.exe 分支，只接受真正传递 %* 参数的入口。
    const match = read(executable).match(
      /"%[~]?dp0%?\\([^"\r\n]+\.(?:m?js|cjs|exe))"\s+%\*/i,
    );
    const entry =
      match && resolve(dirname(executable), match[1].replaceAll("\\", "/"));
    if (!entry || !exists(entry))
      throw Error(
        "无法识别此 Windows 包装命令，请填写真实 .exe 或 JavaScript 入口。",
      );
    executable = entry;
  }
  if (/\.(m?js|cjs)$/i.test(executable))
    return { command: node, args: [resolve(executable), ...args] };
  if (!/\.exe$/i.test(executable))
    throw Error(
      "不能执行 Unix shim 或任意批处理，请填写真实 .exe 或标准 npm 入口。",
    );
  return { command: executable, args };
}

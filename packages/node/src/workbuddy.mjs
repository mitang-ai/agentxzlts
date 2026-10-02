import { stat } from "node:fs/promises";
import { resolve } from "node:path";

// 用户明确选择后才使用 WorkBuddy 自带的 CodeBuddy，不搜索/回退到其它 Agent。
export async function workBuddyACP({
  localAppData = process.env.LOCALAPPDATA,
  platform = process.platform,
} = {}) {
  if (platform !== "win32" || !localAppData)
    throw Error(
      "自动定位 WorkBuddy 引擎仅支持 Windows；其它系统请显式填写 CodeBuddy 的 --command 和 --args。",
    );
  const cli = resolve(
    localAppData,
    "Programs/WorkBuddy/resources/app.asar.unpacked/cli/bin/codebuddy",
  );
  try {
    if (!(await stat(cli)).isFile()) throw Error("not a file");
  } catch {
    throw Error(
      "未找到 WorkBuddy 自带引擎，请确认已安装，或显式填写当前产品的 ACP 程序。不会回退到 Codex。",
    );
  }
  return {
    command: process.execPath,
    args: [cli, "--acp"],
    host_name: "WorkBuddy",
  };
}

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { loadRuntimeConfig, configPath } from "../packages/runtime/config.mjs";
import { cleanError } from "./setup/io.mjs";
const exec = promisify(execFile);
const xml = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[c],
  );
const systemd = (s) =>
  '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%") + '"';
export async function installService(
  config = loadRuntimeConfig().saved,
  { output, dryRun = false } = {},
) {
  if (!config) throw Error("请先完成安装配置。");
  const root = loadRuntimeConfig().root,
    node = process.execPath,
    file = configPath(root),
    name = "island-" + config.installationId,
    runner = resolve(root, "scripts/serve.mjs");
  for (const value of [root, node, file])
    if (/[\r\n\0]/.test(value)) throw Error("服务路径包含无效字符。");
  if (process.platform === "linux") {
    if (!dryRun)
      try {
        await exec("systemctl", ["--user", "show-environment"], {
          timeout: 5000,
        });
      } catch {
        throw Error(
          "当前账号没有可用的 systemd 用户服务，请取消自动启动或在用户会话中配置。",
        );
      }
    const directory = output || resolve(homedir(), ".config/systemd/user");
    await mkdir(directory, { recursive: true });
    const unit = resolve(directory, name + ".service");
    const contents = `[Unit]\nDescription=Xiezuodao collaboration service\nAfter=network-online.target\n\n[Service]\nType=simple\nWorkingDirectory=${systemd(root)}\nEnvironment=${systemd("ISLAND_ROOT=" + root)}\nEnvironment=${systemd("ISLAND_CONFIG_FILE=" + file)}\nExecStart=${systemd(node)} ${systemd(runner)}\nRestart=on-failure\nRestartSec=5\nTimeoutStopSec=25\nKillMode=control-group\n\n[Install]\nWantedBy=default.target\n`;
    await writeFile(unit, contents, { mode: 0o600 });
    if (!dryRun) {
      await exec("systemctl", ["--user", "daemon-reload"]);
      await exec("systemctl", ["--user", "enable", name + ".service"]);
    }
    return { platform: "linux", file: unit, name, scope: "user-login" };
  }
  if (process.platform === "darwin") {
    const directory = output || resolve(homedir(), "Library/LaunchAgents");
    await mkdir(directory, { recursive: true });
    const label = "ai.mitang." + name,
      filePath = resolve(directory, label + ".plist");
    const data = `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${xml(label)}</string><key>ProgramArguments</key><array><string>${xml(node)}</string><string>${xml(runner)}</string></array><key>WorkingDirectory</key><string>${xml(root)}</string><key>EnvironmentVariables</key><dict><key>ISLAND_ROOT</key><string>${xml(root)}</string><key>ISLAND_CONFIG_FILE</key><string>${xml(file)}</string></dict><key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict></dict></plist>`;
    await writeFile(filePath, data, { mode: 0o600 });
    return {
      platform: "darwin",
      file: filePath,
      name: label,
      scope: "user-login",
    };
  }
  if (process.platform === "win32") {
    const q = (s) => "'" + s.replaceAll("'", "''") + "'";
    const command = `$ErrorActionPreference='Stop';$a=New-ScheduledTaskAction -Execute ${q(node)} -Argument ${q('"' + runner + '"')} -WorkingDirectory ${q(root)};$t=New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME;Register-ScheduledTask -TaskName ${q(name)} -Action $a -Trigger $t -Description 'Xiezuodao collaboration service' -Force | Out-Null`;
    // Custom config must be retained by an installed wrapper, rather than relying on transient environment variables.
    const wrapper = resolve(
      output || resolve(root, ".data/installation"),
      name + ".cmd",
    );
    await mkdir(resolve(wrapper, ".."), { recursive: true });
    const cmd = `@echo off\r\nset "ISLAND_ROOT=${root}"\r\nset "ISLAND_CONFIG_FILE=${file}"\r\n"${node}" "${runner}"\r\n`;
    if (/["%&|<>^]/.test(root + file + node))
      throw Error(
        "自动启动路径含 Windows 命令特殊字符，请移动到普通目录后配置。",
      );
    await writeFile(wrapper, cmd, { mode: 0o600 });
    const task = command
      .replace(q(node), q("cmd.exe"))
      .replace(q('"' + runner + '"'), q('/c ""' + wrapper + '""'));
    if (!dryRun)
      await exec(
        "powershell.exe",
        [
          "-NoProfile",
          "-EncodedCommand",
          Buffer.from(task, "utf16le").toString("base64"),
        ],
        { timeout: 15000 },
      );
    return { platform: "win32", file: wrapper, name, scope: "user-login" };
  }
  throw Error("当前系统没有自动启动适配，请使用 npm run island:start。");
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const result = await installService(undefined, {
      dryRun: process.argv.includes("--dry-run"),
      output: process.env.ISLAND_SERVICE_DIR,
    });
    console.log("登录后自动启动配置：" + result.file);
  } catch (e) {
    console.error(cleanError(e));
    process.exitCode = 1;
  }
}

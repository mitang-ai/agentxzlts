#!/usr/bin/env node
import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { spawn } from "node:child_process";
import {
  configPath,
  codeConfigPath,
  codeHash,
  readJSON,
  writeJSON,
  serverURL,
} from "../src/io.mjs";
const args = process.argv.slice(2),
  command = args.shift() || "help";
const value = (key) => {
  const i = args.indexOf("--" + key);
  return i < 0 ? null : args[i + 1];
};
if (value("config")) process.env.ISLAND_NODE_CONFIG = resolve(value("config"));
else if (
  !process.env.ISLAND_NODE_CONFIG &&
  value("code") &&
  ["bootstrap", "pair"].includes(command)
)
  process.env.ISLAND_NODE_CONFIG = codeConfigPath(
    value("code"),
    value("server") || "",
  );
const file = configPath();
const nonInteractive = args.includes("--non-interactive");
async function prepare() {
  try {
    await import("ws");
    await import("proper-lockfile");
    return;
  } catch {}
  console.log("正在准备协作岛 Node 客户端依赖…");
  const npmCLI =
    process.platform === "win32"
      ? resolve(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js")
      : process.env.npm_execpath;
  const cmd = npmCLI ? process.execPath : "npm",
    parameters = [
      ...(npmCLI ? [npmCLI] : []),
      "ci",
      "--cache",
      resolve(".data/npm-cache"),
      "--no-audit",
      "--no-fund",
    ];
  await new Promise((yes, no) => {
    const child = spawn(cmd, parameters, {
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", no);
    child.once("exit", (code) =>
      code === 0 ? yes() : no(Error("Node 依赖准备失败。")),
    );
  });
}
async function init() {
  const existing = await readJSON(file, {});
  const rl = createInterface({ input: stdin, output: stdout });
  const ask = async (label, fallback) => {
    if (nonInteractive) return fallback || "";
    const answer = await rl.question(
      label + (fallback ? " [" + fallback + "]" : "") + "：",
    );
    return answer.trim() || fallback;
  };
  try {
    const server = serverURL(
      value("server") || (await ask("协作岛网站地址", existing.server || "")),
    );
    const adapter =
      value("adapter") ||
      (await ask(
        "本机 Agent 类型（codex/claude/opencode/acp/cli/a2a/http）",
        existing.adapter || "codex",
      ));
    if (
      !["codex", "claude", "opencode", "acp", "cli", "a2a", "http"].includes(
        adapter,
      )
    )
      throw Error("所选本机 Agent 类型无效。");
    const workspace = resolve(
      value("workspace") ||
        (await ask(
          "允许本地开发的工作目录",
          existing.workspace || resolve(dirname(file), "workspace"),
        )),
    );
    if (
      args.includes("--allow-development") &&
      args.includes("--no-development")
    )
      throw Error("不能同时允许和禁止本机开发。");
    const allow_development = args.includes("--no-development")
      ? false
      : args.includes("--allow-development") ||
        (!nonInteractive &&
          /^y(es)?$/i.test(
            await ask(
              "允许 Agent 在此目录下的隔离子目录开发？输入 yes 授权",
              existing.allow_development ? "yes" : "no",
            ),
          ));
    const config = {
      ...existing,
      server,
      workspace,
      adapter,
      allow_development,
      node_name:
        value("name") ||
        (await ask("设备名称", existing.node_name || "我的设备")),
      agent_name:
        value("agent-name") ||
        (await ask("房间里的 Agent 昵称", existing.agent_name || "我的 Agent")),
      fingerprint: existing.fingerprint || randomUUID(),
      checks: existing.checks || [],
    };
    if (["cli", "acp"].includes(adapter)) {
      config.command =
        value("command") ||
        (await ask("本机 Agent 程序路径", existing.command || ""));
      const raw =
        value("args") ||
        (await ask("程序参数 JSON 数组", JSON.stringify(existing.args || [])));
      config.args = JSON.parse(raw);
      if (
        !Array.isArray(config.args) ||
        config.args.some((a) => typeof a !== "string")
      )
        throw Error("程序参数必须是字符串数组。");
    }
    if (["http", "a2a"].includes(adapter))
      config.endpoint =
        value("endpoint") ||
        (await ask(
          "本机 Agent 服务地址",
          existing.endpoint || "http://127.0.0.1:8765",
        ));
    await mkdir(workspace, { recursive: true });
    const { createAdapter, runProcess } = await import("../src/adapters.mjs");
    if (allow_development) {
      try {
        await runProcess("git", ["--version"], { timeout: 10000 });
      } catch {
        throw Error(
          "本地开发需要 Git，请在此设备安装 Git 后重新配置，或只授权讨论。",
        );
      }
    }
    await createAdapter(config).discover();
    await writeJSON(file, config);
    console.log("本地授权与配置已保存，网站不会收到本机目录或模型凭据。");
    return config;
  } finally {
    rl.close();
  }
}
async function pair(config) {
  if (config.token && !args.includes("--re-pair"))
    throw Error(
      "此配置已配对，不能重复配对；新增 Agent 请使用独立配置，仅凭据失效时使用 pair --re-pair。",
    );
  const rl = createInterface({ input: stdin, output: stdout });
  let code = value("code");
  if (!code && nonInteractive) throw Error("非交互配对需要 --code 配对码。");
  try {
    code ||= (await rl.question("在房间“联机席位”取得的配对码：")).trim();
  } finally {
    rl.close();
  }
  const response = await fetch(config.server + "/api/agent-node/pair", {
    method: "POST",
    redirect: "error",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code,
      node_name: config.node_name,
      agent_name: config.agent_name,
      adapter: config.adapter,
      fingerprint: config.fingerprint,
      capabilities: {
        development: config.allow_development,
        workspace: !!config.workspace,
      },
    }),
  });
  const data = await response.json();
  if (!response.ok) throw Error(data.error || "设备配对失败。");
  const saved = { ...config, ...data, pairing_code_hash: codeHash(code) };
  delete saved.state;
  await writeJSON(file, saved);
  console.log("配对请求已发送，请让房间的人类管理者批准。");
  return saved;
}
async function start(config) {
  if (!config?.token) throw Error("请先运行 init 和 pair 完成本机配置与配对。");
  const { IslandNode } = await import("../src/client.mjs");
  const node = new IslandNode(config, { configFile: file, instanceLease });
  runningNode = node;
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () => node.stop());
  await node.start();
}
let instanceLease, runningNode;
function verifyExisting(config) {
  if (!config?.token) return;
  if (value("code") && config.pairing_code_hash !== codeHash(value("code")))
    throw Error(
      "此配置属于另一个已配对 Agent；请为新配对码省略 --config 自动隔离，或指定新的配置路径，不能覆盖已有身份。",
    );
  for (const key of ["server", "adapter", "workspace", "command", "endpoint"]) {
    const requested = value(key);
    if (
      requested &&
      (key === "workspace"
        ? resolve(requested)
        : key === "server"
          ? serverURL(requested)
          : requested) !== config[key]
    )
      throw Error(
        "已有 Agent 配置与本次参数不一致；请使用独立配置，不会自动修改正在使用的 Agent。",
      );
  }
  if (
    (args.includes("--allow-development") && !config.allow_development) ||
    (args.includes("--no-development") && config.allow_development)
  )
    throw Error("本机开发授权与已有配置不一致，请停止该实例后明确重新配置。");
}
try {
  if (
    ["bootstrap", "init", "pair", "start"].includes(command) &&
    !args.includes("--help")
  ) {
    await prepare();
    if (
      command !== "init" &&
      !(command === "pair" && args.includes("--re-pair"))
    )
      verifyExisting(await readJSON(file));
    const { acquireInstance } = await import("../src/instances.mjs");
    try {
      instanceLease = await acquireInstance(file, () => {
        runningNode?.stop();
        console.error("实例锁已失效，停止本次连接以防重复执行。");
        process.exitCode = 1;
      });
    } catch (error) {
      if (
        error.code === "ELOCKED" &&
        ["bootstrap", "start"].includes(command)
      ) {
        console.log(
          "此 Agent 客户端已在运行或启动中，本次不重复配对、启动或执行；配置：" +
            file,
        );
        process.exit(0);
      }
      throw error;
    }
    console.log("本实例配置：" + file);
  }
  if (command === "help" || args.includes("--help"))
    console.log(
      "协作岛异地 Node\n  bootstrap  自动准备依赖、配置、配对并连接\n  init       设置本机 Agent 与明确授权的工作目录\n  pair       用房间配对码申请联机席位\n  start      连接并等待受控发言/任务\n  status     查看设备配置（隐藏凭据）\n  pull       下载房间成果 ZIP，需 --file 文件 ID --out 保存路径\n支持 --config 本机配置文件；自动连接可用 --non-interactive --server 地址 --code 配对码 --adapter 类型 --workspace 目录 --name 设备名称 --agent-name 昵称；默认仅讨论，--allow-development 明确授权开发，--no-development 仅讨论；Ctrl+C 断开并停止本地执行。",
    );
  else if (command === "bootstrap") {
    let config = await readJSON(file);
    verifyExisting(config);
    if (!config) config = await init();
    if (!config.token) config = await pair(config);
    await start(config);
  } else if (command === "init") {
    await init();
  } else if (command === "pair") {
    let config = await readJSON(file);
    if (!config) config = await init();
    await pair(config);
  } else if (command === "start") {
    await start(await readJSON(file));
  } else if (command === "status") {
    const config = await readJSON(file);
    if (!config) throw Error("本机尚未配置。");
    const status = await readJSON(file + ".status.json", {});
    let alive = false;
    if (Number.isInteger(status.pid)) {
      try {
        process.kill(status.pid, 0);
        alive = true;
      } catch (error) {
        alive = error.code === "EPERM";
      }
    }
    console.log(
      JSON.stringify(
        {
          server: config.server,
          agent: config.agent_name,
          node: config.node_name,
          room_id: config.room_id,
          workspace: config.workspace,
          development: config.allow_development,
          paired: !!config.token,
          connection: {
            ...status,
            running: alive,
            connected:
              alive &&
              Boolean(status.connected) &&
              Date.now() - new Date(status.last_sync_at || 0).getTime() < 45000,
          },
          config_file: file,
        },
        null,
        2,
      ),
    );
  } else if (command === "pull") {
    const config = await readJSON(file),
      fid = value("file"),
      out = value("out");
    if (!config?.token || !fid || !out)
      throw Error("需要已配对设备、--file 和 --out。");
    const response = await fetch(
      serverURL(config.server) + "/api/agent-node/files/" + fid,
      {
        redirect: "error",
        headers: { authorization: "Bearer " + config.token },
      },
    );
    if (!response.ok) throw Error("没有下载此房间文件的权限。");
    await writeFile(resolve(out), Buffer.from(await response.arrayBuffer()), {
      flag: "wx",
    });
    console.log("文件已下载；目标存在时不会覆盖。");
  } else throw Error("未知 Node 命令，请运行 help。");
} catch (e) {
  console.error(
    String(e.message || e)
      .replace(/Bearer\s+\S+/g, "[受保护凭据]")
      .slice(0, 600),
  );
  process.exitCode = 1;
} finally {
  await instanceLease?.release().catch(() => {});
}

#!/usr/bin/env node
import { readFile, writeFile, mkdir, access, realpath } from "node:fs/promises";
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
// MCP 的 stdout 只能输出 JSON-RPC；安装/连接日志去 stderr。
if (command === "mcp") console.log = (...values) => console.error(...values);
async function prepare() {
  try {
    await import("ws");
    await import("proper-lockfile");
    return;
  } catch {}
  const { installationLock } = await import("../src/installation.mjs");
  const root = resolve(import.meta.dirname, "../../.."),
    release = await installationLock(root);
  try {
    // 另一安装进程可能已完成；不要再次 npm ci 覆盖它刚准备好的依赖。
    try {
      await access(resolve(root, "node_modules/ws/package.json"));
      await access(resolve(root, "node_modules/proper-lockfile/package.json"));
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
        resolve(root, ".data/npm-cache"),
        "--no-audit",
        "--no-fund",
      ];
    await new Promise((yes, no) => {
      const child = spawn(cmd, parameters, {
        stdio: command === "mcp" ? ["inherit", 2, 2] : "inherit",
        windowsHide: true,
        cwd: root,
      });
      child.once("error", no);
      child.once("exit", (code) =>
        code === 0 ? yes() : no(Error("Node 依赖准备失败。")),
      );
    });
  } finally {
    await release();
  }
}
async function init() {
  const existing = await readJSON(file, {});
  if (existing.token)
    throw Error(
      "此配置已经配对，不能用 init 替换原身份、宿主或工作目录；请复用 start 或新建独立邀请。",
    );
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
        "当前 Agent 接入类型（自动联机用自己的 codex/claude/opencode/acp/cli/a2a/http；mcp 仅手动工具）",
        existing.adapter || "",
      ));
    if (
      ![
        "mcp",
        "codex",
        "claude",
        "opencode",
        "acp",
        "cli",
        "a2a",
        "http",
      ].includes(adapter)
    )
      throw Error(
        "请明确选择当前 Agent 自己的执行接口；不会默认转发给 Codex。mcp 仅手动工具，不能自动唤醒 GUI。",
      );
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
      host_name: value("host") || existing.host_name || "",
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
    if (["codex", "claude", "opencode"].includes(adapter) && value("command"))
      config.command = value("command");
    if (args.includes("--workbuddy-engine")) {
      if (adapter !== "acp")
        throw Error(
          "--workbuddy-engine 必须明确配合 --adapter acp，不是现有 GUI 对话。",
        );
      if (value("command") || value("args"))
        throw Error("不能同时指定 WorkBuddy 自动定位和自定义程序。");
      if (value("host") && !/^work\s*buddy$/i.test(value("host")))
        throw Error("WorkBuddy 自带引擎不能声明为其它宿主。");
      const { workBuddyACP } = await import("../src/workbuddy.mjs");
      Object.assign(config, await workBuddyACP());
      config.workbuddy_engine = true;
      console.log(
        "已选择 WorkBuddy 自带 CodeBuddy ACP：使用独立任务会话，不是已有桌面对话；不启动 Codex。",
      );
    } else if (["cli", "acp"].includes(adapter)) {
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
    if (args.includes("--hub"))
      config.hub_root = resolve(import.meta.dirname, "../../..");
    await writeJSON(file, config);
    console.log("本地授权与配置已保存，网站不会收到本机目录或模型凭据。");
    return config;
  } finally {
    rl.close();
  }
}
async function pair(config) {
  if (args.includes("--hub") && !config.hub_root)
    throw Error(
      "此未配对配置未启用统一客户端，请用 init --hub 明确配置后再配对。",
    );
  if (config.hub_root) {
    const folder = await realpath(dirname(file));
    const root = await realpath(resolve(import.meta.dirname, "../../.."));
    if (
      dirname(folder) !== resolve(root, ".data/connections") ||
      !/^[a-zA-Z0-9-]{16,80}$/.test(
        folder.slice(
          folder.lastIndexOf(process.platform === "win32" ? "\\" : "/") + 1,
        ),
      )
    )
      throw Error("统一客户端配对前需要有效的独立连接配置路径。");
  }
  if (config.token && !args.includes("--re-pair"))
    throw Error(
      "此配置已配对，不能重复配对；新增 Agent 请使用独立配置，仅凭据失效时使用 pair --re-pair。",
    );
  const rl = createInterface({ input: stdin, output: stdout });
  let code = value("code");
  if (!code && nonInteractive) throw Error("非交互配对需要 --code 配对码。");
  try {
    code ||= (await rl.question("在“我的 Agent”取得的配对码：")).trim();
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
        egress_v2: true,
        development: config.allow_development,
        workspace: !!config.workspace,
        ...(config.host_name ? { host_name: config.host_name } : {}),
      },
    }),
  });
  const data = await response.json();
  if (!response.ok) throw Error(data.error || "设备配对失败。");
  const saved = { ...config, ...data, pairing_code_hash: codeHash(code) };
  delete saved.state;
  await writeJSON(file, saved);
  console.log(
    data.room_id
      ? "配对请求已发送，请让房间的人类管理者批准。"
      : "设备身份已登记，请在“我的 Agent”添加到房间。尚未启动连接。",
  );
  return saved;
}
async function start(config) {
  if (config?.hub_root) {
    const { startBackground } = await import("../src/runtime.mjs");
    await instanceLease?.release();
    instanceLease = null;
    console.log(
      JSON.stringify(
        await startBackground(
          file,
          resolve(import.meta.dirname, "island-node.mjs"),
        ),
        null,
        2,
      ),
    );
    return;
  }
  if (!config?.token) throw Error("请先运行 init 和 pair 完成本机配置与配对。");
  const { IslandNode } = await import("../src/client.mjs");
  const node = new IslandNode(config, { configFile: file, instanceLease });
  const { serveRuntime } = await import("../src/runtime.mjs");
  const closeRuntime = await serveRuntime(node, file);
  runningNode = node;
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () => node.stop());
  try {
    await node.start();
  } finally {
    await closeRuntime();
  }
}
let instanceLease, runningNode;
function verifyExisting(config) {
  if (!config?.token) return;
  if (args.includes("--hub") && !config.hub_root)
    throw Error(
      "旧版身份不能静默迁移到统一客户端。请先停止原实例并备份，或为新 Agent 创建独立邀请。",
    );
  if (
    args.includes("--workbuddy-engine") &&
    (config.adapter !== "acp" || config.workbuddy_engine !== true)
  )
    throw Error(
      "此配置不是 WorkBuddy 专用引擎，请使用新的独立配置和邀请，不能替换原 Agent。",
    );
  if (
    value("args") &&
    JSON.stringify(JSON.parse(value("args"))) !==
      JSON.stringify(config.args || [])
  )
    throw Error("程序参数与已有 Agent 不一致，不能替换原信道。");
  if (value("code") && config.pairing_code_hash !== codeHash(value("code")))
    throw Error(
      "此配置属于另一个已配对 Agent；请为新配对码省略 --config 自动隔离，或指定新的配置路径，不能覆盖已有身份。",
    );
  for (const key of [
    "server",
    "adapter",
    "workspace",
    "command",
    "endpoint",
    "host",
  ]) {
    const requested = value(key);
    if (
      requested &&
      (key === "workspace"
        ? resolve(requested)
        : key === "server"
          ? serverURL(requested)
          : requested) !== config[key === "host" ? "host_name" : key]
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
    ["bootstrap", "init", "pair", "start", "mcp"].includes(command) &&
    !args.includes("--help")
  ) {
    await prepare();
    if (
      command !== "init" &&
      !(command === "pair" && args.includes("--re-pair"))
    )
      verifyExisting(await readJSON(file));
    const { acquireInstance } = await import("../src/instances.mjs");
    // 多个 GUI 对话只是代理，不各自抢占设备锁。真正的常驻进程单独持锁。
    if (command !== "mcp")
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
          const { runtimeStatus } = await import("../src/runtime.mjs");
          let live = await runtimeStatus(file);
          const until = Date.now() + 15000;
          while (!live?.running && Date.now() < until) {
            await new Promise((r) => setTimeout(r, 200));
            live = await runtimeStatus(file);
          }
          if (!live?.running)
            throw Error(
              "实例锁被占用，但无法核实常驻进程；可能是旧版客户端。请用 doctor 查看，不抢锁、不伪报成功。",
            );
          verifyExisting(await readJSON(file));
          console.log(
            "已核实原客户端仍在运行，本次不重复配对、启动或执行；复用原身份。",
          );
          process.exit(0);
        }
        throw error;
      }
    console.log("本实例配置：" + file);
  }
  if (command === "help" || args.includes("--help"))
    console.log(
      "协作岛异地 Node\n  bootstrap  自动准备依赖、配置、配对并连接\n  init       设置本机 Agent 与明确授权的工作目录\n  pair       用我的 Agent 配对码登记身份\n  start      连接并等待受控发言/任务；--background 保持常驻\n  hub-status 查看统一客户端全部身份\n  hub-stop   停止统一客户端（保留身份与成果）\n  stop       只停止本配置对应的常驻进程\n  status     查看已核实的连接状态（隐藏凭据）\n  doctor     查看配置、在线证明与旧版进程诊断\n  pull       下载房间成果 ZIP，需 --file 文件 ID --out 保存路径\n支持 --hub 使用统一客户端、--config 本机配置文件；自动连接可用 --non-interactive --server 地址 --code 配对码 --adapter 类型 --workspace 目录 --name 设备名称 --agent-name 昵称；Windows 可明确使用 --adapter acp --workbuddy-engine，运行 WorkBuddy 自带独立引擎而非现有 GUI 对话；默认仅讨论，--allow-development 明确授权开发，--no-development 仅讨论；Ctrl+C 停止前台实例，后台实例用 stop。MCP 是手动工具，不会自动唤醒 GUI 对话。",
    );
  else if (command === "bootstrap") {
    let config = await readJSON(file);
    verifyExisting(config);
    if (!config) config = await init();
    if (!config.token) config = await pair(config);
    if (config.adapter === "mcp") {
      const mcpConfig = {
        mcpServers: {
          ["island-" + config.node_id]: {
            type: "stdio",
            command: process.execPath,
            args: [
              resolve(import.meta.dirname, "island-node.mjs"),
              "mcp",
              "--config",
              file,
            ],
          },
        },
      };
      console.log(
        "请将以下独立服务加入当前宿主的 MCP 配置；不要启动其它 Agent CLI：",
      );
      console.log(JSON.stringify(mcpConfig, null, 2));
      console.log(
        "此方式为手动工具连接，不会自动回应 @。需要自动协作请使用该产品自己的 CLI / ACP / 本地接口。",
      );
    } else if (args.includes("--background")) {
      await instanceLease.release();
      instanceLease = null;
      const { startBackground } = await import("../src/runtime.mjs");
      await startBackground(
        file,
        resolve(import.meta.dirname, "island-node.mjs"),
      );
      console.log(
        "常驻连接已核实启动，关闭安装对话不会停止。停止请用 stop --config；重启电脑后需重新 start --background。",
      );
    } else await start(config);
  } else if (command === "mcp") {
    const config = await readJSON(file);
    if (!config?.token || config.adapter !== "mcp")
      throw Error("MCP 宿主模式需要已配对的 mcp 专用配置，不会复用 CLI 席位。");
    const { hostProxy } = await import("../src/runtime.mjs");
    const { serveHostMCP } = await import("../src/host-mcp.mjs");
    const node = await hostProxy(
      file,
      config,
      resolve(import.meta.dirname, "island-node.mjs"),
    );
    runningNode = node;
    try {
      await serveHostMCP(node);
    } finally {
      node.stop();
    }
  } else if (command === "init") {
    await init();
  } else if (command === "pair") {
    let config = await readJSON(file);
    if (!config) config = await init();
    await pair(config);
  } else if (command === "start") {
    const config = await readJSON(file);
    if (config?.adapter === "mcp" && !args.includes("--managed"))
      throw Error(
        "宿主直连请使用 mcp 命令并由当前宿主启动，不能后台转发到其它 CLI。",
      );
    if (args.includes("--background")) {
      await instanceLease.release();
      instanceLease = null;
      const { startBackground } = await import("../src/runtime.mjs");
      console.log(
        JSON.stringify(
          await startBackground(
            file,
            resolve(import.meta.dirname, "island-node.mjs"),
          ),
          null,
          2,
        ),
      );
    } else await start(config);
  } else if (command === "hub-run") {
    await prepare();
    const { LocalHub } = await import("../src/hub.mjs");
    const hub = new LocalHub(resolve(import.meta.dirname, "../../.."));
    for (const signal of ["SIGINT", "SIGTERM"])
      process.once(signal, () => {
        void hub.stop();
      });
    await hub.start();
  } else if (["hub-status", "hub-stop"].includes(command)) {
    const { hubFile } = await import("../src/hub.mjs");
    const { controlRequest } = await import("../src/runtime.mjs");
    console.log(
      JSON.stringify(
        await controlRequest(
          hubFile(resolve(import.meta.dirname, "../../..")),
          command === "hub-stop" ? "stop" : "status",
        ),
        null,
        2,
      ),
    );
  } else if (command === "stop") {
    const { controlRequest } = await import("../src/runtime.mjs");
    await controlRequest(file, "stop");
    console.log("已通知该配置对应的客户端停止，不终止其它 Agent 或聊天。");
  } else if (command === "doctor" && args.includes("--scan")) {
    const { inventoryClients } = await import("../src/maintenance.mjs");
    console.log(
      JSON.stringify(
        await inventoryClients(value("clients-root") || undefined),
        null,
        2,
      ),
    );
  } else if (["archive", "clean-cache"].includes(command)) {
    const { archiveClient, cleanClientCache } =
      await import("../src/maintenance.mjs");
    const root = resolve(import.meta.dirname, "../../..");
    console.log(
      JSON.stringify(
        command === "archive"
          ? await archiveClient(root, file, {
              confirm: args.includes("--confirm"),
            })
          : await cleanClientCache(root, {
              confirm: args.includes("--confirm"),
            }),
        null,
        2,
      ),
    );
  } else if (["status", "doctor"].includes(command)) {
    const config = await readJSON(file);
    if (!config) throw Error("本机尚未配置。");
    const status = await readJSON(file + ".status.json", {});
    const { runtimeStatus } = await import("../src/runtime.mjs");
    const managed = await runtimeStatus(file);
    const alive = managed?.running === true;
    console.log(
      JSON.stringify(
        {
          server: config.server,
          agent: config.agent_name,
          adapter: config.adapter,
          host: config.host_name || null,
          node: config.node_name,
          room_id: config.room_id,
          workspace: config.workspace,
          development: config.allow_development,
          paired: !!config.token,
          connection: {
            ...(managed || status),
            running: alive,
            connected: alive && Boolean(managed?.connected),
            ...(managed
              ? {}
              : {
                  warning:
                    "未核实管理进程；旧版 PID 状态不是在线证明，不会按 PID 终止。",
                }),
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

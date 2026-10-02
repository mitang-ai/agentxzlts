import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  rm,
  utimes,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { createServer, request } from "node:https";
import { spawn, fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import WebSocket from "ws";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
// @ts-ignore Executable ES modules used by the real server and client.
import { attachGateway } from "../packages/agents/gateway.mjs";
// @ts-ignore
import { writeArchive, readArchive } from "../packages/agents/archive.mjs";
import { createStorage } from "../packages/runtime/storage.mjs";
const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ||
    "postgresql://island:local-development-only@127.0.0.1:55432/postgres",
});
const user = randomUUID();
let root: string,
  room: string,
  server: any,
  gateway: any,
  service: any,
  url: string,
  cert: Buffer;
const children: ChildProcess[] = [];
const bootstrapChildren: ChildProcess[] = [];
const logs: string[] = [];
let nodes: any[] = [],
  session: any,
  bundleRoot: string;
async function run(command: string, args: string[], cwd = root) {
  const child = spawn(command, args, {
    cwd,
    env: {
      ...process.env,
      npm_config_cache: resolve(process.cwd(), ".npm-cache"),
      ...(cert ? { NODE_EXTRA_CA_CERTS: resolve(root, "cert.pem") } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  bootstrapChildren.push(child);
  child.stdout.on("data", (b) => {
    output += b;
  });
  child.stderr.on("data", (b) => {
    output += b;
  });
  const [code] = await once(child, "exit");
  if (code !== 0) throw Error(command + " failed: " + output.slice(-2000));
  return output;
}
async function human(command: string, data: any) {
  const db = await pool.connect();
  try {
    await db.query("begin");
    await db.query("select set_config('request.jwt.claim.sub',$1,true)", [
      user,
    ]);
    const result = (
      await db.query("select island_command($1,$2) result", [
        command,
        JSON.stringify(data),
      ])
    ).rows[0].result;
    await db.query("commit");
    return result;
  } catch (e) {
    await db.query("rollback");
    throw e;
  } finally {
    db.release();
  }
}
async function httpsJSON(
  path: string,
  data: any,
  extraHeaders = {},
  binary = false,
) {
  return new Promise<any>((yes, no) => {
    const req = request(
      new URL(path, url),
      {
        method: "POST",
        ca: cert,
        headers: { "content-type": "application/json", ...extraHeaders },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (b) => chunks.push(b));
        res.on("end", () =>
          yes({
            status: res.statusCode,
            data: binary
              ? Buffer.concat(chunks)
              : JSON.parse(Buffer.concat(chunks).toString()),
          }),
        );
      },
    );
    req.on("error", no);
    req.setTimeout(8000, () => req.destroy(Error("HTTPS 测试请求超时")));
    req.end(JSON.stringify(data));
  });
}
async function waitFor(
  check: () => Promise<any>,
  description: string,
  timeout = 25000,
) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    // Default flow must progress autonomously; this helper never approves a send.
    const value = await check();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error("等待超时: " + description + "\n" + logs.join("\n").slice(-3000));
}
beforeAll(async () => {
  root = await mkdtemp(resolve(tmpdir(), "island-remote-nodes-"));
  await run("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    "key.pem",
    "-out",
    "cert.pem",
    "-days",
    "1",
    "-subj",
    "/CN=localhost",
    "-addext",
    "subjectAltName=DNS:localhost,IP:127.0.0.1",
  ]);
  cert = await readFile(resolve(root, "cert.pem"));
  server = createServer(
    { key: await readFile(resolve(root, "key.pem")), cert },
    (req, res) => {
      void gateway.handleHTTP(req, res).then((handled: boolean) => {
        if (!handled) {
          res.writeHead(404);
          res.end();
        }
      });
    },
  );
  gateway = attachGateway(
    server,
    pool,
    createStorage(pool, { STORAGE_DIR: resolve(root, "files") }),
    { TRUST_PROXY: "true" },
  );
  service = gateway.service;
  server.on("upgrade", (req: any, socket: any, head: any) => {
    void gateway.upgrade(req, socket, head);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  url = "https://127.0.0.1:" + server.address().port;
  await pool.query(
    "insert into auth.users(id,email,raw_user_meta_data) values($1,$2,$3)",
    [
      user,
      user + "@node-integration.invalid",
      JSON.stringify({ display_name: "远程协议验收用户" }),
    ],
  );
  room = (
    await human("create_room", { name: "独立 Node WSS 集成", icon: "🏝️" })
  ).id;
}, 30000);
afterAll(async () => {
  const allChildren = [...children, ...bootstrapChildren];
  for (const child of allChildren)
    if (child.exitCode === null) child.kill("SIGTERM");
  await Promise.all(
    allChildren.map((child) =>
      child.exitCode !== null || child.signalCode !== null
        ? Promise.resolve()
        : Promise.race([
            once(child, "exit"),
            new Promise((r) =>
              setTimeout(() => {
                child.kill("SIGKILL");
                r(null);
              }, 2500),
            ),
          ]),
    ),
  );
  await gateway?.close();
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
  if (room) {
    await pool.query("delete from rooms where id=$1", [room]);
    await pool.query("delete from storage.objects where name like $1", [
      room + "/%",
    ]);
    await pool.query("delete from storage_cleanup_jobs where path like $1", [
      room + "/%",
    ]);
  }
  await pool.query("delete from auth.users where id=$1", [user]);
  await pool.end();
  await rm(root, { recursive: true, force: true });
});
describe.sequential(
  "两个独立进程经真实 TLS/WSS 联机，在各自工作目录开发并回传",
  () => {
    it("可下载的独立客户端包能从锁文件安装，不包含服务器代码、凭据和工作区数据", async () => {
      const pairing = await service.createPairing(user, room);
      const invalid = await httpsJSON("/api/agent-node/client", {
        code: "invalid-pairing-code-123456",
      });
      expect(invalid.status).toBe(403);
      // 模拟异地 Agent：无 Cookie，通过 HTTPS 请求体中的配对码取得实际安装包。
      const download = await httpsJSON(
        "/api/agent-node/client",
        { code: pairing.code },
        {},
        true,
      );
      expect(download.status).toBe(200);
      const files = await readArchive(download.data);
      // 校验真正下载的 ZIP，防止 PS 5.1/旧记事本把中文按 ANSI 解析。
      const utf8 = new TextDecoder("utf-8", { fatal: true });
      for (const path of ["scripts/node-bootstrap.ps1", "README.txt"]) {
        const bytes = files.get(path)!;
        expect(
          bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])),
        ).toBe(true);
        expect(() => utf8.decode(bytes)).not.toThrow();
      }
      const windowsScript = utf8.decode(
        files.get("scripts/node-bootstrap.ps1")!,
      );
      expect(windowsScript).toMatch(/^\$nodeArguments = \$args\r\n/);
      expect(windowsScript).toContain(
        "正在下载项目私有 Node.js，不修改系统安装…",
      );
      expect(windowsScript).toContain(
        "[Console]::InputEncoding = $utf8Encoding",
      );
      expect(windowsScript).toContain(
        "[Console]::OutputEncoding = $utf8Encoding",
      );
      expect(windowsScript).toContain("$OutputEncoding = $utf8Encoding");
      expect(utf8.decode(files.get("README.txt")!)).toContain(
        "协作岛异地 Node 客户端",
      );
      expect(files.get("connect.cmd")!.toString()).toMatch(
        /^@echo off\r\nchcp 65001 >nul\r\n/,
      );
      expect(files.get("connect.sh")!.toString()).toMatch(
        /^#!\/usr\/bin\/env bash\n/,
      );
      expect(files.get("connect.sh")!.toString()).toContain('bootstrap "$@"');
      expect(files.get("scripts/node-bootstrap.ps1")!.toString()).toContain(
        "bootstrap @nodeArguments",
      );
      expect(files.has("connect.cmd")).toBe(true);
      expect(files.has("connect.sh")).toBe(true);
      expect(
        [...files.keys()].some((path) =>
          /service\.mjs|gateway\.mjs|config\.json|\.env$/.test(path),
        ),
      ).toBe(false);
      bundleRoot = resolve(root, "downloaded-client");
      for (const [name, bytes] of files) {
        const path = resolve(bundleRoot, name);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, bytes);
      }
      await run("npm", ["ci", "--no-audit", "--no-fund"], bundleRoot);
      expect(
        await run(
          process.execPath,
          ["packages/node/bin/island-node.mjs", "help"],
          bundleRoot,
        ),
      ).toContain("协作岛");
      await service.revokePairing(user, room, pairing.id);
      expect(
        (await httpsJSON("/api/agent-node/client", { code: pairing.code }))
          .status,
      ).toBe(403);
    }, 60000);
    it("下载后的启动程序能无交互安装配置、配对并连接，默认仅讨论且重复启动复用凭据", async () => {
      const bootstrapRoom = (
        await human("create_room", { name: "一句话自动连接", icon: "🏝️" })
      ).id;
      let child: ChildProcess | undefined;
      try {
        const pairing = await service.createPairing(user, bootstrapRoom);
        const configFile = resolve(
          bundleRoot,
          ".data/connections/bootstrap/config.json",
        );
        const flags = [
          "--non-interactive",
          "--server",
          url,
          "--code",
          pairing.code,
          "--adapter",
          "cli",
          "--command",
          process.execPath,
          "--args",
          JSON.stringify([resolve("tests/fixtures/local-agent.mjs")]),
          "--workspace",
          resolve(root, "automatic-workspace"),
          "--config",
          configFile,
          "--name",
          "自动连接设备",
          "--agent-name",
          "自动连接 Agent",
        ];
        const start = (args: string[]) => {
          const process = spawn("bash", ["connect.sh", ...args], {
            cwd: bundleRoot,
            env: {
              ...globalThis.process.env,
              NODE_EXTRA_CA_CERTS: resolve(root, "cert.pem"),
            },
            stdio: ["ignore", "pipe", "pipe"],
          });
          bootstrapChildren.push(process);
          process.stdout.on("data", (b) => logs.push("Bootstrap: " + b));
          process.stderr.on("data", (b) => logs.push("Bootstrap: " + b));
          return process;
        };
        child = start(flags);
        await waitFor(
          async () =>
            (await service.state(user, bootstrapRoom)).seats[0]?.last_seen_at,
          "无交互配对及连接",
        );
        const config = JSON.parse(await readFile(configFile, "utf8"));
        expect(config.allow_development).toBe(false);
        expect(config.room_id).toBe(bootstrapRoom);
        expect(config.token).toBeTruthy();
        expect((await service.state(user, bootstrapRoom)).seats[0].state).toBe(
          "pending",
        );
        const firstSession = (
          await pool.query("select session_id from agent_nodes where id=$1", [
            config.node_id,
          ])
        ).rows[0].session_id;
        const repeated = await run(
          "bash",
          ["connect.sh", ...flags],
          bundleRoot,
        );
        expect(repeated).toContain("不重复配对、启动或执行");
        expect((await service.state(user, bootstrapRoom)).seats).toHaveLength(
          1,
        );
        expect(
          (
            await pool.query("select session_id from agent_nodes where id=$1", [
              config.node_id,
            ])
          ).rows[0].session_id,
        ).toBe(firstSession);
        // 审批后无需重启，终端和本机 status 都应更新为 approved。
        await service.seatAction(user, bootstrapRoom, "approve", {
          participant_id: config.participant_id,
        });
        await waitFor(
          async () =>
            JSON.parse(await readFile(configFile + ".status.json", "utf8"))
              .state === "approved",
          "审批后本机状态更新",
        );
        expect(logs.join("\n")).toContain("联机席位已批准，等待点名或任务");
        const liveStatus = JSON.parse(
          await run(
            process.execPath,
            [
              "packages/node/bin/island-node.mjs",
              "status",
              "--config",
              configFile,
            ],
            bundleRoot,
          ),
        );
        expect(liveStatus.connection.state).toBe("approved");
        expect(liveStatus.connection.connected).toBe(true);
        expect(liveStatus).not.toHaveProperty("token");
        // 使用相同身份的另一个网络连接应被拒绝，不能修改原 session。
        const duplicateStatus = await new Promise<number>((yes, no) => {
          const ws = new WebSocket(
            url.replace("https:", "wss:") + "/agent-wire",
            { ca: cert, headers: { authorization: "Bearer " + config.token } },
          );
          ws.on("unexpected-response", (_req, response) => {
            response.resume();
            yes(response.statusCode!);
          });
          ws.on("open", () => {
            ws.close();
            no(Error("重复身份不应获准连接"));
          });
          ws.on("error", () => {});
        });
        expect(duplicateStatus).toBe(409);
        const copiedFile = resolve(root, "copied-identity/config.json");
        await mkdir(dirname(copiedFile), { recursive: true });
        await writeFile(copiedFile, JSON.stringify(config));
        let copiedError = "";
        try {
          await run(
            process.execPath,
            [
              "packages/node/bin/island-node.mjs",
              "start",
              "--config",
              copiedFile,
            ],
            bundleRoot,
          );
        } catch (error) {
          copiedError = String(error);
        }
        expect(copiedError).toContain("本次重复连接已停止");
        expect(
          (
            await pool.query("select session_id from agent_nodes where id=$1", [
              config.node_id,
            ])
          ).rows[0].session_id,
        ).toBe(firstSession);
        const wrongCode = await service.createPairing(user, bootstrapRoom);
        let mismatch = "";
        // 替换已有 --code 参数后，不能静默复用第一位 Agent 的凭据。
        const changed = [...flags];
        changed[changed.indexOf("--code") + 1] = wrongCode.code;
        try {
          await run("bash", ["connect.sh", ...changed], bundleRoot);
        } catch (error) {
          mismatch = String(error);
        }
        expect(mismatch).toContain("另一个已配对 Agent");
        expect(JSON.parse(await readFile(configFile, "utf8")).token).toBe(
          config.token,
        );
        // 同一安装目录，新码省略 --config 时自动生成独立配置和身份。
        const omit = new Set([
          changed.indexOf("--config"),
          changed.indexOf("--config") + 1,
          changed.indexOf("--workspace"),
          changed.indexOf("--workspace") + 1,
        ]);
        const secondFlags = changed.filter((_value, index) => !omit.has(index));
        secondFlags[secondFlags.indexOf("--agent-name") + 1] =
          "第二个自动连接 Agent";
        const second = start(secondFlags);
        await waitFor(
          async () =>
            (await service.state(user, bootstrapRoom)).seats.length === 2,
          "同目录第二位 Agent 配对",
        );
        const automatic = resolve(
          bundleRoot,
          ".data/connections",
          createHash("sha256")
            .update(url + "\n" + wrongCode.code)
            .digest("hex"),
          "config.json",
        );
        const secondConfig = await waitFor(
          async () =>
            readFile(automatic, "utf8")
              .then(JSON.parse)
              .catch(() => null),
          "独立配置保存",
        );
        expect(secondConfig.token).not.toBe(config.token);
        expect(secondConfig.workspace).not.toBe(config.workspace);
        await waitFor(
          async () =>
            readFile(automatic + ".status.json", "utf8")
              .then((text) => JSON.parse(text).connected)
              .catch(() => false),
          "第二位 Agent 独立在线",
        );
        expect(
          (
            await pool.query("select session_id from agent_nodes where id=$1", [
              config.node_id,
            ])
          ).rows[0].session_id,
        ).toBe(firstSession);
        second.kill("SIGTERM");
        await once(second, "exit");
        child.kill("SIGTERM");
        await once(child, "exit");
        await pool.query(
          "update agent_pairings set expires_at=now()-interval '1 second' where id=$1",
          [pairing.id],
        );
        child = start(flags);
        await waitFor(async () => {
          const node = (
            await pool.query("select session_id from agent_nodes where id=$1", [
              config.node_id,
            ])
          ).rows[0];
          return node.session_id && node.session_id !== firstSession;
        }, "复用已配对配置重连");
        expect(JSON.parse(await readFile(configFile, "utf8")).token).toBe(
          config.token,
        );
        expect((await service.state(user, bootstrapRoom)).seats).toHaveLength(
          2,
        );
      } finally {
        if (child && child.exitCode === null && child.signalCode === null) {
          child.kill("SIGTERM");
          await once(child, "exit");
        }
        await pool.query("delete from rooms where id=$1", [bootstrapRoom]);
      }
    }, 60000);
    it("首次并发执行同一提示词只配对一次，进程崩溃后可从过期锁恢复原身份", async () => {
      const concurrentRoom = (
        await human("create_room", { name: "并发安装与恢复", icon: "🏝️" })
      ).id;
      const started: ChildProcess[] = [];
      try {
        const pairing = await service.createPairing(user, concurrentRoom);
        const flags = [
          "--non-interactive",
          "--server",
          url,
          "--code",
          pairing.code,
          "--adapter",
          "cli",
          "--command",
          process.execPath,
          "--args",
          JSON.stringify([resolve("tests/fixtures/local-agent.mjs")]),
          "--name",
          "并发设备",
          "--agent-name",
          "并发 Agent",
        ];
        const automatic = resolve(
          bundleRoot,
          ".data/connections",
          createHash("sha256")
            .update(url + "\n" + pairing.code)
            .digest("hex"),
          "config.json",
        );
        const launch = () => {
          const child = spawn("bash", ["connect.sh", ...flags], {
            cwd: bundleRoot,
            env: {
              ...process.env,
              NODE_EXTRA_CA_CERTS: resolve(root, "cert.pem"),
            },
            stdio: ["ignore", "pipe", "pipe"],
          });
          started.push(child);
          bootstrapChildren.push(child);
          child.stdout.on("data", (b) => logs.push("Concurrent: " + b));
          child.stderr.on("data", (b) => logs.push("Concurrent: " + b));
          return child;
        };
        launch();
        launch();
        await waitFor(
          async () =>
            readFile(automatic + ".status.json", "utf8")
              .then((text) => JSON.parse(text).connected)
              .catch(() => false),
          "首次并发启动连接",
        );
        await waitFor(
          async () => started.some((child) => child.exitCode === 0),
          "重复启动安全退出",
        );
        const config = JSON.parse(await readFile(automatic, "utf8"));
        expect((await service.state(user, concurrentRoom)).seats).toHaveLength(
          1,
        );
        const primary = started.find(
          (child) => child.exitCode === null && child.signalCode === null,
        )!;
        const primaryExited = once(primary, "exit");
        primary.kill("SIGKILL");
        await primaryExited;
        // 强制结束留下锁目录；模拟超过 30 秒，验证无需重复配对的恢复。
        const old = new Date(Date.now() - 60000);
        await utimes(automatic + ".lock", old, old);
        await pool.query(
          "update agent_pairings set expires_at=now()-interval '1 second' where id=$1",
          [pairing.id],
        );
        const restored = launch();
        await waitFor(
          async () =>
            readFile(automatic + ".status.json", "utf8")
              .then((text) => {
                const status = JSON.parse(text);
                return status.connected && status.pid === restored.pid;
              })
              .catch(() => false),
          "崩溃后复用凭据恢复",
        );
        expect(JSON.parse(await readFile(automatic, "utf8")).token).toBe(
          config.token,
        );
        expect((await service.state(user, concurrentRoom)).seats).toHaveLength(
          1,
        );
      } finally {
        for (const child of started)
          if (child.exitCode === null && child.signalCode === null) {
            const exited = once(child, "exit");
            child.kill("SIGTERM");
            await exited;
          }
        await pool.query("delete from rooms where id=$1", [concurrentRoom]);
      }
    }, 60000);
    it("两个本地程序通过一次性配对和人类审批连接同一房间，断线自动重连而不重复回复", async () => {
      for (let i = 0; i < 2; i++) {
        const pairing = await service.createPairing(user, room);
        const response = await httpsJSON("/api/agent-node/pair", {
          code: pairing.code,
          node_name: "独立设备 " + i,
          agent_name: i ? "开发 Agent" : "主持 Agent",
          adapter: "cli",
          fingerprint: randomUUID(),
          capabilities: { development: true, workspace: true },
        });
        expect(response.status).toBe(200);
        const node = response.data;
        nodes.push(node);
        await service.seatAction(user, room, "approve", {
          participant_id: node.participant_id,
        });
        const workspace = resolve(root, "device-" + i, "workspace"),
          file = resolve(root, "device-" + i, "config.json");
        await mkdir(workspace, { recursive: true });
        const config = {
          server: url,
          token: node.token,
          node_id: node.node_id,
          participant_id: node.participant_id,
          workspace,
          adapter: "cli",
          command: process.execPath,
          args: [resolve("tests/fixtures/local-agent.mjs")],
          agent_name: i ? "开发 Agent" : "主持 Agent",
          allow_development: true,
          checks: [
            {
              command: process.execPath,
              args: ["--check", i ? "src/worker.js" : "src/host.js"],
              timeout: 10000,
            },
          ],
        };
        await writeFile(file, JSON.stringify(config), { mode: 0o600 });
        const env = {
          ...process.env,
          NODE_EXTRA_CA_CERTS: resolve(root, "cert.pem"),
        };
        // One process is the repository client; one runs solely from the downloaded package.
        const child =
          i === 0
            ? fork(resolve("tests/fixtures/node-runner.mjs"), [file], {
                env,
                stdio: ["ignore", "pipe", "pipe", "ipc"],
              })
            : spawn(
                process.execPath,
                [
                  "packages/node/bin/island-node.mjs",
                  "start",
                  "--config",
                  file,
                ],
                { cwd: bundleRoot, env, stdio: ["ignore", "pipe", "pipe"] },
              );
        children.push(child);
        child.stdout?.on("data", (b) => logs.push("Node " + i + ": " + b));
        child.stderr?.on("data", (b) => logs.push("Node " + i + ": " + b));
      }
      await waitFor(
        async () =>
          (await service.state(user, room)).seats.every(
            (s: any) =>
              s.last_seen_at &&
              Date.now() - new Date(s.last_seen_at).getTime() < 45000,
          ),
        "两台设备在线",
      );
      await service.seatAction(user, room, "host", {
        participant_id: nodes[0].participant_id,
      });
      const before = (
        await pool.query("select session_id from agent_nodes where id=$1", [
          nodes[0].node_id,
        ])
      ).rows[0].session_id;
      children[0].send?.("drop");
      await waitFor(async () => {
        const value = (
          await pool.query(
            "select session_id,last_seen_at from agent_nodes where id=$1",
            [nodes[0].node_id],
          )
        ).rows[0];
        return value.last_seen_at && value.session_id !== before;
      }, "WSS 重连");
      await human("message", {
        room_id: room,
        content: "@主持 Agent 请回应",
        mentioned_participant_ids: [nodes[0].participant_id],
        client_message_id: randomUUID(),
      });
      await waitFor(
        async () =>
          Number(
            (
              await pool.query(
                "select count(*) n from messages where room_id=$1 and sender_participant_id=$2",
                [room, nodes[0].participant_id],
              )
            ).rows[0].n,
          ) === 1,
        "实际本机程序回应一次",
      );
      await new Promise((r) => setTimeout(r, 2200));
      expect(
        Number(
          (
            await pool.query(
              "select count(*) n from messages where room_id=$1 and sender_participant_id=$2",
              [room, nodes[0].participant_id],
            )
          ).rows[0].n,
        ),
      ).toBe(1);
    }, 35000);
    it("主持点名后收敛到分工，全员对齐；人类批准前没有本地开发任务", async () => {
      const bytes = await writeArchive(
        new Map([
          ["src/host.js", Buffer.from("export const host = () => 1;\n")],
          ["src/worker.js", Buffer.from("export const worker = () => 1;\n")],
          ["README.md", Buffer.from("已确认源码基线\n")],
        ]),
      );
      const fid = randomUUID(),
        path = room + "/" + fid;
      await service.storage.storeFile(path, bytes, "application/zip");
      await human("register_file", {
        room_id: room,
        id: fid,
        storage_path: path,
        name: "baseline.zip",
        mime_type: "application/zip",
        size: bytes.length,
      });
      await service.publishBrief(user, room, {
        requirements: "worker 返回 2，host 返回 3".padEnd(32000, "需"),
        design: "两个设备各自修改一个文件，保留 README".padEnd(32000, "设"),
        base_file_id: fid,
      });
      session = await service.startSession(user, room, {
        topic: "核对开发方案与分工",
        max_turns: 5,
        minutes: 10,
        attendee_ids: [nodes[1].participant_id],
      });
      const state = await waitFor(async () => {
        const s = await service.state(user, room);
        if (s.session.stage === "paused") throw Error(s.session.error);
        return s.session.stage === "ready" && s;
      }, "主题讨论与对齐");
      expect(state.session.turns_created).toBe(3);
      expect(
        state.acks.filter((a: any) =>
          nodes.some((n) => n.participant_id === a.participant_id),
        ).length,
      ).toBe(2);
      expect(
        (
          await pool.query(
            "select count(*) n from agent_turns where session_id=$1 and kind='develop'",
            [session.id],
          )
        ).rows[0].n,
      ).toBe("0");
    }, 40000);
    it("批准后各设备真实创建 Git 分支、修改本地文件、执行检查、上传 ZIP，经审阅合并为房间源码", async () => {
      await service.sessionAction(user, room, "approve-plan", {
        session_id: session.id,
        confirm: true,
      });
      const state = await waitFor(async () => {
        const s = await service.state(user, room);
        if (s.session.stage === "paused") throw Error(s.session.error);
        return s.session.stage === "review" && s;
      }, "独立设备源码回传");
      expect(state.artifacts.length).toBe(2);
      for (let i = 0; i < 2; i++) {
        const work = resolve(root, "device-" + i, "workspace", ".island-work");
        const dirs = await readdir(work);
        const turn = state.turns.find(
          (turn: any) =>
            turn.kind === "develop" &&
            turn.participant_id === nodes[i].participant_id,
        );
        expect(dirs).toContain(turn.id);
        const cwd = resolve(work, turn.id);
        expect(await run("git", ["branch", "--show-current"], cwd)).toContain(
          "island/",
        );
        expect(
          await readFile(
            resolve(cwd, i ? "src/worker.js" : "src/host.js"),
            "utf8",
          ),
        ).toContain(i ? "=> 2" : "=> 3");
      }
      for (const artifact of state.artifacts) {
        expect(artifact.manifest.checks[0].status).toBe("passed");
        await service.reviewArtifact(user, room, {
          artifact_id: artifact.id,
          accept: true,
          note: "已核验实际修改及本机检查结果",
        });
      }
      const preview = await service.mergePreview(user, room, session.id);
      expect(preview.conflicts).toHaveLength(0);
      const merged = await service.merge(user, room, {
        session_id: session.id,
        confirm: true,
        resolutions: {},
      });
      const result = await service.nodeDownload(nodes[0].token, merged.id),
        files = await readArchive(result.bytes);
      expect(files.get("src/worker.js").toString()).toContain("=> 2");
      expect(files.get("src/host.js").toString()).toContain("=> 3");
      expect(files.get("README.md").toString()).toBe("已确认源码基线\n");
      expect((await service.state(user, room)).session.stage).toBe("completed");
      expect(
        (
          await service.merge(user, room, {
            session_id: session.id,
            confirm: true,
            resolutions: {},
          })
        ).duplicate,
      ).toBe(true);
    }, 40000);
    it("撤销席位终止真实远端连接，旧凭据无法重新配对或取任务", async () => {
      await service.seatAction(user, room, "revoke", {
        participant_id: nodes[0].participant_id,
      });
      await waitFor(
        async () =>
          (
            await pool.query("select revoked_at from agent_nodes where id=$1", [
              nodes[0].node_id,
            ])
          ).rows[0].revoked_at !== null,
        "撤销后的连接终止",
      );
      await expect(service.connect(nodes[0].token)).rejects.toThrow(
        /撤销|有效|权限/,
      );
      expect(children[1].exitCode).toBeNull();
    });
    it("后台来源 IP 封禁也适用于 Node 配对和 WebSocket 握手", async () => {
      const rule = randomUUID();
      await pool.query(
        "insert into ip_rules(id,network,reason) values($1,'203.0.113.42/32','Node 来源验收')",
        [rule],
      );
      try {
        expect(
          (
            await httpsJSON(
              "/api/agent-node/pair",
              { code: "irrelevant" },
              { "x-forwarded-for": "203.0.113.42" },
            )
          ).status,
        ).toBe(403);
        const ws = new WebSocket(
          url.replace("https:", "wss:") + "/agent-wire",
          {
            ca: cert,
            headers: {
              authorization: "Bearer " + nodes[1].token,
              "x-forwarded-for": "203.0.113.42",
            },
          },
        );
        const status = await new Promise<number>((yes, no) => {
          ws.on("error", no);
          ws.on("unexpected-response", (_req, res) => {
            yes(res.statusCode!);
            res.resume();
            ws.terminate();
          });
        });
        expect(status).toBe(403);
      } finally {
        await pool.query("delete from ip_rules where id=$1", [rule]);
      }
    });
    it("暂时数据库错误返回 503，维护循环恢复后仍接受配对和设备心跳", async () => {
      const query = pool.query.bind(pool),
        connect = pool.connect.bind(pool);
      let failedSweep = false;
      try {
        (pool as any).query = (...args: any[]) => {
          if (
            !failedSweep &&
            String(args[0]).startsWith(
              "select distinct room_id from agent_turns",
            )
          ) {
            failedSweep = true;
            return Promise.reject(Error("database transient outage"));
          }
          return (query as any)(...args);
        };
        await waitFor(async () => failedSweep, "定时维护遇到数据库错误");
        (pool as any).query = query;
        const pairing = await service.createPairing(user, room);
        (pool as any).connect = (...args: any[]) => {
          (pool as any).connect = connect;
          const callback = args.find((arg) => typeof arg === "function"),
            error = Error("database transient outage");
          if (callback) {
            queueMicrotask(() => callback(error));
            return;
          }
          return Promise.reject(error);
        };
        const input = {
          code: pairing.code,
          node_name: "恢复验收",
          agent_name: "恢复 Agent",
          adapter: "cli",
          fingerprint: randomUUID(),
          capabilities: {},
        };
        expect((await httpsJSON("/api/agent-node/pair", input)).status).toBe(
          503,
        );
        expect((await httpsJSON("/api/agent-node/pair", input)).status).toBe(
          200,
        );
        await waitFor(async () => {
          const seen = (
            await query("select last_seen_at from agent_nodes where id=$1", [
              nodes[1].node_id,
            ])
          ).rows[0].last_seen_at;
          return seen && Date.now() - new Date(seen).getTime() < 3000;
        }, "恢复后设备心跳");
        expect(children[1].exitCode).toBeNull();
      } finally {
        (pool as any).query = query;
        (pool as any).connect = connect;
      }
    });
  },
);

it("WorkBuddy/Hermes 宿主经真实 MCP+WSS 各自处理点名，撤销只停止目标设备和在途任务", async () => {
  const peers: any[] = [],
    admin = randomUUID();
  await pool.query(
    "insert into auth.users(id,email,raw_user_meta_data) values($1,$2,$3)",
    [
      admin,
      admin + "@host-revoke.invalid",
      JSON.stringify({ display_name: "撤销验收" }),
    ],
  );
  await pool.query(
    "insert into admin_members(user_id,role) values($1,'technical')",
    [admin],
  );
  try {
    for (const name of ["WorkBuddy", "Hermes"]) {
      const pairing = await service.createPairing(user, room);
      const identity = await service.pair({
        code: pairing.code,
        node_name: name + " 测试设备",
        agent_name: name,
        adapter: "mcp",
        fingerprint: randomUUID(),
        capabilities: {},
      });
      await service.seatAction(user, room, "approve", {
        participant_id: identity.participant_id,
      });
      const directory = resolve(root, "host-" + name),
        file = resolve(directory, "config.json");
      await mkdir(resolve(directory, "workspace"), { recursive: true });
      await writeFile(
        file,
        JSON.stringify({
          server: url,
          ...identity,
          adapter: "mcp",
          host_name: name,
          agent_name: name,
          allow_development: false,
          workspace: resolve(directory, "workspace"),
        }),
        { mode: 0o600 },
      );
      const child = spawn(
        process.execPath,
        [resolve("packages/node/bin/island-node.mjs"), "mcp", "--config", file],
        {
          env: {
            ...process.env,
            NODE_EXTRA_CA_CERTS: resolve(root, "cert.pem"),
          },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      bootstrapChildren.push(child);
      child.stderr.on("data", (b) => logs.push(name + ": " + b));
      const pending = new Map(),
        packets: any[] = [];
      let sequence = 0;
      const lines = createInterface({ input: child.stdout });
      lines.on("line", (line) => {
        const p = JSON.parse(line);
        packets.push(p);
        const waiter = pending.get(p.id);
        if (waiter) {
          clearTimeout(waiter.timer);
          pending.delete(p.id);
          waiter.resolve(p);
        }
      });
      const call = (method: string, params: any = {}) =>
        new Promise<any>((resolve, reject) => {
          const id = ++sequence,
            timer = setTimeout(() => {
              pending.delete(id);
              reject(Error("MCP 等待超时：" + method));
            }, 18000);
          pending.set(id, { resolve, reject, timer });
          child.stdin.write(
            JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
          );
        });
      const tool = async (name: string, args: any = {}) => {
        const p = await call("tools/call", { name, arguments: args });
        if (p.error || p.result.isError)
          throw Error(JSON.stringify(p.error || p.result));
        return JSON.parse(p.result.content[0].text);
      };
      const handshake = await call("initialize", {
        protocolVersion: "2025-06-18",
        clientInfo: { name, version: "fixture" },
        capabilities: {},
      });
      expect(handshake.result.capabilities.tools).toBeDefined();
      child.stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/initialized",
        }) + "\n",
      );
      peers.push({ identity, child, tool, call, packets, lines });
      await waitFor(
        async () => (await tool("island_status")).connected,
        name + " 专用宿主在线",
      );
    }
    const source = await human("message", {
      room_id: room,
      content: "只让 WorkBuddy 回答",
      client_message_id: randomUUID(),
      mentioned_participant_ids: [peers[0].identity.participant_id],
    });
    // 只有宿主有界等待时才领取；闲置 MCP 不抢占任务，也不转发任何 CLI。
    await new Promise((r) => setTimeout(r, 2100));
    expect(
      (
        await pool.query(
          "select status from agent_turns where source_message_id=$1",
          [source.id],
        )
      ).rows[0].status,
    ).toBe("queued");
    const task = await peers[0].tool("island_wait_task", { wait_seconds: 10 });
    expect(task.task.participant_id).toBe(peers[0].identity.participant_id);
    expect(JSON.stringify(task)).not.toContain(peers[0].identity.token);
    expect(task.task.lease).toBeUndefined();
    expect(
      await peers[1].tool("island_wait_task", { wait_seconds: 1 }),
    ).toBeNull();
    const result = { message: "由 WorkBuddy 宿主自己回答" };
    expect(
      await peers[0].tool("island_complete_task", {
        task_id: task.task_id,
        delivery_id: task.delivery_id,
        result,
      }),
    ).toMatchObject({ confirmed: true, pending_review: false });
    const review = (await service.myAgents(user)).reviews.find(
      (v: any) => v.turn_id === task.task_id,
    );
    expect(review).toBeUndefined();
    expect(
      (
        await pool.query(
          "select 1 from messages where content=$1 and room_id=$2",
          [result.message, room],
        )
      ).rowCount,
    ).toBe(1);

    await peers[0].tool("island_complete_task", {
      task_id: task.task_id,
      delivery_id: task.delivery_id,
      result,
    });
    expect(
      (
        await pool.query(
          "select sender_participant_id from messages where room_id=$1 and content=$2",
          [room, result.message],
        )
      ).rows,
    ).toEqual([{ sender_participant_id: peers[0].identity.participant_id }]);
    const foreign = await peers[1].call("tools/call", {
      name: "island_complete_task",
      arguments: {
        task_id: task.task_id,
        delivery_id: task.delivery_id,
        result,
      },
    });
    expect(foreign.result.isError).toBe(true);
    await human("message", {
      room_id: room,
      content: "让 Hermes 自己回答",
      client_message_id: randomUUID(),
      mentioned_participant_ids: [peers[1].identity.participant_id],
    });
    const other = await peers[1].tool("island_wait_task", { wait_seconds: 10 });
    await peers[1].tool("island_complete_task", {
      task_id: other.task_id,
      delivery_id: other.delivery_id,
      result: { message: "由 Hermes 宿主回答" },
    });
    await human("message", {
      room_id: room,
      content: "撤销前在途点名",
      client_message_id: randomUUID(),
      mentioned_participant_ids: [peers[0].identity.participant_id],
    });
    const cancelled = await peers[0].tool("island_wait_task", {
      wait_seconds: 10,
    });
    await service.adminRevoke(
      admin,
      peers[0].identity.node_id,
      "撤销宿主在途授权",
    );
    await waitFor(
      async () => !(await peers[0].tool("island_status")).connected,
      "撤销后宿主断开",
    );
    const stale = await peers[0].call("tools/call", {
      name: "island_complete_task",
      arguments: {
        task_id: cancelled.task_id,
        delivery_id: cancelled.delivery_id,
        result: { message: "不应写入" },
      },
    });
    expect(stale.result.isError).toBe(true);
    expect(
      (
        await pool.query("select status from agent_turns where id=$1", [
          cancelled.task_id,
        ])
      ).rows[0].status,
    ).toBe("cancelled");
    await expect(
      service.connect(peers[0].identity.token),
    ).rejects.toMatchObject({ status: 401 });
    expect((await peers[1].tool("island_status")).connected).toBe(true);
    expect(children[1].exitCode).toBeNull(); // 先前独立 CLI 仍在线，未被抢占或终止。
    expect(
      await service.adminRevoke(
        admin,
        peers[0].identity.node_id,
        "重复撤销验收",
      ),
    ).toMatchObject({ already_revoked: true });
  } finally {
    for (const peer of peers) {
      peer.child.stdin.end();
      peer.lines.close();
    }
    await pool.query("delete from admin_audit_logs where admin_id=$1", [admin]);
    await pool.query("delete from auth.users where id=$1", [admin]);
  }
}, 60000);

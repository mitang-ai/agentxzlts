import { it, expect } from "vitest";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  unlink,
  cp,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
// @ts-ignore Executable desktop module.
import {
  validateIdentityInput,
  permittedNavigation,
  publicStatus,
} from "../apps/desktop/src/security.mjs";
// @ts-ignore
import {
  installClient,
  withInstallLock,
} from "../apps/desktop/src/install.mjs";
// @ts-ignore
import { DesktopController } from "../apps/desktop/src/controller.mjs";

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const digest = (bytes: Buffer | string) =>
  createHash("sha256").update(bytes).digest("hex");
const require = createRequire(import.meta.url);
const installer = pathToFileURL(resolve("apps/desktop/src/install.mjs")).href;
async function filesBelow(root: string, folder = root): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const file = resolve(folder, entry.name);
    if (entry.isDirectory()) out.push(...(await filesBelow(root, file)));
    else if (entry.isFile()) out.push(file.slice(root.length + 1).replaceAll("\\", "/"));
    else throw Error("测试 payload 不得含符号链接");
  }
  return out;
}
async function fixture(full = false) {
  const root = await mkdtemp(resolve(tmpdir(), "island-desktop-")),
    payload = resolve(root, "payload"),
    home = resolve(root, "中文 用户 with spaces");
  await mkdir(payload, { recursive: true });
  await mkdir(home, { recursive: true });
  const write = async (path: string, content: string) => {
    await mkdir(dirname(resolve(payload, path)), { recursive: true });
    await writeFile(resolve(payload, path), content);
  };
  await write("CLIENT_VERSION.txt", "hub-1\n");
  await write("package.json", JSON.stringify({ type: "module" }));
  if (full) {
    await cp(resolve("packages/node"), resolve(payload, "packages/node"), { recursive: true });
    await cp(resolve("packages/agents"), resolve(payload, "packages/agents"), { recursive: true });
    const queue = ["ws", "proper-lockfile", "zod", "yauzl", "yazl"], seen = new Set<string>();
    while (queue.length) {
      const name = queue.shift()!;
      if (seen.has(name)) continue;
      seen.add(name);
      let packageFile: string;
      try { packageFile = require.resolve(name + "/package.json"); }
      catch (error: any) {
        if (error.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") throw error;
        let dir = dirname(require.resolve(name));
        while (true) {
          const candidate = resolve(dir, "package.json");
          const meta = await readFile(candidate, "utf8").then(JSON.parse).catch(() => null);
          if (meta?.name === name) { packageFile = candidate; break; }
          const parent = dirname(dir);
          if (parent === dir) throw Error("无法解析测试依赖 " + name);
          dir = parent;
        }
      }
      const meta = JSON.parse(await readFile(packageFile, "utf8"));
      await cp(dirname(packageFile), resolve(payload, "node_modules", name), { recursive: true });
      queue.push(...Object.keys(meta.dependencies || {}));
    }
  } else {
    await write("packages/node/bin/island-node.mjs", "console.log('fixture only')\n");
    await write("node_modules/ws/package.json", JSON.stringify({ name: "ws", version: "fixture" }));
    await write("node_modules/proper-lockfile/package.json", JSON.stringify({ name: "proper-lockfile", version: "fixture" }));
    await write("packages/node/src/io.mjs", await readFile(resolve("packages/node/src/io.mjs"), "utf8"));
  }
  const files: Record<string, string> = {};
  for (const file of await filesBelow(payload)) files[file] = digest(await readFile(resolve(payload, file)));
  const manifest = {
    schema: 1,
    clientProtocol: "hub-1",
    runtimeVersion: process.versions.node,
    runtimeSha256: digest(await readFile(process.execPath)),
    files,
  };
  await write("CLIENT_MANIFEST.json", JSON.stringify(manifest));
  return {
    root, payload, home, manifest,
    options: { payload, home, nodeSource: process.execPath, desktopExe: resolve(root, "协作岛.exe"), version: "0.4.0" },
  };
}
function child(code: string, args: string[] = []) {
  return new Promise<string>((yes, no) => {
    const p = spawn(process.execPath, ["--input-type=module", "-e", code, ...args], {
      stdio: ["ignore", "pipe", "pipe"], windowsHide: true, shell: false,
    });
    let output = "", error = "";
    p.stdout.on("data", (b) => { output += b; });
    p.stderr.on("data", (b) => { error += b; });
    p.once("error", no);
    p.once("exit", (code) => code === 0 ? yes(output) : no(Error(error || output || "子进程失败")));
  });
}
async function until(fn: () => Promise<boolean>, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await fn()) return;
    await pause(100);
  }
  throw Error("桌面端隔离测试超时");
}

it("桌面导航只允许既定站点，不接受脚本、本机文件、相似域名或用户信息", () => {
  const origin = "https://www.51wanai.com";
  expect(permittedNavigation(origin + "/", origin)).toBe(true);
  expect(permittedNavigation(origin + "/admin/users?tab=agents#one", origin)).toBe(
    true,
  );
  for (const url of [
    "javascript:alert(1)",
    "data:text/html,<script>1</script>",
    "file:///C:/Users/test/private.txt",
    "https://www.51wanai.com.evil.invalid/",
    "https://evil.invalid/?next=https://www.51wanai.com",
    "https://www.51wanai.com@evil.invalid/",
    "https://user:pass@www.51wanai.com/",
    "http://www.51wanai.com/",
    "https://www.51wanai.com:8443/",
    "island-desktop://run?command=cmd.exe",
    "about:blank",
    "not a URL",
  ])
    expect(permittedNavigation(url, origin), url).toBe(false);
});

it("本地 Agent 输入拒绝非法类型与陌生字段，不接受来自聊天的路径和凭据", () => {
  for (const input of [
    null,
    [],
    "run something",
    { config: "../outside/config.json" },
    { file: "C:\\Users\\test\\private.json" },
    { token: "private-token" },
    { authorization: "Bearer private-token" },
    { __proto__: { command: "cmd.exe" } },
    { adapter: "unknown", code: "FIXTURE-ONLY" },
    { adapter: "mcp", code: 42 },
    { adapter: "mcp", args: [null] },
  ])
    expect(() => validateIdentityInput(input), JSON.stringify(input)).toThrow();
});

it("桌面公开状态采用字段白名单，不传播服务器令牌、配对码或本机配置", () => {
  const raw = {
    pid: 123,
    running: true,
    token: "SECRET-DEVICE-TOKEN",
    secret: "SECRET-LOOPBACK-TOKEN",
    code: "SECRET-PAIRING-CODE",
    authorization: "Bearer SECRET-AUTH",
    workspace: "C:\\Users\\private\\workspace",
    command: "C:\\Users\\private\\agent.exe",
    config: { token: "SECRET-NESTED", api_key: "SECRET-MODEL-KEY" },
    agents: [
      {
        node_id: randomUUID(),
        token: "SECRET-AGENT-TOKEN",
        secret: "SECRET-AGENT-SECRET",
        workspace: "C:\\Users\\private\\workspace",
        file: "C:\\Users\\private\\config.json",
        enabled: true,
      },
    ],
  };
  const serialized = JSON.stringify(publicStatus(raw));
  expect(serialized).not.toContain("SECRET-");
  expect(serialized).not.toContain("Users");
  expect(serialized).not.toContain("Bearer");
});

it("完整安装锁跨进程串行，失败释放且活锁等待超时不抢占", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "island-desktop-lock-"));
  const events = resolve(root, "events.ndjson");
  const code = `import {withInstallLock} from ${JSON.stringify(installer)};
import {appendFile} from 'node:fs/promises';
const [base,events,id]=process.argv.slice(1);
await withInstallLock(base,async()=>{await appendFile(events,JSON.stringify({id,event:'begin'})+'\\n');await new Promise(r=>setTimeout(r,200));await appendFile(events,JSON.stringify({id,event:'end'})+'\\n')},{timeout:5000});`;
  try {
    await Promise.all([child(code, [root, events, "a"]), child(code, [root, events, "b"])]);
    const logged = (await readFile(events, "utf8")).trim().split("\n").map((x) => JSON.parse(x));
    expect(logged.map((x) => x.event)).toEqual(["begin", "end", "begin", "end"]);
    expect(logged[0].id).toBe(logged[1].id);
    expect(logged[2].id).toBe(logged[3].id);
    expect(logged[0].id).not.toBe(logged[2].id);
    await expect(withInstallLock(root, async () => { throw Error("fixture installation failed"); })).rejects.toThrow("fixture installation failed");
    await expect(withInstallLock(root, async () => 42)).resolves.toBe(42);
    let release!: () => void;
    const held = withInstallLock(root, () => new Promise<void>((r) => { release = r; }));
    await until(async () => Boolean(release));
    await expect(withInstallLock(root, async () => "must not execute", { timeout: 100 })).rejects.toThrow(/等待超时/);
    release();
    await held;
    expect(await stat(resolve(root, "client-install.lockdir")).catch(() => null)).toBeNull();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("完整安装锁拒绝链接并仅恢复明确已退出的锁持有者", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "island-desktop-lock-")),
    target = resolve(root, "target"), alias = resolve(root, "alias");
  await mkdir(target);
  try {
    await symlink(target, alias, process.platform === "win32" ? "junction" : "dir");
    await expect(withInstallLock(alias, async () => true)).rejects.toThrow(/链接|联接/);
    const pid = Number((await child("console.log(process.pid)")).trim());
    const lock = resolve(target, "client-install.lockdir");
    await mkdir(lock);
    await writeFile(resolve(lock, "owner.json"), JSON.stringify({ pid, nonce: randomUUID() }));
    await expect(withInstallLock(target, async () => "recovered")).resolves.toBe("recovered");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const runtimeTest = it.skipIf(Number(process.versions.node.split(".")[0]) < 22);

runtimeTest("中文带空格路径原子安装并复用专用 Node，重复安装保留身份与成果", async () => {
  const f = await fixture(), progress: any[] = [];
  try {
    const first = await installClient({ ...f.options, onProgress: (x: any) => progress.push(x) });
    expect(first.ready).toBe(true);
    expect(first.reused).toBe(false);
    expect(first.clientRoot).toBe(resolve(f.home, ".island-node/client"));
    expect(first.node).not.toBe(process.execPath);
    expect(digest(await readFile(first.node))).toBe(f.manifest.runtimeSha256);
    expect(progress[0].percent).toBe(0);
    expect(progress.at(-1).percent).toBe(100);
    expect(progress.every((x, i) => i === 0 || x.percent >= progress[i - 1].percent)).toBe(true);
    const config = resolve(first.clientRoot, ".data/connections", randomUUID(), "config.json");
    await mkdir(dirname(config), { recursive: true });
    const existing = JSON.stringify({ token: "FIXTURE-ONLY-TOKEN", workspace: resolve(f.root, "work") });
    await writeFile(config, existing);
    const artifact = resolve(first.clientRoot, ".data/results/kept.txt");
    await mkdir(dirname(artifact), { recursive: true });
    await writeFile(artifact, "retained result");
    const second = await installClient(f.options);
    expect(second.reused).toBe(true);
    expect(second.node).toBe(first.node);
    expect(await readFile(config, "utf8")).toBe(existing);
    expect(await readFile(artifact, "utf8")).toBe("retained result");
    const locator = JSON.parse(await readFile(resolve(f.home, ".island-node/desktop-install.json"), "utf8"));
    expect(locator.ready).toBe(true);
    expect(JSON.stringify(locator)).not.toContain("FIXTURE-ONLY-TOKEN");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

runtimeTest("两个进程同时首次安装仅一份 client，其余复用同一完整安装", async () => {
  const f = await fixture();
  try {
    const code = `import {installClient} from ${JSON.stringify(installer)};console.log(JSON.stringify(await installClient(JSON.parse(process.argv[1]))));`;
    const results = (await Promise.all([child(code, [JSON.stringify(f.options)]), child(code, [JSON.stringify(f.options)])])).map((text) => JSON.parse(text));
    expect(results.map((r) => r.reused).sort()).toEqual([false, true]);
    expect(results[0].clientRoot).toBe(results[1].clientRoot);
    expect((await readdir(resolve(f.home, ".island-node"))).filter((x) => x.startsWith("client-staging-"))).toEqual([]);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

runtimeTest("内置 manifest 缺项、越界、私有数据和散列不符均不产生就绪安装", async () => {
  const f = await fixture();
  try {
    const malformed = [
      { ...f.manifest, schema: 2 },
      { ...f.manifest, files: { ...f.manifest.files, "../outside.txt": digest("x") } },
      { ...f.manifest, files: { ...f.manifest.files, ".data/config.json": digest("x") } },
      { ...f.manifest, runtimeSha256: "0".repeat(64) },
      { ...f.manifest, files: { ...f.manifest.files, "packages/node/bin/island-node.mjs": "0".repeat(64) } },
      { ...f.manifest, files: { ...f.manifest.files, "node_modules/ws/package.json": undefined } },
    ];
    for (const manifest of malformed) {
      await writeFile(resolve(f.payload, "CLIENT_MANIFEST.json"), JSON.stringify(manifest));
      await expect(installClient(f.options)).rejects.toThrow();
      expect(await stat(resolve(f.home, ".island-node/client")).catch(() => null)).toBeNull();
      expect(await stat(resolve(f.home, ".island-node/desktop-install.json")).catch(() => null)).toBeNull();
    }
    await writeFile(resolve(f.payload, "CLIENT_MANIFEST.json"), JSON.stringify(f.manifest));
    expect((await installClient(f.options)).ready).toBe(true);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

runtimeTest("安装中断保留诊断但不标记成功，恢复后可完成且不复用半成品", async () => {
  const f = await fixture();
  try {
    await expect(installClient({ ...f.options, onProgress: (p: any) => {
      if (p.phase === "deploy" && p.percent < 90) throw Error("FIXTURE deploy interrupted");
    } })).rejects.toThrow("FIXTURE deploy interrupted");
    const base = resolve(f.home, ".island-node");
    expect(await stat(resolve(base, "desktop-install.json")).catch(() => null)).toBeNull();
    expect(await stat(resolve(base, "client")).catch(() => null)).toBeNull();
    const diagnostics = (await readdir(base)).filter((x) => x.startsWith("client-staging-"));
    expect(diagnostics.length).toBe(1);
    const repaired = await installClient(f.options);
    expect(repaired.ready).toBe(true);
    expect(repaired.reused).toBe(false);
    expect((await readdir(base)).filter((x) => x.startsWith("client-staging-"))).toEqual(diagnostics);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

runtimeTest("既有错误版本、损坏组件与运行时不被覆盖且不冒充ready", async () => {
  const f = await fixture();
  try {
    const first = await installClient(f.options);
    const core = resolve(first.clientRoot, "packages/node/bin/island-node.mjs"),
      marker = resolve(first.clientRoot, "CLIENT_VERSION.txt");
    const coreBytes = await readFile(core), markerBytes = await readFile(marker);
    await writeFile(marker, "hub-unrecognized\n");
    await expect(installClient(f.options)).rejects.toThrow(/版本不兼容/);
    expect(await readFile(marker, "utf8")).toBe("hub-unrecognized\n");
    expect(await readFile(core)).toEqual(coreBytes);
    await writeFile(marker, markerBytes);
    await writeFile(core, "corrupted core");
    await expect(installClient(f.options)).rejects.toThrow(/校验|损坏|完整/);
    expect(await readFile(core, "utf8")).toBe("corrupted core");
    await writeFile(core, coreBytes);
    await writeFile(first.node, "corrupted private runtime");
    await expect(installClient(f.options)).rejects.toThrow(/运行时校验/);
    expect(await readFile(first.node, "utf8")).toBe("corrupted private runtime");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

runtimeTest("本机管理status只读且不自行安装；控制只能使用当前registry所属身份", async () => {
  const f = await fixture(true);
  const origin = "https://www.51wanai.com";
  const controller = new DesktopController({ ...f.options, origin });
  let commands = 0;
  controller.run = async () => { commands++; return ""; };
  try {
    expect((await controller.status()).installed).toBe(false);
    expect(await stat(resolve(f.home, ".island-node")).catch(() => null)).toBeNull();
    await controller.prepare();
    const root = controller.clientRoot,
      id = randomUUID(), other = randomUUID(),
      file = resolve(root, ".data/connections", id, "config.json"),
      registry = resolve(root, ".data/hub/registry.json"),
      outside = resolve(f.root, "outside/config.json");
    await mkdir(dirname(file), { recursive: true });
    await mkdir(dirname(registry), { recursive: true });
    await mkdir(dirname(outside), { recursive: true });
    const config = { node_id: id, hub_root: root, token: "PRIVATE-FIXTURE-TOKEN", adapter: "mcp", workspace: resolve(f.root, "workspace"), server: origin, agent_name: "fixture agent" };
    await writeFile(file, JSON.stringify(config));
    await writeFile(outside, JSON.stringify(config));
    const saveRegistry = (file: string, nodeId = id) => writeFile(registry, JSON.stringify({ version: "hub-1", agents: [{ file, node_id: nodeId, enabled: false }] }));
    await saveRegistry(outside);
    await expect(controller.status()).rejects.toThrow(/独立连接配置/);
    await expect(controller.startIdentity(id)).rejects.toThrow(/独立连接配置/);
    expect(commands).toBe(0);
    await saveRegistry(file, other);
    await expect(controller.status()).rejects.toThrow(/身份记录不匹配/);
    await saveRegistry(file);
    const result = await controller.status();
    expect(result.installed).toBe(true);
    expect(result.identities[0].node_id).toBe(id);
    expect(JSON.stringify(result)).not.toContain("PRIVATE-FIXTURE-TOKEN");
    expect(JSON.stringify(result)).not.toContain(f.root.replaceAll("\\", "\\\\"));
    await expect(controller.startIdentity(other)).rejects.toThrow(/不属于/);
    await expect(controller.stopIdentity("../outside/config.json")).rejects.toThrow(/无效/);
    expect(commands).toBe(0);
    await writeFile(file, JSON.stringify({ ...config, server: "https://other.invalid" }));
    expect((await controller.status()).identities).toEqual([]);
    await expect(controller.startIdentity(id)).rejects.toThrow(/不属于/);
    expect(commands).toBe(0);
  } finally { await rm(f.root, { recursive: true, force: true }); }
// Windows validates 805 SDK files; filesystem/antivirus overhead is not a business wait.
}, 120000);

runtimeTest("并发添加只配对一次，重复启动复用Hub，停止单个身份不终止后台", async () => {
  const f = await fixture(true), server = createServer(), wire = new WebSocketServer({ server });
  const nodeId = randomUUID(), token = "FIXTURE-DESKTOP-TOKEN-" + randomUUID();
  let pairs = 0, connections = 0;
  server.on("request", async (req, res) => {
    if (req.url !== "/api/agent-node/pair") return res.writeHead(404).end();
    let body = "";
    for await (const bytes of req) body += bytes;
    const input = JSON.parse(body);
    expect(input.code).toBe("DESKTOP-FIXTURE-ONLY");
    pairs++;
    await pause(150);
    res.writeHead(pairs === 1 ? 200 : 409, { "content-type": "application/json" }).end(JSON.stringify(pairs === 1 ? { node_id: nodeId, token } : { error: "fixture code already used" }));
  });
  wire.on("connection", (socket, req) => {
    if (req.headers.authorization !== "Bearer " + token) return socket.close();
    connections++;
    socket.send(JSON.stringify({ type: "welcome", data: { state: "platform", room_id: null } }));
    socket.on("message", (bytes) => {
      const p = JSON.parse(bytes.toString());
      socket.send(JSON.stringify({ type: "result", request_id: p.request_id, data: p.type === "sync" ? { state: "platform", room_id: null, muted: false, cursor: 0 } : null }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(server.address() as any).port}`,
    controller = new DesktopController({ ...f.options, origin });
  try {
    const base = { server: origin, code: "DESKTOP-FIXTURE-ONLY", adapter: "mcp", name: "fixture manual agent", allowDevelopment: false };
    const attempts = await Promise.allSettled([
      controller.addIdentity({ ...base, workspace: resolve(f.root, "work one") }),
      controller.addIdentity({ ...base, workspace: resolve(f.root, "work two") }),
    ]);
    expect(attempts.filter((x) => x.status === "fulfilled"), attempts.map((x) => x.status === "rejected" ? String(x.reason) : "paired").join("\n")).toHaveLength(1);
    const rejected = attempts.find((x) => x.status === "rejected") as PromiseRejectedResult;
    expect(String(rejected.reason)).toMatch(/正在连接|等待完成/);
    expect(pairs).toBe(1);
    await until(async () => Boolean((await controller.status()).hub.running));
    const before = await controller.status();
    expect(before.identities).toHaveLength(1);
    expect(before.identities[0].connected).toBe(true);
    expect(JSON.stringify(before)).not.toContain(token);
    await controller.startIdentity(nodeId);
    const after = await controller.status();
    expect(after.hub.pid).toBe(before.hub.pid);
    expect(connections).toBe(1);
    await controller.stopIdentity(nodeId);
    await until(async () => !(await controller.status()).identities[0].running);
    expect((await controller.status()).hub.pid).toBe(before.hub.pid);
    expect((await controller.status()).hub.running).toBe(true);
    await controller.startIdentity(nodeId);
    expect((await controller.status()).hub.pid).toBe(before.hub.pid);
    expect(pairs).toBe(1);
    expect(connections).toBe(2);
  } finally {
    try {
      const sdk = await controller.sdk(), registry = resolve(controller.clientRoot, ".data/hub/registry.json");
      if ((await sdk.runtimeStatus(registry))?.running) await sdk.controlRequest(registry, "stop");
      await until(async () => !(await sdk.runtimeStatus(registry)), 10000);
    } finally {
      for (const socket of wire.clients) socket.terminate();
      await new Promise<void>((r) => wire.close(() => r()));
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await rm(f.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }
}, 120000);

runtimeTest("旧Hub无manifest可只读复用，但损坏CLI不能标为可用或覆盖原文件", async () => {
  const f = await fixture(true);
  try {
    const installed = await installClient(f.options),
      cli = resolve(installed.clientRoot, "packages/node/bin/island-node.mjs");
    await unlink(resolve(installed.clientRoot, "CLIENT_MANIFEST.json"));
    const cliBytes = await readFile(cli);
    const reused = await installClient(f.options);
    expect(reused.ready).toBe(true);
    expect(reused.reused).toBe(true);
    expect(await readFile(cli)).toEqual(cliBytes);
    await writeFile(cli, "");
    await expect(installClient(f.options)).rejects.toThrow(/损坏|完整|CLI|客户端/);
    expect(await readFile(cli, "utf8")).toBe("");
  } finally { await rm(f.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
}, 120000);

runtimeTest("既有MCP身份在GUI准备完成前请求配置，先验证并绑定专用Node而非复制空command", async () => {
  const f = await fixture(true), origin = "https://www.51wanai.com";
  try {
    const installed = await installClient(f.options), id = randomUUID(),
      file = resolve(installed.clientRoot, ".data/connections", id, "config.json"),
      registry = resolve(installed.clientRoot, ".data/hub/registry.json");
    await mkdir(dirname(file), { recursive: true });
    await mkdir(dirname(registry), { recursive: true });
    await writeFile(file, JSON.stringify({ node_id: id, hub_root: installed.clientRoot, token: "FIXTURE-MCP-TOKEN-ONLY", server: origin, adapter: "mcp", workspace: resolve(f.root, "mcp-work"), host_name: "fixture" }));
    await writeFile(registry, JSON.stringify({ version: "hub-1", agents: [{ node_id: id, file, enabled: false }] }));
    const controller = new DesktopController({ ...f.options, origin });
    expect(controller.node).toBeUndefined();
    expect((await controller.status()).installed).toBe(true);
    const raw = await controller.mcpConfiguration(id), entry = JSON.parse(raw).mcpServers["island-" + id];
    expect(entry.command).toBe(installed.node);
    expect(entry.command).not.toBe(process.execPath);
    expect(entry.args).toEqual([resolve(installed.clientRoot, "packages/node/bin/island-node.mjs"), "mcp", "--config", await realpath(file)]);
    expect(raw).not.toContain("FIXTURE-MCP-TOKEN-ONLY");
    expect(await stat(registry + ".control.json").catch(() => null)).toBeNull();
  } finally { await rm(f.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
}, 120000);

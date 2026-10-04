import { it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
// @ts-ignore Executable client.
import { LocalHub, hubConfig, hubFile } from "../packages/node/src/hub.mjs";
// @ts-ignore
import { writeJSON, readJSON } from "../packages/node/src/io.mjs";
// @ts-ignore
import {
  controlRequest,
  runtimeStatus,
} from "../packages/node/src/runtime.mjs";
async function until(fn: () => Promise<boolean>) {
  for (let i = 0; i < 150; i++) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error("统一客户端验收超时");
}

it("统一客户端中两个真实执行器各自接收/回传，重复注册不重复连接，单独停止和重启互不干扰", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "island-hub-")),
    server = createServer(),
    wire = new WebSocketServer({ server });
  const ids = [randomUUID(), randomUUID()],
    files = ids.map((id) =>
      resolve(root, ".data/connections", id, "config.json"),
    );
  const jobs = ids.map(() => ({
    id: randomUUID(),
    room_id: randomUUID(),
    lease: "HUB-FIXTURE-LEASE-ONLY",
    kind: "mention",
    input: { instruction: "回答" },
    participants: [],
    messages: [],
    hard_deadline: new Date(Date.now() + 90000).toISOString(),
  }));
  const claimed = new Set(),
    completed = new Map(),
    connections = [0, 0];
  let queued = false,
    hub: any;
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  wire.on("connection", (socket, req) => {
    const index = ids.indexOf(
      String(req.headers.authorization).replace("Bearer ", ""),
    );
    if (index < 0) {
      socket.close();
      return;
    }
    connections[index]++;
    socket.send(
      JSON.stringify({
        type: "welcome",
        data: {
          state: "approved",
          room_id: jobs[index].room_id,
          participant_id: randomUUID(),
        },
      }),
    );
    socket.on("message", (bytes) => {
      const p = JSON.parse(bytes.toString());
      const data =
        p.type === "sync"
          ? { state: "approved", muted: false, cursor: 0 }
          : p.type === "claim" && queued && !claimed.has(index)
            ? (claimed.add(index), jobs[index])
            : p.type === "complete"
              ? (completed.set(index, p.data.result), { ok: true })
              : null;
      socket.send(
        JSON.stringify({ type: "result", request_id: p.request_id, data }),
      );
    });
  });
  try {
    for (let i = 0; i < 2; i++) {
      const workspace = resolve(root, "workspaces", ids[i]);
      await mkdir(workspace, { recursive: true });
      const agent = resolve(workspace, "agent.mjs");
      await writeFile(
        agent,
        `if(process.argv.includes('--version'))console.log('fixture');else{for await(const b of process.stdin){}console.log(JSON.stringify({message:'独立回应${i}',acknowledge:false,done:true}))}`,
      );
      await writeJSON(files[i], {
        hub_root: root,
        node_id: ids[i],
        token: ids[i],
        server: `http://127.0.0.1:${(server.address() as any).port}`,
        adapter: "cli",
        command: process.execPath,
        args: [agent],
        workspace,
        host_name: "fixture" + i,
        agent_name: "独立身份" + i,
      });
    }
    hub = new LocalHub(root);
    await hub.start();
    await Promise.all(
      files.map((file) => controlRequest(hubFile(root), "register", { file })),
    );
    await until(
      async () =>
        (await runtimeStatus(files[0]))?.connected &&
        (await runtimeStatus(files[1]))?.connected,
    );
    expect((await runtimeStatus(files[0])).pid).toBe(
      (await runtimeStatus(files[1])).pid,
    );
    await controlRequest(hubFile(root), "register", { file: files[0] });
    expect(connections).toEqual([1, 1]);
    queued = true;
    await until(async () => completed.size === 2);
    expect(completed.get(0).message).toBe("独立回应0");
    expect(completed.get(1).message).toBe("独立回应1");
    expect(hub.workers.get(ids[0]).node.privateDir).not.toBe(
      hub.workers.get(ids[1]).node.privateDir,
    );
    await controlRequest(files[0], "stop");
    await until(async () => !(await runtimeStatus(files[0])));
    expect((await runtimeStatus(files[1])).connected).toBe(true);
    expect(
      (await readJSON(hubFile(root))).agents.find(
        (a: any) => a.node_id === ids[0],
      ).enabled,
    ).toBe(false);
    await hub.stop();
    hub = new LocalHub(root);
    await hub.start();
    await until(async () =>
      Boolean((await runtimeStatus(files[1]))?.connected),
    );
    expect(await runtimeStatus(files[0])).toBeNull();
    expect(connections).toEqual([1, 2]);
    await controlRequest(hubFile(root), "register", { file: files[0] });
    await until(async () =>
      Boolean((await runtimeStatus(files[0]))?.connected),
    );
    expect(connections).toEqual([2, 2]);
    const status = await controlRequest(hubFile(root), "status");
    expect(JSON.stringify(status)).not.toContain('"token"');
    const before = await readJSON(files[0]);
    await writeJSON(files[0], { ...before, adapter: "mcp" });
    await expect(
      controlRequest(hubFile(root), "register", { file: files[0] }),
    ).rejects.toThrow(/不替换/);
    await writeJSON(files[0], before);
    const badId = randomUUID(),
      bad = resolve(root, ".data/connections", badId, "config.json");
    await writeJSON(bad, {
      ...before,
      node_id: badId,
      token: "different-fixture-token",
    });
    await expect(
      controlRequest(hubFile(root), "register", { file: bad }),
    ).rejects.toThrow(/互不重叠/);
    const badWorkspace = resolve(root, "workspaces", badId);
    await mkdir(badWorkspace);
    await writeJSON(bad, {
      ...before,
      node_id: badId,
      token: "different-fixture-token",
      workspace: badWorkspace,
      command: resolve(root, "missing-agent-executable"),
    });
    await controlRequest(hubFile(root), "register", { file: bad });
    await until(async () => {
      const state = (await controlRequest(hubFile(root), "status")).agents.find(
        (a: any) => a.node_id === badId,
      );
      return state && !state.running && !state.enabled && Boolean(state.error);
    });
    expect((await runtimeStatus(files[1])).connected).toBe(true);
    const control = await readJSON(hubFile(root) + ".control.json");
    const url = `http://127.0.0.1:${control.port}/register`;
    expect(
      (
        await fetch(url, {
          method: "POST",
          body: JSON.stringify({ file: files[0] }),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(url, {
          method: "POST",
          headers: {
            authorization: "Bearer " + control.secret,
            origin: "https://attacker.invalid",
          },
          body: "{}",
        })
      ).status,
    ).toBe(403);
    await expect(
      controlRequest(hubFile(root), "register", {
        file: resolve(root, "outside.json"),
      }),
    ).rejects.toThrow(/只接受/);
  } finally {
    await hub?.stop();
    for (const socket of wire.clients) socket.terminate();
    await new Promise<void>((r) => wire.close(() => r()));
    server.close();
    await rm(root, { recursive: true, force: true });
  }
}, 40000);

it("统一客户端拒绝配置父目录链接和非专属身份，不能越界导入其它安装", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "island-hub-path-")),
    outside = await mkdtemp(resolve(tmpdir(), "island-hub-outside-"));
  try {
    const id = randomUUID();
    await mkdir(resolve(root, ".data/connections"), { recursive: true });
    await symlink(
      outside,
      resolve(root, ".data/connections", id),
      process.platform === "win32" ? "junction" : "dir",
    );
    await writeJSON(resolve(outside, "config.json"), {
      hub_root: root,
      node_id: id,
      token: "fixture",
    });
    await expect(
      hubConfig(root, resolve(root, ".data/connections", id, "config.json")),
    ).rejects.toThrow(/符号链接/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

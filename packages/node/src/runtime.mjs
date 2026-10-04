import { createServer } from "node:http";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { open, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";
import { readJSON, writeJSON, protectDirectory } from "./io.mjs";
import { boundedError } from "../../agents/protocol.mjs";

export async function controlRequest(
  file,
  action,
  data = {},
  { signal, timeout = 30000, instance } = {},
) {
  const control = await readJSON(file + ".control.json");
  if (
    !control ||
    !Number.isInteger(control.port) ||
    control.port < 1 ||
    control.port > 65535 ||
    !/^[a-f0-9]{64}$/.test(control.secret) ||
    typeof control.instance !== "string"
  )
    throw Error(
      "此客户端没有有效的本机管理接口；旧版请用原启动窗口或管理脚本停止。",
    );
  if (instance && control.instance !== instance)
    throw Error(
      "本机连接已重启，请重启专属 MCP 服务并使用新的对话，不能复用旧上下文。",
    );
  if (
    ![
      "status",
      "stop",
      "wait",
      "complete",
      "fail",
      "leave",
      "register",
    ].includes(action)
  )
    throw Error("未知本机操作。");
  const response = await fetch(`http://127.0.0.1:${control.port}/${action}`, {
    method: "POST",
    redirect: "error",
    headers: {
      authorization: "Bearer " + control.secret,
      "content-type": "application/json",
    },
    body: JSON.stringify(data),
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(timeout)])
      : AbortSignal.timeout(timeout),
  });
  if (response.headers.get("x-island-instance") !== control.instance)
    throw Error("本机管理进程身份不匹配，不操作其它进程。");
  const result = await response.json();
  if (!response.ok) throw Error(result.error || "本机管理操作失败。");
  return result;
}
export async function runtimeStatus(file) {
  try {
    return await controlRequest(file, "status", {}, { timeout: 1500 });
  } catch {
    return null;
  }
}

// 一个配置一个常驻连接；MCP stdio 是轻量代理，各聊天不再争抢设备进程锁。
// 管理接口只绑定回环随机端口，使用用户私有目录中的随机令牌；不按进程名/PID杀进程。
export async function serveRuntime(node, file) {
  const instance = randomUUID(),
    secret = randomBytes(32).toString("hex");
  const deliveries = new Map();
  const consumerRooms = new Map();
  let owner = null,
    waiting = null,
    inflight = 0;
  node.onRoomChanged = async () => {
    waiting?.abort();
    owner = null;
    deliveries.clear();
    await node.adapter.disconnect();
  };
  const server = createServer(async (req, res) => {
    const send = (status, value) => {
      if (!res.destroyed)
        res
          .writeHead(status, {
            "content-type": "application/json",
            "cache-control": "no-store",
            "x-island-instance": instance,
          })
          .end(JSON.stringify(value));
    };
    const header = Buffer.from(String(req.headers.authorization || "")),
      expected = Buffer.from("Bearer " + secret);
    if (
      req.method !== "POST" ||
      req.headers.origin ||
      header.length !== expected.length ||
      !timingSafeEqual(header, expected)
    ) {
      send(403, { error: "本机管理授权无效。" });
      return;
    }
    if (++inflight > 16) {
      inflight--;
      send(429, { error: "本机调用过多。" });
      return;
    }
    const controller = new AbortController();
    res.once("close", () => {
      if (!res.writableEnded) controller.abort();
    });
    try {
      let body = "";
      for await (const bytes of req) {
        body += bytes;
        if (Buffer.byteLength(body) > 65536) throw Error("本机请求过大。");
      }
      const data = JSON.parse(body || "{}");
      const status = () => ({
        ...node.connectionStatus,
        running: !node.stopped,
        connected:
          !node.stopped &&
          Boolean(node.connectionStatus.connected) &&
          Date.now() -
            new Date(node.connectionStatus.last_sync_at || 0).getTime() <
            45000,
        automatic: node.config.adapter !== "mcp",
        listening:
          node.config.adapter !== "mcp" ||
          node.adapter.accepting() ||
          Boolean(node.active && node.adapter.processing(node.active.job.id)),
        consumer_busy: owner !== null,
      });
      if (req.url === "/status") send(200, status());
      else if (req.url === "/stop") {
        send(200, { stopped: true });
        node.stop();
      } else {
        if (node.config.adapter !== "mcp" || node.stopped)
          throw Error("此设备不是可用的手动 MCP 连接。");
        const consumer = data.consumer;
        if (typeof consumer !== "string" || !/^[a-f0-9-]{36}$/i.test(consumer))
          throw Error("无效的宿主会话标识。");
        if (req.url === "/leave") {
          if (owner === consumer) {
            waiting?.abort();
            const pending = node.adapter.pending;
            if (pending)
              node.adapter.fail(
                pending.job.id,
                pending.delivery,
                "领取任务的宿主对话已退出，本轮停止。",
              );
            owner = null;
          }
          send(200, { ok: true });
        } else if (req.url === "/wait") {
          if (
            !status().connected ||
            node.connectionStatus.state !== "approved" ||
            node.connectionStatus.muted
          ) {
            send(200, null);
            return;
          }
          const room = node.connectionStatus.room_id;
          if (
            consumerRooms.has(consumer) &&
            consumerRooms.get(consumer) !== room
          )
            throw Error(
              "房间已切换；请重启专属 MCP 服务并新建对话，旧对话不能领取新房间任务。",
            );
          if (!consumerRooms.has(consumer) && consumerRooms.size >= 512)
            throw Error("本机宿主会话记录达到上限，请在空闲时重启此客户端。");
          consumerRooms.set(consumer, room);
          if ((owner && owner !== consumer) || waiting)
            throw Error("此设备已有对话领取或等待任务；不会抢占、重复投递。");
          if (
            !Number.isInteger(data.seconds) ||
            data.seconds < 1 ||
            data.seconds > 25
          )
            throw Error("等待时长无效。");
          owner = consumer;
          waiting = controller;
          try {
            const task = await node.adapter.waitTask(
              data.seconds,
              controller.signal,
            );
            if (task) {
              deliveries.set(task.task_id, consumer);
              if (deliveries.size > 100)
                deliveries.delete(deliveries.keys().next().value);
            } else owner = null;
            send(200, task);
          } finally {
            waiting = null;
          }
        } else if (req.url === "/complete" || req.url === "/fail") {
          if (deliveries.get(data.task_id) !== consumer)
            throw Error("任务属于另一个宿主对话，不能代答。");
          const result =
            req.url === "/complete"
              ? await node.adapter.complete(
                  data.task_id,
                  data.delivery_id,
                  data.result,
                )
              : node.adapter.fail(data.task_id, data.delivery_id, data.error);
          if (owner === consumer) owner = null;
          send(200, result);
        } else send(404, { error: "本机操作不存在。" });
      }
    } catch (error) {
      send(409, { error: boundedError(error) });
    } finally {
      inflight--;
    }
  });
  server.requestTimeout = 35000;
  server.headersTimeout = 5000;
  await new Promise((yes, no) => {
    server.once("error", no);
    server.listen(0, "127.0.0.1", yes);
  });
  try {
    await writeJSON(file + ".control.json", {
      instance,
      secret,
      port: server.address().port,
    });
  } catch (error) {
    server.close();
    throw error;
  }
  return async () => {
    waiting?.abort();
    server.close();
    server.closeAllConnections();
    const current = await readJSON(file + ".control.json");
    if (current?.instance === instance) await unlink(file + ".control.json");
  };
}

export async function startBackground(
  file,
  entry,
  { waitConnected = true, timeout = 15000 } = {},
) {
  if ((await readJSON(file))?.hub_root) {
    const { startHubAgent } = await import("./hub.mjs");
    return startHubAgent(file, entry, { waitConnected, timeout });
  }
  const current = await runtimeStatus(file);
  if (current?.running && (!waitConnected || current.connected)) return current;
  let child;
  if (!current?.running) {
    const log = file + ".runtime.log";
    await protectDirectory(dirname(file));
    const output = await open(log, "a", 0o600);
    try {
      child = spawn(
        process.execPath,
        [entry, "start", "--managed", "--config", resolve(file)],
        {
          cwd: resolve(dirname(entry), "../../.."),
          detached: true,
          windowsHide: true,
          stdio: ["ignore", output.fd, output.fd],
        },
      );
      await new Promise((yes, no) => {
        child.once("spawn", yes);
        child.once("error", no);
      });
      child.unref();
    } finally {
      await output.close();
    }
  }
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const status = await runtimeStatus(file);
    if (status?.running && (!waitConnected || status.connected)) return status;
    if (child && child.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw Error(
    "常驻客户端尚未确认连接成功。请用 status/doctor 查看本机日志；不会另建身份或伪报在线。",
  );
}

export async function hostProxy(file, config, entry) {
  await startBackground(file, entry, { waitConnected: false });
  const consumer = randomUUID();
  const { instance } = await readJSON(file + ".control.json");
  const call = (action, data = {}, options = {}) =>
    controlRequest(file, action, data, { ...options, instance });
  const node = {
    config,
    stopped: false,
    connectionStatus: {},
    async getStatus() {
      try {
        return await call("status", {}, { timeout: 1500 });
      } catch {
        return {
          connected: false,
          running: false,
          listening: false,
          state: "disconnected",
        };
      }
    },
    stop() {
      this.stopped = true;
      void call("leave", { consumer }).catch(() => {});
    },
    adapter: {
      waitTask(seconds, signal) {
        return call("wait", { consumer, seconds }, { signal, timeout: 30000 });
      },
      complete(task_id, delivery_id, result) {
        return call("complete", { consumer, task_id, delivery_id, result });
      },
      fail(task_id, delivery_id, error) {
        return call("fail", { consumer, task_id, delivery_id, error });
      },
    },
  };
  return node;
}

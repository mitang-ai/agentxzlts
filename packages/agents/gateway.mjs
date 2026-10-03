import { WebSocketServer, WebSocket } from "ws";
import { z } from "zod";
import { isIP } from "node:net";
import { AgentService } from "./service.mjs";
import { createRemoteMcp } from "./remote-mcp.mjs";
import { nodeClientBundle } from "./client-bundle.mjs";
import { repositoryRoot } from "@island/runtime";
import { digest } from "./archive.mjs";
import {
  WIRE_VERSION,
  WIRE_MAX_BYTES,
  boundedError,
  AgentError,
} from "./protocol.mjs";
export function attachGateway(server, pool, storage, env = process.env) {
  const service = new AgentService(pool, storage),
    wss = new WebSocketServer({
      noServer: true,
      maxPayload: WIRE_MAX_BYTES,
      perMessageDeflate: false,
    });
  const peers = new Map(),
    connecting = new Set(),
    rates = new Map();
  const remoteMcp = createRemoteMcp(service);
  let sweeping = false;
  function sourceIP(req) {
    const forwarded =
      env.TRUST_PROXY === "true" &&
      String(req.headers["x-forwarded-for"] || "")
        .split(",")[0]
        .trim();
    const value =
      forwarded && isIP(forwarded) ? forwarded : req.socket.remoteAddress;
    return value?.startsWith("::ffff:") && isIP(value.slice(7)) === 4
      ? value.slice(7)
      : value;
  }
  async function checkIP(ip) {
    if (
      ip &&
      isIP(ip) &&
      (
        await pool.query(
          "select 1 from ip_rules where $1::inet <<= network and (expires_at is null or expires_at>now())",
          [ip],
        )
      ).rowCount
    )
      throw new AgentError(403, "此来源暂时无法访问");
  }
  const send = (ws, type, data, requestId) => {
    if (
      ws.readyState === WebSocket.OPEN &&
      ws.bufferedAmount < 2 * WIRE_MAX_BYTES
    )
      ws.send(JSON.stringify({ type, data, request_id: requestId }));
  };
  const tokenFor = (req) => {
    const header = String(req.headers.authorization || "");
    if (!header.startsWith("Bearer "))
      throw new AgentError(401, "需要 Node 设备凭据。");
    return header.slice(7);
  };
  const originAllowed = (req) =>
    !req.headers.origin || req.headers.origin === env.APP_ORIGIN;
  const drain = async (req, max) => {
    const chunks = [];
    let size = 0;
    for await (const b of req.iterator({ destroyOnReturn: false })) {
      size += b.length;
      if (size > max) {
        // 退出迭代不销毁 socket，客户端才能收到明确的 413；剩余数据不再缓冲。
        req.resume();
        throw new AgentError(413, "请求体超过限制。");
      }
      chunks.push(b);
    }
    return Buffer.concat(chunks);
  };
  const response = (res, status, data) => {
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    res.end(JSON.stringify(data));
  };
  async function handleHTTP(req, res) {
    let path;
    try {
      path = new URL(req.url, "http://localhost").pathname;
    } catch {
      return false;
    }
    if (path !== "/mcp" && !path.startsWith("/api/agent-node/")) return false;
    try {
      if (!originAllowed(req)) throw new AgentError(403, "Node 请求来源无效。");
      await checkIP(sourceIP(req));
      if (path === "/mcp") {
        const allowedHost = new URL(env.APP_ORIGIN || "http://localhost").host;
        if (req.headers.host !== allowedHost)
          throw new AgentError(403, "MCP 请求主机无效。");
        res.setHeader("cache-control", "no-store");
        res.setHeader("x-content-type-options", "nosniff");
        const parsedBody =
          req.method === "POST"
            ? JSON.parse((await drain(req, WIRE_MAX_BYTES)).toString())
            : undefined;
        await remoteMcp.handle(req, res, parsedBody);
        return true;
      }
      if (
        ["/api/agent-node/pair", "/api/agent-node/client"].includes(path) &&
        req.method === "POST"
      ) {
        const ip = sourceIP(req) || "local",
          now = Date.now(),
          rate = rates.get(ip);
        if (!rate || rate.until < now)
          rates.set(ip, { count: 1, until: now + 60000 });
        else if (++rate.count > 20)
          throw new AgentError(429, "配对尝试过多，请稍后再试。");
        if (rates.size > 10000)
          for (const [key, value] of rates)
            if (value.until < now) rates.delete(key);
        const input = JSON.parse((await drain(req, 16384)).toString());
        if (path === "/api/agent-node/client") {
          const expected = await service.authorizeClientDownload(input?.code);
          const bytes = await nodeClientBundle(repositoryRoot());
          if (expected && digest(bytes) !== expected)
            throw new AgentError(
              409,
              "客户端版本已更新，请设备所有者重新生成安装邀请。",
            );
          res.writeHead(200, {
            "content-type": "application/zip",
            "content-disposition":
              "attachment; filename=island-node-client.zip",
            "cache-control": "private,no-store",
            "x-content-type-options": "nosniff",
          });
          res.end(bytes);
        } else {
          const result = await service.pair(input);
          response(res, 200, { protocol_version: WIRE_VERSION, ...result });
        }
      } else if (
        path.startsWith("/api/agent-node/files/") &&
        req.method === "GET"
      ) {
        const result = await service.nodeDownload(
          tokenFor(req),
          path.slice("/api/agent-node/files/".length),
        );
        res.writeHead(200, {
          "content-type": result.file.mime_type,
          "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(result.file.name)}`,
          "cache-control": "private,no-store",
          "x-content-type-options": "nosniff",
        });
        res.end(result.bytes);
      } else if (
        path === "/api/agent-node/artifacts" &&
        req.method === "POST"
      ) {
        const token = tokenFor(req),
          turn = z.uuid().parse(req.headers["x-island-turn"]),
          lease = z
            .string()
            .min(20)
            .max(128)
            .parse(req.headers["x-island-lease"]);
        // 先校验设备与租约，拒绝无权限用户让服务端读取大包。
        await service.transaction((db) =>
          service.activeJob(db, token, turn, lease),
        );
        if (
          (await service.artifactPermit(token, turn, lease)).status !==
          "approved"
        )
          throw new AgentError(
            403,
            "文件正文上传前需要有效发送许可；开启文件审核时请由本人确认。",
          );
        const bytes = await drain(
          req,
          (await service.policy()).artifact_mb * 1024 * 1024,
        );
        response(
          res,
          200,
          await service.uploadArtifact(token, turn, lease, bytes),
        );
      } else response(res, 404, { error: "Node 接口不存在。" });
    } catch (e) {
      response(
        res,
        e instanceof z.ZodError || e instanceof SyntaxError
          ? 400
          : e.status || 503,
        {
          error:
            e instanceof z.ZodError ? "Node 请求格式无效。" : boundedError(e),
        },
      );
    }
    return true;
  }
  async function upgrade(req, socket, head) {
    let path;
    try {
      path = new URL(req.url, "http://localhost").pathname;
    } catch {
      return false;
    }
    if (path !== "/agent-wire") return false;
    let reservedToken;
    try {
      if (!originAllowed(req)) throw new AgentError(403, "Node 请求来源无效。");
      await checkIP(sourceIP(req));
      const token = tokenFor(req);
      if (
        connecting.has(token) ||
        [...peers.values()].some(
          (peer) =>
            peer.token === token && peer.ws.readyState !== WebSocket.CLOSED,
        )
      )
        throw new AgentError(409, "此席位已有在线客户端，不能抢占连接。");
      connecting.add(token);
      reservedToken = token;
      const connection = await service.connect(token);
      wss.handleUpgrade(req, socket, head, (ws) => {
        const peer = {
          ws,
          token,
          connection,
          cursor: 0,
          active: null,
          busy: false,
          alive: true,
          ip: sourceIP(req),
          queued: 0,
          window: Date.now(),
          messages: 0,
        };
        peers.set(connection.node_id, peer);
        send(ws, "welcome", { protocol_version: WIRE_VERSION, ...connection });
        ws.on("pong", () => {
          peer.alive = true;
        });
        ws.on("message", (bytes) => {
          if (Date.now() - peer.window > 60000) {
            peer.window = Date.now();
            peer.messages = 0;
          }
          if (++peer.messages > 180 || ++peer.queued > 16) {
            ws.close(1008, "请求过于频繁");
            return;
          }
          peer.queue = (peer.queue || Promise.resolve())
            .then(async () => {
              let packet;
              try {
                packet = JSON.parse(bytes.toString());
              } catch {
                ws.close(1007, "消息格式无效");
                return;
              }
              const requestId = z
                .string()
                .max(100)
                .optional()
                .parse(packet.request_id);
              try {
                if (packet.type === "sync") {
                  peer.cursor = z
                    .number()
                    .int()
                    .min(0)
                    .parse(packet.data?.cursor || 0);
                  peer.active = packet.data?.active || null;
                  const state = await service.nodeSync(
                    token,
                    connection.session_id,
                    peer.cursor,
                    peer.active,
                    packet.data?.accepting,
                  );
                  peer.cursor = state.cursor;
                  send(ws, "sync", state, requestId);
                } else if (packet.type === "claim") {
                  let job = null;
                  try {
                    job = await service.claim(token, connection.session_id);
                  } catch (e) {
                    if (!(e.status === 403 && /未批准|静音/.test(e.message)))
                      throw e;
                  }
                  if (job) peer.active = { id: job.id, lease: job.lease };
                  send(ws, "job", job, requestId);
                } else if (packet.type === "artifact-proposal") {
                  send(
                    ws,
                    "ack",
                    await service.proposeArtifact(
                      token,
                      packet.data.id,
                      packet.data.lease,
                      packet.data.proposal,
                      connection.session_id,
                    ),
                    requestId,
                  );
                } else if (packet.type === "artifact-permit") {
                  send(
                    ws,
                    "ack",
                    await service.artifactPermit(
                      token,
                      packet.data.id,
                      packet.data.lease,
                      connection.session_id,
                    ),
                    requestId,
                  );
                } else if (packet.type === "complete") {
                  const result = await service.complete(
                    token,
                    packet.data.id,
                    packet.data.lease,
                    packet.data.result,
                    connection.session_id,
                  );
                  peer.active = null;
                  send(ws, "ack", result, requestId);
                } else if (packet.type === "failed") {
                  const result = await service.failTurn(
                    token,
                    packet.data.id,
                    packet.data.lease,
                    packet.data.error,
                    connection.session_id,
                  );
                  peer.active = null;
                  send(ws, "ack", result, requestId);
                } else throw new AgentError(400, "Node 消息类型无效。");
              } catch (e) {
                send(
                  ws,
                  "error",
                  {
                    status: e.status || (e instanceof z.ZodError ? 400 : 503),
                    code: e.code,
                    error:
                      e instanceof z.ZodError
                        ? "Node 消息格式无效。"
                        : boundedError(e),
                  },
                  requestId,
                );
                if (
                  e.status === 401 ||
                  /撤销|封禁|功能已停用|维护/.test(e.message)
                )
                  ws.close(4003, "设备权限已失效");
              }
            })
            .catch(() => ws.close(1011, "消息处理失败"))
            .finally(() => {
              peer.queued--;
            });
        });
        ws.on("close", () => {
          if (peers.get(connection.node_id) === peer)
            peers.delete(connection.node_id);
          void service
            .disconnected(token, connection.session_id)
            .catch(() => {});
        });
        ws.on("error", () => {});
      });
    } catch (e) {
      socket.write(
        `HTTP/1.1 ${e.status || 503} ${e.status === 409 ? "Conflict" : e.status ? "Forbidden" : "Service Unavailable"}\r\n${e.retryAfter ? `Retry-After: ${e.retryAfter}\r\n` : ""}Connection: close\r\nContent-Length: 0\r\n\r\n`,
      );
      socket.destroy();
    } finally {
      if (reservedToken) connecting.delete(reservedToken);
    }
    return true;
  }
  const heartbeat = setInterval(() => {
    for (const peer of peers.values()) {
      if (!peer.alive) {
        peer.ws.terminate();
        continue;
      }
      peer.alive = false;
      peer.ws.ping();
    }
  }, 20000);
  heartbeat.unref();
  const maintenance = setInterval(async () => {
    if (sweeping) return;
    sweeping = true;
    try {
      await service.housekeeping();
      for (const peer of peers.values()) {
        try {
          await checkIP(peer.ip);
          const state = await service.nodeSync(
            peer.token,
            peer.connection.session_id,
            peer.cursor,
            peer.active,
          );
          peer.cursor = state.cursor;
          send(peer.ws, "sync", state);
        } catch (e) {
          send(peer.ws, "error", {
            status: e.status || 503,
            code: e.code,
            error: boundedError(e),
          });
          peer.ws.close(4003, "设备权限已失效");
        }
      }
    } catch {
      for (const peer of peers.values())
        send(peer.ws, "error", {
          status: 503,
          error: "Gateway 数据库暂不可用，等待恢复。",
        });
    } finally {
      sweeping = false;
    }
  }, 2000);
  maintenance.unref();
  return {
    handleHTTP,
    upgrade,
    service,
    async close() {
      clearInterval(heartbeat);
      clearInterval(maintenance);
      await remoteMcp.close();
      for (const peer of peers.values()) {
        peer.ws.close(1001, "服务器关闭");
        setTimeout(() => peer.ws.terminate(), 1000).unref();
      }
      await new Promise((r) => wss.close(r));
    },
  };
}

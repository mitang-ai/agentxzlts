import WebSocket from "ws";
import {
  safeResult,
  artifactFindings,
  privateFile,
} from "../../agents/privacy.mjs";
import { writeFile, readFile, readdir, lstat, unlink } from "node:fs/promises";
import { resolve, relative, dirname, basename } from "node:path";
import { randomUUID } from "node:crypto";
import {
  readArchive,
  packArtifact,
  treeHash,
  safePath,
  digest,
} from "../../agents/archive.mjs";
import {
  boundedError,
  turnResultSchema,
  WIRE_MAX_BYTES,
} from "../../agents/protocol.mjs";
import { createAdapter, runProcess } from "./adapters.mjs";
import { readJSON, writeJSON, serverURL } from "./io.mjs";
import { acquireInstance } from "./instances.mjs";
import {
  taskWorkspace,
  checkTaskIdentity,
  materializeFile,
} from "./workspace.mjs";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const ignored = (path) =>
  privateFile(path) ||
  path
    .split("/")
    .some(
      (p) =>
        p === ".git" ||
        p === "node_modules" ||
        p === ".data" ||
        p === ".island-work" ||
        p.startsWith(".island-output") ||
        (/^\.env/.test(p) && p !== ".env.example"),
    );
export async function walkWorkspace(directory) {
  const files = new Map();
  let total = 0,
    count = 0;
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = resolve(dir, entry.name),
        name = relative(directory, path).split("\\").join("/");
      if (ignored(name)) continue;
      const info = await lstat(path);
      if (info.isSymbolicLink())
        throw Error("本地成果不能包含符号链接：" + name);
      if (info.isDirectory()) await walk(path);
      else if (info.isFile()) {
        safePath(name);
        total += info.size;
        if (
          ++count > 5000 ||
          info.size > 10 * 1024 * 1024 ||
          total > 100 * 1024 * 1024
        )
          throw Error("本地源码超出归档限制。");
        files.set(name, await readFile(path));
      }
    }
  }
  await walk(directory);
  return files;
}
export class IslandNode {
  constructor(
    config,
    { configFile, logger = console.log, onJob, instanceLease } = {},
  ) {
    this.config = config;
    this.server = serverURL(config.server);
    this.configFile = configFile;
    this.logger = logger;
    this.onJob = onJob;
    this.instanceLease = instanceLease;
    this.adapter = createAdapter(config);
    this.pending = new Map();
    this.stopped = false;
    this.active = null;
    this.cursor = 0;
    this.cursors = {};
    this.retry = 500;
    this.privateDir = resolve(
      dirname(configFile),
      basename(configFile) + ".state",
    );
    this.spool = resolve(this.privateDir, "active.json");
    this.connectionStatus = {
      state: "pending",
      muted: false,
      connected: false,
    };
    this.statusQueue = Promise.resolve();
  }
  log(message) {
    this.logger(message);
  }
  async request(path, options = {}) {
    const response = await fetch(this.server + path, {
      ...options,
      redirect: "error",
      headers: {
        ...options.headers,
        authorization: "Bearer " + this.config.token,
      },
    });
    if (!response.ok) {
      let error;
      try {
        error = (await response.json()).error;
      } catch {}
      const e = Error(error || "网站请求失败：" + response.status);
      e.status = response.status;
      throw e;
    }
    return response;
  }
  rpc(type, data) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN)
      return Promise.reject(Error("Node 连接暂时断开。"));
    const requestId = randomUUID();
    return new Promise((yes, no) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        no(Error("Node 请求等待超时。"));
      }, 15000);
      this.pending.set(requestId, { yes, no, timer });
      this.ws.send(JSON.stringify({ type, data, request_id: requestId }));
    });
  }
  async updateStatus(data = {}) {
    const before = this.connectionStatus;
    this.connectionStatus = {
      ...before,
      ...data,
      pid: process.pid,
      running: !this.stopped,
      activity: this.active?.job?.kind || "idle",
      updated_at: new Date().toISOString(),
    };
    if (
      Object.hasOwn(data, "room_id") &&
      before.room_id !== undefined &&
      before.room_id !== data.room_id
    ) {
      this.controller?.abort();
      this.active = null;
      await unlink(this.spool).catch(() => {});
      await this.onRoomChanged?.(before.room_id, data.room_id);
    }
    if (
      data.connected &&
      (before.connected !== true ||
        before.state !== this.connectionStatus.state ||
        before.muted !== this.connectionStatus.muted)
    ) {
      this.log(
        this.connectionStatus.state === "registered"
          ? "设备已登记到协作岛，请在“我的 Agent”添加到房间。"
          : this.connectionStatus.state === "pending"
            ? "设备已连接，等待人类房间管理者批准席位。"
            : this.connectionStatus.muted
              ? "联机席位已批准，但已静音，等待管理者解除静音。"
              : "联机席位已批准，等待点名或任务；本机开发仍须任务批准。",
      );
    }
    const snapshot = { ...this.connectionStatus };
    this.statusQueue = this.statusQueue
      .catch(() => {})
      .then(() => writeJSON(this.configFile + ".status.json", snapshot));
    await this.statusQueue;
  }
  async start() {
    const lease =
      this.instanceLease ||
      (await acquireInstance(this.configFile, () => {
        this.log("实例锁失效，停止客户端以防重复执行。");
        this.stop();
      }));
    try {
      await this.run();
      if (this.connectionConflict)
        throw Error(
          "此席位已有在线客户端，本次重复连接已停止；新增 Agent 请使用新配对码和独立配置。",
        );
    } finally {
      this.stopped = true;
      await this.updateStatus({ connected: false }).catch(() => {});
      if (!this.instanceLease) await lease.release().catch(() => {});
    }
  }
  async run() {
    const cursor = await readJSON(resolve(this.privateDir, "cursor.json"), {
      cursor: 0,
    });
    this.cursor = Number.isSafeInteger(cursor.cursor) ? cursor.cursor : 0;
    this.cursors = cursor.rooms || {};
    this.savedCursor = this.cursor;
    let record = await readJSON(this.spool);
    if (!record && this.config.participant_id) {
      const legacy = await readJSON(
        resolve(dirname(this.configFile), "state/active.json"),
      );
      if (legacy?.job?.participant_id === this.config.participant_id) {
        record = legacy;
        await writeJSON(this.spool, record);
        await unlink(
          resolve(dirname(this.configFile), "state/active.json"),
        ).catch(() => {});
      }
    }
    if (record?.job) {
      this.active = record;
      this.log(
        record.result
          ? "恢复尚未确认回传的成果。"
          : "恢复中断任务；保留原本地工作目录。",
      );
    }
    await this.adapter.discover();
    while (!this.stopped) {
      try {
        await this.connect();
      } catch (e) {
        this.log("连接暂时断开：" + boundedError(e));
      }
      if (this.stopped) break;
      await wait(this.retry + Math.floor(Math.random() * 300));
      this.retry = Math.min(this.retry * 2, 15000);
    }
  }
  async connect() {
    const url = new URL("/agent-wire", this.server);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return new Promise((done, reject) => {
      const ws = (this.ws = new WebSocket(url, {
        headers: { authorization: "Bearer " + this.config.token },
        maxPayload: WIRE_MAX_BYTES,
        perMessageDeflate: false,
        handshakeTimeout: 10000,
      }));
      let poll,
        welcomed = false;
      ws.on("message", (bytes) => {
        let packet;
        try {
          packet = JSON.parse(bytes.toString());
        } catch {
          ws.close();
          return;
        }
        const waiter = this.pending.get(packet.request_id);
        if (waiter) {
          clearTimeout(waiter.timer);
          this.pending.delete(packet.request_id);
          if (packet.type === "error") {
            const e = Error(packet.data.error);
            e.status = packet.data.status;
            e.code = packet.data.code;
            waiter.no(e);
          } else waiter.yes(packet.data);
        }
        if (packet.type === "welcome") {
          welcomed = true;
          this.hasConnected = true;
          this.leaseConflictRetried = false;
          this.retry = 500;
          const oldRoom = this.connectionStatus.room_id;
          if (oldRoom !== packet.data.room_id) {
            if (oldRoom) this.cursors[oldRoom] = this.cursor;
            this.cursor = Number(this.cursors[packet.data.room_id] || 0);
            this.savedCursor = -1;
          }
          // 切房间先取消旧任务/宿主交付并保存状态，再开始新房间轮询。
          // 否则异步清理可能晚于新 claim，误取消新任务或混用旧消费者。
          void this.updateStatus({ ...packet.data, connected: true })
            .then(() => {
              if (
                this.stopped ||
                this.ws !== ws ||
                ws.readyState !== WebSocket.OPEN
              )
                return;
              poll = setInterval(() => void this.tick(), 2000);
              void this.tick();
            })
            .catch(() => {
              this.log("本机连接状态暂时无法保存，本轮不领取任务。");
              ws.close();
            });
        } else if (packet.type === "sync") {
          void this.updateStatus({
            state: packet.data.state,
            muted: packet.data.muted,
            connected: true,
            last_sync_at: new Date().toISOString(),
          }).catch(() => this.log("本机连接状态暂时无法保存。"));
          this.cursor = Math.max(this.cursor, packet.data.cursor || 0);
          if (
            packet.data.cancelled &&
            this.active?.job.id === packet.data.cancelled
          ) {
            this.adapter.rejectReceipt?.(
              this.active.job.id,
              Error("任务已取消。"),
            );
            this.controller?.abort();
            this.active = null;
            void unlink(this.spool).catch(() => {});
            this.log("授权已停止，本地执行取消，文件保留。");
          }
        } else if (packet.type === "error" && !waiter) {
          this.log(packet.data.error);
          if (packet.data.code === "CONNECTION_REPLACED") ws.close();
          else if ([401, 403].includes(packet.data.status)) this.stop();
        }
      });
      ws.on("unexpected-response", (request, response) => {
        if (response.statusCode === 409) {
          if (
            !this.leaseConflictRetried &&
            response.headers["retry-after"] === "46"
          ) {
            // Gateway 非正常退出可能留下 45 秒数据库租约；原客户端只等待一次，不抢占。
            this.leaseConflictRetried = true;
            this.retry = 46000;
            this.log(
              "原连接可能仍有有效租约，等待 46 秒后仅重试一次；不抢占其它客户端。",
            );
          } else {
            this.connectionConflict = true;
            this.log("此席位已有在线客户端，保留原连接，本次不抢占、不重试。");
            this.stop();
          }
        }
        if ([401, 403].includes(response.statusCode)) {
          this.log("设备凭据无效或已撤销，需要重新配对。");
          this.stop();
        }
        response.resume();
        reject(Error("Gateway 连接被拒绝：" + response.statusCode));
      });
      ws.once("error", reject);
      ws.on("close", (code) => {
        if (code === 4001) {
          this.connectionConflict = true;
          this.log("连接身份重复，本次停止重连，避免互相顶掉连接。");
          this.stop();
        }
        void this.updateStatus({ connected: false }).catch(() => {});
        clearInterval(poll);
        for (const p of this.pending.values()) {
          clearTimeout(p.timer);
          p.no(Error("Node 连接断开。"));
        }
        this.pending.clear();
        if (welcomed) done();
        else reject(Error("设备尚未完成连接。"));
      });
    });
  }
  async tick() {
    if (this.ticking || this.stopped || this.ws?.readyState !== WebSocket.OPEN)
      return;
    this.ticking = true;
    try {
      const state = await this.rpc("sync", {
        accepting:
          Boolean(
            this.active &&
            (!this.adapter.processing ||
              this.adapter.processing(this.active.job.id)),
          ) || (this.adapter.accepting ? this.adapter.accepting() : true),
        cursor: this.cursor,
        active: this.active
          ? { id: this.active.job.id, lease: this.active.job.lease }
          : null,
      });
      await this.updateStatus({
        state: state.state,
        muted: state.muted,
        connected: true,
        last_sync_at: new Date().toISOString(),
      });
      this.cursor = Math.max(this.cursor, state.cursor || 0);
      if (this.cursor !== this.savedCursor) {
        await writeJSON(resolve(this.privateDir, "cursor.json"), {
          cursor: this.cursor,
          rooms: {
            ...this.cursors,
            [this.connectionStatus.room_id]: this.cursor,
          },
        });
        this.savedCursor = this.cursor;
      }
      if (state.cancelled) {
        if (this.active)
          this.adapter.rejectReceipt?.(
            this.active.job.id,
            Error("任务已取消。"),
          );
        this.controller?.abort();
        this.active = null;
        await unlink(this.spool).catch(() => {});
        return;
      }
      if (this.active?.result) {
        const active = this.active;
        const publication = await this.rpc("complete", {
          id: active.job.id,
          lease: active.job.lease,
          result: active.result,
        });
        this.adapter.confirmed?.(active.job.id, publication);
        this.log(
          publication.pending_review
            ? "结果已提交本人审核，尚未公开到聊天室。"
            : "本轮结果已确认回传，Agent 返回等待。",
        );
        this.active = null;
        await unlink(this.spool).catch(() => {});
      } else if (this.active && !this.executing) {
        void this.execute(this.active.job);
      } else if (
        !this.active &&
        state.state === "approved" &&
        !state.muted &&
        (!this.adapter.accepting || this.adapter.accepting())
      ) {
        const job = await this.rpc("claim", {});
        if (job) {
          this.active = { job };
          await writeJSON(this.spool, this.active);
          void this.execute(job);
        }
      }
    } catch (e) {
      if (e.status === 403 && /静音|未批准/.test(e.message)) {
        this.controller?.abort();
        this.active = null;
        await unlink(this.spool).catch(() => {});
      } else if (e.code === "CONNECTION_REPLACED") this.ws?.close();
      else if ([401, 403].includes(e.status)) this.stop();
      else if (e.status === 409 && this.active) {
        this.adapter.rejectReceipt?.(this.active.job.id, e);
        this.controller?.abort();
        this.active = null;
        await unlink(this.spool).catch(() => {});
      } else if (e.status === 400 && this.active?.result) {
        await this.reportFailure(this.active.job, e);
      }
    } finally {
      this.ticking = false;
    }
  }
  async workspace(job) {
    checkTaskIdentity(job);
    const root = resolve(this.config.workspace);
    const stamp = resolve(this.privateDir, job.id + "-workspace.json"),
      previous = await readJSON(stamp);
    // 已启动的旧任务保留原目录，不能把旧基线 stamp 套到空的新目录导致整树误删。
    let legacy = Boolean(previous && previous.layout !== "room-task-v1");
    if (!previous) {
      try {
        await lstat(resolve(root, ".island-work", job.id));
        legacy = true;
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
    } else if (legacy) await lstat(resolve(root, ".island-work", job.id));
    const directory = await taskWorkspace(root, job, { legacy });
    const base = new Map(),
      documents = [];
    if (job.kind === "develop") {
      if (!this.config.allow_development)
        throw Error(
          "本机尚未授权开发。请在 Node 配置中明确启用工作目录开发权限。",
        );
      if (!job.brief?.base_file_id) throw Error("缺少已确认代码基线。");
      const response = await this.request(
          "/api/agent-node/files/" + job.brief.base_file_id,
        ),
        bytes = Buffer.from(await response.arrayBuffer());
      for (const [path, content] of await readArchive(bytes))
        base.set(path, content);
      if (treeHash(base) !== job.brief.base_hash)
        throw Error("本地接收的基线摘要与需求不一致。");
      if (!previous) {
        for (const [path, content] of base) {
          if (ignored(path))
            throw Error(
              "代码基线包含凭据、依赖或 Node 内部路径，请提供纯源码基线。",
            );
          await materializeFile(directory, path, content);
        }
        await runProcess("git", ["init"], { cwd: directory });
        await runProcess("git", ["add", "."], { cwd: directory });
        await runProcess(
          "git",
          [
            "-c",
            "user.name=Island Node",
            "-c",
            "user.email=node@island.local",
            "commit",
            "--allow-empty",
            "-m",
            "Confirmed room baseline",
          ],
          { cwd: directory },
        );
        await runProcess("git", ["switch", "-C", "island/" + job.id], {
          cwd: directory,
        });
        await writeJSON(stamp, {
          brief_hash: job.brief.content_hash,
          base_hash: job.brief.base_hash,
          layout: legacy ? "legacy-task-v0" : "room-task-v1",
        });
      } else if (
        previous.brief_hash !== job.brief.content_hash ||
        previous.base_hash !== job.brief.base_hash
      )
        throw Error("已有工作目录的需求或基线不一致。");
    }
    for (const fid of job.brief?.file_ids || []) {
      const original = job.brief.documents?.find((file) => file.id === fid);
      const extension =
        original?.name?.match(/\.([a-z0-9]{1,10})$/i)?.[0] || "";
      const response = await this.request("/api/agent-node/files/" + fid),
        bytes = Buffer.from(await response.arrayBuffer()),
        doc = resolve(directory, ".island-output-document-" + fid + extension);
      await materializeFile(directory, basename(doc), bytes);
      documents.push(doc);
    }
    return { directory, base, documents };
  }
  async execute(job) {
    if (this.executing) return;
    this.executing = true;
    const controller = (this.controller = new AbortController()),
      timeout = setTimeout(
        () => controller.abort(),
        Math.max(1, new Date(job.hard_deadline).getTime() - Date.now()),
      );
    timeout.unref();
    try {
      this.log(
        job.kind === "develop"
          ? "开始本机开发：" + job.input.title
          : "Agent 获得一次 " + job.kind + " 授权。",
      );
      const { directory, base, documents } = await this.workspace(job);
      const old = await readJSON(
        resolve(this.privateDir, job.id + "-session.json"),
      );
      await this.adapter.resume(old?.session_id || null);
      const { lease, ...agentJob } = job;
      const local = await this.adapter.dispatch(agentJob, {
        cwd: directory,
        signal: controller.signal,
        documentPaths: documents,
      });
      if (controller.signal.aborted || this.active?.job.id !== job.id)
        throw Error("本轮执行已取消。");
      if (local.local_session_id)
        await writeJSON(resolve(this.privateDir, job.id + "-session.json"), {
          session_id: local.local_session_id,
        });
      delete local.local_session_id;
      const result = turnResultSchema.parse(
        safeResult(local, [directory, this.config.workspace]),
      );
      if (job.kind === "develop") {
        const checks = [];
        for (const check of this.config.checks || []) {
          try {
            const r = await runProcess(check.command, check.args || [], {
              cwd: directory,
              signal: controller.signal,
              timeout: check.timeout || 60000,
            });
            checks.push({
              command: [check.command, ...(check.args || [])].join(" "),
              status: "passed",
              output: r.stdout.slice(-4000),
            });
          } catch (e) {
            if (controller.signal.aborted) throw e;
            checks.push({
              command: [check.command, ...(check.args || [])].join(" "),
              status: "failed",
              output: boundedError(e),
            });
          }
        }
        if (!checks.length)
          checks.push({
            command: "本机验证",
            status: "not_run",
            output: "设备所有者未配置本地验证命令。",
          });
        result.checks = safeResult(checks, [directory, this.config.workspace]);
        const current = await walkWorkspace(directory),
          bytes = await packArtifact(
            base,
            current,
            {
              brief_hash: job.brief.content_hash,
              task_id: job.task_id,
              summary: result.summary,
              checks: result.checks,
            },
            job.input.paths,
          );
        const archive = await readArchive(bytes);
        if (artifactFindings(archive).length)
          throw Error(
            "本地发送护栏发现成果含有隐私或凭据；文件正文未上传，请本人在本机检查。",
          );
        // The automatic/manual sending permit always binds exact bytes.
        const proposal = {
          sha256: digest(bytes),
          size: bytes.length,
          paths: JSON.parse(
            archive.get("island-artifact.json").toString(),
          ).changes.map((c) => c.path),
        };
        await writeFile(
          resolve(this.privateDir, job.id + "-pending-artifact.zip"),
          bytes,
          { mode: 0o600 },
        );
        const authorization = await this.rpc("artifact-proposal", {
          id: job.id,
          lease,
          proposal,
        });
        this.log(
          authorization.status === "approved"
            ? "文件发送许可已自动通过，继续上传已检查的成果。"
            : "成果保留在本机，等待本人在“我的 Agent”确认指定文件清单和摘要。",
        );
        while (
          authorization.status !== "approved" &&
          !controller.signal.aborted
        ) {
          const permit = await this.rpc("artifact-permit", {
            id: job.id,
            lease,
          });
          if (permit.status === "approved") break;
          if (permit.status === "rejected") throw Error("本人拒绝了成果发送。");
          await wait(2000);
        }
        if (controller.signal.aborted)
          throw Error("成果发送等待已取消或超时。");
        const response = await this.request("/api/agent-node/artifacts", {
          method: "POST",
          headers: {
            "content-type": "application/zip",
            "x-island-turn": job.id,
            "x-island-lease": lease,
          },
          body: bytes,
        });
        result.artifact_id = (await response.json()).id;
      }
      if (controller.signal.aborted || this.active?.job.id !== job.id)
        throw Error("本轮执行已取消。");
      this.active = { job, result };
      await writeJSON(this.spool, this.active);
      this.onJob?.(job, result);
      await this.tick();
    } catch (e) {
      if (!controller.signal.aborted && this.active?.job.id === job.id)
        await this.reportFailure(job, e);
    } finally {
      clearTimeout(timeout);
      this.executing = false;
      this.controller = null;
    }
  }
  async reportFailure(job, error) {
    this.adapter.rejectReceipt?.(job.id, error);
    this.log("本机执行需要处理：" + boundedError(error));
    try {
      await this.rpc("failed", {
        id: job.id,
        lease: job.lease,
        error: boundedError(error),
      });
      this.active = null;
      await unlink(this.spool).catch(() => {});
    } catch (e) {
      if ([401, 403, 409].includes(e.status)) {
        this.active = null;
        await unlink(this.spool).catch(() => {});
      } else {
        this.controller?.abort();
        this.active = null;
        await unlink(this.spool).catch(() => {});
      }
    }
  }
  stop() {
    this.stopped = true;
    this.controller?.abort();
    this.ws?.close(1000, "Node 已停止");
    void this.adapter.disconnect();
  }
}

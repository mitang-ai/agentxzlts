import { randomUUID } from "node:crypto";
import { turnResultSchema } from "../../agents/protocol.mjs";
import { promptFor } from "./adapters.mjs";

// MCP 宿主自己执行任务；此适配器绝不启动或寻找其它 Agent 的 CLI。
export class HostAdapter {
  constructor(config) {
    this.config = config;
    this.waiters = new Set();
    this.receipts = new Map();
  }
  async discover() {
    return [
      { id: "mcp", name: this.config.host_name || this.config.agent_name },
    ];
  }
  async resume() {}
  accepting() {
    return this.waiters.size > 0;
  }
  processing(taskId) {
    return Boolean(
      (this.pending?.job.id === taskId && this.pending.delivered) ||
      (this.receipts.has(taskId) && !this.receipts.get(taskId).confirmed),
    );
  }
  async dispatch(job, { cwd, signal, documentPaths = [] }) {
    if (signal.aborted) throw Error("任务授权已停止。");
    return new Promise((resolve, reject) => {
      const delivery = randomUUID();
      const abort = () => {
        this.pending = null;
        this.rejectReceipt(job.id, Error("任务已取消，不能继续回传。"));
        reject(Error("任务授权已停止。"));
      };
      this.pending = {
        job,
        delivery,
        resolve,
        reject,
        signal,
        abort,
        delivered: this.waiters.size > 0,
        payload: {
          task_id: job.id,
          delivery_id: delivery,
          kind: job.kind,
          workspace: cwd,
          document_paths: documentPaths,
          deadline: job.hard_deadline,
          prompt: promptFor(job, documentPaths),
          task: job,
        },
      };
      signal.addEventListener("abort", abort, { once: true });
      for (const waiter of this.waiters) waiter(this.pending.payload);
      this.waiters.clear();
    });
  }
  async waitTask(seconds = 20, signal) {
    if (signal?.aborted) return null;
    if (this.pending) {
      this.pending.delivered = true;
      return this.pending.payload;
    }
    if (this.waiters.size)
      throw Error("此宿主已有等待调用，不并发投递同一任务。");
    return new Promise((resolve) => {
      const done = (payload) => {
        clearTimeout(timer);
        this.waiters.delete(done);
        signal?.removeEventListener("abort", cancel);
        resolve(payload);
      };
      const cancel = () => done(null);
      const timer = setTimeout(() => done(null), seconds * 1000);
      this.waiters.add(done);
      signal?.addEventListener("abort", cancel, { once: true });
    });
  }
  async complete(taskId, delivery, input) {
    const result = turnResultSchema.parse(input);
    let receipt = this.receipts.get(taskId);
    if (receipt) {
      if (
        receipt.delivery !== delivery ||
        JSON.stringify(result) !== receipt.result
      )
        throw Error("回传标识或结果与原提交不一致。");
    } else {
      const pending = this.pending;
      if (
        !pending ||
        pending.job.id !== taskId ||
        pending.delivery !== delivery ||
        pending.signal.aborted
      )
        throw Error("任务不属于此宿主或授权已失效。");
      let yes, no;
      const promise = new Promise((resolve, reject) => {
        yes = resolve;
        no = reject;
      });
      promise.catch(() => {});
      receipt = { delivery, result: JSON.stringify(result), promise, yes, no };
      this.receipts.set(taskId, receipt);
      this.pending = null;
      pending.signal.removeEventListener("abort", pending.abort);
      pending.resolve(result);
    }
    if (receipt.confirmed) return receipt.response;
    let timer;
    try {
      return await Promise.race([
        receipt.promise,
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(Error("结果待服务器确认，请使用同一回传标识重试。")),
            15000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  confirmed(taskId, publication = {}) {
    const receipt = this.receipts.get(taskId);
    if (receipt) {
      receipt.confirmed = true;
      receipt.response = {
        task_id: taskId,
        confirmed: true,
        pending_review: publication.pending_review === true,
      };
      receipt.yes(receipt.response);
    }
    // 有界保留成功回执以支持同一宿主重试，不重复发消息。
    if (this.receipts.size > 100)
      this.receipts.delete(this.receipts.keys().next().value);
  }
  rejectReceipt(taskId, error) {
    this.receipts.get(taskId)?.no(error);
  }
  fail(taskId, delivery, error) {
    const pending = this.pending;
    if (!pending || pending.job.id !== taskId || pending.delivery !== delivery)
      throw Error("任务不属于此宿主或授权已失效。");
    this.pending = null;
    pending.signal.removeEventListener("abort", pending.abort);
    pending.reject(Error(error));
    return {
      task_id: taskId,
      accepted: true,
      message: "失败原因已交给客户端回传。",
    };
  }
  async disconnect() {
    this.pending?.abort();
    for (const waiter of this.waiters) waiter(null);
    this.waiters.clear();
    for (const receipt of this.receipts.values())
      receipt.no(Error("宿主连接已停止。"));
  }
}

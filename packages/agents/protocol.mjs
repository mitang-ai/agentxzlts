import { z } from "zod";
export const WIRE_VERSION = "1.0";
export const WIRE_MAX_BYTES = 2 * 1024 * 1024;
export const turnResultSchema = z
  .object({
    message: z.string().trim().max(8000).default(""),
    acknowledge: z.boolean().default(false),
    speakers: z
      .array(
        z.object({
          participant_id: z.uuid(),
          instruction: z.string().trim().min(1).max(2000),
        }),
      )
      .max(4)
      .default([]),
    done: z.boolean().default(false),
    plan: z
      .array(
        z.object({
          title: z.string().trim().min(1).max(160),
          description: z.string().max(8000).default(""),
          assignee_id: z.uuid(),
          paths: z.array(z.string().min(1).max(240)).min(1).max(20),
        }),
      )
      .max(20)
      .default([]),
    summary: z.string().max(4000).default(""),
    artifact_id: z.uuid().optional(),
    checks: z
      .array(
        z.object({
          command: z.string().max(300),
          status: z.enum(["passed", "failed", "not_run"]),
          output: z.string().max(4000).default(""),
        }),
      )
      .max(20)
      .default([]),
  })
  .strict();
export class AgentError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
export const fail = (status, message) => {
  throw new AgentError(status, message);
};
export function boundedError(e) {
  return String(e?.message || e || "操作失败")
    .replace(/postgres(?:ql)?:\/\/\S+/g, "[数据库连接]")
    .slice(0, 600);
}

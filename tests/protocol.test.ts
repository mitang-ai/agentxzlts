import { describe, it, expect } from "vitest";
import {
  validateFile,
  safeFileName,
  MAX_FILE_SIZE,
  canManage,
  canUpdateTask,
  accountSchema,
  roomSchema,
} from "../packages/protocol/src/index";
describe("共享协议与安全输入", () => {
  it("拒绝伪扩展名、超限文件和空文件", () => {
    expect(validateFile("photo.exe", "image/png", 10)).toBe(false);
    expect(validateFile("photo.PNG", "image/png", 10)).toBe(true);
    expect(validateFile("a.txt", "text/plain", MAX_FILE_SIZE + 1)).toBe(false);
    expect(validateFile("a.txt", "text/plain", 0)).toBe(false);
  });
  it("文件名移除路径和控制字符", () => {
    expect(safeFileName("../a\u0000.txt")).not.toMatch(/[\/\u0000]/);
    expect(safeFileName("x".repeat(300))).toHaveLength(180);
  });
  it("账号和房间输入有边界", () => {
    expect(
      accountSchema.safeParse({ email: "bad", password: "123" }).success,
    ).toBe(false);
    expect(roomSchema.safeParse({ name: "  " }).success).toBe(false);
  });
  it("统一 Participant 权限判断遵循主持人和负责人", () => {
    const p = { id: "p", status: "active" } as any;
    const room = { host_participant_id: "h" } as any;
    const task = { task_assignees: [{ participant_id: "p" }] } as any;
    expect(canManage(room, p)).toBe(false);
    expect(canUpdateTask(task, room, p)).toBe(true);
    expect(canUpdateTask(task, room, { ...p, status: "left" })).toBe(false);
    expect(canManage(room, { ...p, id: "h" })).toBe(true);
    expect(canManage(room, { ...p, id: "h", status: "left" })).toBe(false);
  });
});

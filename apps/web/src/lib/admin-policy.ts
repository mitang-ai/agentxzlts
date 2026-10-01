import { z } from "zod";
export const adminRole = z.enum(["super", "operations", "technical"]);
export type AdminRole = z.infer<typeof adminRole>;
export const permissions: Record<string, AdminRole[]> = {
  overview: ["super", "operations", "technical"],
  users: ["super", "operations"],
  rooms: ["super", "operations"],
  content: ["super", "operations"],
  reports: ["super", "operations"],
  files: ["super", "operations"],
  invites: ["super", "operations"],
  operations: ["super", "operations", "technical"],
  system: ["super", "technical"],
  security: ["super", "operations", "technical"],
  audit: ["super", "operations", "technical"],
  admins: ["super"],
  ip: ["super", "technical"],
  events: ["super", "technical"],
  errors: ["super", "technical"],
  maintenance: ["super"],
};
const text = z.string().trim();
const asset = z.union([
  z.literal(""),
  z.string().regex(/^\/api\/brand\/[0-9a-f-]{36}$/),
]);
export const settingSchemas = {
  brand: z.object({
    name: text.min(1).max(50),
    logo: asset,
    favicon: asset,
    intro: text.max(200),
  }),
  information: z.object({
    title: text.min(1).max(60),
    description: text.max(160),
    icp: text.max(100),
    footer: text.max(200),
    email: z.union([z.literal(""), z.email()]),
    phone: text.max(40),
  }),
  analytics: z
    .object({
      baidu_enabled: z.boolean(),
      baidu_id: z.union([z.literal(""), z.string().regex(/^[a-f0-9]{32}$/)]),
      ga_enabled: z.boolean(),
      ga_id: z.union([z.literal(""), z.string().regex(/^G-[A-Z0-9]{4,30}$/)]),
      umami_enabled: z.boolean(),
      umami_url: z.union([
        z.literal(""),
        z
          .url()
          .refine(
            (s) =>
              s.startsWith("https://") &&
              !new URL(s).username &&
              !new URL(s).password,
          ),
      ]),
      umami_id: z.union([z.literal(""), z.uuid()]),
    })
    .superRefine((v, c) => {
      for (const [enabled, key] of [
        ["baidu_enabled", "baidu_id"],
        ["ga_enabled", "ga_id"],
        ["umami_enabled", "umami_id"],
        ["umami_enabled", "umami_url"],
      ] as const)
        if (v[enabled] && !v[key])
          c.addIssue({
            code: "custom",
            path: [key],
            message: "启用统计工具时请填写有效标识",
          });
    }),
  operations: z.object({
    registration: z.boolean(),
    invite_days: z.number().int().min(1).max(30),
    max_file_mb: z.number().int().min(1).max(500),
    room_storage_mb: z.number().int().min(1).max(1048576),
    allowed_extensions: z
      .array(
        z.enum([
          "png",
          "jpg",
          "jpeg",
          "webp",
          "gif",
          "pdf",
          "txt",
          "md",
          "csv",
          "zip",
          "docx",
          "xlsx",
          "pptx",
        ]),
      )
      .min(1),
    announcements: z.boolean(),
    maintenance: z.boolean(),
    maintenance_message: text.min(1).max(300),
  }),
};
export const actionSchemas = {
  restrict_user: z.object({
    id: z.uuid(),
    status: z.enum([
      "normal",
      "limited_post",
      "limited_room",
      "limited_upload",
      "banned",
    ]),
    until: z
      .union([z.literal(""), z.iso.datetime({ offset: true })])
      .optional(),
  }),
  edit_user: z.object({
    id: z.uuid(),
    display_name: text.min(1).max(40),
    avatar_url: z.union([
      z.literal(""),
      z.url().refine((s) => s.startsWith("https://")),
    ]),
  }),
  revoke_sessions: z.object({ id: z.uuid(), session_id: z.uuid().optional() }),
  room_status: z.object({
    id: z.uuid(),
    status: z.enum(["active", "frozen", "deleted"]),
  }),
  transfer_host: z.object({ id: z.uuid(), participant_id: z.uuid() }),
  remove_member: z.object({ id: z.uuid() }),
  assign_task: z.object({
    id: z.uuid(),
    assignee_ids: z.array(z.uuid()).max(100),
  }),
  delete_message: z.object({ id: z.uuid() }),
  content_view: z.object({ id: z.uuid() }),
  file_status: z.object({
    id: z.uuid(),
    status: z.enum(["normal", "quarantined", "deleted"]),
  }),
  invite_update: z.object({
    id: z.uuid(),
    revoke: z.boolean().optional(),
    expires_at: z.iso.datetime({ offset: true }).optional(),
    max_uses: z.number().int().min(1).max(1000).optional(),
  }),
  feature_flag: z.object({
    key: z.enum([
      "tasks",
      "uploads",
      "create_room",
      "connection_seat",
      "agents",
    ]),
    enabled: z.boolean(),
    scope: z.enum(["all", "users", "rooms", "admins", "percentage"]),
    targets: z.array(z.uuid()).max(1000),
    rollout: z.number().int().min(0).max(100),
  }),
  announcement: z.object({
    id: z.uuid().optional(),
    title: text.min(1).max(120),
    content: text.min(1).max(4000),
    starts_at: z.iso.datetime({ offset: true }),
    ends_at: z.union([z.literal(""), z.iso.datetime({ offset: true })]),
    position: z.enum(["all", "public", "app"]),
    dismissible: z.boolean(),
    enabled: z.boolean(),
  }),
  delete_announcement: z.object({ id: z.uuid() }),
  resolve_report: z.object({
    id: z.uuid(),
    resolution_action: z.enum([
      "approve",
      "dismiss",
      "processing",
      "delete_message",
      "quarantine",
      "freeze",
      "banned",
      "limited_post",
      "limited_room",
      "limited_upload",
      "warning",
    ]),
  }),
  admin_member: z.object({
    id: z.uuid(),
    role: z.enum(["super", "operations", "technical", "remove"]),
  }),
  ip_rule: z.object({
    network: text.min(3).max(60),
    expires_at: z.union([z.literal(""), z.iso.datetime({ offset: true })]),
  }),
  delete_ip_rule: z.object({ id: z.uuid() }),
  cleanup: z.object({}),
  orphan_cleanup: z.object({}),
};
export const reasonSchema = z.object({
  reason: text.min(3).max(2000),
  confirm: z.boolean().optional(),
});

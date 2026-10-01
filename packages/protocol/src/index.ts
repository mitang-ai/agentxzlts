import { z } from "zod";
export const PROTOCOL_VERSION = "0.1";
export const participantType = z.enum(["human", "agent"]);
export const taskStatus = z.enum(["pending", "in_progress", "completed"]);
export const textSchema = z.string().trim().min(1).max(8000);
export const roomSchema = z.object({
  name: z.string().trim().min(1).max(60),
  icon: z.string().max(8).default("🏝️"),
});
export const accountSchema = z.object({
  email: z.email().max(254),
  password: z.string().min(8).max(128),
  display_name: z.string().trim().min(1).max(40).optional(),
});
export type Participant = {
  id: string;
  room_id: string;
  type: "human" | "agent";
  user_id: string | null;
  display_name: string;
  avatar_url: string | null;
  status: "active" | "left";
  last_read_event_id: number;
  last_active_at: string | null;
};
export type Room = {
  id: string;
  name: string;
  icon: string;
  host_participant_id: string;
  created_at: string;
  updated_at: string;
  status?: "active" | "frozen" | "deleted";
  unread_count?: number;
  last_message?: string;
  last_message_at?: string | null;
};
export type Message = {
  reply_context?: Message | null;
  id: string;
  room_id: string;
  sender_participant_id: string | null;
  type: "text" | "file" | "system" | "task";
  content: string;
  reply_to_message_id: string | null;
  mentioned_participant_ids: string[];
  file_id: string | null;
  task_id: string | null;
  client_message_id: string | null;
  created_at: string;
  deleted_at: string | null;
};
export type Task = {
  source_message?: Message | null;
  id: string;
  room_id: string;
  creator_participant_id: string;
  title: string;
  description: string;
  status: z.infer<typeof taskStatus>;
  due_at: string | null;
  source_message_id: string | null;
  created_at: string;
  updated_at: string;
  task_assignees: { participant_id: string }[];
  task_files: { file_id: string }[];
};
export type IslandFile = {
  id: string;
  room_id: string;
  uploader_participant_id: string;
  name: string;
  mime_type: string;
  size: number;
  status?: "normal" | "quarantined" | "deleted";
  storage_path: string;
  created_at: string;
};
export type IslandEvent = {
  id: number;
  room_id: string;
  type: string;
  actor_participant_id: string | null;
  entity_id: string | null;
  payload: Record<string, unknown>;
  created_at: string;
};
export type RoomState = {
  capabilities?: Record<string, boolean>;
  room: Room;
  participants: Participant[];
  messages: Message[];
  tasks: Task[];
  files: IslandFile[];
  cursor: number;
  has_more: boolean;
};
// 未来 Gateway 和 Adapter 的契约独立于聊天室 Core，当前不启用远端 Agent。
export interface AgentAdapter {
  kind: "acp" | "a2a" | "cli" | "http";
  discover(): Promise<{ id: string; name: string }[]>;
  resume(sessionId: string): Promise<void>;
  dispatch(event: IslandEvent): Promise<void>;
  disconnect(): Promise<void>;
}
export type NodePairing = {
  protocol_version: typeof PROTOCOL_VERSION;
  code: string;
  expires_at: string;
  node_id: string;
};
export function canManage(room: Room, participant: Participant) {
  return (
    participant.status === "active" &&
    room.host_participant_id === participant.id
  );
}
export function canUpdateTask(
  task: Task,
  room: Room,
  participant: Participant,
) {
  return (
    participant.status === "active" &&
    (canManage(room, participant) ||
      task.task_assignees.some((a) => a.participant_id === participant.id))
  );
}
export const MAX_FILE_SIZE = 10 * 1024 * 1024;
export const FILE_TYPES: Record<string, string[]> = {
  "image/png": ["png"],
  "image/jpeg": ["jpg", "jpeg"],
  "image/webp": ["webp"],
  "image/gif": ["gif"],
  "application/pdf": ["pdf"],
  "text/plain": ["txt"],
  "text/markdown": ["md"],
  "text/csv": ["csv"],
  "application/zip": ["zip"],
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [
    "docx",
  ],
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ["xlsx"],
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": [
    "pptx",
  ],
};
export function validateFile(
  name: string,
  mime: string,
  size: number,
  maxSize = MAX_FILE_SIZE,
) {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  return size > 0 && size <= maxSize && (FILE_TYPES[mime] || []).includes(ext);
}
export function safeFileName(name: string) {
  return (
    name
      .replace(/[\\/\x00-\x1f\x7f]/g, "_")
      .replace(/^\.+/, "")
      .slice(0, 180) || "附件"
  );
}

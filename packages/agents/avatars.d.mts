import { AgentService } from "./index.js";
export function normalizeAvatar(bytes: Buffer): Promise<Buffer>;
export function uploadAvatar(
  service: AgentService,
  userId: string,
  bytes: Buffer,
): Promise<{ avatar_url: string }>;
export function readAvatar(
  service: AgentService,
  userId: string,
  avatarId: string,
): Promise<Buffer>;

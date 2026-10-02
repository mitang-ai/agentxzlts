import type { Pool } from "pg";
export function participantPresence<T extends { id: string }>(
  pool: Pool,
  participants: T[],
  roomId: string,
): Promise<(T & { online: boolean })[]>;

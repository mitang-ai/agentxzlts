import type { Pool } from "pg";
import type { Storage } from "@island/runtime/storage";
export class AgentService {
  constructor(pool: Pool, storage: Storage);
  adminRevoke(adminId: string, nodeId: string, reason: string): Promise<any>;
  state(userId: string, roomId: string): Promise<any>;
  createPairing(userId: string, roomId: string): Promise<any>;
  deletePairings(userId: string, input: any): Promise<any>;
  revokePairing(
    userId: string,
    roomId: string,
    pairingId: string,
  ): Promise<any>;
  seatAction(
    userId: string,
    roomId: string,
    action: string,
    input: any,
  ): Promise<any>;
  publishBrief(userId: string, roomId: string, input: any): Promise<any>;
  deleteSeats(userId: string, roomId: string, input: any): Promise<any>;
  acknowledge(userId: string, roomId: string, briefId: string): Promise<any>;
  startSession(userId: string, roomId: string, input: any): Promise<any>;
  sessionAction(
    userId: string,
    roomId: string,
    action: string,
    input: any,
  ): Promise<any>;
  reviewArtifact(userId: string, roomId: string, input: any): Promise<any>;
  retryWork(userId: string, roomId: string, taskId: string): Promise<any>;
  mergePreview(userId: string, roomId: string, sessionId: string): Promise<any>;
  merge(userId: string, roomId: string, input: any): Promise<any>;
}

export class AgentError extends Error {
  status: number;
}

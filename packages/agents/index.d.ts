import type { Pool } from "pg";
import type { Storage } from "@island/runtime/storage";
export class AgentService {
  constructor(pool: Pool, storage: Storage);
  readEnrollment(id: string, token: string, origin: string): Promise<string>;
  myAgents(userId: string): Promise<any>;
  updateAgent(userId: string, input: any): Promise<any>;
  addAgentToRoom(userId: string, roomId: string, nodeId: string): Promise<any>;
  selectAgentRoom(userId: string, input: any): Promise<any>;
  revokeMyAgent(userId: string, nodeId: string): Promise<any>;
  invitationAction(userId: string, input: any): Promise<any>;
  reviewPrivate(userId: string, input: any): Promise<any>;
  policy(): Promise<any>;
  verifyAvatar(db: any, userId: string, url: any): Promise<void>;
  adminPolicy(userId: string, input?: any): Promise<any>;
  adminRevoke(adminId: string, nodeId: string, reason: string): Promise<any>;
  state(userId: string, roomId: string): Promise<any>;
  createPairing(
    userId: string,
    roomId?: string | null,
    input?: any,
  ): Promise<any>;
  createRemoteConnection(
    userId: string,
    roomId: string | null,
    input: any,
  ): Promise<any>;
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
  constructor(status: number, message: string);
  status: number;
}

import "server-only";
import { AgentService } from "@island/agents";
import { pool, fileStorage } from "./server";
export const agents = new AgentService(pool, fileStorage);

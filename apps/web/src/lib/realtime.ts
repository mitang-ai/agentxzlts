import { pool } from "./server";
const g = globalThis as unknown as {
  islandListeners?: Map<string, Set<() => void>>;
  islandListening?: Promise<void>;
};
const listeners = (g.islandListeners ??= new Map<string, Set<() => void>>());
export async function subscribe(room: string, callback: () => void) {
  if (!g.islandListening)
    g.islandListening = (async () => {
      const db = await pool.connect();
      await db.query("LISTEN island_events");
      db.on("notification", (n) => {
        if (n.payload) listeners.get(n.payload)?.forEach((fn) => fn());
      });
      db.on("error", () => {
        g.islandListening = undefined;
        db.release(true);
      });
    })();
  await g.islandListening;
  if (!listeners.has(room)) listeners.set(room, new Set());
  listeners.get(room)!.add(callback);
  return () => {
    listeners.get(room)?.delete(callback);
    if (!listeners.get(room)?.size) listeners.delete(room);
  };
}

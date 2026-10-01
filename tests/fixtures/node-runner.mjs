import { readFile } from "node:fs/promises";
import { IslandNode } from "../../packages/node/src/client.mjs";
const file = process.argv[2],
  config = JSON.parse(await readFile(file, "utf8"));
const node = new IslandNode(config, { configFile: file });
process.on("SIGTERM", () => node.stop());
process.on("SIGINT", () => node.stop());
process.on("message", (data) => {
  if (data === "drop") node.ws?.terminate();
  if (data === "stop") node.stop();
});
await node.start();

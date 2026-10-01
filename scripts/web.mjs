import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { applyRuntimeConfig } from "../packages/runtime/config.mjs";
const config = applyRuntimeConfig(),
  command = process.argv[2];
if (!["dev", "start"].includes(command)) throw Error("网站启动方式无效。");
const child = spawn(
  process.execPath,
  [
    resolve(config.root, "scripts/web-server.mjs"),
    ...(command === "dev" ? ["--dev"] : []),
  ],
  {
    cwd: resolve(config.root, "apps/web"),
    env: { ...process.env, ...config.env, ISLAND_ROOT: config.root },
    stdio: "inherit",
  },
);
child.on("error", () => {
  console.error("网站启动失败，请检查依赖是否安装。");
  process.exitCode = 1;
});
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => child.kill(signal));
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});

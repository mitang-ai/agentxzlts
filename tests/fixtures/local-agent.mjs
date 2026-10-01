// Deterministic local process for protocol acceptance; performs real file edits.
// It is not presented as an LLM or a production Agent adapter.
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
if (process.argv.includes("--version")) {
  console.log("island-local-protocol-fixture 1.0");
  process.exit(0);
}
let input = "";
for await (const part of process.stdin) input += part;
const { job, workspace } = JSON.parse(input);
const result = {
  message: "",
  acknowledge: false,
  speakers: [],
  done: false,
  plan: [],
  summary: "",
};
if (job.kind === "mention") {
  result.message = "已收到本次人类点名，仅回应一次。";
} else if (job.kind === "host") {
  const worker = job.participants.find(
    (p) => p.type === "agent" && p.id !== job.participant_id,
  );
  const prior = job.messages.some(
    (m) => m.content === "已核对模块方案，建议按文件分工。",
  );
  if (worker && !prior && !job.input.final) {
    result.message = "主持人围绕确认需求点名开发成员。";
    result.speakers = [
      {
        participant_id: worker.id,
        instruction: "核对需求，说明 worker 模块分工。",
      },
    ];
  } else {
    result.message = "主持讨论结束，提交有限分工方案。";
    result.done = true;
    result.plan = [
      {
        title: "实现 worker 模块",
        description:
          "修改 src/worker.js，使 worker 返回 2；完成后由 Node 执行配置的测试。".padEnd(
            8000,
            "需",
          ),
        assignee_id: worker?.id || job.participant_id,
        paths: ["src/worker.js"],
      },
      {
        title: "实现 host 模块",
        description:
          "修改 src/host.js，使 host 返回 3；完成后由 Node 执行配置的测试。".padEnd(
            8000,
            "设",
          ),
        assignee_id: job.participant_id,
        paths: ["src/host.js"],
      },
    ];
  }
} else if (job.kind === "speak") {
  result.message = "已核对模块方案，建议按文件分工。";
} else if (job.kind === "align") {
  result.acknowledge = true;
  result.message = "已确认本轮需求、设计、源码基线和分工版本。";
} else if (job.kind === "develop") {
  const path = job.input.paths[0],
    file = resolve(workspace, path);
  if (path === "src/worker.js")
    await writeFile(file, "export const worker = () => 2;\n");
  else if (path === "src/host.js")
    await writeFile(file, "export const host = () => 3;\n");
  else throw Error("测试范围不支持。");
  result.message =
    "已在本机隔离工作目录完成 " + job.input.title + "，回传源码等待审阅。";
  result.summary = "本地实际修改 " + path + "，保留其他文件。";
}
console.log(JSON.stringify(result));

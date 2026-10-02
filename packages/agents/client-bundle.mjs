import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { writeArchive } from "./archive.mjs";
export async function nodeClientBundle(root) {
  const files = new Map();
  for (const path of [
    "packages/node/bin/island-node.mjs",
    "packages/node/src/client.mjs",
    "packages/node/src/adapters.mjs",
    "packages/node/src/io.mjs",
    "packages/agents/archive.mjs",
    "packages/agents/protocol.mjs",
  ])
    files.set(
      path,
      await readFile(/* turbopackIgnore: true */ resolve(root, path)),
    );
  files.set(
    "package.json",
    await readFile(
      /* turbopackIgnore: true */ resolve(
        root,
        "packages/node/client-package.json",
      ),
    ),
  );
  files.set(
    "package-lock.json",
    await readFile(
      /* turbopackIgnore: true */ resolve(
        root,
        "packages/node/client-package-lock.json",
      ),
    ),
  );
  const shell = await readFile(
    /* turbopackIgnore: true */ resolve(root, "install.sh"),
    "utf8",
  );
  files.set(
    "connect.sh",
    Buffer.from(
      shell.slice(0, shell.lastIndexOf('case "${1:-}"')) +
        'exec node packages/node/bin/island-node.mjs bootstrap "$@"\n',
    ),
  );
  const ps = await readFile(
    /* turbopackIgnore: true */ resolve(root, "scripts/bootstrap.ps1"),
    "utf8",
  );
  files.set(
    "scripts/node-bootstrap.ps1",
    Buffer.from(
      ps
        .slice(0, ps.lastIndexOf("if ($Stop)"))
        .replace(/^param\([^\n]*\)\r?\n/, "$nodeArguments = $args\n") +
        "& node packages/node/bin/island-node.mjs bootstrap @nodeArguments\nexit $LASTEXITCODE\n",
    ),
  );
  files.set(
    "connect.cmd",
    Buffer.from(
      '@echo off\r\ncd /d "%~dp0"\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\\node-bootstrap.ps1" %*\r\nif errorlevel 1 pause\r\n',
    ),
  );
  files.set(
    "README.txt",
    Buffer.from(
      '协作岛异地 Node 客户端\nWindows：双击 connect.cmd\nLinux/macOS：bash connect.sh\n在此设备准备本机 Agent（Codex、Claude Code、OpenCode 或标准 ACP/CLI/本机 Agent 服务），启动文件会准备 Node.js 和客户端依赖。\n在房间生成一次性配对码，然后填写网站地址、Agent 昵称和本机工作目录。配对后由人类管理者批准。\n本地配置在 .data/island-node/config.json，设备凭据不能分享。默认等待点名，不自动回复每条消息。\n本机开发仅在明确授权的工作目录下的隔离子目录进行，原项目不会被自动覆盖。Ctrl+C 停止。\n设备所有者可在配置 checks 中声明自己信任的本地验证命令，如 {"command":"npm","args":["test"],"timeout":60000}。未配置则清楚标为未验证。\n',
    ),
  );
  return writeArchive(files);
}

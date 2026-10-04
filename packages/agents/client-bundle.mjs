import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { writeArchive } from "./archive.mjs";
// Windows PowerShell 5.1 将无 BOM 的脚本按系统 ANSI 编码读取。
// 只给 PowerShell 和说明文本加 UTF-8 BOM；CMD 与 shebang 脚本必须保持无 BOM。
const windowsText = (text) =>
  Buffer.from(
    "\uFEFF" + text.replace(/^\uFEFF/, "").replace(/\r?\n/g, "\r\n"),
    "utf8",
  );
const windowsInvoke = (bootstrap) => String.raw`
# PowerShell 5.1 的原生命令传参会吞掉 JSON 引号；显式按 Windows argv 规则编码。
function Quote-NodeArgument([string]$value) {
  $escaped = [regex]::Replace($value, '(\\*)"', { param($m) $m.Groups[1].Value + $m.Groups[1].Value + '\"' })
  $escaped = [regex]::Replace($escaped, '(\\+)$', '$1$1')
  return '"' + $escaped + '"'
}
$nodeCommand = (Get-Command node -ErrorAction Stop).Source
$arguments = @('packages/node/bin/island-node.mjs') ${bootstrap ? "+ @('bootstrap')" : ""} + @($nodeArguments)
$info = New-Object System.Diagnostics.ProcessStartInfo
$info.FileName = $nodeCommand
$info.WorkingDirectory = $repoDir
$info.UseShellExecute = $false
$info.CreateNoWindow = $true
$info.Arguments = (($arguments | ForEach-Object { Quote-NodeArgument $_ }) -join ' ')
$oneShot = ($nodeArguments -contains '--non-interactive') -or ($nodeArguments -contains '--background') -or (@('status','stop','doctor','hub-status','hub-stop','help') -contains $nodeArguments[0])
if ($oneShot) {
  # 隐藏窗口不能依赖继承的控制台句柄。并行读取两个管道，避免 WaitForExit / stdout 死锁。
  $info.RedirectStandardOutput = $true
  $info.RedirectStandardError = $true
  $info.RedirectStandardInput = $true
  $info.StandardOutputEncoding = $utf8Encoding
  $info.StandardErrorEncoding = $utf8Encoding
}
$child = New-Object System.Diagnostics.Process
$child.StartInfo = $info
if (!$child.Start()) { throw 'Node 客户端未能启动。' }
if ($oneShot) {
  $child.StandardInput.Close()
  $outputTask = $child.StandardOutput.ReadToEndAsync()
  $errorTask = $child.StandardError.ReadToEndAsync()
}
$child.WaitForExit()
if ($oneShot) {
  [Console]::Out.Write($outputTask.Result)
  [Console]::Error.Write($errorTask.Result)
}
exit $child.ExitCode
`;
export async function nodeClientBundle(root) {
  const files = new Map();
  for (const path of [
    "packages/node/bin/island-node.mjs",
    "packages/node/src/client.mjs",
    "packages/node/src/adapters.mjs",
    "packages/node/src/workbuddy.mjs",
    "packages/node/src/host-adapter.mjs",
    "packages/node/src/host-mcp.mjs",
    "packages/node/src/io.mjs",
    "packages/node/src/instances.mjs",
    "packages/node/src/windows-command.mjs",
    "packages/node/src/runtime.mjs",
    "packages/node/src/hub.mjs",
    "packages/node/src/workspace.mjs",
    "packages/node/src/installation.mjs",
    "packages/node/src/maintenance.mjs",
    "packages/agents/archive.mjs",
    "packages/agents/protocol.mjs",
    "packages/agents/privacy.mjs",
    "LICENSE",
    "NOTICE.md",
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
  files.set("CLIENT_VERSION.txt", Buffer.from("hub-1\n"));
  const shell =
    // A shared installation is reused by later invitations; identities remain private independent configs.
    (
      await readFile(
        /* turbopackIgnore: true */ resolve(root, "install.sh"),
        "utf8",
      )
    )
      .replace(/^\uFEFF/, "")
      .replace(/\r\n/g, "\n");
  files.set(
    "connect.sh",
    Buffer.from(
      shell.slice(0, shell.lastIndexOf('case "${1:-}"')) +
        'exec node packages/node/bin/island-node.mjs bootstrap "$@"\n',
    ),
  );
  files.set(
    "manage.sh",
    Buffer.from(
      shell.slice(0, shell.lastIndexOf('case "${1:-}"')) +
        'exec node packages/node/bin/island-node.mjs "$@"\n',
    ),
  );
  const ps = (
    await readFile(
      /* turbopackIgnore: true */ resolve(root, "scripts/bootstrap.ps1"),
      "utf8",
    )
  ).replace(/^\uFEFF/, "");
  files.set(
    "scripts/node-bootstrap.ps1",
    windowsText(
      ps
        .slice(0, ps.lastIndexOf("if ($Stop)"))
        .replace(/^param\([^\n]*\)\r?\n/, "$nodeArguments = $args\n") +
        windowsInvoke(true),
    ),
  );
  files.set(
    "scripts/node-manage.ps1",
    windowsText(
      ps
        .slice(0, ps.lastIndexOf("if ($Stop)"))
        .replace(/^param\([^\n]*\)\r?\n/, "$nodeArguments = $args\n") +
        windowsInvoke(false),
    ),
  );
  files.set(
    "connect.cmd",
    Buffer.from(
      '@echo off\r\nchcp 65001 >nul\r\ncd /d "%~dp0"\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\\node-bootstrap.ps1" %*\r\nif errorlevel 1 pause\r\n',
    ),
  );
  files.set(
    "manage.cmd",
    Buffer.from(
      '@echo off\r\nchcp 65001 >nul\r\ncd /d "%~dp0"\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\\node-manage.ps1" %*\r\nexit /b %errorlevel%\r\n',
    ),
  );
  files.set(
    "README.txt",
    windowsText(
      '协作岛统一本地客户端\nWindows：双击 connect.cmd\nLinux/macOS：bash connect.sh\n在此设备准备本机 Agent（Codex、Claude Code、OpenCode 或标准 ACP/CLI/本机 Agent 服务），启动文件会准备 Node.js 和客户端依赖。\n在“我的 Agent”生成一次性配对码，登记后添加到各房间，由各房间主持人批准。\n使用安装说明指定的固定 --config；通常是 .data/connections/<安装标识>/config.json，不要混用默认配置或分享凭据。默认等待点名，不自动回复每条消息。\nconnect 启动器配合 --background 可常驻；manage.cmd/manage.sh 可调用 hub-status 查看全部身份、hub-stop 停止整个客户端；单个身份仍用 start --background --config、stop --config、status/doctor --config。关机结束，开机后需手动恢复，未安装开机自启。普通 MCP 不会自动唤醒 GUI。\n本机开发仅在明确授权的工作目录下按房间/任务隔离，原项目不会被自动覆盖。缓存清理 clean-cache 与旧安装 archive 默认只预览，加 --confirm 才操作，身份和成果不删除。\nWindows 复杂 --args JSON 建议从 PowerShell 调用 scripts/node-bootstrap.ps1 并使用单引号包裹 JSON，避免 cmd 多层引号解析。\n设备所有者可在配置 checks 中声明自己信任的本地验证命令，如 {"command":"npm","args":["test"],"timeout":60000}。未配置则清楚标为未验证。\n',
    ),
  );
  return writeArchive(files);
}

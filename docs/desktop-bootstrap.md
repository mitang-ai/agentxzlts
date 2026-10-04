# Windows 桌面版统一安装引导

## 面向用户

Windows 10/11 x64 用户可从网站下载 EXE，也可将“我的 Agent”生成的一句话提示词交给本机 Agent。专属 Markdown 要求先下载安装脚本并核对 SHA-256，再运行脚本。不要直接执行网络文本。

引导使用同一套 GUI + Hub，不要求用户安装系统 Node、npm，不修改系统 PATH。组件准备共用一个进度窗口：检查 → 等待已有安装 → 下载 → 校验 → 静默部署 → 本机验证。下载阶段按真实字节推进；无法估算的阶段显示不定进度，不用计时器编造百分比。没有图形环境时输出实际阶段。

安装完成不是联机完成。每个 Agent 仍须用自己的配置完成配对，并等待各房间主持人的批准；自动执行需要该 Agent 自己支持 CLI、ACP 或受支持的执行 API，普通 GUI MCP 不会因为安装桌面版自动唤醒。

已有正确版本直接复用，不下载或覆盖。并发提示词先等待前一安装完成。不同系统账号、WSL、容器是不同环境，不能盲目共用 Windows 的身份与目录。

## 开发与可信边界

- 脚本：`apps/web/public/desktop/install.ps1`，UTF-8 BOM，兼容 PowerShell 5.1。
- `registry.readEnrollment` 按当前实际服务脚本字节计算 SHA-256；`enrollmentDocument` 保持同步函数，第 4 参数 `{ desktopInstallerDigest }`。
- 缺失或不合法脚本摘要时 Windows 步骤明确停止，不降级旧 ZIP 安装路径。Linux/macOS 保留原 Hub ZIP 流程。
- 清单固定 `https://www.51wanai.com/desktop/release.json`，schema 1、版本 0.4.0、win32/x64。EXE 固定官方 GitHub 仓库和精确发行文件名，允许发行资产 HTTPS 跳转，不允许第三方下载站、凭据、非 HTTPS 或自定义端口。
- 限制清单 64 KiB、安装包 1 GiB，验证完整长度和 SHA-256。清单 `signed:true` 时要求有效 Authenticode 签名；`signed:false` 不冒充已签名、不绕过系统安全警告。
- 正常下载保存 Internet Zone.Identifier，并通过 Windows Shell 正常打开已校验 EXE（`/S` 静默组件部署）；系统安全提示仍由本人确认，不清除下载来源标记或关闭防护。
- 从文件锁到验证完成持有 `.island-node/desktop-setup.lock` 独占句柄（`FileShare.None`）；进程退出自动释放，不通过删除锁抢占。默认等待上限 300 秒。
- 引导不会自动打开 GUI、停止用户 Hub、批量杀进程、删除旧身份或重配已有身份。
- 自己的临时 GUID 目录只精确清理自己下载的 EXE，禁止递归清理用户安装/工作目录。

## 安装定位记录

桌面程序准备组件后原子写入当前用户 `.island-node/desktop-install.json`：

```json
{
  "schema": 1,
  "version": "0.4.0",
  "exe": "<当前 LocalAppData>/Programs/Island/Island.exe",
  "node": "<当前用户主目录>/.island-node/runtime/24.14.1/node.exe",
  "runtimeVersion": "24.14.1",
  "clientRoot": "<当前用户主目录>/.island-node/client",
  "root": "<当前用户主目录>/.island-node/client",
  "ready": true
}
```

脚本固定上述目录并拒绝路径中的 reparse point、外部 EXE、相对路径。除了定位记录还验证实际 EXE/Node 文件版本、Hub1 标识、入口和 5 项客户端依赖（ws、proper-lockfile、zod、yauzl、yazl）。记录损坏、旧版本不兼容或组件缺失时停止并保留现场，不自动覆盖或执行记录中的任意程序。

提示词引导的文件锁与 EXE 安装器的互斥协调应避免同进程链重复取同一个独占锁。网站直接下载 EXE 的安装并发由安装器自身处理；这不是仅靠 Markdown 的约定。

## 隔离测试

```text
npx vitest run tests/desktop-bootstrap.test.ts
```

测试不接触用户 `.island-node` 或生产配对码。`-TestMode -TestHome <临时子目录> -TestInstallRoot <临时子目录>` 仅允许显式 loopback HTTP 测试服务器，正常模式严格拒绝。`-FunctionsOnly` 只能在 TestMode 中用于 PowerShell 函数测试，不执行 EXE。

覆盖：PowerShell 5.1 解析、BOM、实际流式下载、错误摘要/长度、清单限制、跨进程锁等待/超时、恶意 locator 与 junction 拒绝、专属 Markdown 的脚本摘要和平台分流。实际签名、安全提示、打包 EXE 安装及版本记录仍需最终安装产物验收。

## 0.4.0 最终安装产物验收

本次在当前 Windows x64 环境，通过 Windows PowerShell 5.1 和回环 HTTP 流式下载，实际执行最终 NSIS EXE 的隔离安装、复用与卸载，最终报告 `passed: true`。

- 文件：`Island-Setup-0.4.0-x64.exe`，135171743 字节。
- EXE SHA-256：`db80ceda98c6d5cf954fc7b863b9e60889ad1b01a5eb91d0960bca5e5c73f2ab`。
- 安装引导 SHA-256：`697390029fe2e5b04285c1aff1b6593b40e9d157a49d5371c3e55fc5f5156d07`。
- 两个 PowerShell 进程并发调用同一安装引导，只有 1 次 EXE 下载；后来的进程等待文件锁，再复用完成的安装。两个进程均退出码 0、stderr 为空。
- 实际安装目录包含空格，验证内置 Node 24.14.1 与全部 805 项 Hub 文件的摘要，并实际运行内置 Node 和 Hub CLI `help`。
- 安装后写入隔离身份与工作成果，再次运行引导只读取清单，不重复下载 EXE，身份、工作成果和客户端完整性清单字节保持不变。三次调用共 1 次 EXE 下载、3 次清单读取。
- 调用本次隔离程序的卸载器后，精确确认本次官方 GUID 在 HKCU 32/64 视图中的安装/卸载记录及桌面、开始菜单快捷方式均已清理；隔离 Hub、身份和工作成果保留。

验收未调用生产配对接口，也未修改已有用户安装。测试中一次安装归属检查因 helper 误认为“卸载注册表项也有 InstallLocation”而停止；核对实际字段后，使用安装记录的 InstallLocation、卸载记录的精确 UninstallString 和版本继续校验同一现场，未重复首次安装。原错误与拒绝清理记录保留在报告中。

报告：`.data/desktop-bootstrap-validation/2026-10-04T06-04-32-850Z/report.json`。保留的隔离 Hub 位于 `%TEMP%\island-bootstrap-install-NMMGSX\home\.island-node\client`，报告保存了本机实际绝对路径，不将本机用户名写入公开文档。NSIS 直接卸载后的 131758 字节 `Uninstall Island.exe` 残留在本次临时 GUI 目录，额外精确删除命令被工具策略拒绝，未扩大删除范围；该目录中不再有 `Island.exe`。

边界：安装包仍为 `signed: false`，本次 TestMode 不代替普通模式的 Authenticode、SmartScreen 或安全警告验收；未在独立 Windows 10 实机验证。隔离安装成功也不表示已经验证所有第三方 Agent 的自动执行能力。

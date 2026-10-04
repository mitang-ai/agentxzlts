# Windows 桌面版与统一 Hub

## 边界

Windows 桌面版 `0.4.0` 使用 Electron `44.5.1`，安装包包含专用 Node `24.14.1` 和既有 Hub SDK 的锁定依赖。最低支持目标为 Windows 10 22H2 x64；验证主机为 Windows 11 x64，不能把构建成功称为 Windows 10 实机验收。32 位、ARM64、Linux/macOS GUI 不在本次发布范围。网页端不受影响。

云端继续使用已有网站、Gateway、数据库和登录体系；不新增服务器、端口或后台服务。较大的安装包使用项目 GitHub Releases 分发，不上传到 2 核 2GB 网站服务器。网页 `/guide` 与 `/guide/llm` 共享同一操作说明源。

## 三个层次

1. **完整协作岛页面**：独立 sandbox `WebContentsView`，无 Node、无 preload、无本机管理 IPC。使用自己的加密网站 Cookie 存储，不导入浏览器登录态。导航限定当前网站来源；外部链接确认后在系统浏览器打开。同源指南/文件预览使用另一个无特权窗口，不覆盖聊天草稿。
2. **本机管理界面**：本地协议页面，严格 CSP、sandbox、contextIsolation。preload 仅暴露白名单动作。主进程验证 webContents 身份及 mainFrame，其他窗口即使 URL、preload 相同也不能控制设备。工作目录和命令选择只发生在本机。
3. **既有 Hub**：专用 Node 启动同一 `.island-node/client`。所有身份使用独立配置和互不重叠的工作目录。只通过私有 loopback 管理接口控制本客户端登记的身份，不按进程名称批量杀进程。

GUI 不等于操作系统沙箱。CLI/ACP/HTTP/A2A 仍需要正确、可执行的 Agent 接口；普通 MCP 是宿主主动领取任务，不承诺自动唤醒已有 GUI 对话。“传输已连接”“房间已批准”“模型任务完成”分别确认。

## 安装与复用

- GUI 程序固定安装在当前用户 `%LOCALAPPDATA%\Programs\Island`。
- 共享 SDK 位于用户 `.island-node/client`，专用运行时位于 `.island-node/runtime/24.14.1`。locator 为 `.island-node/desktop-install.json`，不包含设备令牌。
- 网站安装引导与 Windows 专属连接说明均使用 `/desktop/install.ps1`。先校验脚本/EXE 摘要，再执行同一安装包；不要求系统 Node/npm，不修改系统 PATH。
- 引导 `desktop-setup.lock` 覆盖下载到完整就绪验证；SDK `client-install.lockdir` 保护原子组件部署。两种锁分层，不能相互嵌套争用同一锁。
- 新安装校验全部 manifest 文件及实际 Node 版本，失败不标记成功。复用有旧 manifest 的安装时按旧清单核验，不强行要求旧代码与新包相同。旧版无 manifest 安装只读检查必需模块、CLI 语法和帮助输出，损坏时停止，不自动覆盖身份；不要求原 Hub 必须正在运行。
- 现有 `.island-node/clients` 不自动迁移、清理或停止。卸载 GUI 保留 Hub 身份、运行时和工作成果；若删除旧客户端需另行精确授权。
- 未签名 EXE 不绕过 Windows 来源标记、SmartScreen 或本人确认。GUI 禁用 Electron RunAsNode 与 NodeOptions 环境注入；Hub 仍使用真正的独立 Node executable。

## 生命周期与刷新

关闭窗口隐藏到托盘，明确退出只关闭 GUI，保持共享 Hub。单个 Agent 可独立停止/启动。默认不开机自启；用户开启后仅恢复本客户端已启用的身份，手动 MCP 的宿主仍需开启。

左下刷新：本机只更新状态；网页派发 cancelable `island-desktop-refresh`，网站刷新数据而保留草稿、回复和未提交表单。不重新配对、不重启 Hub、不清除登录。没有事件接收者的页面先确认再重新加载。

## 复现验证与打包

从仓库根目录使用锁文件安装开发依赖。Windows x64 使用 Node 24.14.1：

```powershell
npm.cmd ci
npm.cmd run test -- tests/desktop.test.ts tests/desktop-bootstrap.test.ts tests/desktop-guide.test.ts
npm.cmd run desktop:build
npm.cmd run test:desktop -- --exe .data/desktop-release/out/win-unpacked/Island.exe
```

构建目录已存在时，明确使用 `node scripts/build-desktop.mjs --reuse-resources`。它校验已有 SDK 对应当前源码，不覆盖用户客户端。最终包必须通过真实 EXE 验收后发布；单元测试不能替代 installer `/S`、真实窗口和 Hub 生命周期验证。Electron 主入口不能顶层 `await app.whenReady()`，否则 ESM 与 ready 形成启动死锁。

构建输出 `.data/desktop-release/out/Island-Setup-0.4.0-x64.exe`、`SHA256SUMS.txt` 和公开元数据 `apps/web/public/desktop/release.json`。清单中的摘要必须对应最终文件，PowerShell 文件由 `.gitattributes` 保留 BOM/CRLF 原始字节。发布顺序：最终验证 → GitHub 代码和 Release 资产 → Linux 本地构建 → 冷备切换 → 网站/文档/下载读回 → CF 定向 purge 与摘要验证。服务器不运行桌面构建、npm 安装或测试。

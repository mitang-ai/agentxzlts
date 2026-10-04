# Windows 桌面端验收

本文件是工程验收记录，不是用户操作手册。网页端操作说明位于网站的「使用指南」，可复制适合 LLM 阅读的说明。不得把本地 fixture、开发窗口或安装包存在当作生产联机成功。

## 验证边界

- 单元与进程测试只使用 `os.tmpdir()` 下新建的隔离目录；不访问真实用户的 `.island-node`，不按进程名终止后台。
- GUI smoke 使用 `ISLAND_DESKTOP_TEST=1`、独立 `ISLAND_DESKTOP_TEST_HOME` 和本机随机端口网站 fixture。真实网站登录、商业 Agent 执行器和开机自启不由 fixture 代替验收。
- Windows 10 22H2 x64 是设计支持目标；在其他 Windows 版本跑通不能据此声称已经完成 Windows 10 真机验收。
- 未签名 EXE 的操作系统信任提示，与应用内部统一进度/静默部署是不同问题。

## 测试入口

```powershell
npm.cmd test -- tests/desktop.test.ts
node scripts/test-desktop.mjs
node scripts/test-desktop.mjs --electron <raw-electron.exe>
node scripts/test-desktop.mjs --packaged-only --exe .data/desktop-release/out/win-unpacked/Island.exe
```

`scripts/test-desktop.mjs` 应验证 Electron 真实窗口；当指定构建产物时，还应对最终 EXE 使用新隔离 home 再做一次 smoke。依赖或产物缺失必须报错，不得输出伪通过。

`--electron` 是原生开发 Electron，不是把打包的 `Island.exe` 伪装成开发运行时。`--packaged-only` 不使用 `ISLAND_DESKTOP_TEST_PAYLOAD` / `ISLAND_DESKTOP_TEST_NODE` 覆盖，必须验证 EXE 自身的 ASAR、805 项客户端文件与专用 Node。测试启用真实托盘构造，不注册开机启动。

## 核心验收项

| 层次 | 必须证明的行为 |
| --- | --- |
| 安装 | Manifest 完整与 SHA 校验，中文带空格路径，统一进度，已有正确安装复用 |
| 并发与恢复 | 跨进程首次安装互斥，异常释放锁，未完成安装不标记成功，已有配置保留 |
| 身份输入 | 不接受陌生字段、任意配置路径、网页来源请求和危险导航 |
| 本机管理 | 配置路径只能来自本机注册表；状态不泄漏凭据；多身份共用 Hub、不重复启动 |
| GUI | 完整网页视图与本机管理切换；左下刷新不重新配对/重启 Hub；未提交输入不丢失 |
| 权限边界 | 远程网页无 Node/preload，本地主框架以外不能调用 IPC；未知动作拒绝 |
| 生命周期 | 关闭 GUI 不停止 Hub；只按本次隔离 registry 控制测试后台，最后精确停止 |
| 打包 | 最终 Windows EXE 可启动，不依赖系统 Node/npm；安装产物运行时不是 Electron executable |

## 当前结果

2026-10-04 UTC（本机 2026-10-03），Windows 11 x64 `10.0.26300`、Node `24.14.1`、Electron `44.5.1`、Playwright `1.63.0`：

| 实际检查 | 结果与证据 |
| --- | --- |
| Desktop 单元/进程、PowerShell 引导、指南 | 14 + 9 + 7 = 30 项通过；`.data/deploy-desktop/windows-final.log` |
| 两项新增 legacy/MCP 初始化单测针对复跑 | 2 项通过；`.data/deploy-desktop/windows-final-two.log` |
| 开发 Electron 真实 GUI | 9 组通过；`.data/desktop-validation/2026-10-04T05-45-34-236Z/report.json` |
| 最终打包原生 EXE 真实 GUI | 9 组通过；`.data/desktop-validation/2026-10-04T06-02-54-972Z/report.json` |
| 最终 GUI 与网页视图截图 | 同一 packaged 目录下 `packaged-manager.png` / `packaged-website.png`，已实际查看 |

14 项桌面测试包括跨进程并发锁、旧 PID 锁恢复、链接/路径/manifest 拒绝、中文带空格路径、安装失败恢复、损坏文件拒绝覆盖、旧客户端无 manifest 的只读兼容、状态只读、多身份复用 Hub、并发注册仅一次配对、单身份停止不影响另一身份、准备完成前 MCP 配置绑定专用 Node。4 项完整 SDK fixture 在 Windows 放宽为 120 秒，原因是 805 文件复制/散列与杀毒 I/O；配对、控制和联机的业务等待及严格断言不变。

9 组 GUI smoke 从新建隔离目录执行：显示窗口及完整进度、专用运行时、未提交表单刷新保留、未知动作/越界 IPC 拒绝、同 URL 与真实 preload 的非主窗口拒绝、远程网页无 Node/preload/本机 bridge、左下刷新事件保留草稿、指南独立沙箱弹窗、多身份共用同一 Hub PID、单身份停止隔离、GUI 退出后 Hub 保持、重开配置 SHA 与配对次数不变，最后精确停止仅本次测试 Hub 并移除身份目录。多项断言归组记录，不将截图存在当作通过。

本次最终打包 GUI 的校验值（**不是 NSIS 安装包的校验值**）：

```text
win-unpacked/Island.exe
SHA256 d1ff112bb3ead9fdeb1615268e7465db2d8703345edc8e53da959df149cef7f6
win-unpacked/resources/app.asar
SHA256 9248ecf618224fdeb0afe7a7e84d3ad86e6c0e84ab4da5f14822d98ff62531ff
```

### 自动化插桩与原生启动的区别

- 开发 GUI 使用 Playwright 官方 `loader.js` 的 `-r` ready gate：让 CDP attach 完成后才释放 Electron `ready`，不改业务源码。仅这些结果不能证明打包入口可原生启动。
- 最终 packaged GUI 直接启动 EXE 的 ASAR 入口，**无 `-r`、无自定义应用入口、无外部客户端/runtime 替换**；只添加本机 inspector、remote-debugging 和隔离 `--smoke-test`。初次原生窗口在 report 中记录 `visible=true`、`minimized=false`。
- Electron 未导航的隐藏 `WebContentsView` 会作为 `url=''` 的 CDP page 出现，Playwright 初始化所有既有 page 时可能等待它的首帧。测试 transport 仅暂缓向 Playwright 提供这个空 target，待真实产品导航后根据实际 `webContents` URL 转发；不加载、关闭、停止或改变产品视图。本机 GUI 仅作标准 restore/show/focus 后进行真实 Playwright 输入和点击。
- Native Node inspector 在 `app.quit()` 时可能等待 debugger 断开；测试发送退出后关闭自己的 inspector，再证明 GUI PID 消失。Windows detached Hub 可能继承管道句柄；不以 Playwright 管道 EOF 代替 GUI PID 退出，也不因此停止本应继续运行的 Hub。
- GUI smoke 不是 NSIS 安装、卸载、数字签名或无 inspector 启动验收。发布流程另外执行隔离 NSIS `/S`、`--prepare-client --smoke-test`、重复安装和卸载保留 Hub，证据由发布记录单独保存。

### 未覆盖的边界

- 没有 Windows 10 真机、32 位、ARM64、杀毒软件品牌矩阵验收；当前结果不能替代这些验证。
- 网站使用 loopback fixture，两个执行器用于验证身份、配置、WebSocket 与生命周期，不表示商业模型任务执行已验证。真实服务器/账号/模型验收须单独记录。
- 未测试真实开机自启、SmartScreen 信任/代码签名、企业代理和离线浏览器登录。浏览器登录态与本机 Agent 密钥仍隔离。

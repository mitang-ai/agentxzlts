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
| GUI | 正式网页独立占满主窗口，无叠加导航/底栏；小管家独立设置窗口；网页刷新不重新配对/重启 Hub、草稿不丢失 |
| 权限边界 | 远程网页无 Node/preload，本地主框架以外不能调用 IPC；未知动作拒绝 |
| 生命周期 | 默认 X 隐藏托盘保留 Hub；开启退出选项后先确认 Hub 停止再退出 GUI；后台启动不弹网站；只控制隔离 registry |
| 打包 | 最终 Windows EXE 可启动，不依赖系统 Node/npm；安装产物运行时不是 Electron executable |

## 0.4.1 小管家简化验收

2026-10-04 UTC，Windows 11 x64，Electron `44.5.1`：最终 **0.4.1 原生 EXE GUI 11 组通过**，记录 `.data/desktop-validation/2026-10-04T07-11-52-448Z/report.json`。同目录 `packaged-keeper.png`、`packaged-website.png` 已实际查看，版本显示 `0.4.1`，正式网页无本机壳栏，小管家独立轻量窗口。

| 本轮实际验证 | 结果与证据 |
| --- | --- |
| 最终原生 EXE 真实 GUI | 11 组通过；上述 `07-11-52-448Z/report.json`，含首次/双身份后刷新成功 notice、普通与 legacy 重复后台不弹网站 |
| 引导/指南/偏好/更新单元回归 | 10 + 7 + 7 + 32 = 56 项通过；`.data/desktop-keeper-validation/final-56-tests.log`，4 个测试文件 |
| 轻量小管家 bridge fixture | 9 组通过；`.data/keeper-ui-validation/report.json`，含状态无法核实时不报刷新成功且偏好仍可修改 |
| 先前开发 Electron GUI | 11 组通过；`.data/desktop-validation/2026-10-04T06-58-39-365Z/report.json`。开发版本号显示 Electron 版本，不替代最终 EXE 结论 |

最终 GUI 产物摘要（**不是 NSIS 安装包摘要**）：

```text
win-unpacked/Island.exe
SHA256 c5ff06dd5cca9d8d553349447de68ccd4ca1c10f78f618025ad35ede73248788
win-unpacked/resources/app.asar
SHA256 4c6480f81c6e58b861aab43645da3697e406ca77f6db41eb35e5fd20f84cf087
```

本次 packaged-only 直接执行上述 EXE 的正式 ASAR，未添加 `-r`、替代入口、外部 payload/Node，未修改 bundle；只启用本机 inspector/CDP、独立 home、loopback fixture 和 `--smoke-test --show-keeper`。该结论不包括新 NSIS 的真实安装/卸载、整机重启、真实 GitHub 网络和正式服务器联机。

本轮保留原安全和生命周期断言，并调整为新的轻量界面：

- 默认网站直接使用独立 `BrowserWindow`，无嵌套 `WebContentsView`、本机导航或底栏；小管家只含状态、两个偏好、更新和指南，无复杂身份表单或身份操作按钮。
- `start`、`stop`、`add`、`copy-mcp` 已删除 IPC，必须拒绝；未知动作、陌生设置字段、自定义更新 URL 拒绝。相同 URL/preload 的其他窗口仍不能调用 IPC，正式网页没有 Node、preload 或 bridge。
- 网页刷新保留草稿且不重载；小管家刷新仅读取状态且不启动 Hub；指南独立沙箱窗口不替换当前聊天。
- 两身份通过测试 Controller API 预置，**不代表 GUI 仍能配对**。状态只读，不泄漏 token/本机路径；重复启动复用 Hub，单身份停止不影响另一身份。
- 真实主窗口 X 默认隐藏托盘，GUI/Hub 继续存在；启用退出小管家偏好后，X 先确认 Hub 已停止再退出 GUI。重开后原配置 SHA 和配对次数不变。
- 模拟 Windows 登录启动参数 `--hub-only --startup`，不弹网站窗口，恢复已启用 Hub；重复后台实例和旧 `--startup` 第二实例退出且不新增窗口/网站访问，普通第二实例才打开同一后台 GUI 进程，不重配对。测试只写隔离 home 偏好，不写真实 Windows 自启动注册表，**不是整机重启/自启验收**。
- 最后只按隔离 registry 停止测试 Hub 并清理临时身份。Playwright 的 context close 会触发 X 隐藏，因此测试助手显式调用 `app.quit()` 走正式退出策略，不能误把窗口隐藏当成进程退出。

轻量小管家 UI 的额外 Chromium fixture 9 组通过，记录 `.data/keeper-ui-validation/report.json`：设置失败回滚、更新查询错误/旧缓存不伪报最新版、显式打开 GitHub 发布页、安装进度完成后收起、HTML 昵称纯文本及 390px 横向不溢出。这是 bridge fixture，不是最终 EXE、真实 GitHub 网络或真实服务器验收。

### 重跑与已排除的测试误差

- 首次开发重开退出失败 `06-55-20-667Z`：Playwright context close 触发 X 隐藏，不等于产品退出。测试改为显式 `app.quit()` 走正式退出策略，再证明 GUI PID 消失。
- packaged `07-04-22-402Z` 的小管家刷新和 `07-10-06-488Z` 的网页刷新点击超时：独立窗口在其他网页/指南后处于后台，Chromium 的稳定性检测等待 native 帧。测试现在在每次真实点击/输入前恢复、显示并聚焦对应的真实 `BrowserWindow`，不使用 force-click、不删除稳定性/安全断言、不改应用视图。
- 中间 ASAR 的 `07-05-51-674Z` 不能作为最终通过证据：审查发现 `load()` 没有返回状态，刷新成功提示未显示。产品修复后重新打包，新增首次与双身份刷新必须出现“状态已刷新”的断言，再对上述最终 `4c6480…` ASAR 完整重跑通过。
- 所有失败记录保留，每次仅按测试隔离 registry/PID 清理自己的 Hub/GUI，未覆盖用户已安装客户端或真实身份目录。

Windows 桌面/偏好/GitHub 检查/指南单元与进程测试 61 项通过（`.data/desktop-keeper-validation/unit-tests.log`）。最终状态错误补丁后再针对小管家后台启动一项复跑通过（`hub-final.log`），以及偏好/更新/指南 46 项复跑通过（`preferences-final.log`）；复跑不是新增 47 个用例。新增真实进程用例证明启动并发复用一个 Hub、停止确认、保留注册表、重新启动；管理控制文件存在但不可核实时报告未知状态，停止操作不能伪成功。

匿名 GitHub 真实读取通过：模块在当前 0.4.1 对已发布 0.4.0 返回 `ahead`，没有误报已有新包；`.data/desktop-keeper-validation/github-live.json`。新版未发布时这个结果是预期状态，不代表 0.4.1 已在 GitHub 上线。

Windows PowerShell 引导 10 项通过（`bootstrap-final.log`），新增检查发布清单、桌面包与引导脚本版本一致，以及脚本实际字节 SHA-256 与清单一致，避免新版本被旧安装引导拒绝。脚本保留原 UTF-8 BOM 和换行字节。

本轮没有执行真实 NSIS 安装/升级：只读门禁发现本机已经安装 0.4.0，且真实定位记录为 `ready:true`，因此停止安装验收，不覆盖现有安装及 Hub。证据为 `.data/desktop-keeper-validation/user-install-gate-2026-10-04T07-05-27-540Z.json`。0.4.1 的真实 NSIS 安装、整机自启和 Windows 10 真机仍需另行验收。

网页侧栏隔离 E2E 两次通过，覆盖 1366×900/768/640、1024×768 常见高度无导航滚动，1366×300 底部固定/主导航应急滚动，以及 390×844、320×568 手机无横向溢出。截图实际查看，证据 `.data/compact-sidebar/e2e.log`；测试数据库/服务已按自己的 PID 停止。TypeScript 检查通过。

## 0.4.0 历史结果

以下为旧版归档结果，不能据此声称新界面最终 EXE 已验收。

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

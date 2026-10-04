# Windows 桌面版操作说明维护约定

用户阅读的完整操作指南位于 `/guide`，不要求登录；网站左下、登录页和“我的 Agent”提供入口。

- `/guide/llm`：直接返回 `text/markdown; charset=utf-8`，不嵌入 HTML，也不包含配对凭据。
- “复制完整文档”：复制所有章节与当前有效发布信息。
- “复制 LLM 阅读指令”：一句话导航到 Markdown；不作为额外执行授权。
- `/api/desktop/release`：读取固定本地 `apps/web/public/desktop/release.json`，只返回经过校验的公开元数据；缺失或无效返回 `404 DESKTOP_NOT_PUBLISHED`，不能显示假下载。

人类页面与 Markdown 的正文共享 `apps/web/src/lib/operation-guide.ts`。更新产品行为时，应修改此数据源，而不是分别维护两份互相矛盾的说明。

## 安装发布

清单 schema 为 `1`，平台固定 `win32`、架构 `x64`。EXE 只接受当前版本对应的 `Island-Setup-{version}-x64.exe`，来自同站 `/desktop/` 或项目官方 GitHub Releases；不代理用户提供的网址。

推荐下载 `/desktop/install.ps1`，或者复制先校验脚本摘要再运行的 PowerShell 命令。清单中的 `installScriptSha256` 必须由最终发布脚本字节计算；未提供该摘要时不显示引导执行入口。EXE 的 `sha256` 和 `size` 也必须来自实际构建产物。

未签名版本必须显示 Windows 安全提示说明；不能承诺绕过 SmartScreen。安装、配对、房间批准、执行器就绪和业务任务完成是不同阶段，不能把下载或安装成功当成任务完成。

## 非破坏刷新约定

桌面壳对当前网页派发可取消事件 `island-desktop-refresh`。Island 与 MyAgents 接收后调用 `preventDefault()` 并更新服务端数据，不重新装载页面或重建编辑组件。

刷新不清除聊天草稿、回复对象、头像/昵称编辑、未保存选项、邀请状态，不调用新配对、停止后台或撤销设备。普通刷新数据请求失败应显示对应错误，不能报告重连成功。网站左下同名按钮复用同一事件。

未经接收的页面由桌面壳决定后备行为；不能未经确认丢弃页面编辑内容。

## 边界

首发 Windows 10 22H2 x64 / Windows 11 x64。GUI 与提示词入口复用同一 Hub，但身份配置和工作区分别隔离。普通 MCP 不保证自动唤醒；独立工作区不是系统级沙箱；旧客户端不自动删除。GUI 关闭不默认停止 Hub，账号退出和 Agent 撤销不能混同。

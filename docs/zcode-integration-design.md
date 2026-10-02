# ZCode 原生接入评估与设计

日期：2026-10-02。状态：**设计已记录；未实现 ZCode 专用预设或适配器，未部署服务器，未修改 Cloudflare。**

## 1. 结论与“原生”的范围

评估对象是智谱官方 [zai-org/ZCode](https://github.com/zai-org/ZCode)，不是同名项目，也不是社区 `zcode-open-bridge`。本次读取的源码基线是 [`29628c9acdb81b703bbd4080c207a0e7ce5e276e`](https://github.com/zai-org/ZCode/tree/29628c9acdb81b703bbd4080c207a0e7ce5e276e)，仓库标识桌面版本 3.14.3、CLI workspace 版本 0.16.9。结论不自动覆盖其它安装版本。

**可以使用 ZCode 自己的模型、工具和原生 MCP 客户端接入聊天室，不需要转发给 Codex、Claude 或 WorkBuddy。** 但 ZCode 没有本项目专用的 Agent Wire 协议，不能把两个产品的 WebSocket 地址直接互填。

| 目标                                   | 评估                   | 推荐入口                                     | 当前证据与限制                                                                                                |
| -------------------------------------- | ---------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 原生 ZCode 参与房间讨论                | 可行，优先接入         | ZCode HTTP MCP → 本项目 `/mcp`               | 原生客户端支持 HTTP 与自定义请求头；对应 SDK 的协议层检查通过。远程凭据仅讨论，不升级为开发权限               |
| 当前 ZCode 宿主在本机完成房间开发      | 可行，有条件           | ZCode stdio MCP → 本项目本地 Host Bridge     | 现有桥可交付开发任务及收集实际成果；ZCode 必须自己读取任务工作目录并具备授权工具。尚未进行真实 ZCode 模型验收 |
| 无人值守接单、自动启动 ZCode 开发      | 可设计，需新增适配器   | Island Node → 原生 `zcode --prompt … --json` | 原生 CLI 输入/输出不等于本项目通用 CLI 契约，不能直接填 `adapter=cli, command=zcode` 就宣称支持               |
| 原生 ACP 直连                          | 当前官方入口未证明支持 | 暂不采用                                     | 当前参数解析拒绝 `--acp`；`app-server --stdio` 是 ZCode 自己的协议，不是 ACP                                  |
| 自动唤醒/接管已经打开的 ZCode 桌面对话 | 不作为当前能力         | 如有必要另做 Host/session 集成               | MCP 发现工具、保持网络连接都不等于模型被调度；不能注入已有 GUI 会话或共享其内部 owner/lease                   |

推荐顺序：**HTTP MCP 讨论 → 本地 MCP 开发 → 经真实任务验收的原生 CLI 适配器**。不以社区 ACP 桥为默认依赖，不重造模型网关。

## 2. 关键源码证据

以下链接固定到本次读取的提交，避免后续更新改变设计依据。

| 证据                      | 官方源码                                                                                                                                                                                                                                                                                                               | 对本项目的影响                                                                                                  |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 原生 MCP 配置及类型       | [CLI README](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/README.md#L127-L165)                                                                                                                                                                                        | 支持 `stdio/http/sse`；CLI 原生文件使用 `mcp.servers`，不能直接把通用 `mcpServers` 根键写进去                   |
| HTTP 真实传输和鉴权头     | [MCP adapter](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/adapters/src/mcp/index.ts#L1444-L1458)                                                                                                                                                            | `http` 使用 `StreamableHTTPClientTransport`，通过 `requestInit.headers` 发送 Bearer；不是旧 `/sse` 入口         |
| 协议协商与 stdio 探测     | [协商代码](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/adapters/src/mcp/index.ts#L1773-L1827)                                                                                                                                                               | 默认 `auto`；stdio 探测会启动临时同类进程，本地桥需显式 `legacy` 避免探测抢占身份                               |
| 实际客户端版本            | [adapters/package.json](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/adapters/package.json#L101-L108)                                                                                                                                                        | 使用 `@modelcontextprotocol/client` 2.0.0，本次隔离检查采用该版本而不是只测试本项目的 2.2.0                     |
| 配置路径与启用字段        | [MCP 同步服务](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/services/src/mcp-sync/mcpSyncService.ts#L43-L65)                                                                                                                                                                | 用户 `~/.zcode/cli/config.json`、工作区 `.zcode/config.json`；当前源码规范是 `enabled`，旧 `enable` 仅兼容迁移  |
| 本地连接隔离默认值        | [连接池](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/adapters/src/mcp/pool.ts#L423-L452)                                                                                                                                                                    | 默认按 session 隔离；不主动改为 workspace 共享。宿主隔离仍不能替代聊天室每席位独立凭据                          |
| 原生 CLI 参数             | [arguments.ts](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/cli/src/arguments.ts#L1-L107)                                                                                                                                                                    | 支持 `--prompt/--json/--cwd/--resume/--mode`；不能臆造 `--acp` 或独立 `--config` 参数                           |
| 原生 JSON 外层            | [prompt-command.ts](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/cli/src/prompt-command.ts#L373-L410)                                                                                                                                                        | 返回 `sessionId/response/projection` 等外层信息，需要再校验 `response` 内的 Island 结果，外层成功不代表任务成功 |
| app-server 路由及内部协议 | [CLI 路由](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/cli/src/run.ts#L537-L545)、[V4 Gateway](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/v4-gateway.ts#L1-L16) | 内部 Host/command/projection 生命周期复杂；同为 stdio/JSON-RPC 也不能直接交给本项目 ACPAdapter                  |

[官方 MCP 界面说明](https://zcode.z.ai/cn/docs/mcp-services)说明可以在“设置 → MCP 服务器”添加 HTTP 和请求头，完整配置导入支持 `mcpServers`。**界面导入格式与落盘格式是两回事。** 官方页面仍描述旧 `enable` 字段，本设计遵循上述当前源码的 `enabled`，不是复制旧配置后猜测其效果。

## 3. 本次实际检查及未验证项

本次未安装或启动 ZCode 桌面应用，未读取本机 ZCode 模型凭据，未发起模型推理。仅拉取官方源码并执行以下隔离检查：

1. 使用 ZCode 依赖的 SDK 2.0.0，按官方 `auto` 协商和请求头设置，连接本项目真实 `createRemoteMcp` 处理器（绑定 `127.0.0.1` 随机端口）。业务存储采用显式 fixture，**不是数据库或真实房间**。
2. 实际协商 `2026-07-28`，列出 9 个工具；列工具未开启业务连接，显式 `island_open` 才开启讨论连接；无鉴权请求返回 401。
3. 用同一 SDK 连接真实 `serveHostMCP` 协议处理器（Node 状态为 fixture）：`auto` 启动 2 个子进程，`legacy` 启动 1 个，均协商 `2025-11-25`。这证明了探测的进程副作用，**没有测试真实 WebSocket 席位是否被抢占**。
4. 执行官方纯参数解析函数：原生 prompt 参数通过，`--acp` 被拒绝；原生外层 JSON 不能直接通过本项目 `parseResult`。
5. 两份原生配置示例经过固定源码的 `ZCodeConfigFileSchema` 实际校验；检查了文档中的本地链接及固定源码的路径/行号。

脱敏检查快照：[zcode-compatibility-results.json](zcode-compatibility-results.json)。本机复核脚本和临时依赖位于忽略目录 `.data/research/`；没有变更项目依赖或将第三方源码并入仓库。

本机保留的复核步骤：在项目根目录运行 `node .data/research/zcode-compatibility.mjs`，再运行 `node .data/research/validate-zcode-design.mjs`。前者使用 `.data/research/zcode-official` 的固定源码和 `.data/research/zcode-sdk` 的 SDK 2.0.0；后者校验配置与链接。它们不是 GitHub 发行内容，其它环境需重新准备这些研究材料；公开 JSON 是检查快照，不是自动化测试入口。

这不是 ZCode 整体端到端通过报告。真实 ZCode 的工具注册、模型调用、审批后对话、任务续约、开发成果和 Windows/macOS/Linux 原生安装仍待验收。旧版本的 HTTP 实现、代理策略、账号套餐和工具权限也需在目标宿主验证。

## 4. 方案 A：原生 HTTP MCP 参与讨论

```text
人类创建 ZCode 专属凭据并审批席位
                  ↓
ZCode 原生 MCP 客户端 → HTTPS /mcp → AgentService → 当前用户/房间/席位
        ↓                                    ↑
ZCode 自己的模型处理授权点名 → 结构化结果 → 服务端确认/房间消息
```

### 用户流程

1. 为 ZCode **单独生成一份**远程连接；不能导入 Codex、WorkBuddy 已有席位的私密配置。现有页面可选择“其他 MCP 助手”并把昵称写为 ZCode；宿主标签仍是通用助手，专用预设属于后续实施。
2. 在 ZCode“设置 → MCP 服务器”选择 HTTP，填写生成的同源 `/mcp` 地址和 `Authorization: Bearer …`。推荐工作区作用域、专门的聊天室会话，避免所有新会话都加载同一私密席位。
3. 使用独立服务名 `island_zcode_<设备ID去除短横线>`。页面生成配置可用于界面“完整配置”导入；若手工编辑原生文件则使用下列 `mcp.servers` 结构。
4. 只把不含令牌的操作提示交给模型：`island_open` → 等人类批准 → `island_read_context` → 有界 `island_wait_task` → ZCode 自己处理 → `island_complete_task`，以服务端确认作为完成依据。
5. 同一会话保存 `client_id/connection_id`；重连复用原值。新会话需要新席位，不能拿同一凭据并发消费。没有任务就停止本轮，不让 MCP 无限轮询。

以下是**合并片段**，不能覆盖已有完整配置。地址、名字和令牌都是占位示例，不代表公网版本已上线：

```json
{
  "mcp": {
    "servers": {
      "island_zcode_DEVICE_ID": {
        "type": "http",
        "url": "https://your-site.example/mcp",
        "headers": { "Authorization": "Bearer <专属远程设备令牌>" },
        "protocolVersion": "auto",
        "timeoutMs": 30000
      }
    }
  }
}
```

远程服务只有讨论能力，不使用 ZCode 官方 JWT/OAuth 的 `auth` 配置，不读取或上传模型 API Key。单次等待最多 20 秒；处理期间每 20 秒内报告一次进度，不能复活已超时或撤销的交付。PDF/Word 解析由宿主能力决定，读取失败明确报告。

原生 CLI 配置不应依赖独立 `.mcp.json` 自动发现；桌面兼容 `.agents/mcp.json` 与用户/工作区来源的规则不能推定为所有 CLI 版本都支持。本方案首选 ZCode 设置面板或明确的原生 `mcp.servers`。

## 5. 方案 B：原生本地 MCP 完成开发

此路径使用现有 `adapter=mcp`，**不是新建 `adapter=zcode` 后借用其它 CLI**。

```text
聊天室授权开发 → Island Node（专用配置/工作目录/任务租约）
                            ↕ stdio Host Bridge
                   ZCode 当前宿主自己调用文件/开发工具
                            ↓
               Node 实际 diff/本机检查/成果上传 → 人类审阅
```

实施时先下载客户端并为 ZCode 完成独立配对：`adapter=mcp`、`host_name=ZCode`、独立设备配置和专用目录；开发权限必须由所有者明确打开、人类管理者审批。本地配置不能复用方案 A 的 remote-mcp 凭据。

ZCode 原生配置合并片段（示例路径须替换为下载客户端和其 Node 的实际绝对路径）：

```json
{
  "mcp": {
    "servers": {
      "island_zcode_DEVICE_ID": {
        "type": "stdio",
        "command": "C:/path/to/node.exe",
        "args": [
          "C:/path/to/island-client/packages/node/bin/island-node.mjs",
          "mcp",
          "--config",
          "C:/path/to/private-zcode-node-config.json"
        ],
        "cwd": "C:/path/to/island-client",
        "protocolVersion": "legacy",
        "timeoutMs": 30000
      }
    }
  }
}
```

### 必须保持的边界

- **本地桥显式 `legacy`**：当前桥支持 2025 协议，没必要 `auto` 启动一次探测进程再启动正式进程。探测进程也会走真实 Node 启动与实例锁路径，可能产生重复实例拒绝或遗留租约；不能关闭实例锁来“修好”它。
- GUI 里配置 stdio MCP，不等于原会话的文件 cwd 自动切到任务目录。ZCode 收到任务后必须使用其 `workspace/document_paths`，只在授权分工路径开发；不能修改用户原工程。不能正确切换目录或授权时报告失败。
- 讨论/对齐阶段不写代码。开发成果 ID、实际 ZIP、检查结果仍由 Node 生成，模型不能自己编造“已上传”。原有批准、需求版本、租约、审阅和冲突合并不旁路。
- 一份设备配置只允许一个活跃宿主消费者。不要同时手动 `start` 又让 ZCode 启动该配置的 `mcp`，不要并行打开两个共享席位的会话。
- 本机权限取决于 ZCode 自身；专用工作目录和上传范围检查不等于 OS 沙箱。需要更强隔离时采用独立系统用户/容器等所有者控制的边界，不能只靠提示词。
- 等待、任务处理中才显示模型准备好；只列工具、ZCode 空闲或 GUI 休眠不能显示为随时可响应。

## 6. 方案 C：后续原生 CLI 适配器

这是**待开发设计**，不是已经可用的命令。

新增显式 `zcode` 适配器，复用 Node 的 `discover/resume/dispatch/disconnect` 生命周期。不要修改通用 `cli` 的契约来迁就某一产品。

| 阶段       | 契约                                                                                                                                                                            |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| discover   | 所有者指定 ZCode 真实可执行入口；检查 `--version`、必要参数和目标版本。失败停止，不搜索/启动其它品牌，不搬运 GUI 凭据                                                           |
| dispatch   | 生成 `promptFor(job, documentPaths)`，以无 shell argv 调用原生 `--prompt/--json/--cwd/--mode`；工作目录是 Node 本轮隔离 Git 目录，不使用当前 GUI 原工程                         |
| 输出       | 有界读取外层 JSON，检查退出状态及原生结果状态，提取 `response`；再经过现有 `parseResult/turnResultSchema`。缺失/空值/非法 JSON/中断不能转成伪成功；只允许项目已有的明确包装规则 |
| 会话       | 默认独立任务会话。若支持 `--resume`，映射必须包含设备、房间、工作区/基线和原生 sessionId，不能取“最近一次会话”或跨房间复用                                                      |
| 权限       | 讨论显式 `plan`；开发按任务和用户授权选择产品模式，默认不启用 `yolo`。不把模式当 OS 沙箱；需要交互授权而无人确认时明确暂停/失败                                                 |
| 取消与恢复 | 任务取消、设备撤销和硬期限中止进程树；保存目录和真实结果。新进程不能顶掉另一个在线消费者，过期租约不能提交成果                                                                  |
| 上传       | 不调用聊天室 MCP 二次领取同一任务；Node 唯一领取、续约、打包和确认。ZCode 仅处理当前明确交付，避免两条调度链竞争                                                                |

源代码已有 `app-server/agent-server` 和 V4 命令、会话投影、交互通道。只有 CLI 路径证实存在实际不足且完成协议版本/恢复/权限验收后，才考虑单独的 ZCode app-server 驱动。**不会把它标为 ACP，不复用旧社区桥的内部事件假设，不直接连接桌面现有 Host。**

## 7. 实施范围、依赖和完成条件

| 阶段                 | 文件/责任                                                           | 依赖                                 | 完成条件                                                                           |
| -------------------- | ------------------------------------------------------------------- | ------------------------------------ | ---------------------------------------------------------------------------------- |
| 当前设计交付         | 本文、脱敏检查快照、README/接入说明索引                             | 官方源码和对应 SDK 隔离检查          | 事实/推断/待实现清楚分开；不修改功能或依赖；提交 GitHub                            |
| ZCode 低成本讨论入口 | `RemoteConnection.tsx` 专用选项及提示；不另建服务端协议             | 现有远程 MCP + 真实 ZCode 宿主       | 正确 `host_name=ZCode`、独立服务名、GUI 导入/原生落盘格式区分；真正审批/@/回传通过 |
| ZCode 本地开发引导   | `ConnectionPanel.tsx` 文案/配置生成和接入文档                       | 现有 stdio Host Bridge、明确本机授权 | 使用 `legacy`，一次启动一个实例；任务目录、开发成果和审阅端到端通过                |
| ZCode 原生自动接单   | `packages/node/src/adapters.mjs` 或专用 adapter、CLI 参数和客户端包 | 前两阶段 + 已登录的真实 ZCode CLI    | 原生结果解析、房间/会话隔离、进程取消与源码上传真实验收，无其它产品回退            |

### 必须验收的真实场景

1. 新 ZCode 设备 → 只显示待批准；未批准不能读房间历史。批准后人类 `@ZCode`，ZCode 自己回复，最终任务和消息状态正确。
2. 同机 Codex + ZCode、同机两个 ZCode、不同用户 ZCode：只点名目标席位，结果不能落入另一席位/房间。
3. 复用同一配置启动第二消费者明确拒绝；原消费者不被顶掉。正常恢复保留自身业务 IDs，不共享另一会话状态。
4. HTTP 发现/工具列表不宣称模型就绪；有界等待、空闲、休眠、断线显示真实状态，宿主不被虚假后台保活。
5. 撤销、静音、封禁、取消、需求版本变化和超时后，晚到结果不可提交；错误反馈不自动重新配对或升级权限。
6. ZCode 读取 TXT/MD/Word/PDF；读不了时不得确认需求。远程大文档限制与本地原文件路径均实测。
7. 本地 MCP 用 `legacy` 完成开发，只有一个正式客户端；按分工路径修改、运行预设检查、实际成果上传、人类审阅及冲突处理正确。
8. CLI 新适配器验证普通结果、多回合外层、非法响应、授权等待、超时、取消和恢复；真实模型失败不产生成功成果。

本次只提交设计和检查快照，**上述真实 ZCode 场景均未声称完成**。不需要为这份设计调整 DNS、CF 缓存或服务端数据库；未来上线沿用现有通用 MCP 部署条件。

[通用接入设计](universal-mcp.md) · [现有 Node/Host Bridge 用法](agents.md) · [权限与成果边界](agent-boundary.md) · [现有验收记录](agent-acceptance.md)

# 通用 Agent 接入与隔离（2026-10-02）

本次只开发、验证并更新 GitHub，未部署服务器，未修改 Cloudflare。部署该版本后，远程入口才会出现在公网。

## 普通用户怎么选择

| 目标                                              | 方式                                                                                                     | 实际边界                                                                                                                                |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| WorkBuddy、豆包工作及支持 HTTP MCP 的助手参与讨论 | 联机席位 → 展开“无需安装客户端连接讨论” → 生成专属远程连接 → 添加到助手的连接器设置 → 复制接入后的提示词 | 不安装模型、不上传模型 Key；助手自己处理。不会自动后台唤醒，也不授予本机文件执行权限                                                    |
| 当前 GUI Agent 自己在本机开发                     | 原“一键连接提示词”，选择 `mcp`，明确授权专用工作目录                                                     | 宿主启动本地 stdio MCP；宿主需要具备文件/开发工具，任务和成果继续走批准、租约、检查与审阅链路                                           |
| 使用该产品自己的 CLI / ACP 自动处理               | 显式选择 `codex/claude/opencode/acp/cli/http/a2a`，填写真实接口                                          | 每个实例单独配置、工作目录、凭据、状态。接口不存在就报告，不借用其他产品                                                                |
| Windows WorkBuddy 的自带独立执行引擎              | 明确选择 `--adapter acp --workbuddy-engine`                                                              | 使用 WorkBuddy 自带 CodeBuddy 的 `--acp`，不是 Codex，也不是现有桌面对话。需该引擎自己的有效登录和权限；不读取应用密钥、不搬运 GUI 凭据 |

WorkBuddy Windows 5.6.2 安装中实测存在自带 CodeBuddy。自动定位只检查当前用户已安装应用的固定位置；不存在就停止，不扫描凭据或回退。其它系统、不同安装位置可显式填写该产品自己的 `--command` / `--args`。

```powershell
# 使用客户端下载包内启动器。以下参数是示例占位；每个 Agent 单独目录和配置。
.\connect.cmd --non-interactive --server https://your-site.example --code <一次性配对码> --adapter acp --workbuddy-engine --workspace <专用绝对路径> --config <独立配置路径> --name WorkBuddy设备 --agent-name WorkBuddy引擎 --allow-development
```

ACP 客户端仅自动批准当前任务会话、授权目录/分工范围内的 `read/edit` 一次性权限。`execute`、空位置、永久授权、其它会话及越界编辑不会自动批准；文件写入也再次检查路径和分工。没有实现 ACP 终端委托，不承诺全部命令型开发任务都能无人值守完成。ACP 不是 OS 沙箱，产品自身执行行为仍取决于其权限机制；需要完整开发工具的 GUI 推荐本地 MCP 宿主直连。

ZCode 官方开源版本可以使用自己的原生 HTTP/stdio MCP 接入，不需要转发给 Codex。HTTP 适合讨论，本地 Host Bridge 用于有授权的开发；本地配置必须考虑 `auto` 探测多启动一个进程的问题，推荐 `protocolVersion: "legacy"`。专用预设、自动接单 CLI 适配器及真实 ZCode 宿主验收尚未完成，详见 [ZCode 原生接入评估与设计](zcode-integration-design.md)。

## 独立信道，而不是把所有助手转发到 Codex

- 每份配置对应一个设备、所属用户、房间、席位。配置名含唯一设备 ID；宿主使用对应服务器的工具，不复制其它 Agent 的连接配置。
- 远程凭据在网页登录授权下生成，90 天有效，服务器只存摘要。仅在当前生成页面显示一次，不进入房间消息、公开列表、MCP 工具结果或 URL。丢失后撤销旧席位并生成新连接；误分享立即撤销。
- MCP 协议连接和业务连接不同。先 `island_open`，保存自己生成的 `client_id` 与服务端返回的 `connection_id`；同一助手恢复时附两个原值。新的消费者不能顶掉在线连接。
- 单活动消费者由数据库事务/房间锁保护，不只依赖单个 Gateway 的内存。WS 与远程 MCP 凭据用途不同，不能交叉接入；本地两个 WS Gateway 也不能同时占用同一设备。
- 每个远程交付有随机 `delivery_id`，租约由设备秘密和当前连接派生；数据库不存派生秘密明文。其它设备、房间、连接的提交无效。已完成提交重复发送不重复写入消息。
- 远程等待限 0～20 秒，同一连接不能并发等待。讨论租约 45 秒，执行上限 5 分钟；处理超过 20 秒使用 `island_task_progress`。已取消、过期、静音、撤销、封禁、离房或冻结后不能继续写入。不要无限轮询。
- WS 断线正常释放后可以恢复。Gateway 崩溃留下租约时，曾经连接成功的原客户端收到 `Retry-After: 46` 只等待一次再试；新重复实例仍停止，不抢占。冷启动遇到遗留租约可等 45 秒后手动恢复。

## 工具和协议

同源 `/mcp` 使用官方 MCP TypeScript SDK（server 2.2.0、node 2.1.0），支持 2026-07-28 请求和旧版 2025 Streamable HTTP 客户端。不是旧的独立 HTTP+SSE `/sse` 服务。Origin、Host、IP 规则与 Bearer 都在 SDK 外核验，请求体上限 2 MiB。

| 工具                                        | 内容                                                                                                              |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `island_open`                               | 开启/恢复专属业务连接，仅返回房间、席位、审批和业务连接号                                                         |
| `island_status`                             | 自己的审批状态；批准后查看房间内其他 Agent 所属用户与状态                                                         |
| `island_read_context`                       | 最近消息、成员、需求与设计、文档元信息；待批准席位无历史                                                          |
| `island_wait_task`                          | 有界领取点名，或恢复同一未过期交付；不返回 Node 租约秘密                                                          |
| `island_task_progress`                      | 续约当前有效交付，不能复活超时任务                                                                                |
| `island_complete_task` / `island_fail_task` | 提交结构化真实结果/报告失败，以服务端确认和最终消息状态为准                                                       |
| `island_read_document`                      | 读取本房间原始文档，最大 256 KiB；TXT/MD 为文本，Word/PDF 为原始 MCP 资源，解析能力取决于宿主；大文件用本地客户端 |
| `island_disconnect`                         | 结束业务连接，保留设备身份                                                                                        |

配置格式取决于宿主：页面为 WorkBuddy 输出 `type: streamableHttp`，其余输出通用 HTTP 配置；豆包工作通过自定义 HTTP 连接器填地址与 `Authorization: Bearer …` 请求头。无需把私密配置发给模型或房间。每个助手只需收到不含密钥的接入提示词。

## 在线显示与唤醒限制

成员能看到同房间所有 Agent 所属用户、宿主、待批准/连接/活动状态。未使用的邀请只显示记录和所有者，不显示配对码；下载记录表示已经开始准备客户端，不表示已连入。

“客户端已连接”和“模型正在等待任务”分别判断：有效业务连接最近活动 45 秒；模型就绪是实际宿主等待/执行上报的短期状态，后台维护不续期模型就绪。远程协议发现、列工具不会创建在线身份。等待结束没有任务就清除模型就绪；GUI 休眠显示需要用户唤醒，不能假装全天候在线。

WorkBuddy 官方 OpenAPI 可以向本地助手发送文本，但需要第三方应用注册、用户 OAuth 和对应 scope。其公开请求没有已验证的按房间/会话投递字段，不能用同一助手账户并行绑定多个独立房间。**本次未启用该唤醒路径**，没有应用授权，也不使用私有 GUI hook。MCP 提供标准通信，并不自行安排模型执行、唤醒产品或授予本机开发能力。

## 部署下一次版本时

执行新增迁移 `202610020002_universal_mcp.sql`，安装锁文件依赖，构建并重启 Web/Gateway。`APP_ORIGIN` 必须是规范 HTTPS 域名，代理保持原 Host，并将 `/mcp` 的 POST 转到同一 Node 服务，长请求超时至少 30 秒；`/agent-wire` 保留 WebSocket Upgrade。MCP、认证 API 与业务 API 禁止缓存，不为其启用 Cache Everything。无需新增公网端口、改 DNS 或重新申请域名证书。本次没有执行上述生产动作。

## 资料与验证边界

- [WorkBuddy 连接器](https://open.workbuddy.cn/docs/connector)、[WorkBuddy OpenAPI](https://open.workbuddy.cn/docs/openapi)
- [CodeBuddy ACP](https://www.codebuddy.ai/docs/cli/acp)
- [豆包工作自定义 HTTP 连接器示例](https://help.flomoapp.com/advance/mcp/connect-doubao.html)
- [MCP SDK 新旧协议支持](https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28)

这些是接入依据，不等于商用助手的端到端验收。本机真实 WorkBuddy ACP 仅测试初始化，未发送模型开发任务；WorkBuddy/豆包真实 GUI 的配置、唤醒与模型对话仍待产品实测。协议、SQL、浏览器及模拟宿主的实际测试结果见 [Agent 验收](agent-acceptance.md)。

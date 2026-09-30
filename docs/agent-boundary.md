# 未来 Agent Gateway 与 Node 边界（结构预留）

当前只有 human Participant 可通过应用创建，agent 类型在 PostgreSQL CHECK 与 TypeScript 联合类型中预留；应用导航没有联机入口，也没有伪造在线 Agent。

Gateway 位于 Core 之外，使用经授权的 participant_id 调用核心业务事务。Gateway 负责设备配对、订阅授权和适配协议；具体 SDK 不进入 Core。Node 主动发起 WSS 连接，设备不需要公网端口。Node 负责心跳、退避重连、事件游标、重复事件去重、Agent 唤起/恢复和本地授权提示。

拟议设备配对步骤：主持人生成短期一次性配对码 → Node 交换设备身份 → 主持人确认成员 → Gateway 生成仅可订阅该成员所在房间的设备凭据。配对码和设备凭据只保存哈希，凭据可撤销；服务端每次消息/任务/文件写入复核成员权限。不得将房间邀请直接当作长期设备凭据。

`AgentAdapter` 的 `discover/resume/dispatch/disconnect` 接口为 ACP/A2A/CLI/HTTP 四类适配器预留，事件复用 IslandEvent。消息、任务与产物引用相同 Participant；权限扩张须通过 Gateway 与主持人确认。当前不包含具体 Codex/Claude/其他 Agent 适配器、不调用模型、不托管用户 API Key。这些属于原文后续版本的实际开发范围。

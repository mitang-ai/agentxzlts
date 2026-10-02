-- MCP 业务连接独立于协议会话。共享数据库锁阻止 WS / MCP / 多 Gateway 抢占。
alter table agent_nodes add column connection_transport text
  check(connection_transport in ('wire','remote-mcp'));
alter table agent_nodes add column ready_until timestamptz;
alter table agent_nodes add column connection_client_id uuid;
alter table agent_nodes add column remote_wait_id uuid;
alter table agent_nodes add column remote_wait_until timestamptz;
alter table agent_turns add column remote_delivery_id uuid;
alter table agent_turns add column remote_connection_id uuid;
create unique index agent_remote_delivery on agent_turns(remote_delivery_id)
  where remote_delivery_id is not null;
alter table agent_pairings add column download_started_at timestamptz;

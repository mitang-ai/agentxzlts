-- 宿主 MCP 席位不借用其它 Agent CLI；旧迁移保持原 checksum。
alter table agent_nodes drop constraint agent_nodes_adapter_check;
alter table agent_nodes add constraint agent_nodes_adapter_check
  check (adapter in ('codex','claude','opencode','cli','acp','a2a','http','mcp'));

-- 管理员一键创建的幂等记录不保存账号密码。
create table admin_user_creations (
 request_id uuid primary key, admin_id uuid references profiles on delete set null,
 user_id uuid not null unique references profiles on delete cascade,
 created_at timestamptz not null default now()
);
alter table admin_user_creations enable row level security;
revoke all on admin_user_creations from public,anon,authenticated;

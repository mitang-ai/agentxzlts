-- Credentials, invitations and private reviews are never exposed through public settings/RLS.
alter table agent_nodes add column platform_scope boolean not null default false;
alter table agent_nodes add column active_seat_id uuid references agent_seats(participant_id) on delete set null;
alter table agent_nodes add column avatar_url text;
alter table agent_nodes add column privacy_mode text not null default 'review' check(privacy_mode in ('review','filtered'));
alter table agent_pairings alter column room_id drop not null;
alter table agent_pairings add column code_cipher text;
alter table agent_pairings add column doc_token_hash text;
alter table agent_pairings add column doc_cipher text;
alter table agent_pairings add column source text not null default 'local' check(source in ('local','remote_mcp'));
alter table agent_pairings add column development boolean not null default false;
alter table agent_pairings add column client_digest text;
alter table agent_pairings add column deleted_at timestamptz;
alter table agent_turns drop constraint agent_turns_status_check;
alter table agent_turns add constraint agent_turns_status_check check(status in ('queued','leased','awaiting_review','completed','failed','cancelled','expired'));
drop index agent_one_running;
create unique index agent_one_running on agent_turns(participant_id) where status in ('leased','awaiting_review');
do $$ declare f record; body text; begin
 for f in select oid from pg_proc where pronamespace='public'::regnamespace and prosrc like '%agent_turns%' and prosrc like '%''queued'',''leased''%' loop
  body:=pg_get_functiondef(f.oid);
  body:=replace(body,'''queued'',''leased''','''queued'',''leased'',''awaiting_review''');
  execute body;
 end loop;
end $$;
create table agent_private_reviews (
 id uuid primary key default gen_random_uuid(), owner_user_id uuid not null references profiles on delete cascade,
 node_id uuid not null references agent_nodes on delete cascade, turn_id uuid not null references agent_turns on delete cascade,
 kind text not null check(kind in ('result','artifact')), payload_cipher text not null, payload_hash text not null,
 status text not null default 'pending' check(status in ('pending','approved','rejected','expired')),
 created_at timestamptz not null default now(),expires_at timestamptz not null default now()+interval '24 hours',
 unique(turn_id,kind)
);
create index agent_reviews_owner on agent_private_reviews(owner_user_id,status,created_at);
create table avatar_assets (
 id uuid primary key default gen_random_uuid(), owner_user_id uuid not null references profiles on delete cascade,
 bytes bytea not null check(octet_length(bytes)<=262144),created_at timestamptz not null default now()
);
create index avatar_owner on avatar_assets(owner_user_id);
create table agent_security_policy (
 id boolean primary key default true check(id), value jsonb not null, updated_at timestamptz not null default now()
);
insert into agent_security_policy values(true,'{"force_review":true,"allow_remote_mcp":true,"max_agents":20,"max_pending_invites":5,"invite_minutes":10,"artifact_mb":10,"avatar_uploads":true,"preview_enabled":true}');
do $$ declare t text; begin
 foreach t in array array['agent_private_reviews','avatar_assets','agent_security_policy'] loop
 execute format('alter table %I enable row level security',t);
 execute format('revoke all on %I from public,anon,authenticated',t);
 end loop;
end $$;
-- No raw Agent failure text can reach room readers through the legacy error column.
update agent_turns set error='Agent 执行失败，请设备所有者查看本地日志。' where error is not null;

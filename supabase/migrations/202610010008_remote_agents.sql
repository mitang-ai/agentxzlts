-- Node 凭据与调度状态均仅供受信服务端；房间仍只有统一 Participant/Message/Task/File。
create table agent_nodes (
 id uuid primary key default gen_random_uuid(), owner_user_id uuid not null references profiles on delete cascade,
 name text not null check(length(name) between 1 and 60),agent_name text not null check(length(agent_name) between 1 and 40),
 adapter text not null check(adapter in ('codex','claude','opencode','cli','acp','a2a','http')),
 token_hash text not null unique,expires_at timestamptz not null default now()+interval '90 days',revoked_at timestamptz,
 fingerprint text not null check(length(fingerprint) between 16 and 128),capabilities jsonb not null default '{}',
 session_id uuid,last_seen_at timestamptz,created_at timestamptz not null default now()
);
create table agent_pairings (
 id uuid primary key default gen_random_uuid(),room_id uuid not null references rooms on delete cascade,owner_user_id uuid not null references profiles on delete cascade,
 code_hash text not null unique,expires_at timestamptz not null default now()+interval '10 minutes',used_at timestamptz,revoked_at timestamptz,node_id uuid references agent_nodes on delete set null,created_at timestamptz not null default now()
);
create table agent_seats (
 participant_id uuid primary key references participants on delete cascade,node_id uuid not null references agent_nodes on delete cascade,
 state text not null default 'pending' check(state in ('pending','approved','rejected','revoked')),muted boolean not null default false,
 approved_by uuid references profiles,approved_at timestamptz,created_at timestamptz not null default now()
);
alter table rooms add column agent_host_participant_id uuid;
alter table rooms add constraint rooms_agent_host_fk foreign key(id,agent_host_participant_id) references participants(room_id,id) deferrable initially deferred;
create table collaboration_briefs (
 id uuid primary key default gen_random_uuid(),room_id uuid not null references rooms on delete cascade,revision integer not null check(revision>0),
 requirements text not null check(length(requirements) between 1 and 32000),design text not null check(length(design) between 1 and 32000),
 file_ids uuid[] not null default '{}',base_file_id uuid references files,base_hash text,content_hash text not null,
 published_by uuid not null references participants,created_at timestamptz not null default now(),unique(room_id,revision)
);
create table collaboration_acks (
 brief_id uuid references collaboration_briefs on delete cascade,participant_id uuid references participants on delete cascade,
 content_hash text not null,created_at timestamptz not null default now(),primary key(brief_id,participant_id)
);
create table collaboration_sessions (
 id uuid primary key default gen_random_uuid(),room_id uuid not null references rooms on delete cascade,brief_id uuid not null references collaboration_briefs,
 host_participant_id uuid not null references participants,attendee_ids uuid[] not null,
 topic text not null check(length(topic) between 1 and 2000),stage text not null default 'discussing' check(stage in ('discussing','aligning','ready','developing','review','completed','paused','stopped')),
 previous_stage text,max_turns integer not null default 12 check(max_turns between 3 and 40),turns_created integer not null default 0,
 deadline timestamptz not null default now()+interval '30 minutes',plan jsonb not null default '[]',plan_version integer not null default 0,
 plan_approved_by uuid references participants,error text,merged_file_id uuid references files on delete set null,
 created_at timestamptz not null default now(),updated_at timestamptz not null default now()
);
create unique index collaboration_one_active on collaboration_sessions(room_id) where stage not in ('completed','stopped');
create table collaboration_work (
 task_id uuid primary key references tasks on delete cascade,session_id uuid not null references collaboration_sessions on delete cascade,
 assignee_id uuid not null references participants,paths text[] not null,
 brief_hash text not null,state text not null default 'pending' check(state in ('pending','running','submitted','accepted','rejected')),attempt integer not null default 0
);
create table agent_turns (
 id uuid primary key default gen_random_uuid(),sequence bigint generated always as identity,room_id uuid not null references rooms on delete cascade,
 participant_id uuid not null references participants,session_id uuid references collaboration_sessions on delete cascade,
 kind text not null check(kind in ('host','speak','align','develop','mention')),
 source_message_id uuid references messages on delete cascade,task_id uuid references tasks on delete cascade,
 input jsonb not null default '{}',status text not null default 'queued' check(status in ('queued','leased','completed','failed','cancelled','expired')),
 attempt integer not null default 0,lease_hash text,lease_until timestamptz,hard_deadline timestamptz,
 queued_until timestamptz not null default now()+interval '30 minutes',result jsonb,error text,created_at timestamptz not null default now(),completed_at timestamptz,
 unique(participant_id,source_message_id)
);
create unique index agent_one_running on agent_turns(participant_id) where status='leased';
create index agent_turn_queue on agent_turns(status,sequence);
create table collaboration_artifacts (
 id uuid primary key default gen_random_uuid(),room_id uuid not null references rooms on delete cascade,session_id uuid not null references collaboration_sessions on delete cascade,
 task_id uuid not null references tasks on delete cascade,turn_id uuid not null unique references agent_turns,
 file_id uuid not null references files,brief_hash text not null,manifest jsonb not null,
 state text not null default 'proposed' check(state in ('proposed','accepted','rejected','merged')),review_note text,
 reviewed_by uuid references participants,reviewed_at timestamptz,created_at timestamptz not null default now()
);
do $$ declare t text; begin foreach t in array array['agent_nodes','agent_pairings','agent_seats','collaboration_briefs','collaboration_acks','collaboration_sessions','collaboration_work','agent_turns','collaboration_artifacts'] loop execute format('alter table %I enable row level security',t);execute format('revoke all on %I from public,anon,authenticated',t);end loop;end $$;
-- 现在是真实能力，沿用灰度开关；停用后每个 Node 请求重新验证。
create or replace function flag_enabled(k text,u uuid,r uuid default null) returns boolean language sql stable security definer set search_path=public as $$
 select coalesce((select enabled and case scope when 'all' then true when 'users' then u=any(targets) when 'rooms' then r=any(targets) when 'admins' then exists(select 1 from admin_members where user_id=u) when 'percentage' then u is not null and ('x'||substr(md5(u::text||key),1,8))::bit(32)::bigint%100<rollout end from feature_flags where key=k),false)
$$;
update feature_flags set enabled=true,updated_at=now() where key in ('agents','connection_seat');
-- 追加迁移调整旧的硬性禁止，不修改已发布迁移及其 checksum。
do $$ declare body text; begin
 select pg_get_functiondef('island_admin_command(text,jsonb,jsonb)'::regprocedure) into body;
 body:=replace(body,'if data->>''key'' in (''agents'',''connection_seat'') and (data->>''enabled'')::boolean then raise exception ''AGENT_NOT_AVAILABLE'';end if;','');
 execute body;
end $$;

-- 人和 Agent 共用同一业务实现；Actor 参数只允许受信 Gateway 使用。
create function public.island_actor_command(agent_actor uuid,command text,data jsonb default '{}') returns jsonb
language plpgsql security definer set search_path=public,extensions as $$
declare
 u uuid:=auth.uid();r uuid; p participants; target participants; rm rooms; m messages; t tasks; inv room_invites;
 eid uuid;mid uuid;tok text;is_host boolean; ids uuid[]; file_ids uuid[]; n integer; b bigint; result jsonb;
begin
 if agent_actor is not null then
  if command not in ('message','create_task','update_task','register_file') then raise exception 'FORBIDDEN';end if;
  select n.owner_user_id into u from agent_seats s join agent_nodes n on n.id=s.node_id join participants ap on ap.id=s.participant_id where s.participant_id=agent_actor and s.state='approved' and not s.muted and ap.status='active' and n.revoked_at is null and n.expires_at>now();
  if u is null or effective_status(u)='banned' or not flag_enabled('agents',u,(data->>'room_id')::uuid) then raise exception 'FORBIDDEN';end if;
 end if;
 if u is null then raise exception 'UNAUTHORIZED';end if;
 b:=floor(extract(epoch from now())/60);
 insert into command_limits values(u,b,1) on conflict(user_id,bucket) do update set count=command_limits.count+1 returning count into n;
 if n>180 then raise exception 'RATE_LIMITED';end if;
 delete from command_limits where bucket<b-60;
 if command='profile' then
  if length(trim(data->>'display_name')) not between 1 and 40 then raise exception 'INVALID_NAME';end if;
  update profiles set display_name=trim(data->>'display_name'),avatar_url=nullif(data->>'avatar_url','') where id=u;
  update participants set display_name=trim(data->>'display_name'),avatar_url=nullif(data->>'avatar_url','') where user_id=u;
  for r in select room_id from participants where user_id=u and status='active' loop perform emit(r,'participant.updated',null,u);end loop;
  return '{}'::jsonb;
 elsif command='create_room' then
  insert into rooms(name,icon,created_by) values(trim(data->>'name'),coalesce(data->>'icon','🏝️'),u) returning * into rm;
  insert into participants(room_id,user_id,display_name,avatar_url) select rm.id,u,display_name,avatar_url from profiles where id=u returning * into p;
  update rooms set host_participant_id=p.id where id=rm.id;
  perform emit(rm.id,'room.created',p.id,rm.id);perform emit(rm.id,'participant.joined',p.id,p.id);
  return jsonb_build_object('id',rm.id);
 elsif command='join_invite' then
  select * into inv from room_invites where token_hash=encode(digest(data->>'token','sha256'),'hex');
  if inv.id is null or inv.revoked_at is not null or inv.expires_at<=now() then raise exception 'INVALID_INVITE';end if;
  select * into rm from rooms where id=inv.room_id for update;
  select * into inv from room_invites where id=inv.id for update;
  if inv.id is null or inv.revoked_at is not null or inv.expires_at<=now() then raise exception 'INVALID_INVITE';end if;
  select * into p from participants where room_id=inv.room_id and user_id=u;
  if p.status='active' then return jsonb_build_object('id',inv.room_id);end if;
  if inv.used_count>=inv.max_uses then raise exception 'INVITE_EXHAUSTED';end if;
  insert into participants(room_id,user_id,display_name,avatar_url)
  select inv.room_id,u,display_name,avatar_url from profiles where id=u
  on conflict(room_id,user_id) do update set status='active',joined_at=now(),last_active_at=now() returning * into p;
  update room_invites set used_count=used_count+1 where id=inv.id;
  insert into messages(room_id,type,content) values(inv.room_id,'system',p.display_name||' 加入了房间') returning id into mid;
  perform emit(inv.room_id,'participant.joined',p.id,p.id);perform emit(inv.room_id,'message.created',p.id,mid);
  return jsonb_build_object('id',inv.room_id);
 end if;
 r:=(data->>'room_id')::uuid;
 -- 所有敏感操作共享房间锁，串行化邀请、退出、移除和主持人转移。
 select * into rm from rooms where id=r for update;
 select * into p from participants where room_id=r and status='active' and ((agent_actor is null and user_id=u) or id=agent_actor);
 if p.id is null or rm.id is null then raise exception 'FORBIDDEN';end if;
 is_host:=rm.host_participant_id=p.id or (agent_actor is not null and rm.agent_host_participant_id=p.id);
 if agent_actor is not null then
  if rm.status<>'active' then raise exception 'ROOM_FROZEN';end if;
  if (select (value->>'maintenance')::boolean from site_settings where key='operations') then raise exception 'MAINTENANCE';end if;
  if command='message' and effective_status(u)='limited_post' then raise exception 'POST_DISABLED';end if;
  if command in ('create_task','update_task') and not flag_enabled('tasks',u,r) then raise exception 'TASK_DISABLED';end if;
  if command='register_file' then
   if effective_status(u)='limited_upload' or not flag_enabled('uploads',u,r) then raise exception 'UPLOAD_DISABLED';end if;
   if (data->>'size')::bigint>(select (value->>'max_file_mb')::bigint*1048576 from site_settings where key='operations') or coalesce((select sum(size) from files where room_id=r and status<>'deleted'),0)+(data->>'size')::bigint>(select (value->>'room_storage_mb')::bigint*1048576 from site_settings where key='operations') then raise exception 'STORAGE_LIMIT';end if;
   if not (select value->'allowed_extensions' from site_settings where key='operations') ? lower(regexp_replace(data->>'name','^.*\.','')) then raise exception 'FILE_TYPE_DISABLED';end if;
  end if;
 end if;
 if command in ('update_room','invite','revoke_invite','remove_member','transfer_host','delete_room') and not is_host then raise exception 'HOST_REQUIRED';end if;
 if command='update_room' then
  update rooms set name=trim(data->>'name'),icon=data->>'icon',updated_at=now() where id=r;
  perform emit(r,'room.updated',p.id,r);
 elsif command='invite' then
  tok:=encode(gen_random_bytes(24),'hex');
  insert into room_invites(room_id,token_hash,created_by,expires_at,max_uses) values(r,encode(digest(tok,'sha256'),'hex'),p.id,now()+make_interval(hours=>least(greatest(coalesce((data->>'hours')::int,168),1),720)),coalesce((data->>'max_uses')::int,20)) returning id into eid;
  return jsonb_build_object('token',tok,'id',eid);
 elsif command='revoke_invite' then
  update room_invites set revoked_at=now() where id=(data->>'invite_id')::uuid and room_id=r;
 elsif command='transfer_host' then
  select * into target from participants where id=(data->>'participant_id')::uuid and room_id=r and status='active' and type='human';
  if target.id is null or target.id=p.id then raise exception 'INVALID_TARGET';end if;
  update rooms set host_participant_id=target.id,updated_at=now() where id=r;
  insert into messages(room_id,type,content) values(r,'system',p.display_name||' 将主持人转移给了 '||target.display_name) returning id into mid;
  perform emit(r,'host.transferred',p.id,target.id);perform emit(r,'message.created',p.id,mid);
 elsif command in ('leave_room','remove_member') then
  if command='leave_room' then target:=p;else select * into target from participants where id=(data->>'participant_id')::uuid and room_id=r and status='active';end if;
  if target.id is null then raise exception 'INVALID_TARGET';end if;
  if target.id=rm.host_participant_id then raise exception 'TRANSFER_BEFORE_LEAVING';end if;
  update participants set status='left',last_active_at=null where id=target.id;
  delete from task_assignees where participant_id=target.id;
  insert into messages(room_id,type,content) values(r,'system',target.display_name||' 离开了房间') returning id into mid;
  perform emit(r,'participant.left',p.id,target.id);perform emit(r,'message.created',p.id,mid);
 elsif command='delete_room' then
  perform pg_notify('island_events',r::text);delete from rooms where id=r;return '{}'::jsonb;
 elsif command='message' then
  if data->>'client_message_id' is null then raise exception 'INVALID_MESSAGE';end if;
  if length(trim(data->>'content')) not between 1 and 8000 then raise exception 'INVALID_MESSAGE';end if;
  select * into m from messages where sender_participant_id=p.id and client_message_id=(data->>'client_message_id')::uuid;
  if m.id is not null then return jsonb_build_object('id',m.id);end if;
  ids:=array(select jsonb_array_elements_text(coalesce(data->'mentioned_participant_ids','[]'))::uuid);
  if exists(select 1 from unnest(ids) x where not exists(select 1 from participants where id=x and room_id=r and status='active')) then raise exception 'INVALID_MENTION';end if;
  insert into messages(room_id,sender_participant_id,type,content,reply_to_message_id,mentioned_participant_ids,client_message_id)
  values(r,p.id,'text',trim(data->>'content'),nullif(data->>'reply_to_message_id','')::uuid,ids,(data->>'client_message_id')::uuid) returning id into eid;
  perform emit(r,'message.created',p.id,eid);
  return jsonb_build_object('id',eid);
 elsif command='delete_message' then
  select * into m from messages where id=(data->>'message_id')::uuid and room_id=r;
  if m.sender_participant_id is distinct from p.id or m.type<>'text' then raise exception 'FORBIDDEN';end if;
  update messages set content='',deleted_at=now() where id=m.id;
  delete from message_reactions where message_id=m.id;
  perform emit(r,'message.deleted',p.id,m.id);
 elsif command='react' then
  select * into m from messages where id=(data->>'message_id')::uuid and room_id=r and deleted_at is null;
  if m.id is null then raise exception 'INVALID_MESSAGE';end if;
  if exists(select 1 from message_reactions where message_id=m.id and participant_id=p.id and emoji=data->>'emoji') then
   delete from message_reactions where message_id=m.id and participant_id=p.id and emoji=data->>'emoji';
  else insert into message_reactions values(m.id,p.id,data->>'emoji');end if;
  perform emit(r,'message.updated',p.id,m.id);
 elsif command in ('create_task','update_task') then
  ids:=array(select jsonb_array_elements_text(coalesce(data->'assignee_ids','[]'))::uuid);
  file_ids:=array(select jsonb_array_elements_text(coalesce(data->'file_ids','[]'))::uuid);
  if exists(select 1 from unnest(ids) x where not exists(select 1 from participants where id=x and room_id=r and status='active')) then raise exception 'INVALID_ASSIGNEE';end if;
  if exists(select 1 from unnest(file_ids) x where not exists(select 1 from files where id=x and room_id=r)) then raise exception 'INVALID_ATTACHMENT';end if;
  if command='create_task' then
   insert into tasks(room_id,creator_participant_id,title,description,due_at,source_message_id)
   values(r,p.id,trim(data->>'title'),coalesce(data->>'description',''),nullif(data->>'due_at','')::timestamptz,nullif(data->>'source_message_id','')::uuid) returning * into t;
   insert into messages(room_id,sender_participant_id,type,content,task_id) values(r,p.id,'task',t.title,t.id) returning id into eid;
   perform emit(r,'task.created',p.id,t.id);perform emit(r,'message.created',p.id,eid);
  else
   select * into t from tasks where id=(data->>'task_id')::uuid and room_id=r for update;
   if t.id is null or (not is_host and not exists(select 1 from task_assignees where task_id=t.id and participant_id=p.id)) then raise exception 'FORBIDDEN';end if;
   if data ? 'assignee_ids' and not is_host and ids is distinct from array(select participant_id from task_assignees where task_id=t.id order by participant_id) then
    if array(select unnest(ids) order by 1) is distinct from array(select participant_id from task_assignees where task_id=t.id order by participant_id) then raise exception 'HOST_REQUIRED';end if;
   end if;
   update tasks set title=coalesce(trim(data->>'title'),title),description=coalesce(data->>'description',description),
   status=coalesce(data->>'status',status),due_at=case when data ? 'due_at' then nullif(data->>'due_at','')::timestamptz else due_at end,
   updated_at=now(),completed_at=case when data->>'status'='completed' then now() when data ? 'status' then null else completed_at end where id=t.id;
   perform emit(r,case when data->>'status'='completed' then 'task.completed' else 'task.updated' end,p.id,t.id);
  end if;
  if command='create_task' or data ? 'assignee_ids' then
   delete from task_assignees where task_id=t.id;
   insert into task_assignees select t.id,x from (select distinct unnest(ids) x) s;
   perform emit(r,'task.assigned',p.id,t.id);
  end if;
  if command='create_task' or data ? 'file_ids' then
   delete from task_files where task_id=t.id;insert into task_files select t.id,x from (select distinct unnest(file_ids) x) s;
  end if;
  return jsonb_build_object('id',t.id);
 elsif command='register_file' then
  if data->>'storage_path' <> r::text||'/'||(data->>'id') or not exists(select 1 from storage.objects where bucket_id='room-files' and name=data->>'storage_path' and (metadata->>'size')::bigint=(data->>'size')::bigint and metadata->>'mimetype'=data->>'mime_type') then raise exception 'INVALID_ATTACHMENT';end if;
  insert into files(id,room_id,uploader_participant_id,storage_path,name,mime_type,size)
  values((data->>'id')::uuid,r,p.id,data->>'storage_path',data->>'name',data->>'mime_type',(data->>'size')::bigint) returning id into eid;
  insert into messages(room_id,sender_participant_id,type,content,file_id) values(r,p.id,'file',data->>'name',eid) returning id into mid;
  perform emit(r,'file.created',p.id,eid);perform emit(r,'message.created',p.id,mid);
 elsif command='read' then
  update participants set last_read_event_id=greatest(last_read_event_id,least(coalesce((data->>'cursor')::bigint,0),coalesce((select max(id) from events where room_id=r),0))) where id=p.id;
 elsif command='presence' then
  perform pg_notify('island_events',r::text);
  update participants set last_active_at=case when coalesce((data->>'offline')::boolean,false) then null else now() end where id=p.id;
 else raise exception 'UNKNOWN_COMMAND';end if;
 return '{}'::jsonb;
end $$;
revoke all on function island_actor_command(uuid,text,jsonb) from public,anon,authenticated;
create or replace function island_core_command(command text,data jsonb default '{}') returns jsonb language sql security definer set search_path=public,extensions as $$ select island_actor_command(null,command,data) $$;
revoke all on function island_core_command(text,jsonb) from public,anon,authenticated;
-- 只有人类明确 @ 的消息产生一次性唤起。Agent 消息、Presence 和系统消息不会触发接龙。
create function agent_human_mention() returns trigger language plpgsql security definer set search_path=public as $$
declare ap uuid; owner_id uuid;
begin
 if new.type<>'text' or new.deleted_at is not null or not exists(select 1 from participants where id=new.sender_participant_id and type='human') then return new;end if;
 if not exists(select 1 from rooms where id=new.room_id and status='active') then return new;end if;
 for ap in select p.id from participants p join agent_seats s on s.participant_id=p.id join agent_nodes n on n.id=s.node_id join participants owner on owner.room_id=p.room_id and owner.user_id=n.owner_user_id and owner.status='active'
  where p.id=any(new.mentioned_participant_ids) and p.room_id=new.room_id and p.type='agent' and p.status='active' and s.state='approved' and not s.muted and n.revoked_at is null and n.expires_at>now() and flag_enabled('agents',n.owner_user_id,p.room_id) and effective_status(n.owner_user_id)<>'banned' limit 8 loop
  if (select count(*) from agent_turns where room_id=new.room_id and status in ('queued','leased'))>=40 then exit;end if;
  insert into agent_turns(room_id,participant_id,kind,source_message_id,input,queued_until) values(new.room_id,ap,'mention',new.id,jsonb_build_object('instruction',new.content),now()+interval '5 minutes') on conflict(participant_id,source_message_id) do nothing;
  perform emit(new.room_id,'agent.turn.queued',new.sender_participant_id,ap,jsonb_build_object('kind','mention'));
 end loop;
 return new;
end $$;
create trigger agent_explicit_mention after insert on messages for each row execute function agent_human_mention();
revoke all on function agent_human_mention() from public,anon,authenticated;
create function agent_participant_leave() returns trigger language plpgsql security definer set search_path=public as $$
begin
 if new.type='agent' and new.status='left' and old.status='active' then
  update agent_seats set state='revoked' where participant_id=new.id;
  update agent_turns set status='cancelled',lease_hash=null,error='成员已移出房间' where participant_id=new.id and status in ('queued','leased');
  update rooms set agent_host_participant_id=null where id=new.room_id and agent_host_participant_id=new.id;
  update collaboration_sessions set previous_stage=stage,stage='paused',error='Agent 成员离开了房间' where room_id=new.room_id and new.id=any(attendee_ids) and stage not in ('completed','stopped','paused');
 end if;return new;
end $$;
create trigger agent_leave after update of status on participants for each row execute function agent_participant_leave();
revoke all on function agent_participant_leave() from public,anon,authenticated;

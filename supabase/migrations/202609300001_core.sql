create extension if not exists pgcrypto with schema extensions;
create table public.profiles (
 id uuid primary key references auth.users on delete cascade,
 email text not null, display_name text not null check(length(display_name) between 1 and 40), avatar_url text,
 created_at timestamptz not null default now()
);
create table public.rooms (
 id uuid primary key default gen_random_uuid(), name text not null check(length(name) between 1 and 60),
 icon text not null default '🏝️' check(length(icon)<=8), host_participant_id uuid,
 created_by uuid references public.profiles, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.participants (
 id uuid primary key default gen_random_uuid(), room_id uuid not null references public.rooms on delete cascade,
 type text not null default 'human' check(type in ('human','agent')), user_id uuid references public.profiles,
 display_name text not null, avatar_url text, status text not null default 'active' check(status in ('active','left')),
 joined_at timestamptz not null default now(), last_active_at timestamptz, last_read_event_id bigint not null default 0,
 unique(room_id,user_id), unique(room_id,id), check((type='human' and user_id is not null) or type='agent')
);
alter table public.rooms add constraint rooms_host_fk foreign key (id,host_participant_id) references public.participants(room_id,id) deferrable initially deferred;
create table public.files (
 id uuid primary key default gen_random_uuid(),room_id uuid not null references public.rooms on delete cascade,
 uploader_participant_id uuid not null,storage_path text not null unique,name text not null check(length(name) between 1 and 180),
 mime_type text not null,size bigint not null check(size>0 and size<=10485760),created_at timestamptz not null default now(),
 unique(room_id,id),foreign key(room_id,uploader_participant_id) references public.participants(room_id,id)
);
create table public.messages (
 id uuid primary key default gen_random_uuid(),room_id uuid not null references public.rooms on delete cascade,
 sender_participant_id uuid,type text not null check(type in ('text','file','system','task')),content text not null check(length(content)<=8000),
 reply_to_message_id uuid,mentioned_participant_ids uuid[] not null default '{}',file_id uuid,task_id uuid,
 client_message_id uuid,created_at timestamptz not null default now(),edited_at timestamptz,deleted_at timestamptz,
 unique(room_id,id),unique(sender_participant_id,client_message_id),
 foreign key(room_id,sender_participant_id) references public.participants(room_id,id),
 foreign key(room_id,reply_to_message_id) references public.messages(room_id,id),
 foreign key(room_id,file_id) references public.files(room_id,id)
);
create table public.tasks (
 id uuid primary key default gen_random_uuid(),room_id uuid not null references public.rooms on delete cascade,
 creator_participant_id uuid not null,title text not null check(length(title) between 1 and 160),description text not null default '' check(length(description)<=8000),
 status text not null default 'pending' check(status in ('pending','in_progress','completed')),due_at timestamptz,
 source_message_id uuid,created_at timestamptz not null default now(),updated_at timestamptz not null default now(),completed_at timestamptz,
 unique(room_id,id),foreign key(room_id,creator_participant_id) references public.participants(room_id,id),
 foreign key(room_id,source_message_id) references public.messages(room_id,id)
);
alter table public.messages add constraint messages_task_fk foreign key(room_id,task_id) references public.tasks(room_id,id);
create table public.task_assignees (
 task_id uuid not null references public.tasks on delete cascade,participant_id uuid not null references public.participants on delete cascade,
 primary key(task_id,participant_id)
);
create table public.task_files (task_id uuid references public.tasks on delete cascade,file_id uuid references public.files on delete cascade,primary key(task_id,file_id));
create table public.message_reactions (message_id uuid references public.messages on delete cascade,participant_id uuid references public.participants on delete cascade,emoji text not null check(length(emoji)<=12),primary key(message_id,participant_id,emoji));
create table public.room_invites (
 id uuid primary key default gen_random_uuid(),room_id uuid not null references public.rooms on delete cascade,
 token_hash text not null unique,created_by uuid not null references public.participants,expires_at timestamptz not null,
 max_uses integer not null check(max_uses between 1 and 1000),used_count integer not null default 0,revoked_at timestamptz,created_at timestamptz not null default now()
);
create table public.events (
 id bigint generated always as identity primary key,room_id uuid not null references public.rooms on delete cascade,
 type text not null,actor_participant_id uuid,entity_id uuid,payload jsonb not null default '{}',created_at timestamptz not null default now()
);
create table public.command_limits (user_id uuid references auth.users on delete cascade,bucket bigint,count integer not null,primary key(user_id,bucket));
create index participants_user on public.participants(user_id,status);
create index messages_room_time on public.messages(room_id,created_at,id);
create index events_room_cursor on public.events(room_id,id);
create index tasks_room on public.tasks(room_id);
create index files_room on public.files(room_id);
create index task_assignees_participant on public.task_assignees(participant_id);

create function public.is_room_member(r uuid) returns boolean language sql stable security definer set search_path=public
as $$ select exists(select 1 from participants where room_id=r and user_id=auth.uid() and status='active') $$;
create function public.is_room_host(r uuid) returns boolean language sql stable security definer set search_path=public
as $$ select exists(select 1 from rooms x join participants p on p.id=x.host_participant_id where x.id=r and p.user_id=auth.uid() and p.status='active') $$;

alter table public.profiles enable row level security;
create policy profile_self on public.profiles for select to authenticated using(id=auth.uid());
alter table public.rooms enable row level security;
create policy room_members on public.rooms for select to authenticated using(public.is_room_member(id));
alter table public.participants enable row level security;
create policy participant_members on public.participants for select to authenticated using(public.is_room_member(room_id));
alter table public.messages enable row level security;
create policy message_members on public.messages for select to authenticated using(public.is_room_member(room_id));
alter table public.tasks enable row level security;
create policy task_members on public.tasks for select to authenticated using(public.is_room_member(room_id));
alter table public.files enable row level security;
create policy file_members on public.files for select to authenticated using(public.is_room_member(room_id));
alter table public.events enable row level security;
create policy event_members on public.events for select to authenticated using(public.is_room_member(room_id));
alter table public.room_invites enable row level security;
create policy invite_host on public.room_invites for select to authenticated using(public.is_room_host(room_id));
alter table public.task_assignees enable row level security;
create policy assignee_members on public.task_assignees for select to authenticated using(exists(select 1 from tasks where tasks.id=task_id and public.is_room_member(room_id)));
alter table public.task_files enable row level security;
create policy task_file_members on public.task_files for select to authenticated using(exists(select 1 from tasks where tasks.id=task_id and public.is_room_member(room_id)));
alter table public.message_reactions enable row level security;
create policy reaction_members on public.message_reactions for select to authenticated using(exists(select 1 from messages where messages.id=message_id and public.is_room_member(room_id)));
alter table public.command_limits enable row level security;

create function public.create_profile() returns trigger language plpgsql security definer set search_path=public as $$
begin
 insert into profiles(id,email,display_name) values(new.id,new.email,left(coalesce(nullif(trim(new.raw_user_meta_data->>'display_name'),''),split_part(new.email,'@',1)),40));return new;
end $$;
create trigger on_account_created after insert on auth.users for each row execute function public.create_profile();

create function public.emit(r uuid,t text,a uuid,e uuid,p jsonb default '{}') returns void language plpgsql security definer set search_path=public as $$
begin
 insert into events(room_id,type,actor_participant_id,entity_id,payload) values(r,t,a,e,p);
 perform pg_notify('island_events',r::text);
end $$;
revoke all on function public.emit(uuid,text,uuid,uuid,jsonb) from public,anon,authenticated;

-- 业务写入只通过这一事务入口；RLS 用于所有读取，禁止客户端直接改表。
create function public.island_command(command text,data jsonb default '{}') returns jsonb
language plpgsql security definer set search_path=public,extensions as $$
declare
 u uuid:=auth.uid();r uuid; p participants; target participants; rm rooms; m messages; t tasks; inv room_invites;
 eid uuid;mid uuid;tok text;is_host boolean; ids uuid[]; file_ids uuid[]; n integer; b bigint; result jsonb;
begin
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
 select * into p from participants where room_id=r and user_id=u and status='active';
 if p.id is null or rm.id is null then raise exception 'FORBIDDEN';end if;
 is_host:=rm.host_participant_id=p.id;
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
revoke all on function public.island_command(text,jsonb) from public,anon;
grant execute on function public.island_command(text,jsonb) to authenticated;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types) values('room-files','room-files',false,10485760,array['image/png','image/jpeg','image/webp','image/gif','application/pdf','text/plain','text/markdown','text/csv','application/zip','application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','application/vnd.openxmlformats-officedocument.presentationml.presentation']);
-- 对象只由受信服务端在成员校验后上传和下载；客户端无直接存储策略。
alter publication supabase_realtime add table public.events;
alter publication supabase_realtime add table public.participants;

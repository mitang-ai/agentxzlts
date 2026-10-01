alter table profiles add column status text not null default 'normal' check(status in ('normal','limited_post','limited_room','limited_upload','banned'));
alter table profiles add column restriction_reason text, add column restricted_until timestamptz, add column last_active_at timestamptz;
alter table rooms add column status text not null default 'active' check(status in ('active','frozen','deleted')), add column status_reason text, add column deleted_at timestamptz;
alter table files add column status text not null default 'normal' check(status in ('normal','quarantined','deleted')), add column status_reason text;
alter table files drop constraint files_size_check;
alter table files add constraint files_size_check check(size>0 and size<=524288000);
alter table auth.local_sessions add column id uuid not null default gen_random_uuid(), add column created_at timestamptz not null default now(), add column last_active_at timestamptz not null default now(), add column ip inet, add column user_agent text;
create unique index session_id on auth.local_sessions(id);
create table admin_members(user_id uuid primary key references profiles(id) on delete cascade,role text not null check(role in ('super','operations','technical')),created_at timestamptz not null default now());
create table admin_audit_logs(id bigint generated always as identity primary key,admin_id uuid references profiles(id) on delete set null, action text not null,target_type text not null,target_id text,before jsonb,after jsonb,reason text not null,result text not null default 'success',ip inet,trace_id uuid not null,created_at timestamptz not null default now());
create index audit_time on admin_audit_logs(created_at desc);
create table site_settings(key text primary key,value jsonb not null,updated_at timestamptz not null default now());
insert into site_settings values
('brand','{"name":"协作岛","logo":"","favicon":"","intro":"聊天、分工与文件，在一个轻松的协作空间里。"}',now()),
('information','{"title":"协作岛 · 一起把想法做成","description":"聊天、分工与文件，在一个轻松的协作空间里。","icp":"","footer":"一起把想法做成","email":"","phone":""}',now()),
('analytics','{"baidu_enabled":false,"baidu_id":"","ga_enabled":false,"ga_id":"","umami_enabled":false,"umami_url":"","umami_id":""}',now()),
('operations','{"registration":true,"invite_days":7,"max_file_mb":10,"room_storage_mb":1024,"allowed_extensions":["png","jpg","jpeg","webp","gif","pdf","txt","md","csv","zip","docx","xlsx","pptx"],"announcements":true,"maintenance":false,"maintenance_message":"网站正在维护，请稍后再试。"}',now());
create table feature_flags(key text primary key,enabled boolean not null,scope text not null default 'all' check(scope in ('all','users','rooms','admins','percentage')),targets uuid[] not null default '{}',rollout integer not null default 100 check(rollout between 0 and 100),updated_at timestamptz not null default now());
insert into feature_flags(key,enabled) values('tasks',true),('uploads',true),('create_room',true),('connection_seat',false),('agents',false);
create table announcements(id uuid primary key default gen_random_uuid(),title text not null check(length(title) between 1 and 120),content text not null check(length(content)<=4000),starts_at timestamptz not null default now(),ends_at timestamptz,position text not null default 'all' check(position in ('all','public','app')),dismissible boolean not null default true,enabled boolean not null default true,created_at timestamptz not null default now(),check(ends_at is null or ends_at>starts_at));
create table reports(id uuid primary key default gen_random_uuid(),reporter_id uuid references profiles(id),target_type text not null check(target_type in ('message','file','user','room')),target_id uuid not null,room_id uuid references rooms(id) on delete set null,reason text not null check(length(reason) between 3 and 2000),status text not null default 'pending' check(status in ('pending','processing','resolved','dismissed')),resolution text,handled_by uuid references profiles(id),handled_at timestamptz,created_at timestamptz not null default now());
create index reports_queue on reports(status,created_at desc);
create table ip_rules(id uuid primary key default gen_random_uuid(),network cidr not null unique,reason text not null,expires_at timestamptz,created_at timestamptz not null default now());
create table control_events(id bigint generated always as identity primary key,type text not null,target_user_id uuid,entity_id text,payload jsonb not null default '{}',created_at timestamptz not null default now());
create table login_events(id bigint generated always as identity primary key,user_id uuid references profiles(id) on delete set null,email text,success boolean not null,ip inet,user_agent text,created_at timestamptz not null default now());
create table request_metrics(id bigint generated always as identity primary key,path text not null,method text not null,status integer not null,duration_ms integer not null,trace_id uuid not null,user_id uuid,bytes bigint not null default 0,created_at timestamptz not null default now());
create index metrics_time on request_metrics(created_at desc);
create table system_incidents(id bigint generated always as identity primary key,service text not null,status text not null,message text not null,created_at timestamptz not null default now());
create table realtime_connections(id uuid primary key,user_id uuid not null,room_id uuid not null,created_at timestamptz not null default now(),last_seen_at timestamptz not null default now());
create table brand_assets(id uuid primary key,mime_type text not null,bytes bytea not null,created_at timestamptz not null default now());
-- All management tables are server-only; even guessed table names cannot bypass Admin API.
do $$ declare t text; begin foreach t in array array['admin_members','admin_audit_logs','site_settings','feature_flags','announcements','reports','ip_rules','control_events','login_events','request_metrics','system_incidents','realtime_connections','brand_assets'] loop execute format('alter table %I enable row level security',t);execute format('revoke all on %I from anon,authenticated',t);end loop;end $$;
create function control_emit(t text,u uuid default null,e text default null,p jsonb default '{}') returns void language plpgsql security definer set search_path=public as $$ begin insert into control_events(type,target_user_id,entity_id,payload) values(t,u,e,p);perform pg_notify('island_events','global');end $$;
revoke all on function control_emit(text,uuid,text,jsonb) from public,anon,authenticated;
create function effective_status(u uuid) returns text language sql stable security definer set search_path=public as $$ select case when restricted_until is not null and restricted_until<=now() then 'normal' else status end from profiles where id=u $$;
create function flag_enabled(k text,u uuid,r uuid default null) returns boolean language sql stable security definer set search_path=public as $$
 select coalesce((select enabled and case scope when 'all' then true when 'users' then u=any(targets) when 'rooms' then r=any(targets) when 'admins' then exists(select 1 from admin_members where user_id=u) when 'percentage' then u is not null and ('x'||substr(md5(u::text||key),1,8))::bit(32)::bigint%100<rollout end from feature_flags where key=k),false) and k not in ('agents','connection_seat')
$$;
revoke all on function effective_status(uuid),flag_enabled(text,uuid,uuid) from public,anon;
grant execute on function effective_status(uuid),flag_enabled(text,uuid,uuid) to authenticated;
create or replace function is_room_member(r uuid) returns boolean language sql stable security definer set search_path=public as $$ select exists(select 1 from participants p join rooms q on q.id=p.room_id where p.room_id=r and p.user_id=auth.uid() and p.status='active' and q.status<>'deleted') and effective_status(auth.uid())<>'banned' $$;
alter function island_command(text,jsonb) rename to island_core_command;
revoke all on function island_core_command(text,jsonb) from public,anon,authenticated;
create function island_command(command text,data jsonb default '{}') returns jsonb language plpgsql security definer set search_path=public,extensions as $$
declare u uuid:=auth.uid(); r uuid:=nullif(data->>'room_id','')::uuid; st text; op jsonb; tid uuid; rr uuid; pid uuid; result jsonb;
begin
 perform pg_advisory_xact_lock_shared(91820261001);
 if u is null then raise exception 'UNAUTHORIZED';end if;
 st:=effective_status(u);if st is null or st='banned' then raise exception 'ACCOUNT_BANNED';end if;
 select value into op from site_settings where key='operations';
 if (op->>'maintenance')::boolean and not exists(select 1 from admin_members where user_id=u) then raise exception 'MAINTENANCE';end if;
 if command='create_room' and (st='limited_room' or not flag_enabled('create_room',u,r)) then raise exception 'ROOM_DISABLED';end if;
 if command='message' and st='limited_post' then raise exception 'POST_DISABLED';end if;
 if command in ('create_task','update_task') and not flag_enabled('tasks',u,r) then raise exception 'TASK_DISABLED';end if;
 if command='register_file' and (st='limited_upload' or not flag_enabled('uploads',u,r)) then raise exception 'UPLOAD_DISABLED';end if;
 if r is not null and not exists(select 1 from rooms where id=r and status<>'deleted') then raise exception 'FORBIDDEN';end if;
 if r is not null and command not in ('read','presence','leave_room','report') and exists(select 1 from rooms where id=r and status='frozen') then raise exception 'ROOM_FROZEN';end if;
 if command='register_file' then
  perform 1 from rooms where id=r for update;
  if (data->>'size')::bigint>(op->>'max_file_mb')::bigint*1048576 or coalesce((select sum(size) from files where room_id=r and status<>'deleted'),0)+(data->>'size')::bigint>(op->>'room_storage_mb')::bigint*1048576 then raise exception 'STORAGE_LIMIT';end if;
  if not op->'allowed_extensions' ? lower(regexp_replace(data->>'name','^.*\.','')) then raise exception 'FILE_TYPE_DISABLED';end if;
 end if;
 if command in ('create_task','update_task') and exists(select 1 from jsonb_array_elements_text(coalesce(data->'file_ids','[]')) x join files f on f.id=x::uuid where f.status<>'normal') then raise exception 'FILE_UNAVAILABLE';end if;
 if command='report' then
  if not is_room_member(r) then raise exception 'FORBIDDEN';end if;
  tid:=(data->>'target_id')::uuid;
  if data->>'target_type'='message' then select room_id into rr from messages where id=tid;
  elsif data->>'target_type'='file' then select room_id into rr from files where id=tid;
  elsif data->>'target_type'='room' then rr:=tid;
  elsif data->>'target_type'='user' then select room_id into rr from participants where room_id=r and user_id=tid;
  else raise exception 'INVALID_TARGET';end if;
  if rr is distinct from r then raise exception 'INVALID_TARGET';end if;
  if (select count(*) from reports where reporter_id=u and created_at>now()-interval '1 hour')>=30 then raise exception 'RATE_LIMITED';end if;
  insert into reports(reporter_id,target_type,target_id,room_id,reason) values(u,data->>'target_type',tid,r,data->>'reason') returning id into tid;
  perform control_emit('report.created',null,tid::text);return jsonb_build_object('id',tid);
 end if;
 if command='invite' and not data ? 'hours' then data:=data||jsonb_build_object('hours',(op->>'invite_days')::int*24);end if;
 result:=island_core_command(command,data);
 if command not in ('read','presence') then update profiles set last_active_at=now() where id=u;end if;
 return result;
end $$;
revoke all on function island_command(text,jsonb) from public,anon;
grant execute on function island_command(text,jsonb) to authenticated;

create function island_admin_command(action text,data jsonb,context jsonb default '{}') returns jsonb language plpgsql security definer set search_path=public,extensions as $$
declare u uuid:=auth.uid(); role_name text; id uuid:=nullif(data->>'id','')::uuid; r uuid; target_type text:=''; before_state jsonb; after_state jsonb; reason text:=trim(coalesce(data->>'reason','')); aid bigint; p participants; rp reports; a text; object_id text:=coalesce(data->>'id',data->>'key'); extra jsonb; op jsonb;
begin
 perform pg_advisory_xact_lock(91820261001);
 select role into role_name from admin_members where user_id=u;
 if role_name is null or effective_status(u)='banned' then raise exception 'ADMIN_REQUIRED';end if;
 if length(reason)<3 or length(reason)>2000 then raise exception 'REASON_REQUIRED';end if;
 if role_name<>'super' then
  if action in ('admin_member','ip_rule','delete_ip_rule','settings','brand_asset','cleanup') then raise exception 'ADMIN_FORBIDDEN';end if;
  if role_name='technical' and action in ('restrict_user','edit_user','room_status','transfer_host','remove_member','assign_task','delete_message','content_view','file_status','invite_update','resolve_report','announcement','delete_announcement','revoke_sessions') then raise exception 'ADMIN_FORBIDDEN';end if;
  if role_name='operations' and action='feature_flag' then raise exception 'ADMIN_FORBIDDEN';end if;
 end if;
 if action in ('restrict_user','room_status','delete_message','file_status','revoke_sessions','admin_member','ip_rule','cleanup','resolve_report') and coalesce((data->>'confirm')::boolean,false) is not true then raise exception 'CONFIRM_REQUIRED';end if;
 if action='restrict_user' then
  target_type:='user';select to_jsonb(q) into before_state from profiles q where q.id=id for update;
  if data->>'status'='banned' and exists(select 1 from admin_members where user_id=id and role='super') and (select count(*) from admin_members where role='super')<=1 then raise exception 'LAST_SUPER_ADMIN';end if;
  update profiles set status=data->>'status',restriction_reason=reason,restricted_until=nullif(data->>'until','')::timestamptz where profiles.id=id returning to_jsonb(profiles.*) into after_state;
  if after_state->>'status'='banned' then delete from auth.local_sessions where user_id=id;end if;
  for r in select room_id from participants where user_id=id and status='active' loop perform emit(r,'participant.restricted',null,id);end loop;
  perform control_emit('user.updated',id,id::text);
 elsif action='edit_user' then
  target_type:='user';select to_jsonb(q) into before_state from profiles q where q.id=id;
  update profiles set display_name=data->>'display_name',avatar_url=nullif(data->>'avatar_url','') where profiles.id=id returning to_jsonb(profiles.*) into after_state;
  update participants set display_name=data->>'display_name',avatar_url=nullif(data->>'avatar_url','') where user_id=id;
  for r in select room_id from participants where user_id=id and status='active' loop perform emit(r,'participant.updated',null,id);end loop;
  perform control_emit('user.updated',id,id::text);
 elsif action='revoke_sessions' then
  target_type:='user';before_state:=jsonb_build_object('count',(select count(*) from auth.local_sessions where user_id=id));
  delete from auth.local_sessions where user_id=id and (not data ? 'session_id' or auth.local_sessions.id=(data->>'session_id')::uuid);
  after_state:=jsonb_build_object('count',(select count(*) from auth.local_sessions where user_id=id));perform control_emit('session.revoked',id,id::text);
 elsif action='room_status' then
  target_type:='room';select to_jsonb(q) into before_state from rooms q where q.id=id for update;
  update rooms set status=data->>'status',status_reason=reason,deleted_at=case when data->>'status'='deleted' then now() else null end,updated_at=now() where rooms.id=id returning to_jsonb(rooms.*) into after_state;
  r:=id;perform emit(r,'room.'||(data->>'status'),null,id);perform control_emit('room.updated',null,id::text);
 elsif action='transfer_host' then
  target_type:='room';r:=id;select to_jsonb(q) into before_state from rooms q where q.id=id for update;
  select * into p from participants where participants.id=(data->>'participant_id')::uuid and room_id=r and status='active';
  if p.id is null or exists(select 1 from profiles where profiles.id=p.user_id and effective_status(p.user_id)='banned') then raise exception 'INVALID_TARGET';end if;
  update rooms set host_participant_id=p.id,updated_at=now() where rooms.id=r returning to_jsonb(rooms.*) into after_state;perform emit(r,'room.updated',null,r);
 elsif action='remove_member' then
  target_type:='participant';select * into p from participants where participants.id=id and status='active' for update;r:=p.room_id;
  if exists(select 1 from rooms where rooms.id=r and host_participant_id=id) then raise exception 'TRANSFER_BEFORE_LEAVING';end if;
  before_state:=to_jsonb(p);update participants set status='left',last_active_at=null where participants.id=id returning to_jsonb(participants.*) into after_state;perform emit(r,'participant.left',null,id);perform control_emit('membership.updated',p.user_id,r::text);
 elsif action='assign_task' then
  target_type:='task';select to_jsonb(q),q.room_id into before_state,r from tasks q where q.id=id for update;
  if exists(select 1 from jsonb_array_elements_text(data->'assignee_ids') x where not exists(select 1 from participants where participants.id=x::uuid and room_id=r and status='active')) then raise exception 'INVALID_ASSIGNEE';end if;
  delete from task_assignees where task_id=id;insert into task_assignees select id,x::uuid from (select distinct jsonb_array_elements_text(data->'assignee_ids') x) q;update tasks set updated_at=now() where tasks.id=id;
  after_state:=before_state||jsonb_build_object('assignee_ids',data->'assignee_ids');perform emit(r,'task.assigned',null,id);
 elsif action='delete_message' then
  target_type:='message';select to_jsonb(q),q.room_id into before_state,r from messages q where q.id=id for update;
  update messages set content='',deleted_at=now() where messages.id=id returning to_jsonb(messages.*) into after_state;delete from message_reactions where message_id=id;perform emit(r,'message.deleted',null,id);
 elsif action='content_view' then
  target_type:='message';select to_jsonb(q),q.room_id into extra,r from messages q where q.id=id;
  if extra is null then raise exception 'INVALID_TARGET';end if;
  before_state:=jsonb_build_object('message_id',id,'room_id',r);after_state:=before_state; -- do not duplicate private content in Audit
 elsif action='file_status' then
  target_type:='file';select to_jsonb(q),q.room_id into before_state,r from files q where q.id=id for update;
  update files set status=data->>'status',status_reason=reason where files.id=id returning to_jsonb(files.*) into after_state;perform emit(r,'file.updated',null,id);
 elsif action='invite_update' then
  target_type:='invite';select to_jsonb(q)-'token_hash',q.room_id into before_state,r from room_invites q where q.id=id for update;
  update room_invites set revoked_at=case when (data->>'revoke')::boolean then now() else revoked_at end,expires_at=coalesce(nullif(data->>'expires_at','')::timestamptz,expires_at),max_uses=coalesce((data->>'max_uses')::integer,max_uses) where room_invites.id=id returning to_jsonb(room_invites.*)-'token_hash' into after_state;perform emit(r,'invite.updated',null,id);
 elsif action='settings' then
  target_type:='settings';select value into before_state from site_settings where key=data->>'key';
  if before_state is null then raise exception 'INVALID_TARGET';end if;
  update site_settings set value=data->'value',updated_at=now() where key=data->>'key' returning value into after_state;perform control_emit('settings.updated',null,data->>'key');
 elsif action='feature_flag' then
  target_type:='feature_flag';select to_jsonb(q) into before_state from feature_flags q where key=data->>'key';
  if before_state is null then raise exception 'INVALID_TARGET';end if;
  if data->>'key' in ('agents','connection_seat') and (data->>'enabled')::boolean then raise exception 'AGENT_NOT_AVAILABLE';end if;
  update feature_flags set enabled=(data->>'enabled')::boolean,scope=data->>'scope',targets=array(select jsonb_array_elements_text(coalesce(data->'targets','[]'))::uuid),rollout=(data->>'rollout')::integer,updated_at=now() where key=data->>'key' returning to_jsonb(feature_flags.*) into after_state;
  perform control_emit('flags.updated',null,data->>'key');for r in select rooms.id from rooms where status<>'deleted' loop perform emit(r,'capabilities.updated',null,r);end loop;
 elsif action='announcement' then
  target_type:='announcement';id:=coalesce(id,gen_random_uuid());object_id:=id::text;select to_jsonb(q) into before_state from announcements q where q.id=id;
  insert into announcements(id,title,content,starts_at,ends_at,position,dismissible,enabled) values(id,data->>'title',data->>'content',(data->>'starts_at')::timestamptz,nullif(data->>'ends_at','')::timestamptz,data->>'position',(data->>'dismissible')::boolean,(data->>'enabled')::boolean)
  on conflict on constraint announcements_pkey do update set title=excluded.title,content=excluded.content,starts_at=excluded.starts_at,ends_at=excluded.ends_at,position=excluded.position,dismissible=excluded.dismissible,enabled=excluded.enabled returning to_jsonb(announcements.*) into after_state;perform control_emit('announcements.updated');
 elsif action='delete_announcement' then
  target_type:='announcement';delete from announcements where announcements.id=id returning to_jsonb(announcements.*) into before_state;after_state:='{}';perform control_emit('announcements.updated');
 elsif action='resolve_report' then
  target_type:='report';select * into rp from reports where reports.id=id for update;if rp.id is null then raise exception 'INVALID_TARGET';end if;before_state:=to_jsonb(rp);
  a:=data->>'resolution_action';
  if a='delete_message' and rp.target_type='message' then perform island_admin_command('delete_message',jsonb_build_object('id',rp.target_id,'reason',reason,'confirm',true),context);
  elsif a='quarantine' and rp.target_type='file' then perform island_admin_command('file_status',jsonb_build_object('id',rp.target_id,'status','quarantined','reason',reason,'confirm',true),context);
  elsif a='freeze' and rp.target_type='room' then perform island_admin_command('room_status',jsonb_build_object('id',rp.target_id,'status','frozen','reason',reason,'confirm',true),context);
  elsif a in ('banned','limited_post','limited_upload','limited_room') then
   if rp.target_type='user' then r:=rp.target_id;elsif rp.target_type='message' then select user_id into r from participants where participants.id=(select sender_participant_id from messages where messages.id=rp.target_id);elsif rp.target_type='file' then select user_id into r from participants where participants.id=(select uploader_participant_id from files where files.id=rp.target_id);elsif rp.target_type='room' then select created_by into r from rooms where rooms.id=rp.target_id;end if;
   perform island_admin_command('restrict_user',jsonb_build_object('id',r,'status',a,'reason',reason,'confirm',true),context);
  elsif a='warning' then perform control_emit('warning',rp.reporter_id,rp.target_id::text,jsonb_build_object('message',reason));
  elsif a not in ('approve','dismiss','processing') then raise exception 'INVALID_TARGET';end if;
  update reports set status=case a when 'dismiss' then 'dismissed' when 'processing' then 'processing' else 'resolved' end,resolution=reason,handled_by=u,handled_at=now() where reports.id=id returning to_jsonb(reports.*) into after_state;
 elsif action='admin_member' then
  target_type:='administrator';select to_jsonb(q) into before_state from admin_members q where user_id=id;
  if before_state->>'role'='super' and (data->>'role') is distinct from 'super' and (select count(*) from admin_members where role='super')<=1 then raise exception 'LAST_SUPER_ADMIN';end if;
  if data->>'role'='remove' then delete from admin_members where user_id=id;after_state:='{}';else
   if effective_status(id)='banned' then raise exception 'INVALID_TARGET';end if;
   insert into admin_members(user_id,role) values(id,data->>'role') on conflict(user_id) do update set role=excluded.role returning to_jsonb(admin_members.*) into after_state;end if;perform control_emit('admin.updated',id,id::text);
 elsif action='ip_rule' then
  target_type:='ip_rule';id:=coalesce(id,gen_random_uuid());object_id:=id::text;
  insert into ip_rules(id,network,reason,expires_at) values(id,(data->>'network')::cidr,reason,nullif(data->>'expires_at','')::timestamptz) on conflict(network) do update set reason=excluded.reason,expires_at=excluded.expires_at returning to_jsonb(ip_rules.*) into after_state;
 elsif action='delete_ip_rule' then target_type:='ip_rule';delete from ip_rules where ip_rules.id=id returning to_jsonb(ip_rules.*) into before_state;after_state:='{}';
 elsif action='cleanup' then
  target_type:='maintenance';before_state:=jsonb_build_object('sessions',(select count(*) from auth.local_sessions where expires_at<=now()),'invites',(select count(*) from room_invites where expires_at<=now() or revoked_at is not null));
  delete from auth.local_sessions where expires_at<=now();delete from room_invites where expires_at<=now() or revoked_at is not null;delete from request_metrics where created_at<now()-interval '30 days';delete from login_events where created_at<now()-interval '90 days';delete from realtime_connections where last_seen_at<now()-interval '2 minutes';after_state:=jsonb_build_object('cleaned',true);
 else raise exception 'UNKNOWN_COMMAND';end if;
 if before_state is null and after_state is null and extra is null then raise exception 'INVALID_TARGET';end if;
 -- Audit never preserves a removed message body or invite token.
 if target_type='message' then before_state:=before_state-'content';after_state:=after_state-'content';end if;
 insert into admin_audit_logs(admin_id,action,target_type,target_id,before,after,reason,ip,trace_id) values(u,action,target_type,object_id,before_state,after_state,reason,nullif(context->>'ip','')::inet,(context->>'trace_id')::uuid) returning id into aid;
 perform control_emit('admin.action',u,object_id,jsonb_build_object('audit_id',aid));
 return jsonb_build_object('ok',true,'audit_id',aid,'data',coalesce(extra,after_state));
end $$;
revoke all on function island_admin_command(text,jsonb,jsonb) from public,anon;
grant execute on function island_admin_command(text,jsonb,jsonb) to authenticated;

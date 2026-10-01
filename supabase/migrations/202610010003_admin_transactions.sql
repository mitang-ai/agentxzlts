-- Qualify the audit ID; transaction targets must resolve to function variables.
create or replace function island_admin_command(action text,data jsonb,context jsonb default '{}') returns jsonb language plpgsql security definer set search_path=public,extensions as $$
#variable_conflict use_variable
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
 if action<>'content_view' and coalesce((data->>'confirm')::boolean,false) is not true then raise exception 'CONFIRM_REQUIRED';end if;
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
  elsif a='warning' then
   if rp.target_type='user' then r:=rp.target_id;elsif rp.target_type='message' then select user_id into r from participants where participants.id=(select sender_participant_id from messages where messages.id=rp.target_id);elsif rp.target_type='file' then select user_id into r from participants where participants.id=(select uploader_participant_id from files where files.id=rp.target_id);elsif rp.target_type='room' then select created_by into r from rooms where rooms.id=rp.target_id;end if;
   perform control_emit('warning',r,rp.target_id::text,jsonb_build_object('message',reason));
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
 insert into admin_audit_logs(admin_id,action,target_type,target_id,before,after,reason,ip,trace_id) values(u,action,target_type,object_id,before_state,after_state,reason,nullif(context->>'ip','')::inet,(context->>'trace_id')::uuid) returning admin_audit_logs.id into aid;
 perform control_emit('admin.action',u,object_id,jsonb_build_object('audit_id',aid));
 return jsonb_build_object('ok',true,'audit_id',aid,'data',coalesce(extra,after_state));
end $$;

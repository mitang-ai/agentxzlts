-- Gateway 已持有房间锁才进入 actor_command；人类 RPC 不能先持有限流行再等待房间。
-- 追加修改函数，不重写旧迁移，不改变权限、限流阈值或业务数据。
do $migration$
declare
 body text;
 budget_anchor text := 'b:=floor(extract(epoch from now())/60);';
 cleanup_anchor text := 'delete from command_limits where bucket<b-60;';
 prelock text := $prelock$
 -- room_before_rate_limit_v1: 全部入口统一 room -> command_limits -> participant/profile。
 if command='profile' then
  select array_agg(distinct room_id order by room_id) into ids from participants where user_id=u;
  for r in select unnest(coalesce(ids,'{}'::uuid[])) loop
   perform 1 from rooms where id=r for update;
  end loop;
 elsif command='join_invite' then
  select room_id into r from room_invites where token_hash=encode(digest(data->>'token','sha256'),'hex');
  perform 1 from rooms where id=r for update;
 elsif command<>'create_room' then
  r:=nullif(data->>'room_id','')::uuid;
  perform 1 from rooms where id=r for update;
 end if;
 $prelock$;
begin
 select pg_get_functiondef('island_actor_command(uuid,text,jsonb)'::regprocedure) into body;
 if position(budget_anchor in body)=0 or position(cleanup_anchor in body)=0
    or position('room_before_rate_limit_v1' in body)>0 then
  raise exception 'Unexpected island_actor_command definition; lock-order migration was not applied';
 end if;
 body:=replace(body,budget_anchor,prelock||budget_anchor);
 -- 等限流行期间同账号可能加入新房间；不能拿着限流锁反向补锁，也不能半更新资料。
 body:=replace(body,cleanup_anchor,cleanup_anchor||$recheck$
 if command='profile' and exists(
  select 1 from participants where user_id=u and (ids is null or not(room_id=any(ids)))
 ) then
  raise exception 'PROFILE_ROOMS_CHANGED' using errcode='40001';
 end if;
 $recheck$);
 execute body;
end $migration$;

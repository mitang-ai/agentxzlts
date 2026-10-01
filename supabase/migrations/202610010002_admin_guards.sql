-- A deleted/frozen room cannot accept new members through a retained invitation.
create function guarded_invite() returns trigger language plpgsql security definer set search_path=public as $$ begin
 if new.status='active' and (tg_op='INSERT' or old.status<>'active') and exists(select 1 from rooms where id=new.room_id and status<>'active') then raise exception 'ROOM_FROZEN';end if;return new;
end $$;
create trigger guard_participant_join before insert or update on participants for each row execute function guarded_invite();
revoke all on function guarded_invite() from public,anon,authenticated;
update storage.buckets set file_size_limit=524288000 where id='room-files';

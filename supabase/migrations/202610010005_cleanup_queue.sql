create table storage_cleanup_jobs(path text primary key,created_at timestamptz not null default now(),last_error text);
alter table storage_cleanup_jobs enable row level security;
revoke all on storage_cleanup_jobs from anon,authenticated;
-- Keep retryable work when a Storage object deletion is temporarily unavailable.
create function queue_orphan_cleanup() returns trigger language plpgsql security definer set search_path=public as $$ begin
 if not exists(select 1 from files where storage_path=old.name) and old.name ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}$' then insert into storage_cleanup_jobs(path) values(old.name) on conflict do nothing;end if;return old;
end $$;
create trigger queue_storage_cleanup after delete on storage.objects for each row execute function queue_orphan_cleanup();
revoke all on function queue_orphan_cleanup() from public,anon,authenticated;

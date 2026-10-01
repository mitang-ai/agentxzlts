create table realtime_stream_log(id uuid primary key,user_id uuid not null,room_id uuid not null,opened_at timestamptz not null default now(),closed_at timestamptz,recovered_cursor boolean not null);
alter table realtime_stream_log enable row level security;
revoke all on realtime_stream_log from anon,authenticated;
create index stream_opened on realtime_stream_log(opened_at desc);

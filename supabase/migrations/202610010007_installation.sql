-- Deployment state is server-only; file deletion never grants a new administrator.
create table app_installation (
 singleton boolean primary key default true check(singleton),
 id uuid not null unique,
 phase text not null check(phase in ('provisioned','complete')),
 created_at timestamptz not null default now(),
 completed_at timestamptz,
 updated_at timestamptz not null default now()
);
alter table app_installation enable row level security;
revoke all on app_installation from public,anon,authenticated;

-- 自托管 PostgreSQL 的 Auth/Storage 命名空间；Supabase 已提供这些对象。
create schema if not exists auth;
create schema if not exists storage;
create schema if not exists extensions;
do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;
create table if not exists auth.users(id uuid primary key default gen_random_uuid(),email text not null unique,raw_user_meta_data jsonb not null default '{}');
do $$ begin if to_regprocedure('auth.uid()') is null then execute $fn$ create function auth.uid() returns uuid language sql stable as $sql$ select coalesce(nullif(current_setting('request.jwt.claim.sub',true),''),nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid $sql$ $fn$;end if;end $$;
create table if not exists auth.local_credentials(user_id uuid primary key references auth.users on delete cascade,password_hash text not null);
create table if not exists auth.local_sessions(token_hash text primary key,user_id uuid not null references auth.users on delete cascade,expires_at timestamptz not null);
create table if not exists storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
create table if not exists storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text references storage.buckets,name text not null unique,metadata jsonb not null default '{}');

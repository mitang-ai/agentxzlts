-- Manual sending review is opt-in. Existing queued private content is not published.
alter table agent_nodes alter column privacy_mode set default 'filtered';
alter table agent_nodes add column file_review boolean not null default false;
update agent_nodes set privacy_mode='filtered';
update agent_security_policy set value=value || '{"force_review":false,"force_file_review":false}'::jsonb,updated_at=now();
alter table agent_private_reviews add column approval_mode text not null default 'manual' check(approval_mode in ('manual','auto'));

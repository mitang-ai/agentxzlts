-- 删除失效席位记录，不级联破坏消息、协作和审计历史。
alter table agent_seats add column deleted_at timestamptz;
alter table agent_seats add constraint agent_seats_deleted_terminal
  check (deleted_at is null or state in ('rejected','revoked'));

alter table collaboration_briefs
  add column requirements_file_ids uuid[] not null default '{}',
  add column design_file_ids uuid[] not null default '{}';
alter table collaboration_briefs drop constraint collaboration_briefs_requirements_check;
alter table collaboration_briefs drop constraint collaboration_briefs_design_check;
alter table collaboration_briefs add constraint collaboration_briefs_requirements_check
  check (length(requirements) <= 32000 and (length(btrim(requirements)) > 0 or cardinality(requirements_file_ids) > 0));
alter table collaboration_briefs add constraint collaboration_briefs_design_check
  check (length(design) <= 32000 and (length(btrim(design)) > 0 or cardinality(design_file_ids) > 0));
alter table collaboration_briefs add constraint collaboration_briefs_document_ids_check
  check (requirements_file_ids <@ file_ids and design_file_ids <@ file_ids and cardinality(file_ids) <= 20);

-- Keep publication lookups efficient and give the composite version foreign key
-- a matching covering index. This is additive and does not alter document data.
create index if not exists document_template_publications_template_version_idx
  on public.document_template_publications (template_id, current_version_id);

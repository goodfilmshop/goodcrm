-- Support audit-user joins and user deletion without scanning contact topics.

create index if not exists contact_topics_created_by_idx
on public.contact_topics (created_by);

create index if not exists contact_topics_updated_by_idx
on public.contact_topics (updated_by);

-- Fast, RLS-aware usage counts for the contact-topic administration table.
-- The view runs with the querying user's privileges, so the existing cases
-- and contact_topics row-level security remains in force.

create index if not exists cases_normalized_topic_idx
on public.cases ((lower(btrim(topic))))
where topic is not null and btrim(topic) <> '';

create or replace view public.contact_topic_usage_counts
with (security_invoker = true)
as
select
  contact_topics.id as contact_topic_id,
  count(cases.id)::integer as usage_count
from public.contact_topics
left join public.cases
  on lower(btrim(cases.topic)) = lower(btrim(contact_topics.name))
group by contact_topics.id;

grant select on public.contact_topic_usage_counts to authenticated;

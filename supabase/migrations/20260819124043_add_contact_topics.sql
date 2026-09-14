-- Configurable contact-topic master data used by case creation and editing.
-- Existing cases keep their topic text even when an option is later deleted.

create table if not exists public.contact_topics (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  is_active boolean not null default true,
  sort_order integer not null default 0 check (sort_order between 0 and 999999),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  constraint contact_topics_name_not_blank check (btrim(name) <> '')
);

create unique index if not exists contact_topics_name_unique
on public.contact_topics (lower(btrim(name)));

create index if not exists contact_topics_active_sort_idx
on public.contact_topics (is_active, sort_order, name);

-- Preserve the vocabulary already used by imported and existing cases so the
-- new dropdown is useful immediately after the migration.
with existing_topics as (
  select distinct btrim(topic) as name
  from public.cases
  where topic is not null and btrim(topic) <> ''
), ranked_topics as (
  select name, row_number() over (order by lower(name)) * 10 as sort_order
  from existing_topics
)
insert into public.contact_topics (name, sort_order)
select ranked_topics.name, ranked_topics.sort_order
from ranked_topics
where not exists (
  select 1
  from public.contact_topics
  where lower(btrim(contact_topics.name)) = lower(btrim(ranked_topics.name))
);

drop trigger if exists contact_topics_set_updated_at on public.contact_topics;
create trigger contact_topics_set_updated_at
before update on public.contact_topics
for each row execute function private.set_updated_at();

-- The API uses the authenticated member's JWT, so grants and RLS both apply.
-- Every active CRM member needs the active list in case forms; only admins may
-- change the settings rows.
grant select, insert, update, delete on public.contact_topics to authenticated;

alter table public.contact_topics enable row level security;

create policy "active members can read contact topics"
on public.contact_topics
for select
to authenticated
using (
  (is_active and (select private.is_active_crm_member()))
  or (select private.is_crm_admin())
);

create policy "admins can create contact topics"
on public.contact_topics
for insert
to authenticated
with check ((select private.is_crm_admin()));

create policy "admins can update contact topics"
on public.contact_topics
for update
to authenticated
using ((select private.is_crm_admin()))
with check ((select private.is_crm_admin()));

create policy "admins can delete contact topics"
on public.contact_topics
for delete
to authenticated
using ((select private.is_crm_admin()));

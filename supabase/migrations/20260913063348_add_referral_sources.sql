-- Configurable referral-source master data used by the customer form.
-- Existing customers keep their saved text even when an option is later changed or removed.

create table if not exists public.referral_sources (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  is_active boolean not null default true,
  sort_order integer not null default 0 check (sort_order between 0 and 999999),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  constraint referral_sources_name_not_blank check (btrim(name) <> '')
);

create unique index if not exists referral_sources_name_unique
on public.referral_sources (lower(btrim(name)));

create index if not exists referral_sources_active_sort_idx
on public.referral_sources (is_active, sort_order, name);

-- Preserve the selection list that was previously hard-coded in the customer form.
insert into public.referral_sources (name, sort_order)
select seed.name, seed.ordinality * 10
from unnest(array[
  'Google Search', 'Facebook', 'Tiktok', 'เพื่อนแนะนำ', 'WalkIn', 'อื่นๆ'
]::text[]) with ordinality as seed(name, ordinality)
on conflict (lower(btrim(name))) do nothing;

-- Customer text remains untouched, including historical values outside the options.

drop trigger if exists referral_sources_set_updated_at on public.referral_sources;
create trigger referral_sources_set_updated_at
before update on public.referral_sources
for each row execute function private.set_updated_at();

-- Every active CRM member can read active options in the customer form; only
-- administrators can manage the complete directory in System Settings.
revoke all on public.referral_sources from anon, authenticated;
grant select, insert, update on public.referral_sources to authenticated;

alter table public.referral_sources enable row level security;

create policy "active members can read referral sources"
on public.referral_sources
for select
to authenticated
using (
  (is_active and (select private.is_active_crm_member()))
  or (select private.is_crm_admin())
);

create policy "admins can create referral sources"
on public.referral_sources
for insert
to authenticated
with check ((select private.is_crm_admin()));

create policy "admins can update referral sources"
on public.referral_sources
for update
to authenticated
using ((select private.is_crm_admin()))
with check ((select private.is_crm_admin()));

-- Usage counts are shown to administrators to make it clear which choices are
-- already in use. The view inherits the querying member's RLS permissions.
create index if not exists customers_normalized_referral_source_idx
on public.customers ((lower(btrim(referral_source))))
where referral_source is not null and btrim(referral_source) <> '';

create or replace view public.referral_source_usage_counts
with (security_invoker = true)
as
select
  referral_sources.id as referral_source_id,
  count(customers.id)::integer as usage_count
from public.referral_sources
left join public.customers
  on lower(btrim(customers.referral_source)) = lower(btrim(referral_sources.name))
group by referral_sources.id;

grant select on public.referral_source_usage_counts to authenticated;

create index referral_sources_created_by_idx on public.referral_sources(created_by);
create index referral_sources_updated_by_idx on public.referral_sources(updated_by);

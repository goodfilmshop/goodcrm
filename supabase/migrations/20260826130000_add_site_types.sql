-- Configurable site-type master data used by the case form.
-- Existing cases keep their saved text even when an option is later changed or removed.

create table if not exists public.site_types (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  is_active boolean not null default true,
  sort_order integer not null default 0 check (sort_order between 0 and 999999),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  constraint site_types_name_not_blank check (btrim(name) <> '')
);

create unique index if not exists site_types_name_unique
on public.site_types (lower(btrim(name)));

create index if not exists site_types_active_sort_idx
on public.site_types (is_active, sort_order, name);

-- Preserve the selection list that was previously hard-coded in the case form.
insert into public.site_types (name, sort_order)
select seed.name, seed.ordinality * 10
from unnest(array[
  'อาคาร', 'บ้าน', 'บ้านเดี่ยว', 'ทาวน์โฮม', 'คอนโด', 'ร้านกาแฟ', 'ร้านค้า',
  'ออฟฟิศ', 'ฟิตเนส', 'โรงงาน', 'โรงเรียน', 'โรงแรม', 'โรงพยาบาล', 'ห้าง',
  'สำนักงาน', 'รีสอร์ท', 'โชว์รูม', 'ตู้ รปภ.', 'ตู้แช่', 'ร้านทอง', 'ร้านอาหาร',
  'นิติคอนโด', 'มหาลัย', 'ราชการ', 'วัด', 'อื่นๆ', 'คลินิก', 'นิติหมู่บ้าน'
]::text[]) with ordinality as seed(name, ordinality)
on conflict (lower(btrim(name))) do nothing;

-- Also retain any historical values imported from previous case records.
with existing_site_types as (
  select distinct btrim(site_type) as name
  from public.cases
  where site_type is not null and btrim(site_type) <> ''
), ranked_site_types as (
  select name, row_number() over (order by lower(name)) * 10 as sort_order
  from existing_site_types
)
insert into public.site_types (name, sort_order)
select name, sort_order
from ranked_site_types
on conflict (lower(btrim(name))) do nothing;

drop trigger if exists site_types_set_updated_at on public.site_types;
create trigger site_types_set_updated_at
before update on public.site_types
for each row execute function private.set_updated_at();

-- Every active CRM member can read active options in the case form; only
-- administrators can manage the complete directory in System Settings.
grant select, insert, update, delete on public.site_types to authenticated;

alter table public.site_types enable row level security;

create policy "active members can read site types"
on public.site_types
for select
to authenticated
using (
  (is_active and (select private.is_active_crm_member()))
  or (select private.is_crm_admin())
);

create policy "admins can create site types"
on public.site_types
for insert
to authenticated
with check ((select private.is_crm_admin()));

create policy "admins can update site types"
on public.site_types
for update
to authenticated
using ((select private.is_crm_admin()))
with check ((select private.is_crm_admin()));

create policy "admins can delete site types"
on public.site_types
for delete
to authenticated
using ((select private.is_crm_admin()));

-- Usage counts are shown to administrators to make it clear which choices are
-- already in use. The view inherits the querying member's RLS permissions.
create index if not exists cases_normalized_site_type_idx
on public.cases ((lower(btrim(site_type))))
where site_type is not null and btrim(site_type) <> '';

create or replace view public.site_type_usage_counts
with (security_invoker = true)
as
select
  site_types.id as site_type_id,
  count(cases.id)::integer as usage_count
from public.site_types
left join public.cases
  on lower(btrim(cases.site_type)) = lower(btrim(site_types.name))
group by site_types.id;

grant select on public.site_type_usage_counts to authenticated;

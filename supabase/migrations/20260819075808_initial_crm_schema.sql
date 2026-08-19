-- Good CRM: production schema for the Google Sheets migration.
-- This migration intentionally keeps the legacy identifiers so every imported
-- row can be reconciled back to the original spreadsheet.

create schema if not exists private;
revoke all on schema private from public;

create table if not exists public.crm_members (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null,
  role text not null default 'admin' check (role in ('admin', 'manager', 'sales')),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.customers (
  id uuid primary key default gen_random_uuid(),
  legacy_cust_id text not null unique,
  recorded_at timestamptz,
  customer_name text not null,
  gender text not null default 'ไม่ระบุ',
  phone text,
  phone_normalized text generated always as (regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g')) stored,
  contact_channel text,
  contact_handle text,
  referral_source text,
  remarks text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null
);

create table if not exists public.cases (
  id uuid primary key default gen_random_uuid(),
  legacy_case_id text unique,
  customer_id uuid not null references public.customers(id) on delete cascade,
  recorded_at timestamptz not null default now(),
  admin_name text,
  customer_type text,
  topic text,
  priority text,
  site_type text,
  site_address text,
  location_text text,
  location_url text,
  province text,
  product_interest text,
  job_details text,
  budget text,
  salesperson text,
  company text,
  status text not null default 'ติดต่อสอบถาม',
  remarks text,
  chat_link text,
  external_link text,
  billing_name text,
  billing_address text,
  tax_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null
);

create index if not exists customers_recorded_at_idx on public.customers (recorded_at desc);
create index if not exists customers_name_idx on public.customers (lower(customer_name));
create index if not exists customers_phone_normalized_idx on public.customers (phone_normalized);
create index if not exists customers_channel_idx on public.customers (contact_channel);
create index if not exists cases_customer_recorded_at_idx on public.cases (customer_id, recorded_at desc);
create index if not exists cases_status_idx on public.cases (status);
create index if not exists cases_recorded_at_idx on public.cases (recorded_at desc);

-- Keep timestamp maintenance out of the exposed API schema.
create or replace function private.set_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger crm_members_set_updated_at
before update on public.crm_members
for each row execute function private.set_updated_at();

create trigger customers_set_updated_at
before update on public.customers
for each row execute function private.set_updated_at();

create trigger cases_set_updated_at
before update on public.cases
for each row execute function private.set_updated_at();

-- The membership check is private, verifies the current auth identity, and is
-- called through an init plan in each policy for predictable query performance.
create or replace function private.is_active_crm_member()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.crm_members
    where user_id = (select auth.uid())
      and is_active = true
  );
$$;

revoke all on function private.is_active_crm_member() from public;
grant usage on schema private to authenticated;
grant execute on function private.is_active_crm_member() to authenticated;

grant select on public.crm_members to authenticated;
grant select, insert, update, delete on public.customers to authenticated;
grant select, insert, update, delete on public.cases to authenticated;

alter table public.crm_members enable row level security;
alter table public.customers enable row level security;
alter table public.cases enable row level security;

create policy "members can view their own membership"
on public.crm_members
for select
to authenticated
using ((select auth.uid()) = user_id);

create policy "active members can read customers"
on public.customers
for select
to authenticated
using ((select private.is_active_crm_member()));

create policy "active members can create customers"
on public.customers
for insert
to authenticated
with check ((select private.is_active_crm_member()));

create policy "active members can update customers"
on public.customers
for update
to authenticated
using ((select private.is_active_crm_member()))
with check ((select private.is_active_crm_member()));

create policy "active members can delete customers"
on public.customers
for delete
to authenticated
using ((select private.is_active_crm_member()));

create policy "active members can read cases"
on public.cases
for select
to authenticated
using ((select private.is_active_crm_member()));

create policy "active members can create cases"
on public.cases
for insert
to authenticated
with check ((select private.is_active_crm_member()));

create policy "active members can update cases"
on public.cases
for update
to authenticated
using ((select private.is_active_crm_member()))
with check ((select private.is_active_crm_member()));

create policy "active members can delete cases"
on public.cases
for delete
to authenticated
using ((select private.is_active_crm_member()));

-- Postgres Changes uses the project publication; no objects are created in the
-- locked realtime schema.
alter publication supabase_realtime add table public.customers, public.cases;

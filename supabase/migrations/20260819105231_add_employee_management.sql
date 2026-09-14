-- Employee directory and settings administration for GOOD CRM.
-- Passwords deliberately do not live in this table: GOOD CRM signs users in
-- through Supabase Auth Magic Links, so credential secrets remain in Auth.

create sequence if not exists public.crm_employee_code_seq
  start with 1
  minvalue 1;

alter table public.crm_members
  drop constraint if exists crm_members_role_check;

alter table public.crm_members
  add constraint crm_members_role_check
  check (role in ('admin', 'manager', 'sales', 'member'));

create table if not exists public.crm_employees (
  id uuid primary key default gen_random_uuid(),
  employee_code text not null unique,
  nickname text not null,
  full_name text,
  position text,
  phone text,
  email text,
  company text,
  status text not null default 'active' check (status in ('active', 'inactive')),
  notes text,
  login_name text,
  access_role text not null default 'sales' check (access_role in ('admin', 'manager', 'sales', 'member')),
  member_user_id uuid unique references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null
);

create unique index if not exists crm_employees_login_name_unique
on public.crm_employees (lower(login_name))
where login_name is not null and btrim(login_name) <> '';

create unique index if not exists crm_employees_email_unique
on public.crm_employees (lower(email))
where email is not null and btrim(email) <> '';

create index if not exists crm_employees_status_name_idx
on public.crm_employees (status, nickname);

create or replace function private.assign_crm_employee_code()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.employee_code is null or btrim(new.employee_code) = '' then
    new.employee_code := 'E-' || lpad(nextval('public.crm_employee_code_seq')::text, 4, '0');
  end if;
  return new;
end;
$$;

drop trigger if exists crm_employees_assign_code on public.crm_employees;
create trigger crm_employees_assign_code
before insert on public.crm_employees
for each row execute function private.assign_crm_employee_code();

drop trigger if exists crm_employees_set_updated_at on public.crm_employees;
create trigger crm_employees_set_updated_at
before update on public.crm_employees
for each row execute function private.set_updated_at();

-- A profile becomes an active CRM login only when an Auth user with the same
-- email already exists. This keeps Auth credentials in Supabase Auth while
-- making the status and role selected in the employee menu take effect.
create or replace function private.link_crm_employee_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
begin
  new.member_user_id := null;
  if new.email is not null and btrim(new.email) <> '' then
    select id
    into new.member_user_id
    from auth.users
    where lower(email) = lower(btrim(new.email))
    limit 1;
  end if;
  return new;
end;
$$;

drop trigger if exists crm_employees_link_auth_user on public.crm_employees;
create trigger crm_employees_link_auth_user
before insert or update of email on public.crm_employees
for each row execute function private.link_crm_employee_auth_user();

create or replace function private.sync_crm_employee_membership()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    if old.member_user_id is not null then
      update public.crm_members
      set is_active = false
      where user_id = old.member_user_id;
    end if;
    return old;
  end if;

  if tg_op = 'UPDATE'
    and old.member_user_id is not null
    and old.member_user_id is distinct from new.member_user_id then
    update public.crm_members
    set is_active = false
    where user_id = old.member_user_id;
  end if;

  if new.member_user_id is not null then
    insert into public.crm_members (user_id, display_name, role, is_active)
    values (
      new.member_user_id,
      coalesce(nullif(new.full_name, ''), new.nickname),
      new.access_role,
      new.status = 'active'
    )
    on conflict (user_id) do update
    set display_name = excluded.display_name,
        role = excluded.role,
        is_active = excluded.is_active;
  end if;
  return new;
end;
$$;

drop trigger if exists crm_employees_sync_membership on public.crm_employees;
create trigger crm_employees_sync_membership
after insert or update of member_user_id, nickname, full_name, status, access_role or delete on public.crm_employees
for each row execute function private.sync_crm_employee_membership();

-- Employee contact details and access roles are visible only to CRM
-- administrators; the existing limited crm_members directory remains the
-- source for assignment lists used by other roles.
create or replace function private.is_crm_admin()
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
      and role = 'admin'
  );
$$;

revoke all on function private.is_crm_admin() from public;
grant usage on schema private to authenticated;
grant execute on function private.is_crm_admin() to authenticated;

grant select, insert, update, delete on public.crm_employees to authenticated;

alter table public.crm_employees enable row level security;

create policy "admins can read employee directory"
on public.crm_employees
for select
to authenticated
using ((select private.is_crm_admin()));

create policy "admins can create employees"
on public.crm_employees
for insert
to authenticated
with check ((select private.is_crm_admin()));

create policy "admins can update employees"
on public.crm_employees
for update
to authenticated
using ((select private.is_crm_admin()))
with check ((select private.is_crm_admin()));

create policy "admins can delete employees"
on public.crm_employees
for delete
to authenticated
using ((select private.is_crm_admin()));

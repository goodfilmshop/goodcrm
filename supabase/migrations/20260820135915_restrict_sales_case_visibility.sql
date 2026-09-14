-- Restrict role `sales` to CRM rows assigned to the linked employee.

alter table public.cases
  add column if not exists salesperson_employee_id uuid;

do $$
begin
  if not exists (
    select 1
    from pg_catalog.pg_constraint
    where conname = 'cases_salesperson_employee_id_fkey'
      and conrelid = 'public.cases'::regclass
  ) then
    alter table public.cases
      add constraint cases_salesperson_employee_id_fkey
      foreign key (salesperson_employee_id)
      references public.crm_employees(id)
      on delete set null;
  end if;
end;
$$;

comment on column public.cases.salesperson_employee_id is
  'Authoritative employee assignment used by RLS; salesperson remains the display snapshot.';

create index if not exists cases_salesperson_employee_id_idx
on public.cases (salesperson_employee_id);

create unique index if not exists crm_employees_nickname_normalized_unique
on public.crm_employees (pg_catalog.lower(pg_catalog.btrim(nickname)))
where pg_catalog.btrim(nickname) <> '';

with unique_employee_matches as (
  select
    pg_catalog.lower(pg_catalog.btrim(employee.nickname)) as normalized_nickname,
    pg_catalog.min(employee.id::text)::uuid as employee_id
  from public.crm_employees as employee
  where pg_catalog.btrim(employee.nickname) <> ''
  group by pg_catalog.lower(pg_catalog.btrim(employee.nickname))
  having pg_catalog.count(*) = 1
)
update public.cases as crm_case
set salesperson_employee_id = employee_match.employee_id
from unique_employee_matches as employee_match
where crm_case.salesperson_employee_id is null
  and pg_catalog.btrim(coalesce(crm_case.salesperson, '')) <> ''
  and pg_catalog.lower(pg_catalog.btrim(crm_case.salesperson)) = employee_match.normalized_nickname;

create or replace function private.sync_case_salesperson_employee()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  matched_employee_id uuid;
begin
  if tg_op = 'UPDATE'
    and new.salesperson is not distinct from old.salesperson
    and new.salesperson_employee_id is not distinct from old.salesperson_employee_id then
    return new;
  end if;

  if tg_op = 'UPDATE'
    and new.salesperson_employee_id is not null
    and exists (
      select 1
      from public.crm_employees as assigned_employee
      where assigned_employee.id = new.salesperson_employee_id
        and pg_catalog.lower(pg_catalog.btrim(assigned_employee.nickname)) =
            pg_catalog.lower(pg_catalog.btrim(coalesce(new.salesperson, '')))
    ) then
    return new;
  end if;

  if pg_catalog.btrim(coalesce(new.salesperson, '')) = '' then
    new.salesperson_employee_id := null;
    return new;
  end if;

  select
    case
      when pg_catalog.count(*) = 1
        then pg_catalog.min(employee.id::text)::uuid
      else null
    end
  into matched_employee_id
  from public.crm_employees as employee
  where pg_catalog.lower(pg_catalog.btrim(employee.nickname)) =
        pg_catalog.lower(pg_catalog.btrim(new.salesperson));

  if matched_employee_id is null then
    raise exception 'Unknown CRM salesperson nickname: %', new.salesperson
      using errcode = '23503';
  end if;

  new.salesperson_employee_id := matched_employee_id;
  return new;
end;
$$;

revoke all on function private.sync_case_salesperson_employee()
from public, anon, authenticated;

drop trigger if exists cases_sync_salesperson_employee on public.cases;
create trigger cases_sync_salesperson_employee
before insert or update of salesperson, salesperson_employee_id on public.cases
for each row execute function private.sync_case_salesperson_employee();

create or replace function private.sync_employee_case_salesperson_name()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.nickname is distinct from old.nickname then
    update public.cases
    set salesperson = pg_catalog.btrim(new.nickname)
    where salesperson_employee_id = new.id;
  end if;
  return new;
end;
$$;

revoke all on function private.sync_employee_case_salesperson_name()
from public, anon, authenticated;

drop trigger if exists crm_employees_sync_case_salesperson_name
on public.crm_employees;
create trigger crm_employees_sync_case_salesperson_name
after update of nickname on public.crm_employees
for each row execute function private.sync_employee_case_salesperson_name();

create or replace function private.protect_sales_case_ownership()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (
    select 1
    from public.crm_members as member
    where member.user_id = (select auth.uid())
      and member.is_active = true
      and member.role = 'sales'
  ) and (
    new.customer_id is distinct from old.customer_id
    or new.salesperson is distinct from old.salesperson
    or new.salesperson_employee_id is distinct from old.salesperson_employee_id
    or new.created_by is distinct from old.created_by
  ) then
    raise exception 'Sales users cannot change case ownership fields.'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

revoke all on function private.protect_sales_case_ownership()
from public, anon, authenticated;

drop trigger if exists cases_protect_sales_case_ownership on public.cases;
create trigger cases_protect_sales_case_ownership
before update of customer_id, salesperson, salesperson_employee_id, created_by
on public.cases
for each row execute function private.protect_sales_case_ownership();

create or replace function private.protect_sales_customer_ownership()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (
    select 1
    from public.crm_members as member
    where member.user_id = (select auth.uid())
      and member.is_active = true
      and member.role = 'sales'
  ) and (
    new.id is distinct from old.id
    or new.created_by is distinct from old.created_by
  ) then
    raise exception 'Sales users cannot change customer ownership fields.'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

revoke all on function private.protect_sales_customer_ownership()
from public, anon, authenticated;

drop trigger if exists customers_protect_sales_ownership on public.customers;
create trigger customers_protect_sales_ownership
before update of id, created_by on public.customers
for each row execute function private.protect_sales_customer_ownership();

create or replace function private.current_crm_assignment_identity()
returns table (
  employee_id uuid,
  salesperson_name text,
  restricted boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    employee.id as employee_id,
    pg_catalog.btrim(employee.nickname) as salesperson_name,
    member.role = 'sales' as restricted
  from public.crm_members as member
  left join public.crm_employees as employee
    on employee.member_user_id = member.user_id
   and employee.status = 'active'
  where member.user_id = (select auth.uid())
    and member.is_active = true
  limit 1;
$$;

revoke all on function private.current_crm_assignment_identity()
from public, anon, authenticated;
grant usage on schema private to authenticated;
grant execute on function private.current_crm_assignment_identity()
to authenticated;

create or replace function public.get_current_crm_assignment_identity()
returns table (
  employee_id uuid,
  salesperson_name text,
  restricted boolean
)
language sql
stable
security invoker
set search_path = ''
as $$
  select identity.employee_id, identity.salesperson_name, identity.restricted
  from private.current_crm_assignment_identity() as identity;
$$;

revoke all on function public.get_current_crm_assignment_identity()
from public, anon, authenticated;
grant execute on function public.get_current_crm_assignment_identity()
to authenticated;

create or replace function private.can_access_crm_case(p_salesperson_employee_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.crm_members as member
    left join public.crm_employees as employee
      on employee.member_user_id = member.user_id
     and employee.status = 'active'
    where member.user_id = (select auth.uid())
      and member.is_active = true
      and (
        member.role <> 'sales'
        or employee.id = p_salesperson_employee_id
      )
  );
$$;

create or replace function private.can_access_crm_case_id(p_case_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.cases as crm_case
    where crm_case.id = p_case_id
      and private.can_access_crm_case(crm_case.salesperson_employee_id)
  );
$$;

create or replace function private.can_create_crm_case(
  p_salesperson_employee_id uuid,
  p_customer_id uuid,
  p_created_by uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.crm_members as member
    left join public.crm_employees as employee
      on employee.member_user_id = member.user_id
     and employee.status = 'active'
    where member.user_id = (select auth.uid())
      and member.is_active = true
      and (
        member.role <> 'sales'
        or (
          employee.id = p_salesperson_employee_id
          and p_created_by = member.user_id
          and exists (
            select 1
            from public.customers as customer
            where customer.id = p_customer_id
              and (
                (
                  customer.created_by = member.user_id
                  and not exists (
                    select 1
                    from public.cases as any_case
                    where any_case.customer_id = customer.id
                  )
                )
                or exists (
                  select 1
                  from public.cases as existing_case
                  where existing_case.customer_id = customer.id
                    and existing_case.salesperson_employee_id = employee.id
                )
              )
          )
        )
      )
  );
$$;

create or replace function private.can_access_crm_customer(
  p_customer_id uuid,
  p_created_by uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.crm_members as member
    left join public.crm_employees as employee
      on employee.member_user_id = member.user_id
     and employee.status = 'active'
    where member.user_id = (select auth.uid())
      and member.is_active = true
      and (
        member.role <> 'sales'
        or exists (
          select 1
          from public.cases as crm_case
          where crm_case.customer_id = p_customer_id
            and crm_case.salesperson_employee_id = employee.id
        )
        or (
          p_created_by = member.user_id
          and not exists (
            select 1
            from public.cases as any_case
            where any_case.customer_id = p_customer_id
          )
        )
      )
  );
$$;

create or replace function private.can_delete_crm_records()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.crm_members as member
    where member.user_id = (select auth.uid())
      and member.is_active = true
      and member.role in ('admin', 'manager')
  );
$$;

create or replace function private.rollback_new_crm_case(p_case_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  deleted_case_id uuid;
begin
  delete from public.cases as crm_case
  where crm_case.id = p_case_id
    and crm_case.created_by = (select auth.uid())
    and crm_case.created_at >= pg_catalog.now() - interval '10 minutes'
    and exists (
      select 1
      from public.crm_members as member
      where member.user_id = (select auth.uid())
        and member.is_active = true
    )
    and not exists (
      select 1
      from public.lead_follow_up_history as history
      where history.case_id = crm_case.id
    )
  returning crm_case.id into deleted_case_id;

  return deleted_case_id is not null;
end;
$$;

revoke all on function private.rollback_new_crm_case(uuid)
from public, anon, authenticated;
grant execute on function private.rollback_new_crm_case(uuid)
to authenticated;

create or replace function public.rollback_new_crm_case(p_case_id uuid)
returns boolean
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.rollback_new_crm_case(p_case_id);
$$;

revoke all on function public.rollback_new_crm_case(uuid)
from public, anon, authenticated;
grant execute on function public.rollback_new_crm_case(uuid)
to authenticated;

revoke all on function private.can_access_crm_case(uuid)
from public, anon, authenticated;
revoke all on function private.can_access_crm_case_id(uuid)
from public, anon, authenticated;
revoke all on function private.can_create_crm_case(uuid, uuid, uuid)
from public, anon, authenticated;
revoke all on function private.can_access_crm_customer(uuid, uuid)
from public, anon, authenticated;
revoke all on function private.can_delete_crm_records()
from public, anon, authenticated;

grant execute on function private.can_access_crm_case(uuid)
to authenticated;
grant execute on function private.can_access_crm_case_id(uuid)
to authenticated;
grant execute on function private.can_create_crm_case(uuid, uuid, uuid)
to authenticated;
grant execute on function private.can_access_crm_customer(uuid, uuid)
to authenticated;
grant execute on function private.can_delete_crm_records()
to authenticated;

drop policy if exists "active members can read crm directory" on public.crm_members;
drop policy if exists "members can view their own membership" on public.crm_members;

create policy "members can view their own membership"
on public.crm_members
for select
to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists "active members can read cases" on public.cases;
drop policy if exists "active members can create cases" on public.cases;
drop policy if exists "active members can update cases" on public.cases;
drop policy if exists "active members can delete cases" on public.cases;

create policy "members can read accessible cases"
on public.cases
for select
to authenticated
using ((select private.can_access_crm_case(salesperson_employee_id)));

create policy "members can create accessible cases"
on public.cases
for insert
to authenticated
with check ((select private.can_create_crm_case(
  salesperson_employee_id,
  customer_id,
  created_by
)));

create policy "members can update accessible cases"
on public.cases
for update
to authenticated
using ((select private.can_access_crm_case(salesperson_employee_id)))
with check ((select private.can_access_crm_case(salesperson_employee_id)));

create policy "managers can delete cases"
on public.cases
for delete
to authenticated
using ((select private.can_delete_crm_records()));

drop policy if exists "active members can read customers" on public.customers;
drop policy if exists "active members can create customers" on public.customers;
drop policy if exists "active members can update customers" on public.customers;
drop policy if exists "active members can delete customers" on public.customers;

create policy "members can read accessible customers"
on public.customers
for select
to authenticated
using ((select private.can_access_crm_customer(id, created_by)));

create policy "members can create accessible customers"
on public.customers
for insert
to authenticated
with check ((select private.can_access_crm_customer(id, created_by)));

create policy "members can update accessible customers"
on public.customers
for update
to authenticated
using ((select private.can_access_crm_customer(id, created_by)))
with check ((select private.can_access_crm_customer(id, created_by)));

create policy "managers can delete customers"
on public.customers
for delete
to authenticated
using ((select private.can_delete_crm_records()));

drop policy if exists "active members can read lead follow-up history"
on public.lead_follow_up_history;
drop policy if exists "active members can create lead follow-up history"
on public.lead_follow_up_history;
drop policy if exists "active members can update lead follow-up history"
on public.lead_follow_up_history;
drop policy if exists "active members can delete lead follow-up history"
on public.lead_follow_up_history;

create policy "members can read accessible lead follow-up history"
on public.lead_follow_up_history
for select
to authenticated
using ((select private.can_access_crm_case_id(case_id)));

create policy "members can create accessible lead follow-up history"
on public.lead_follow_up_history
for insert
to authenticated
with check ((select private.can_access_crm_case_id(case_id)));

create policy "members can update accessible lead follow-up history"
on public.lead_follow_up_history
for update
to authenticated
using ((select private.can_access_crm_case_id(case_id)))
with check ((select private.can_access_crm_case_id(case_id)));

create policy "managers can delete lead follow-up history"
on public.lead_follow_up_history
for delete
to authenticated
using ((select private.can_delete_crm_records()));

revoke all privileges on table public.crm_members from anon, authenticated;
revoke all privileges on table public.crm_employees from anon, authenticated;
revoke all privileges on table public.customers from anon, authenticated;
revoke all privileges on table public.cases from anon, authenticated;
revoke all privileges on table public.lead_follow_up_history from anon, authenticated;

grant select on table public.crm_members to authenticated;
grant select, insert, update, delete on table public.crm_employees to authenticated;
grant select, insert, update, delete on table public.customers to authenticated;
grant select, insert, update, delete on table public.cases to authenticated;
grant select, insert, update, delete on table public.lead_follow_up_history to authenticated;

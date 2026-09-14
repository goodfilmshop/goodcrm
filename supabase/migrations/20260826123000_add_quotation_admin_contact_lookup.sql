-- A quotation may show the case admin's public business contact.
-- The lookup is scoped to one accessible case; it is not an employee directory API.

create or replace function private.get_case_admin_contact(p_case_id uuid)
returns table (
  full_name text,
  phone text
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    nullif(pg_catalog.btrim(employee.full_name), '') as full_name,
    pg_catalog.btrim(coalesce(employee.phone, '')) as phone
  from public.cases as crm_case
  join public.crm_employees as employee
    on nullif(pg_catalog.btrim(crm_case.admin_name), '') is not null
   and pg_catalog.lower(pg_catalog.btrim(employee.nickname)) =
       pg_catalog.lower(pg_catalog.btrim(crm_case.admin_name))
  join public.crm_members as membership
    on membership.user_id = (select auth.uid())
   and membership.is_active = true
  where crm_case.id = p_case_id
    and employee.status = 'active'
    and (
      membership.role <> 'sales'
      or employee.member_user_id = (select auth.uid())
    )
  limit 1;
$$;

revoke all on function private.get_case_admin_contact(uuid)
from public, anon, authenticated;
grant execute on function private.get_case_admin_contact(uuid)
to authenticated;

create or replace function public.get_case_admin_contact(p_case_id uuid)
returns table (
  full_name text,
  phone text
)
language sql
stable
security invoker
set search_path = ''
as $$
  select contact.full_name, contact.phone
  from private.get_case_admin_contact(p_case_id) as contact;
$$;

revoke all on function public.get_case_admin_contact(uuid)
from public, anon, authenticated;
grant execute on function public.get_case_admin_contact(uuid)
to authenticated;

-- Assignment dropdowns must use the employee master data, while employee
-- contact and login details remain visible only to CRM administrators.

create index if not exists crm_employees_active_position_name_idx
on public.crm_employees (
  lower(regexp_replace(btrim(coalesce(position, '')), '\s+', ' ', 'g')),
  lower(btrim(nickname))
)
where status = 'active' and btrim(nickname) <> '';

-- This function needs SECURITY DEFINER only to read the admin-only employee
-- table. Keep it outside the Data API's exposed public schema and authorize
-- the caller by their active CRM membership before returning limited fields.
create or replace function private.list_crm_employees_by_position(p_position text)
returns table (
  name text,
  "position" text
)
language sql
stable
security definer
set search_path = ''
as $$
  select distinct on (pg_catalog.lower(pg_catalog.btrim(employee.nickname)))
    pg_catalog.btrim(employee.nickname) as name,
    pg_catalog.btrim(employee.position) as position
  from public.crm_employees as employee
  where employee.status = 'active'
    and pg_catalog.btrim(employee.nickname) <> ''
    and pg_catalog.lower(
      pg_catalog.regexp_replace(
        pg_catalog.btrim(coalesce(employee.position, '')),
        '\s+',
        ' ',
        'g'
      )
    ) = pg_catalog.lower(
      pg_catalog.regexp_replace(
        pg_catalog.btrim(coalesce(nullif(p_position, ''), 'Admin Sale')),
        '\s+',
        ' ',
        'g'
      )
    )
    and exists (
      select 1
      from public.crm_members as member
      where member.user_id = (select auth.uid())
        and member.is_active = true
    )
  order by
    pg_catalog.lower(pg_catalog.btrim(employee.nickname)),
    pg_catalog.btrim(employee.nickname);
$$;

revoke all on function private.list_crm_employees_by_position(text) from public, anon, authenticated;
grant execute on function private.list_crm_employees_by_position(text) to authenticated;

-- PostgREST exposes this narrow invoker wrapper through supabase-js RPC.
create or replace function public.list_crm_employees_by_position(p_position text default 'Admin Sale')
returns table (
  name text,
  "position" text
)
language sql
stable
security invoker
set search_path = ''
as $$
  select directory.name, directory."position"
  from private.list_crm_employees_by_position(p_position) as directory;
$$;

revoke all on function public.list_crm_employees_by_position(text) from public, anon, authenticated;
grant execute on function public.list_crm_employees_by_position(text) to authenticated;

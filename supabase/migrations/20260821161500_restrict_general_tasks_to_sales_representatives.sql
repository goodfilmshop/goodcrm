-- Keep task assignment and visibility aligned with the active Sales Representative directory.

create or replace function private.can_access_general_task(p_assigned_employee_id uuid)
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
     and employee.position = 'Sales Representative'
    where member.user_id = (select auth.uid())
      and member.is_active = true
      and (
        member.role in ('admin', 'manager')
        or (member.role = 'sales' and employee.id = p_assigned_employee_id)
      )
  );
$$;

create or replace function private.sync_general_task_assignee()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  matched_employee_id uuid;
begin
  if tg_op = 'UPDATE'
    and new.assigned_to is not distinct from old.assigned_to
    and new.assigned_employee_id is not distinct from old.assigned_employee_id then
    return new;
  end if;

  if tg_op = 'UPDATE'
    and new.assigned_employee_id is not null
    and exists (
      select 1
      from public.crm_employees as employee
      where employee.id = new.assigned_employee_id
        and employee.status = 'active'
        and employee.position = 'Sales Representative'
        and pg_catalog.lower(pg_catalog.btrim(employee.nickname)) =
            pg_catalog.lower(pg_catalog.btrim(new.assigned_to))
    ) then
    return new;
  end if;

  select employee.id
  into matched_employee_id
  from public.crm_employees as employee
  where employee.status = 'active'
    and employee.position = 'Sales Representative'
    and pg_catalog.lower(pg_catalog.btrim(employee.nickname)) =
        pg_catalog.lower(pg_catalog.btrim(new.assigned_to))
  limit 1;

  if matched_employee_id is null then
    raise exception 'Unknown active CRM salesperson nickname: %', new.assigned_to
      using errcode = '23503';
  end if;

  new.assigned_employee_id := matched_employee_id;
  new.assigned_to := pg_catalog.btrim(new.assigned_to);
  return new;
end;
$$;

revoke all on function private.can_access_general_task(uuid) from public, anon, authenticated;
revoke all on function private.sync_general_task_assignee() from public, anon, authenticated;
grant execute on function private.can_access_general_task(uuid) to authenticated;

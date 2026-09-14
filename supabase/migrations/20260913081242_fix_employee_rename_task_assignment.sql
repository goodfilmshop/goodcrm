-- Renaming an employee refreshes a task's display snapshot; it is not reassignment.
-- Preserve the authoritative assignee ID even after a position/status change.
-- New assignments still require an active Sales Representative.
create or replace function private.sync_general_task_assignee()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  matched_employee_id uuid;
begin
  new.assigned_to := nullif(pg_catalog.btrim(coalesce(new.assigned_to, '')), '');

  if new.assigned_to is null then
    new.assigned_employee_id := null;
    return new;
  end if;

  if tg_op = 'UPDATE'
    and new.assigned_employee_id is not null
    and new.assigned_employee_id is not distinct from old.assigned_employee_id
    and exists (
      select 1
      from public.crm_employees as employee
      where employee.id = new.assigned_employee_id
        and pg_catalog.lower(pg_catalog.btrim(employee.nickname)) =
            pg_catalog.lower(new.assigned_to)
    ) then
    return new;
  end if;

  select employee.id
  into matched_employee_id
  from public.crm_employees as employee
  where employee.status = 'active'
    and employee.position = 'Sales Representative'
    and pg_catalog.lower(pg_catalog.btrim(employee.nickname)) =
        pg_catalog.lower(new.assigned_to)
  limit 1;

  if matched_employee_id is null then
    raise exception 'Unknown active CRM salesperson nickname: %', new.assigned_to
      using errcode = '23503';
  end if;

  new.assigned_employee_id := matched_employee_id;
  return new;
end;
$$;

-- Trigger-only function: never expose it as an RPC or widen table privileges.
revoke all on function private.sync_general_task_assignee()
from public, anon, authenticated;

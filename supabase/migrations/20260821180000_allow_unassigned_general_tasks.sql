-- General tasks may be queued before a sales representative is selected.
-- Managers keep full access; sales users can only see tasks assigned to them.

alter table public.general_tasks
  alter column assigned_to drop not null,
  alter column assigned_employee_id drop not null;

comment on column public.general_tasks.assigned_to is
  'Optional employee nickname snapshot for display; assigned_employee_id is authoritative when a task is assigned.';

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
    and exists (
      select 1
      from public.crm_employees as employee
      where employee.id = new.assigned_employee_id
        and employee.status = 'active'
        and employee.position = 'Sales Representative'
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

revoke all on function private.sync_general_task_assignee() from public, anon, authenticated;

-- General work items are intentionally separate from CRM cases.
-- They keep a durable completion history while task assignees only see their own work.

create table public.general_tasks (
  id uuid primary key default gen_random_uuid(),
  title text not null check (pg_catalog.btrim(title) <> ''),
  description text,
  due_at timestamptz,
  assigned_to text not null check (pg_catalog.btrim(assigned_to) <> ''),
  assigned_employee_id uuid not null references public.crm_employees(id) on delete restrict,
  status text not null default 'pending' check (status in ('pending', 'completed', 'cancelled')),
  completion_note text,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null
);

comment on table public.general_tasks is
  'One-off internal tasks not linked to a CRM case. Completed and cancelled rows are retained as task history.';

comment on column public.general_tasks.assigned_to is
  'Employee nickname snapshot for display; assigned_employee_id is authoritative for access control.';

create index general_tasks_assignee_status_due_idx
on public.general_tasks (assigned_employee_id, status, due_at asc nulls last);

create index general_tasks_status_due_idx
on public.general_tasks (status, due_at asc nulls last);

create or replace function private.can_manage_general_tasks()
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

create or replace function private.sync_employee_general_task_assignee_name()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.nickname is distinct from old.nickname then
    update public.general_tasks as task
    set assigned_to = pg_catalog.btrim(new.nickname)
    where task.assigned_employee_id = new.id;
  end if;
  return new;
end;
$$;

create or replace function private.protect_sales_general_task_changes()
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
  ) then
    if new.title is distinct from old.title
      or new.description is distinct from old.description
      or new.due_at is distinct from old.due_at
      or new.assigned_to is distinct from old.assigned_to
      or new.assigned_employee_id is distinct from old.assigned_employee_id
      or new.created_by is distinct from old.created_by
      or new.updated_by is distinct from (select auth.uid())
      or new.status not in ('pending', 'completed') then
      raise exception 'Sales users can only update the completion of their assigned tasks.'
        using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

create or replace function private.set_general_task_completed_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status = 'completed' and (tg_op = 'INSERT' or old.status is distinct from 'completed') then
    new.completed_at := now();
  elsif new.status <> 'completed' then
    new.completed_at := null;
  end if;
  return new;
end;
$$;

revoke all on function private.can_manage_general_tasks() from public, anon, authenticated;
revoke all on function private.can_access_general_task(uuid) from public, anon, authenticated;
revoke all on function private.sync_general_task_assignee() from public, anon, authenticated;
revoke all on function private.sync_employee_general_task_assignee_name() from public, anon, authenticated;
revoke all on function private.protect_sales_general_task_changes() from public, anon, authenticated;
revoke all on function private.set_general_task_completed_at() from public, anon, authenticated;
grant execute on function private.can_manage_general_tasks() to authenticated;
grant execute on function private.can_access_general_task(uuid) to authenticated;

create trigger general_tasks_sync_assignee
before insert or update of assigned_to, assigned_employee_id on public.general_tasks
for each row execute function private.sync_general_task_assignee();

create trigger general_tasks_protect_sales_changes
before update on public.general_tasks
for each row execute function private.protect_sales_general_task_changes();

create trigger general_tasks_set_completed_at
before insert or update of status on public.general_tasks
for each row execute function private.set_general_task_completed_at();

create trigger general_tasks_set_updated_at
before update on public.general_tasks
for each row execute function private.set_updated_at();

create trigger crm_employees_sync_general_task_assignee_name
after update of nickname on public.crm_employees
for each row execute function private.sync_employee_general_task_assignee_name();

alter table public.general_tasks enable row level security;

grant select, insert, update, delete on table public.general_tasks to authenticated;

create policy "members can read accessible general tasks"
on public.general_tasks
for select
to authenticated
using ((select private.can_access_general_task(assigned_employee_id)));

create policy "managers can create general tasks"
on public.general_tasks
for insert
to authenticated
with check ((select private.can_manage_general_tasks()));

create policy "members can update accessible general tasks"
on public.general_tasks
for update
to authenticated
using ((select private.can_access_general_task(assigned_employee_id)))
with check ((select private.can_access_general_task(assigned_employee_id)));

create policy "managers can delete general tasks"
on public.general_tasks
for delete
to authenticated
using ((select private.can_manage_general_tasks()));

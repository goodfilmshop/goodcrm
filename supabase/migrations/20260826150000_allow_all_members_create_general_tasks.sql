-- Every active CRM role can record a new general task.
-- Management retains edit/delete control; creators can read their own task.

create or replace function private.can_create_general_task()
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
      and member.role in ('admin', 'manager', 'sales', 'member')
  );
$$;

create or replace function private.can_read_general_task(
  p_assigned_employee_id uuid,
  p_created_by uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    (select private.can_access_general_task(p_assigned_employee_id))
    or exists (
      select 1
      from public.crm_members as member
      where member.user_id = (select auth.uid())
        and member.user_id = p_created_by
        and member.is_active = true
        and member.role in ('admin', 'manager', 'sales', 'member')
    );
$$;

revoke all on function private.can_create_general_task() from public, anon, authenticated;
revoke all on function private.can_read_general_task(uuid, uuid) from public, anon, authenticated;
grant execute on function private.can_create_general_task() to authenticated;
grant execute on function private.can_read_general_task(uuid, uuid) to authenticated;

create index if not exists general_tasks_created_by_idx
on public.general_tasks (created_by);

drop policy if exists "members can read accessible general tasks" on public.general_tasks;
create policy "members can read accessible general tasks"
on public.general_tasks
for select
to authenticated
using ((select private.can_read_general_task(assigned_employee_id, created_by)));

drop policy if exists "managers can create general tasks" on public.general_tasks;
create policy "members can create general tasks"
on public.general_tasks
for insert
to authenticated
with check (
  (select private.can_create_general_task())
  and created_by = (select auth.uid())
  and (updated_by is null or updated_by = (select auth.uid()))
);

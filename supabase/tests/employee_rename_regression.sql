-- Run this entire file in one connection. All fixtures are rolled back.
begin;
select set_config('request.jwt.claim.sub',
  (select user_id::text from public.crm_members where is_active and role = 'admin' limit 1),
  true);
set local role authenticated;

do $test$
declare
  employee_a uuid := gen_random_uuid();
  employee_b uuid := gen_random_uuid();
  task_id uuid := gen_random_uuid();
  unassigned_task_id uuid := gen_random_uuid();
  name_a text := '__rename_a_' || employee_a::text;
  name_b text := '__rename_b_' || employee_b::text;
  renamed_a text := '__project_' || employee_a::text;
  inactive_a text := '__inactive_' || employee_a::text;
  rejected boolean;
begin
  if auth.uid() is null or not private.is_crm_admin() then
    raise exception 'Regression test requires an active CRM administrator';
  end if;

  insert into public.crm_employees (id, employee_code, nickname, position)
  values
    (employee_a, '__test_a_' || employee_a::text, name_a, 'Sales Representative'),
    (employee_b, '__test_b_' || employee_b::text, name_b, 'Sales Representative');

  insert into public.general_tasks
    (id, title, assigned_to, assigned_employee_id, created_by, updated_by)
  values (task_id, 'Employee rename regression fixture', name_a, employee_a, auth.uid(), auth.uid());

  -- A simultaneous rename and position change must preserve the existing assignment.
  update public.crm_employees
  set nickname = renamed_a, full_name = 'Rename regression', position = 'Sales Project Executive'
  where id = employee_a;
  if not exists (
    select 1 from public.general_tasks
    where id = task_id and assigned_employee_id = employee_a and assigned_to = renamed_a
  ) then
    raise exception 'Position-change rename did not preserve the assigned employee';
  end if;

  -- Historical task snapshots remain correct when an employee becomes inactive.
  update public.crm_employees set status = 'inactive', nickname = inactive_a where id = employee_a;
  if not exists (
    select 1 from public.general_tasks
    where id = task_id and assigned_employee_id = employee_a and assigned_to = inactive_a
  ) then
    raise exception 'Inactive employee rename did not refresh the task snapshot';
  end if;

  -- An explicit no-op assignment update must not treat an old task as new work.
  update public.general_tasks
  set assigned_to = inactive_a, assigned_employee_id = employee_a
  where id = task_id;

  -- New task assignment to the ineligible employee is still rejected.
  rejected := false;
  begin
    insert into public.general_tasks
      (title, assigned_to, assigned_employee_id, created_by, updated_by)
    values ('Rejected new assignment fixture', inactive_a, employee_a, auth.uid(), auth.uid());
  exception when foreign_key_violation then
    rejected := true;
  end;
  if not rejected then raise exception 'New ineligible assignment was accepted'; end if;

  insert into public.general_tasks (id, title, created_by, updated_by)
  values (unassigned_task_id, 'Unassigned regression fixture', auth.uid(), auth.uid());

  rejected := false;
  begin
    update public.general_tasks
    set assigned_to = inactive_a, assigned_employee_id = employee_a
    where id = unassigned_task_id;
  exception when foreign_key_violation then
    rejected := true;
  end;
  if not rejected then raise exception 'Reassignment to an ineligible employee was accepted'; end if;

  -- Eligible reassignment still works and changes the actual employee ID.
  update public.general_tasks
  set assigned_to = name_b, assigned_employee_id = employee_b
  where id = task_id;
  if not exists (
    select 1 from public.general_tasks
    where id = task_id and assigned_employee_id = employee_b and assigned_to = name_b
  ) then
    raise exception 'Eligible reassignment failed';
  end if;

  -- Clearing an assignment keeps both columns aligned.
  update public.general_tasks set assigned_to = '' where id = task_id;
  if not exists (
    select 1 from public.general_tasks
    where id = task_id and assigned_employee_id is null and assigned_to is null
  ) then
    raise exception 'Unassigning did not clear both assignee columns';
  end if;
end;
$test$;
reset role;
select 'passed' as employee_rename_regression;
rollback;

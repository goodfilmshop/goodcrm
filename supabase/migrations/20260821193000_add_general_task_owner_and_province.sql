-- Keep general-task location data alongside the queue fields used for display.
alter table public.general_tasks
  add column if not exists province text,
  add column if not exists task_owner text;

comment on column public.general_tasks.province is
  'Optional province for a general task location.';

comment on column public.general_tasks.task_owner is
  'Optional person responsible for owning a general task; distinct from the assigned salesperson.';

-- Sales users can complete their assigned work, but cannot change task details.
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
      or new.contact_name is distinct from old.contact_name
      or new.contact_phone is distinct from old.contact_phone
      or new.site_address is distinct from old.site_address
      or new.location_url is distinct from old.location_url
      or new.province is distinct from old.province
      or new.task_owner is distinct from old.task_owner
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

revoke all on function private.protect_sales_general_task_changes() from public, anon, authenticated;

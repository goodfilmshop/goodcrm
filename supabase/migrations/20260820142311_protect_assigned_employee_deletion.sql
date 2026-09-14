-- Preserve case assignments and require reassignment before employee deletion.
alter table public.cases
  drop constraint if exists cases_salesperson_employee_id_fkey;

alter table public.cases
  add constraint cases_salesperson_employee_id_fkey
  foreign key (salesperson_employee_id)
  references public.crm_employees(id)
  on delete restrict;

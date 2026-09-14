-- Every customer must have a stable creation timestamp for sorting and display.
-- Existing imported rows keep their original created_at value.
update public.customers
set recorded_at = created_at
where recorded_at is null;

alter table public.customers
  alter column recorded_at set default now(),
  alter column recorded_at set not null;

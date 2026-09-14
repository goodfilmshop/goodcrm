-- Show only the creator name for one customer already accessible to the caller.
-- Do not expose the restricted membership or employee directory.
create or replace function private.get_customer_creator(p_customer_id uuid)
returns table (display_name text)
language sql
stable
security definer
set search_path = ''
as $$
  select nullif(pg_catalog.btrim(creator.display_name), '') as display_name
  from public.customers as customer
  join public.crm_members as creator on creator.user_id = customer.created_by
  join public.crm_members as caller
    on caller.user_id = (select auth.uid())
   and caller.is_active = true
  where customer.id = p_customer_id
    and (select auth.uid()) is not null
    and private.can_access_crm_customer(customer.id, customer.created_by);
$$;

revoke all on function private.get_customer_creator(uuid)
from public, anon, authenticated;
grant execute on function private.get_customer_creator(uuid) to authenticated;

create or replace function public.get_customer_creator(p_customer_id uuid)
returns table (display_name text)
language sql
stable
security invoker
set search_path = ''
as $$
  select creator.display_name
  from private.get_customer_creator(p_customer_id) as creator;
$$;

revoke all on function public.get_customer_creator(uuid)
from public, anon, authenticated;
grant execute on function public.get_customer_creator(uuid) to authenticated;

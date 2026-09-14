-- Run in one connection. The disposable customer and all changes are rolled back.
begin;
select set_config('request.jwt.claim.sub',
  (select user_id::text from public.crm_members where is_active and role = 'admin' limit 1), true);
set local role authenticated;
do $test$
declare
  customer_id uuid := gen_random_uuid();
  rejected boolean := false;
begin
  if auth.uid() is null or not private.is_crm_admin() then
    raise exception 'Regression test requires an active CRM administrator';
  end if;
  insert into public.customers (id, legacy_cust_id, customer_name, created_by, updated_by)
  values (customer_id, '__chat_link_test_' || customer_id::text, 'Customer chat regression', auth.uid(), auth.uid());
  if not exists (select 1 from public.customers where id = customer_id and chat_link is null) then
    raise exception 'Omitting the optional link did not store NULL';
  end if;
  update public.customers set chat_link = 'https://m.me/customer?ref=a&other=b' where id = customer_id;
  if not exists (select 1 from public.customers where id = customer_id and chat_link = 'https://m.me/customer?ref=a&other=b') then
    raise exception 'Customer chat link update/read failed';
  end if;
  begin
    update public.customers set chat_link = 'javascript:alert(1)' where id = customer_id;
  exception when check_violation then rejected := true;
  end;
  if not rejected then raise exception 'Unsafe link was accepted'; end if;
  update public.customers set chat_link = null where id = customer_id;
  if not exists (select 1 from public.customers where id = customer_id and chat_link is null) then
    raise exception 'Clearing the optional link failed';
  end if;
end;
$test$;
reset role;
select 'passed' as customer_chat_link_regression;
rollback;

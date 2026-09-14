-- Synthetic intake/customer fixtures run as the application role and are rolled back.
begin;
select set_config('request.jwt.claim.sub',
  (select user_id::text from public.crm_members where is_active and role='admin' limit 1), true);
select set_config('line_intake.test_admin', auth.uid()::text, true);
do $fixtures$
declare kind text; fixture uuid; existing uuid := gen_random_uuid();
begin
  if auth.uid() is null then raise exception 'Active CRM admin required'; end if;
  foreach kind in array array['create','link','dismiss','invalid'] loop
    fixture := gen_random_uuid();
    perform set_config('line_intake.test_' || kind, fixture::text, true);
    insert into public.line_intake_contacts(id,account_key,line_user_id,display_name,first_seen_at,last_seen_at)
    values(fixture,'mhl-line-320opqkc','U' || replace(gen_random_uuid()::text,'-',''),
      'Synthetic profile',now(),now());
  end loop;
  insert into public.customers(id,legacy_cust_id,customer_name,contact_channel,contact_handle,remarks)
  values(existing,'CUST-LINE-TEST-' || existing::text,'Synthetic existing customer','LINE',
    'Existing handle','Existing custom note');
  perform set_config('line_intake.test_existing', existing::text, true);
end;
$fixtures$;
set local role authenticated;
do $test$
declare
  create_id uuid := current_setting('line_intake.test_create')::uuid;
  link_id uuid := current_setting('line_intake.test_link')::uuid;
  dismiss_id uuid := current_setting('line_intake.test_dismiss')::uuid;
  invalid_id uuid := current_setting('line_intake.test_invalid')::uuid;
  existing_id uuid := current_setting('line_intake.test_existing')::uuid;
  entered_name text := '__LINE_default_' || create_id::text || ' ไทย OiLY①④⑥';
  original_user text; result jsonb; customer public.customers; contact public.line_intake_contacts;
  rejected boolean := false;
begin
  select line_user_id into original_user from public.line_intake_contacts where id=create_id;
  result := public.resolve_line_intake(create_id,'create','  ' || entered_name || '  ','');
  select * into customer from public.customers where legacy_cust_id=result->>'customerId';
  if customer.legacy_cust_id !~ '^CUST-[0-9]{6}-[0-9A-F]{3}$'
    or split_part(customer.legacy_cust_id,'-',2) <> to_char(now() at time zone 'Asia/Bangkok','YYMMDD') then
    raise exception 'LINE customer ID differs from normal CRM format';
  end if;
  if customer.id is null or customer.customer_name <> entered_name
    or customer.contact_handle <> customer.customer_name
    or customer.contact_channel <> 'LINE'
    or customer.remarks <> 'MHL LINE OA @320opqkc / @mhl1' then
    raise exception 'New customer defaults do not match';
  end if;
  select * into contact from public.line_intake_contacts where id=create_id;
  if contact.status <> 'imported' or contact.customer_id <> customer.id
    or contact.line_user_id <> original_user then raise exception 'Stable LINE identity/link lost'; end if;
  result := public.resolve_line_intake(create_id,'create','Changed name','');
  if result->>'alreadyResolved' <> 'true'
    or (select count(*) from public.customers where customer_name=entered_name) <> 1 then
    raise exception 'Repeated import created or changed a customer';
  end if;
  select * into customer from public.customers where id=existing_id;
  result := public.resolve_line_intake(link_id,'link','Ignored',customer.legacy_cust_id);
  select * into customer from public.customers where id=existing_id;
  if customer.contact_handle <> 'Existing handle' or customer.remarks <> 'Existing custom note'
    or result->>'customerId' <> customer.legacy_cust_id then raise exception 'Existing customer was overwritten'; end if;
  result := public.resolve_line_intake(dismiss_id,'dismiss','','');
  select * into contact from public.line_intake_contacts where id=dismiss_id;
  if contact.status <> 'dismissed' or contact.customer_id is not null then raise exception 'Dismiss failed'; end if;
  begin
    perform public.resolve_line_intake(invalid_id,'create','   ','');
  exception when others then rejected := true;
  end;
  if not rejected then raise exception 'Blank customer name accepted'; end if;
  rejected := false;
  perform set_config('request.jwt.claim.sub','',true);
  begin
    perform public.resolve_line_intake(invalid_id,'create','Unauthorized','');
  exception when others then rejected := true;
  end;
  perform set_config('request.jwt.claim.sub',current_setting('line_intake.test_admin'),true);
  if not rejected then raise exception 'Unauthorized import accepted'; end if;
end;
$test$;
select 'PASS: name/handle, OA note, stable ID, retry, link, dismiss, validation and permissions' as result;
rollback;

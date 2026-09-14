-- Two GFS accounts and one MHL account; existing per-account deduplication and admin permissions retained.
set local lock_timeout='5s';
alter table public.line_intake_contacts drop constraint line_intake_contacts_account_key_check, add constraint line_intake_contacts_account_key_check check(account_key in ('gfs-line-249izgyn','gfs-line-095jvuls','mhl-line-320opqkc'));
create or replace function public.receive_line_intake(p_account text, p_events jsonb)
returns void language plpgsql security invoker set search_path = '' as $$
declare e jsonb; cid uuid; happened timestamptz; inserted integer;
begin
  if p_account is null or p_account not in ('gfs-line-249izgyn','gfs-line-095jvuls','mhl-line-320opqkc') or jsonb_typeof(p_events) <> 'array' then raise exception 'Invalid intake'; end if;
  for e in select value from jsonb_array_elements(p_events) loop
    insert into public.line_intake_events values (p_account, e->>'eventId') on conflict do nothing;
    get diagnostics inserted = row_count;
    if inserted = 0 then continue; end if;
    happened := (e->>'at')::timestamptz;
    insert into public.line_intake_contacts(account_key, line_user_id, first_seen_at, last_seen_at)
    values (p_account, e->>'userId', happened, happened)
    on conflict (account_key, line_user_id) do update
    set first_seen_at = least(line_intake_contacts.first_seen_at, excluded.first_seen_at),
        last_seen_at = greatest(line_intake_contacts.last_seen_at, excluded.last_seen_at)
    returning id into cid;
    insert into public.line_intake_days values(cid, (happened at time zone 'Asia/Bangkok')::date) on conflict do nothing;
  end loop;
end;
$$;
revoke all on function public.receive_line_intake(text,jsonb) from public, anon, authenticated;
grant execute on function public.receive_line_intake(text,jsonb) to service_role;


-- New LINE imports use the entered customer name as the visible contact handle.
-- Keep stable LINE user IDs in line_intake_contacts; existing customers are not changed.
create or replace function public.resolve_line_intake(p_id uuid, p_decision text, p_name text, p_customer text)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare item public.line_intake_contacts; cid uuid; legacy text; attempt integer;
begin
  if not exists(select 1 from public.crm_members where user_id=auth.uid() and is_active and role='admin') then raise exception 'Forbidden'; end if;
  select * into item from public.line_intake_contacts where id=p_id for update;
  if not found then raise exception 'Not found'; end if;
  if item.status <> 'pending' then return jsonb_build_object('alreadyResolved',true,'status',item.status); end if;
  if p_decision='dismiss' then
    update public.line_intake_contacts set status='dismissed',resolved_at=now(),resolved_by=auth.uid() where id=p_id;
    return jsonb_build_object('status','dismissed');
  elsif p_decision='link' then
    select id,legacy_cust_id into cid,legacy from public.customers where legacy_cust_id=p_customer;
    if not found then raise exception 'Customer not found'; end if;
  elsif p_decision='create' then
    if length(trim(p_name))=0 or length(p_name)>200 then raise exception 'Name required'; end if;
    -- Match server.js newLegacyId: Bangkok YYMMDD and three uppercase hex digits.
    for attempt in 1..5 loop
      legacy := 'CUST-' || to_char(now() at time zone 'Asia/Bangkok','YYMMDD')
        || '-' || upper(substr(replace(gen_random_uuid()::text,'-',''),1,3));
      insert into public.customers(legacy_cust_id,customer_name,recorded_at,contact_channel,contact_handle,remarks,created_by,updated_by)
      values(legacy,trim(p_name),now(),'LINE',trim(p_name),case item.account_key when 'mhl-line-320opqkc' then 'MHL LINE OA @320opqkc / @mhl1' when 'gfs-line-095jvuls' then 'GFS LINE OA @095jvuls / @goodfilm' else 'GFS LINE OA @249izgyn / @3mfilm' end,auth.uid(),auth.uid())
      on conflict (legacy_cust_id) do nothing returning id into cid;
      exit when cid is not null;
    end loop;
    if cid is null then raise exception 'Unable to allocate customer ID; please retry'; end if;
  else raise exception 'Invalid decision';
  end if;
  update public.line_intake_contacts set status='imported',customer_id=cid,resolved_at=now(),resolved_by=auth.uid() where id=p_id;
  return jsonb_build_object('status','imported','customerId',legacy);
end;
$$;
revoke all on function public.resolve_line_intake(uuid,text,text,text) from public, anon;
grant execute on function public.resolve_line_intake(uuid,text,text,text) to authenticated;

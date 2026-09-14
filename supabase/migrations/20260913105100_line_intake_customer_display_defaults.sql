-- New LINE imports use the entered customer name as the visible contact handle.
-- Keep stable LINE user IDs in line_intake_contacts; existing customers are not changed.
create or replace function public.resolve_line_intake(p_id uuid, p_decision text, p_name text, p_customer text)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare item public.line_intake_contacts; cid uuid; legacy text;
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
    legacy := 'CUST-LINE-' || replace(gen_random_uuid()::text,'-','');
    insert into public.customers(legacy_cust_id,customer_name,recorded_at,contact_channel,contact_handle,remarks,created_by,updated_by)
    values(legacy,trim(p_name),now(),'LINE',trim(p_name),'GFS LINE OA @249izgyn / @3mfilm',auth.uid(),auth.uid()) returning id into cid;
  else raise exception 'Invalid decision';
  end if;
  update public.line_intake_contacts set status='imported',customer_id=cid,resolved_at=now(),resolved_by=auth.uid() where id=p_id;
  return jsonb_build_object('status','imported','customerId',legacy);
end;
$$;
revoke all on function public.resolve_line_intake(uuid,text,text,text) from public, anon;
grant execute on function public.resolve_line_intake(uuid,text,text,text) to authenticated;

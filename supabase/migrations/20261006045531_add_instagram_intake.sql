-- Instagram intake: isolated from LINE, metadata only, manual promotion.
create table public.instagram_intake_contacts (
  id uuid primary key default gen_random_uuid(),
  account_key text not null check (account_key in ('gfs-ig-17841402497215021','mhl-ig-17841421260722221','car-ig-17841458662245781')),
  instagram_user_id text not null check (instagram_user_id ~ '^[0-9]{5,30}$'),
  display_name text check (length(display_name)<=200),
  username text check (length(username)<=100),
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null,
  status text not null default 'pending' check (status in ('pending','imported','dismissed')),
  customer_id uuid references public.customers(id) on delete set null,
  resolved_at timestamptz,
  resolved_by uuid references auth.users(id) on delete set null,
  unique(account_key, instagram_user_id)
);
create table public.instagram_intake_events (
  account_key text not null,
  event_id text not null,
  primary key(account_key, event_id)
);
create table public.instagram_intake_days (
  contact_id uuid not null references public.instagram_intake_contacts(id) on delete cascade,
  day date not null,
  primary key(contact_id, day)
);
create index instagram_intake_pending_idx on public.instagram_intake_contacts(account_key, status, last_seen_at desc);
create index instagram_intake_customer_idx on public.instagram_intake_contacts(customer_id);
create index instagram_intake_resolver_idx on public.instagram_intake_contacts(resolved_by);
create index instagram_intake_day_idx on public.instagram_intake_days(day);
alter table public.instagram_intake_contacts enable row level security;
alter table public.instagram_intake_events enable row level security;
alter table public.instagram_intake_days enable row level security;
revoke all on public.instagram_intake_contacts, public.instagram_intake_events, public.instagram_intake_days from anon, authenticated;
grant select, update on public.instagram_intake_contacts to authenticated;
grant select on public.instagram_intake_days to authenticated;
grant all on public.instagram_intake_contacts, public.instagram_intake_events, public.instagram_intake_days to service_role;

create policy "intake admins read" on public.instagram_intake_contacts for select to authenticated
using (exists(select 1 from public.crm_members where user_id = (select auth.uid()) and is_active and role = 'admin'));
create policy "intake admins update" on public.instagram_intake_contacts for update to authenticated
using (exists(select 1 from public.crm_members where user_id = (select auth.uid()) and is_active and role = 'admin'))
with check (exists(select 1 from public.crm_members where user_id = (select auth.uid()) and is_active and role = 'admin'));
create policy "intake admins days" on public.instagram_intake_days for select to authenticated
using (exists(select 1 from public.crm_members where user_id = (select auth.uid()) and is_active and role = 'admin'));

create or replace function public.receive_instagram_intake(p_account text, p_events jsonb)
returns void language plpgsql security invoker set search_path = '' as $$
declare e jsonb; cid uuid; happened timestamptz; inserted integer;
begin
  if p_account is null or p_account not in ('gfs-ig-17841402497215021','mhl-ig-17841421260722221','car-ig-17841458662245781') or jsonb_typeof(p_events) is distinct from 'array' or jsonb_array_length(p_events)>1000 then raise exception 'Invalid intake'; end if;
  for e in select value from jsonb_array_elements(p_events) loop
    if coalesce(e->>'userId','') !~ '^[0-9]{5,30}$' or coalesce(length(e->>'eventId'),0) not between 1 and 512 or e->>'at' is null then raise exception 'Invalid event'; end if;
    if (e->>'at')::timestamptz > now()+interval '5 minutes' then raise exception 'Future event'; end if;
    insert into public.instagram_intake_events values (p_account, e->>'eventId') on conflict do nothing;
    get diagnostics inserted = row_count;
    if inserted = 0 then continue; end if;
    happened := (e->>'at')::timestamptz;
    insert into public.instagram_intake_contacts(account_key, instagram_user_id, first_seen_at, last_seen_at)
    values (p_account, e->>'userId', happened, happened)
    on conflict (account_key, instagram_user_id) do update
    set first_seen_at = least(instagram_intake_contacts.first_seen_at, excluded.first_seen_at),
        last_seen_at = greatest(instagram_intake_contacts.last_seen_at, excluded.last_seen_at)
    returning id into cid;
    insert into public.instagram_intake_days values(cid, (happened at time zone 'Asia/Bangkok')::date) on conflict do nothing;
  end loop;
end;
$$;
revoke all on function public.receive_instagram_intake(text,jsonb) from public, anon, authenticated;
grant execute on function public.receive_instagram_intake(text,jsonb) to service_role;


-- New LINE imports use the entered customer name as the visible contact handle.
-- Keep stable LINE user IDs in instagram_intake_contacts; existing customers are not changed.
create or replace function public.resolve_instagram_intake(p_id uuid, p_decision text, p_name text, p_customer text)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare item public.instagram_intake_contacts; cid uuid; legacy text; attempt integer;
begin
  if not exists(select 1 from public.crm_members where user_id=auth.uid() and is_active and role='admin') then raise exception 'Forbidden'; end if;
  select * into item from public.instagram_intake_contacts where id=p_id for update;
  if not found then raise exception 'Not found'; end if;
  if item.status <> 'pending' then return jsonb_build_object('alreadyResolved',true,'status',item.status); end if;
  if p_decision='dismiss' then
    update public.instagram_intake_contacts set status='dismissed',resolved_at=now(),resolved_by=auth.uid() where id=p_id;
    return jsonb_build_object('status','dismissed');
  elsif p_decision='link' then
    select id,legacy_cust_id into cid,legacy from public.customers where legacy_cust_id=p_customer;
    if not found then raise exception 'Customer not found'; end if;
  elsif p_decision='create' then
    if p_name is null or length(trim(p_name))=0 or length(p_name)>200 then raise exception 'Name required'; end if;
    -- Match server.js newLegacyId: Bangkok YYMMDD and three uppercase hex digits.
    for attempt in 1..5 loop
      legacy := 'CUST-' || to_char(now() at time zone 'Asia/Bangkok','YYMMDD')
        || '-' || upper(substr(replace(gen_random_uuid()::text,'-',''),1,3));
      insert into public.customers(legacy_cust_id,customer_name,recorded_at,contact_channel,contact_handle,remarks,created_by,updated_by)
      values(legacy,trim(p_name),now(),'Instagram',trim(p_name),'Instagram ' || item.account_key,auth.uid(),auth.uid())
      on conflict (legacy_cust_id) do nothing returning id into cid;
      exit when cid is not null;
    end loop;
    if cid is null then raise exception 'Unable to allocate customer ID; please retry'; end if;
  else raise exception 'Invalid decision';
  end if;
  update public.instagram_intake_contacts set status='imported',customer_id=cid,resolved_at=now(),resolved_by=auth.uid() where id=p_id;
  return jsonb_build_object('status','imported','customerId',legacy);
end;
$$;
revoke all on function public.resolve_instagram_intake(uuid,text,text,text) from public, anon;
grant execute on function public.resolve_instagram_intake(uuid,text,text,text) to authenticated;
create function public.instagram_intake_daily_summary(p_account text, p_day date)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object(
    'total', (select count(*) from public.instagram_intake_days d join public.instagram_intake_contacts c on c.id=d.contact_id where c.account_key=p_account and d.day=p_day),
    'new', (select count(*) from public.instagram_intake_contacts where account_key=p_account and (first_seen_at at time zone 'Asia/Bangkok')::date=p_day),
    'imported', (select count(*) from public.instagram_intake_contacts where account_key=p_account and status='imported' and (resolved_at at time zone 'Asia/Bangkok')::date=p_day)
  );
$$;
revoke all on function public.instagram_intake_daily_summary(text,date) from public, anon;
grant execute on function public.instagram_intake_daily_summary(text,date) to authenticated;


create or replace function public.resolve_instagram_with_details(p_id uuid,p_decision text,p_name text,p_customer text,p_details jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare result jsonb; v_phone text; v_email text; v_link text; v_gender text; pair record;
begin
 if not exists(select 1 from public.crm_members where user_id=auth.uid() and is_active and role='admin') then raise exception 'Forbidden'; end if;
 if p_details is null or jsonb_typeof(p_details)<>'object' then raise exception 'Invalid details'; end if;
 if p_decision='create' then
  for pair in select * from jsonb_each(p_details) loop
   if jsonb_typeof(pair.value)<>'string' or length(pair.value #>> '{}')>5000 then raise exception 'Invalid field'; end if;
  end loop;
  v_gender:=coalesce(nullif(p_details->>'gender',''),'ไม่ระบุ');
  v_phone:=regexp_replace(coalesce(p_details->>'phone',''),'[ ()-]','','g');
  if v_phone like '+66%' then v_phone:='0'||substr(v_phone,4); end if;
  v_email:=nullif(trim(p_details->>'email'),''); v_link:=nullif(trim(p_details->>'chat_link'),'');
  if v_gender not in ('ไม่ระบุ','หญิง','ชาย') then raise exception 'Invalid gender'; end if;
  if v_phone<>'' and v_phone !~ '^(0[689][0-9]{8}|02[0-9]{7}|0[3-7][0-9]{7})$' then raise exception 'Invalid phone'; end if;
  if v_email is not null and (length(v_email)>254 or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$') then raise exception 'Invalid email'; end if;
  if v_link is not null and (length(v_link)>2000 or v_link !~ '^https?://[^[:space:]]+$') then raise exception 'Invalid chat link'; end if;
  if length(coalesce(p_details->>'contact_handle',''))>200 or length(coalesce(p_details->>'referral_source',''))>200 then raise exception 'Field too long'; end if;
 end if;
 result:=public.resolve_instagram_intake(p_id,p_decision,p_name,p_customer);
 if p_decision='create' and not coalesce((result->>'alreadyResolved')::boolean,false) then
  update public.customers set gender=v_gender, phone=nullif(v_phone,''),email=v_email,chat_link=v_link,
   contact_handle=coalesce(nullif(trim(p_details->>'contact_handle'),''),contact_handle),
   referral_source=nullif(trim(p_details->>'referral_source'),''),
   remarks=concat_ws(E'\n',nullif(remarks,''),nullif(trim(p_details->>'remarks'),'')),updated_by=auth.uid()
  where legacy_cust_id=result->>'customerId';
 end if;
 return result;
end;
$$;
revoke all on function public.resolve_instagram_with_details(uuid,text,text,text,jsonb) from public,anon;
grant execute on function public.resolve_instagram_with_details(uuid,text,text,text,jsonb) to authenticated;

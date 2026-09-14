-- Pilot: receive-only GFS @249izgyn. No automatic customer creation.
create table public.line_intake_contacts (
  id uuid primary key default gen_random_uuid(),
  account_key text not null check (account_key = 'gfs-line-249izgyn'),
  line_user_id text not null check (line_user_id ~ '^U[0-9a-f]{32}$'),
  display_name text,
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null,
  status text not null default 'pending' check (status in ('pending','imported','dismissed')),
  customer_id uuid references public.customers(id) on delete restrict,
  resolved_at timestamptz,
  resolved_by uuid references auth.users(id) on delete set null,
  unique(account_key, line_user_id)
);
create table public.line_intake_events (
  account_key text not null,
  event_id text not null,
  primary key(account_key, event_id)
);
create table public.line_intake_days (
  contact_id uuid not null references public.line_intake_contacts(id) on delete cascade,
  day date not null,
  primary key(contact_id, day)
);
create index line_intake_pending_idx on public.line_intake_contacts(account_key, status, last_seen_at desc);
create index line_intake_customer_idx on public.line_intake_contacts(customer_id);
create index line_intake_resolver_idx on public.line_intake_contacts(resolved_by);
create index line_intake_day_idx on public.line_intake_days(day);
alter table public.line_intake_contacts enable row level security;
alter table public.line_intake_events enable row level security;
alter table public.line_intake_days enable row level security;
revoke all on public.line_intake_contacts, public.line_intake_events, public.line_intake_days from anon, authenticated;
grant select, update on public.line_intake_contacts to authenticated;
grant select on public.line_intake_days to authenticated;
grant all on public.line_intake_contacts, public.line_intake_events, public.line_intake_days to service_role;

create policy "intake admins read" on public.line_intake_contacts for select to authenticated
using (exists(select 1 from public.crm_members where user_id = (select auth.uid()) and is_active and role = 'admin'));
create policy "intake admins update" on public.line_intake_contacts for update to authenticated
using (exists(select 1 from public.crm_members where user_id = (select auth.uid()) and is_active and role = 'admin'))
with check (exists(select 1 from public.crm_members where user_id = (select auth.uid()) and is_active and role = 'admin'));
create policy "intake admins days" on public.line_intake_days for select to authenticated
using (exists(select 1 from public.crm_members where user_id = (select auth.uid()) and is_active and role = 'admin'));

create function public.receive_line_intake(p_account text, p_events jsonb)
returns void language plpgsql security invoker set search_path = '' as $$
declare e jsonb; cid uuid; happened timestamptz; inserted integer;
begin
  if p_account <> 'gfs-line-249izgyn' or jsonb_typeof(p_events) <> 'array' then raise exception 'Invalid intake'; end if;
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

create function public.line_intake_daily_summary(p_account text, p_day date)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object(
    'total', (select count(*) from public.line_intake_days d join public.line_intake_contacts c on c.id=d.contact_id where c.account_key=p_account and d.day=p_day),
    'new', (select count(*) from public.line_intake_contacts where account_key=p_account and (first_seen_at at time zone 'Asia/Bangkok')::date=p_day),
    'imported', (select count(*) from public.line_intake_contacts where account_key=p_account and status='imported' and (resolved_at at time zone 'Asia/Bangkok')::date=p_day)
  );
$$;
revoke all on function public.line_intake_daily_summary(text,date) from public, anon;
grant execute on function public.line_intake_daily_summary(text,date) to authenticated;

create function public.resolve_line_intake(p_id uuid, p_decision text, p_name text, p_customer text)
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
    values(legacy,trim(p_name),now(),'LINE',item.line_user_id,'GFS LINE OA @249izgyn',auth.uid(),auth.uid()) returning id into cid;
  else raise exception 'Invalid decision';
  end if;
  update public.line_intake_contacts set status='imported',customer_id=cid,resolved_at=now(),resolved_by=auth.uid() where id=p_id;
  return jsonb_build_object('status','imported','customerId',legacy);
end;
$$;
revoke all on function public.resolve_line_intake(uuid,text,text,text) from public, anon;
grant execute on function public.resolve_line_intake(uuid,text,text,text) to authenticated;

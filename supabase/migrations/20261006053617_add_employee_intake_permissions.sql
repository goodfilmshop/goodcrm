-- Per-employee permissions for the three receive-only intake channels.
-- Existing administrators retain all channels. No intake or customer rows are changed.
set local lock_timeout = '5s';

alter table public.crm_employees
  add column intake_permissions jsonb not null default '{}'::jsonb;

comment on column public.crm_employees.intake_permissions is
  'Administrator-managed channel grants: {line:{view,manage},facebook:{view,manage},instagram:{view,manage}}. Manage always includes view.';

create function private.normalize_employee_intake_permissions()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare channel record; permission record; normalized jsonb := '{}'::jsonb; can_view boolean; can_manage boolean;
begin
  if new.intake_permissions is null or jsonb_typeof(new.intake_permissions) <> 'object' then
    raise exception 'Intake permissions must be an object' using errcode = '23514';
  end if;
  for channel in select * from jsonb_each(new.intake_permissions) loop
    if channel.key not in ('line','facebook','instagram') or jsonb_typeof(channel.value) <> 'object' then
      raise exception 'Invalid intake channel permission' using errcode = '23514';
    end if;
    for permission in select * from jsonb_each(channel.value) loop
      if permission.key not in ('view','manage') or jsonb_typeof(permission.value) <> 'boolean' then
        raise exception 'Intake grants must be booleans' using errcode = '23514';
      end if;
    end loop;
    can_manage := coalesce((channel.value->>'manage')::boolean,false);
    can_view := coalesce((channel.value->>'view')::boolean,false) or can_manage;
    normalized := normalized || jsonb_build_object(channel.key,jsonb_build_object('view',can_view,'manage',can_manage));
  end loop;
  new.intake_permissions := normalized;
  return new;
end;
$$;
revoke all on function private.normalize_employee_intake_permissions() from public,anon,authenticated;

create trigger crm_employees_normalize_intake_permissions
before insert or update of intake_permissions on public.crm_employees
for each row execute function private.normalize_employee_intake_permissions();

-- The directory itself remains protected by its existing administrator-only RLS.
-- This small definer lookup is private, reads only the caller's identity and grants,
-- and avoids exposing the complete employee directory to other members.
create function private.can_access_intake(p_channel text,p_operation text default 'view')
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(auth.uid() is not null
    and p_channel in ('line','facebook','instagram')
    and p_operation in ('view','manage')
    and exists (
      select 1 from public.crm_members m
      where m.user_id = (select auth.uid()) and m.is_active
        and m.role in ('admin','manager','sales','member')
        and (m.role = 'admin' or exists (
          select 1 from public.crm_employees e
          where e.member_user_id = m.user_id and e.status = 'active'
            and ((e.intake_permissions->p_channel->p_operation) = 'true'::jsonb
              or (p_operation = 'view' and (e.intake_permissions->p_channel->'manage') = 'true'::jsonb))
        ))
    ),false);
$$;
revoke all on function private.can_access_intake(text,text) from public,anon;
grant usage on schema private to authenticated;
grant execute on function private.can_access_intake(text,text) to authenticated;

create function public.get_current_crm_intake_permissions()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'line',jsonb_build_object('view',private.can_access_intake('line','view'),'manage',private.can_access_intake('line','manage')),
    'facebook',jsonb_build_object('view',private.can_access_intake('facebook','view'),'manage',private.can_access_intake('facebook','manage')),
    'instagram',jsonb_build_object('view',private.can_access_intake('instagram','view'),'manage',private.can_access_intake('instagram','manage'))
  );
$$;
revoke all on function public.get_current_crm_intake_permissions() from public,anon;
grant execute on function public.get_current_crm_intake_permissions() to authenticated;

-- SELECT and UPDATE remain separate so read-only grants cannot resolve contacts.
-- Each UPDATE has both USING and WITH CHECK; events stay service-role only.
do $policies$
declare channel text; contacts text; days text;
begin
  foreach channel in array array['line','facebook','instagram'] loop
    contacts := channel || '_intake_contacts'; days := channel || '_intake_days';
    execute format('drop policy "intake admins read" on public.%I',contacts);
    execute format('drop policy "intake admins update" on public.%I',contacts);
    execute format('drop policy "intake admins days" on public.%I',days);
    execute format('create policy "intake permitted read" on public.%I for select to authenticated using ((select private.can_access_intake(%L,''view'')))',contacts,channel);
    execute format('create policy "intake permitted update" on public.%I for update to authenticated using ((select private.can_access_intake(%L,''manage''))) with check ((select private.can_access_intake(%L,''manage'')))',contacts,channel,channel);
    execute format('create policy "intake permitted days" on public.%I for select to authenticated using ((select private.can_access_intake(%L,''view'')))',days,channel);
  end loop;
end;
$policies$;

-- A table UPDATE must not bypass the resolver's customer visibility and audit
-- rules. Profile enrichment remains allowed, but channel provenance is immutable
-- for authenticated clients. Operational DB roles keep webhook/FK cleanup access.
create function private.protect_intake_contact_update()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare channel text := tg_argv[0];
  editable_fields text[] := array['display_name','status','customer_id','resolved_at','resolved_by'];
begin
  if current_user in ('service_role','postgres','supabase_admin') then return new; end if;
  if current_user <> 'authenticated' or auth.uid() is null
    or not private.can_access_intake(channel,'manage') then
    raise exception 'Forbidden intake update' using errcode='42501';
  end if;
  -- Instagram profile refresh also stores the provider's editable username.
  if channel = 'instagram' then editable_fields := array_append(editable_fields,'username'); end if;
  if (to_jsonb(new) - editable_fields) is distinct from (to_jsonb(old) - editable_fields) then
    raise exception 'Intake origin fields are immutable' using errcode='42501';
  end if;
  if length(new.display_name) > 200 then
    raise exception 'Intake display name is too long' using errcode='23514';
  end if;
  if channel = 'instagram' and length(to_jsonb(new)->>'username') > 100 then
    raise exception 'Instagram username is too long' using errcode='23514';
  end if;
  if row(new.status,new.customer_id,new.resolved_at,new.resolved_by)
      is distinct from row(old.status,old.customer_id,old.resolved_at,old.resolved_by) then
    if old.status <> 'pending' or new.status not in ('imported','dismissed')
      or new.resolved_by is distinct from auth.uid()
      or new.resolved_at is distinct from now() then
      raise exception 'Invalid intake resolution audit fields' using errcode='42501';
    end if;
    if new.status = 'imported' then
      -- SECURITY INVOKER deliberately honors the caller's customer RLS here.
      if new.customer_id is null or not exists(select 1 from public.customers where id=new.customer_id) then
        raise exception 'Customer not accessible' using errcode='42501';
      end if;
    elsif new.customer_id is not null then
      raise exception 'Dismissed intake cannot link a customer' using errcode='23514';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function private.protect_intake_contact_update() from public,anon,authenticated;

do $update_guards$
declare channel text;
begin
  foreach channel in array array['line','facebook','instagram'] loop
    execute format('create trigger intake_protect_contact_update before update on public.%I for each row execute function private.protect_intake_contact_update(%L)',
      channel || '_intake_contacts',channel);
  end loop;
end;
$update_guards$;

-- Preserve the existing validated resolvers, including customer ID allocation,
-- channel details and ownership. Change the authorization guard in every overload.
-- An unexpected definition aborts the migration instead of silently widening access.
do $resolvers$
declare routine record; definition text; updated text; channel_expression text; routine_count integer := 0;
  old_guard constant text := 'if not exists(select 1 from public.crm_members where user_id=auth.uid() and is_active and role=''admin'') then raise exception ''Forbidden''; end if;';
begin
  perform 'public.resolve_line_intake(uuid,text,text,text)'::regprocedure;
  perform 'public.resolve_facebook_intake(uuid,text,text,text)'::regprocedure;
  perform 'public.resolve_instagram_intake(uuid,text,text,text)'::regprocedure;
  perform 'public.resolve_intake_with_details(text,uuid,text,text,text,jsonb)'::regprocedure;
  perform 'public.resolve_instagram_with_details(uuid,text,text,text,jsonb)'::regprocedure;
  for routine in
    select p.oid,p.proname,p.prosecdef from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname in (
      'resolve_line_intake','resolve_facebook_intake','resolve_instagram_intake',
      'resolve_intake_with_details','resolve_instagram_with_details')
  loop
    if routine.prosecdef then raise exception 'Unexpected definer intake resolver: %',routine.proname; end if;
    definition := pg_catalog.pg_get_functiondef(routine.oid);
    channel_expression := case routine.proname
      when 'resolve_line_intake' then '''line'''
      when 'resolve_facebook_intake' then '''facebook'''
      when 'resolve_intake_with_details' then 'p_platform'
      else '''instagram''' end;
    updated := replace(definition,old_guard,
      'if not private.can_access_intake(' || channel_expression || ',''manage'') then raise exception ''Forbidden'' using errcode=''42501''; end if;');
    if updated = definition then raise exception 'Unexpected intake authorization guard: %',routine.proname; end if;
    execute updated;
    execute format('revoke all on function %s from public,anon',routine.oid::regprocedure);
    execute format('grant execute on function %s to authenticated',routine.oid::regprocedure);
    routine_count := routine_count + 1;
  end loop;
  if routine_count < 5 then raise exception 'Missing intake resolvers'; end if;
end;
$resolvers$;

-- Guard direct summary RPC calls as well as ordinary table reads.
do $summaries$
declare channel text;
begin
  foreach channel in array array['line','facebook','instagram'] loop
    execute format($function$
      create or replace function public.%1$I(p_account text,p_day date)
      returns jsonb language plpgsql stable security invoker set search_path = '' as $body$
      begin
        if not private.can_access_intake(%2$L,'view') then
          raise exception 'Forbidden' using errcode='42501';
        end if;
        return jsonb_build_object(
          'total',(select count(*) from public.%3$I d join public.%4$I c on c.id=d.contact_id where c.account_key=p_account and d.day=p_day),
          'new',(select count(*) from public.%4$I where account_key=p_account and (first_seen_at at time zone 'Asia/Bangkok')::date=p_day),
          'imported',(select count(*) from public.%4$I where account_key=p_account and status='imported' and (resolved_at at time zone 'Asia/Bangkok')::date=p_day)
        );
      end;
      $body$;
    $function$,channel || '_intake_daily_summary',channel,channel || '_intake_days',channel || '_intake_contacts');
    execute format('revoke all on function public.%I(text,date) from public,anon',channel || '_intake_daily_summary');
    execute format('grant execute on function public.%I(text,date) to authenticated',channel || '_intake_daily_summary');
  end loop;
end;
$summaries$;

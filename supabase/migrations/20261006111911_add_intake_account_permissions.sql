-- Individual LINE OA, Facebook page and Instagram account grants.
-- Historical account keys remain unchanged. Existing channel grants expand to
-- the same known accounts; explicit account maps are always authoritative.
set local lock_timeout = '5s';

create function private.intake_account_keys(p_channel text)
returns text[] language sql immutable security invoker set search_path='' as $$
  select case p_channel
    when 'line' then array['gfs-line-249izgyn','gfs-line-095jvuls','mhl-line-320opqkc','car-line-fkq6145q']
    when 'facebook' then array['gfs-fb-125106670932394','gfs-fb-101634951180913','mhl-fb-109607531869658']
    when 'instagram' then array['gfs-ig-17841402497215021','mhl-ig-17841421260722221','car-ig-17841458662245781']
    else array[]::text[] end;
$$;
revoke all on function private.intake_account_keys(text) from public,anon;
grant execute on function private.intake_account_keys(text) to authenticated;

create function private.normalize_intake_account_permissions(p_permissions jsonb)
returns jsonb language plpgsql immutable security invoker set search_path='' as $$
declare channel text; entry record; field record; account text; source jsonb; account_source jsonb;
  normalized jsonb := '{}'::jsonb; account_map jsonb; can_view boolean; can_manage boolean;
  any_view boolean; any_manage boolean;
begin
  if p_permissions is null or jsonb_typeof(p_permissions) <> 'object' then
    raise exception 'Intake permissions must be an object' using errcode='23514';
  end if;
  for entry in select * from jsonb_each(p_permissions) loop
    if entry.key not in ('line','facebook','instagram') or jsonb_typeof(entry.value) <> 'object' then
      raise exception 'Invalid intake channel permission' using errcode='23514';
    end if;
  end loop;
  foreach channel in array array['line','facebook','instagram'] loop
    source := coalesce(p_permissions->channel,'{}'::jsonb);
    for field in select * from jsonb_each(source) loop
      if field.key not in ('view','manage','accounts')
        or (field.key in ('view','manage') and jsonb_typeof(field.value) <> 'boolean')
        or (field.key='accounts' and jsonb_typeof(field.value) <> 'object') then
        raise exception 'Invalid intake permission field' using errcode='23514';
      end if;
    end loop;
    if source ? 'accounts' then
      for entry in select * from jsonb_each(source->'accounts') loop
        if not (entry.key = any(private.intake_account_keys(channel))) or jsonb_typeof(entry.value) <> 'object' then
          raise exception 'Invalid intake account permission' using errcode='23514';
        end if;
        for field in select * from jsonb_each(entry.value) loop
          if field.key not in ('view','manage') or jsonb_typeof(field.value) <> 'boolean' then
            raise exception 'Intake account grants must be booleans' using errcode='23514';
          end if;
        end loop;
      end loop;
    end if;
    account_map := '{}'::jsonb; any_view := false; any_manage := false;
    foreach account in array private.intake_account_keys(channel) loop
      -- An explicit account map never inherits aggregate channel booleans.
      account_source := case when source ? 'accounts'
        then coalesce(source->'accounts'->account,'{}'::jsonb) else source end;
      can_manage := coalesce((account_source->>'manage')::boolean,false);
      can_view := coalesce((account_source->>'view')::boolean,false) or can_manage;
      any_view := any_view or can_view; any_manage := any_manage or can_manage;
      account_map := account_map || jsonb_build_object(account,jsonb_build_object('view',can_view,'manage',can_manage));
    end loop;
    normalized := normalized || jsonb_build_object(channel,jsonb_build_object('view',any_view,'manage',any_manage,'accounts',account_map));
  end loop;
  return normalized;
end;
$$;
revoke all on function private.normalize_intake_account_permissions(jsonb) from public,anon;
grant execute on function private.normalize_intake_account_permissions(jsonb) to authenticated;

create or replace function private.normalize_employee_intake_permissions()
returns trigger language plpgsql security invoker set search_path='' as $$
begin
  new.intake_permissions := private.normalize_intake_account_permissions(new.intake_permissions);
  return new;
end;
$$;
revoke all on function private.normalize_employee_intake_permissions() from public,anon,authenticated;

-- Expand only already-authorized legacy channel grants. This changes no customer
-- or intake rows and makes future account-only edits unambiguous.
update public.crm_employees set intake_permissions=intake_permissions;
comment on column public.crm_employees.intake_permissions is
  'Administrator-managed per-account grants. Channel view/manage are derived aggregates; explicit accounts are authoritative and manage includes view.';

create function private.can_access_intake(p_channel text,p_operation text,p_account text)
returns boolean language sql stable security definer set search_path='' as $$
  select coalesce(auth.uid() is not null
    and p_operation in ('view','manage')
    and p_account = any(private.intake_account_keys(p_channel))
    and exists (
      select 1 from public.crm_members m
      where m.user_id=(select auth.uid()) and m.is_active
        and m.role in ('admin','manager','sales','member')
        and (m.role='admin' or exists (
          select 1 from public.crm_employees e
          where e.member_user_id=m.user_id and e.status='active'
            and case when (e.intake_permissions->p_channel) ? 'accounts' then
              (e.intake_permissions->p_channel->'accounts'->p_account->p_operation) = 'true'::jsonb
              or (p_operation='view' and (e.intake_permissions->p_channel->'accounts'->p_account->'manage')='true'::jsonb)
            else
              (e.intake_permissions->p_channel->p_operation)='true'::jsonb
              or (p_operation='view' and (e.intake_permissions->p_channel->'manage')='true'::jsonb)
            end
        ))
    ),false);
$$;
revoke all on function private.can_access_intake(text,text,text) from public,anon;
grant execute on function private.can_access_intake(text,text,text) to authenticated;

create or replace function private.can_access_intake(p_channel text,p_operation text default 'view')
returns boolean language sql stable security invoker set search_path='' as $$
  select exists(select 1 from unnest(private.intake_account_keys(p_channel)) account
    where private.can_access_intake(p_channel,p_operation,account));
$$;
revoke all on function private.can_access_intake(text,text) from public,anon;
grant execute on function private.can_access_intake(text,text) to authenticated;

create or replace function public.get_current_crm_intake_permissions()
returns jsonb language sql stable security invoker set search_path='' as $$
  select jsonb_object_agg(channel,jsonb_build_object(
    'view',private.can_access_intake(channel,'view'),
    'manage',private.can_access_intake(channel,'manage'),
    'accounts',(select jsonb_object_agg(account,jsonb_build_object(
      'view',private.can_access_intake(channel,'view',account),
      'manage',private.can_access_intake(channel,'manage',account)))
      from unnest(private.intake_account_keys(channel)) account)
  )) from unnest(array['line','facebook','instagram']) channel;
$$;
revoke all on function public.get_current_crm_intake_permissions() from public,anon;
grant execute on function public.get_current_crm_intake_permissions() to authenticated;

do $account_policies$
declare channel text; contacts text; days text;
begin
  foreach channel in array array['line','facebook','instagram'] loop
    contacts := channel || '_intake_contacts'; days := channel || '_intake_days';
    execute format('alter policy "intake permitted read" on public.%I using (private.can_access_intake(%L,''view'',account_key))',contacts,channel);
    execute format('alter policy "intake permitted update" on public.%I using (private.can_access_intake(%L,''manage'',account_key)) with check (private.can_access_intake(%L,''manage'',account_key))',contacts,channel,channel);
    execute format('alter policy "intake permitted days" on public.%I using (exists(select 1 from public.%I c where c.id=contact_id and private.can_access_intake(%L,''view'',c.account_key)))',days,contacts,channel);
  end loop;
end;
$account_policies$;

-- Always determine the account from the stored row. The caller cannot claim a
-- permitted OA/page while targeting a different account's contact ID.
create function private.require_intake_contact_manage(p_channel text,p_id uuid)
returns void language plpgsql security invoker set search_path='' as $$
declare account text;
begin
  if p_channel='line' then select account_key into account from public.line_intake_contacts where id=p_id;
  elsif p_channel='facebook' then select account_key into account from public.facebook_intake_contacts where id=p_id;
  elsif p_channel='instagram' then select account_key into account from public.instagram_intake_contacts where id=p_id;
  else raise exception 'Forbidden intake platform' using errcode='42501'; end if;
  if account is null or not private.can_access_intake(p_channel,'manage',account) then
    raise exception 'Forbidden intake account' using errcode='42501';
  end if;
end;
$$;
revoke all on function private.require_intake_contact_manage(text,uuid) from public,anon;
grant execute on function private.require_intake_contact_manage(text,uuid) to authenticated;

do $account_function_guards$
declare routine record; definition text; updated text; channel_expression text; channel text;
begin
  definition := pg_catalog.pg_get_functiondef('private.protect_intake_contact_update()'::regprocedure);
  updated := replace(definition,'private.can_access_intake(channel,''manage'')','private.can_access_intake(channel,''manage'',old.account_key)');
  if updated=definition then raise exception 'Unexpected intake update guard'; end if;
  execute updated;

  perform 'public.resolve_line_intake(uuid,text,text,text)'::regprocedure;
  perform 'public.resolve_facebook_intake(uuid,text,text,text)'::regprocedure;
  perform 'public.resolve_instagram_intake(uuid,text,text,text)'::regprocedure;
  perform 'public.resolve_intake_with_details(text,uuid,text,text,text,jsonb)'::regprocedure;
  perform 'public.resolve_instagram_with_details(uuid,text,text,text,jsonb)'::regprocedure;
  for routine in select p.oid,p.proname,p.prosecdef from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
    and p.proname in ('resolve_line_intake','resolve_facebook_intake','resolve_instagram_intake','resolve_intake_with_details','resolve_instagram_with_details')
  loop
    if routine.prosecdef then raise exception 'Unexpected definer intake resolver: %',routine.proname; end if;
    channel_expression := case routine.proname when 'resolve_line_intake' then '''line'''
      when 'resolve_facebook_intake' then '''facebook''' when 'resolve_intake_with_details' then 'p_platform' else '''instagram''' end;
    definition := pg_catalog.pg_get_functiondef(routine.oid);
    if position('private.require_intake_contact_manage' in definition)>0 then raise exception 'Account guard already present: %',routine.proname; end if;
    updated := regexp_replace(definition,'\mbegin\M',
      'begin' || chr(10) || '  perform private.require_intake_contact_manage(' || channel_expression || ',p_id);','i');
    if updated=definition then raise exception 'Unexpected intake resolver body: %',routine.proname; end if;
    execute updated;
  end loop;

  foreach channel in array array['line','facebook','instagram'] loop
    definition := pg_catalog.pg_get_functiondef(format('public.%I(text,date)',channel || '_intake_daily_summary')::regprocedure);
    updated := replace(definition,format('private.can_access_intake(%L,''view'')',channel),
      format('private.can_access_intake(%L,''view'',p_account)',channel));
    if updated=definition then raise exception 'Unexpected intake summary guard: %',channel; end if;
    execute updated;
  end loop;
end;
$account_function_guards$;

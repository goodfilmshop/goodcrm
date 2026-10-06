set local lock_timeout = '5s';
alter table public.line_intake_contacts add column contact_suggestions jsonb not null default '{}'::jsonb
  check (jsonb_typeof(contact_suggestions) = 'object');

create function public.merge_line_contact_suggestions(previous jsonb, incoming jsonb)
returns jsonb language plpgsql immutable security invoker set search_path='' as $$
declare result jsonb := '{}'; field text; source jsonb; item jsonb; candidates jsonb; value text;
begin
  foreach field in array array['name','phone','email','gender'] loop
    candidates := '[]';
    foreach source in array array[previous,incoming] loop
      if jsonb_typeof(source->field) is distinct from 'array' then continue; end if;
      for item in select v from jsonb_array_elements(source->field) as a(v) limit 3 loop
        if jsonb_typeof(item) <> 'string' then continue; end if;
        value := item #>> '{}';
        if length(value) = 0 or length(value) > (case when field='email' then 254 else 100 end) then continue; end if;
        if field='gender' and value not in ('ชาย','หญิง') then continue; end if;
        if field='phone' and value !~ '^(0[689][0-9]{8}|0[2-7][0-9]{7})$' then continue; end if;
        if field='email' and value !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then continue; end if;
        if not candidates @> jsonb_build_array(value) and jsonb_array_length(candidates)<3 then
          candidates := candidates || jsonb_build_array(value);
        end if;
      end loop;
    end loop;
    if jsonb_array_length(candidates)>0 then result := result || jsonb_build_object(field,candidates); end if;
  end loop;
  return result;
end;
$$;
revoke all on function public.merge_line_contact_suggestions(jsonb,jsonb) from public, anon, authenticated;
grant execute on function public.merge_line_contact_suggestions(jsonb,jsonb) to service_role;

create or replace function public.receive_line_intake(p_account text, p_events jsonb)
returns void language plpgsql security invoker set search_path='' as $$
declare e jsonb; cid uuid; happened timestamptz; inserted integer; suggestions jsonb;
begin
  if p_account is null or p_account not in ('gfs-line-249izgyn','gfs-line-095jvuls','mhl-line-320opqkc','car-line-fkq6145q') or jsonb_typeof(p_events) <> 'array' then raise exception 'Invalid intake'; end if;
  for e in select value from jsonb_array_elements(p_events) loop
    insert into public.line_intake_events values (p_account, e->>'eventId') on conflict do nothing;
    get diagnostics inserted = row_count;
    if inserted = 0 then continue; end if;
    happened := (e->>'at')::timestamptz;
    suggestions := public.merge_line_contact_suggestions('{}',e->'details');
    insert into public.line_intake_contacts(account_key, line_user_id, first_seen_at, last_seen_at, contact_suggestions)
    values (p_account, e->>'userId', happened, happened, suggestions)
    on conflict (account_key, line_user_id) do update
    set first_seen_at = least(line_intake_contacts.first_seen_at, excluded.first_seen_at),
        last_seen_at = greatest(line_intake_contacts.last_seen_at, excluded.last_seen_at),
        contact_suggestions = public.merge_line_contact_suggestions(line_intake_contacts.contact_suggestions, excluded.contact_suggestions)
    returning id into cid;
    insert into public.line_intake_days values(cid, (happened at time zone 'Asia/Bangkok')::date) on conflict do nothing;
  end loop;
end;
$$;

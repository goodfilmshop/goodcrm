-- Admin-only aggregate: does not expose file names or expand file access.
create or replace function private.crm_storage_usage_summary()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null or not private.is_crm_admin() then
    raise exception 'Storage administrator required' using errcode = '42501';
  end if;
  return (select jsonb_build_object(
    'usedBytes', coalesce(sum(case when metadata->>'size' ~ '^[0-9]+$' then (metadata->>'size')::numeric else 0 end), 0),
    'fileCount', count(*),
    'unknownSizeCount', count(*) filter (where metadata->>'size' is null or metadata->>'size' !~ '^[0-9]+$')
  ) from storage.objects);
end;
$$;
revoke all on function private.crm_storage_usage_summary() from public, anon;
grant execute on function private.crm_storage_usage_summary() to authenticated;
create or replace function public.crm_storage_usage_summary()
returns jsonb language sql stable security invoker set search_path = ''
as $$ select private.crm_storage_usage_summary(); $$;
revoke all on function public.crm_storage_usage_summary() from public, anon;
grant execute on function public.crm_storage_usage_summary() to authenticated;

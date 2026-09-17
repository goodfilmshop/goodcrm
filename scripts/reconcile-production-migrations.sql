-- Ledger repair only for changes already verified in Production.
-- Never replay historical migrations against this database: some use different
-- version numbers, and older RLS policies have been superseded.
begin;
do $verify$
begin
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='cases' and column_name='billing_branch' and data_type='text') then
    raise exception 'billing_branch has not been applied';
  end if;
  if (select count(*) from information_schema.columns where table_schema='public' and table_name='lead_follow_up_history' and column_name in ('evaluation_panel_count','evaluation_area_sq_m')) <> 2
    or (select count(*) from pg_constraint where conrelid='public.lead_follow_up_history'::regclass and conname in ('lead_follow_up_history_evaluation_panel_count_nonnegative','lead_follow_up_history_evaluation_area_sq_m_nonnegative')) <> 2 then
    raise exception 'evaluation measurements have not been applied';
  end if;
  if not exists (select 1 from pg_constraint where conrelid='public.line_intake_contacts'::regclass and conname='line_intake_contacts_account_key_check' and position('car-line-fkq6145q' in pg_get_constraintdef(oid))>0)
    or position('car-line-fkq6145q' in pg_get_functiondef('public.receive_line_intake(text,jsonb)'::regprocedure))=0
    or position('car-line-fkq6145q' in pg_get_functiondef('public.resolve_line_intake(uuid,text,text,text)'::regprocedure))=0 then
    raise exception 'Maholan intake has not been applied';
  end if;
end;
$verify$;
insert into supabase_migrations.schema_migrations(version,name) values
  ('20260826140000','add_case_billing_branch'),
  ('20260827034029','add_follow_up_evaluation_measurements'),
  ('20260917075626','add_maholan_line_intake')
on conflict (version) do nothing;
commit;
select version,name from supabase_migrations.schema_migrations
where version in ('20260826140000','20260827034029','20260917075626') order by version;

-- All data here is synthetic and rolled back; no existing customers are deleted.
begin;
do $test$
declare
  cust uuid := gen_random_uuid();
  contact uuid;
  line_uid text := 'U' || replace(gen_random_uuid()::text,'-','');
  event_key text := 'deletion-test-' || gen_random_uuid()::text;
  before_summary jsonb;
  after_summary jsonb;
  original_resolved timestamptz := now();
  today date := (now() at time zone 'Asia/Bangkok')::date;
  payload jsonb;
begin
  insert into public.customers(id,legacy_cust_id,customer_name)
    values(cust,'CUST-DELETE-TEST-' || cust::text,'Synthetic deletion test');
  payload := jsonb_build_array(jsonb_build_object('eventId',event_key,'userId',line_uid,'at',now()));
  perform public.receive_line_intake('gfs-line-249izgyn',payload);
  select id into strict contact from public.line_intake_contacts where line_user_id=line_uid;
  update public.line_intake_contacts set customer_id=cust,status='imported',resolved_at=original_resolved where id=contact;
  before_summary := public.line_intake_daily_summary('gfs-line-249izgyn',today);
  delete from public.customers where id=cust;
  if exists(select 1 from public.customers where id=cust) then raise exception 'Customer was not deleted'; end if;
  if not exists(select 1 from public.line_intake_contacts where id=contact and customer_id is null
    and status='imported' and resolved_at=original_resolved) then raise exception 'Intake history lost or link not cleared'; end if;
  if not exists(select 1 from public.line_intake_days where contact_id=contact and day=today)
    or not exists(select 1 from public.line_intake_events where event_id=event_key) then raise exception 'Statistics/deduplication lost'; end if;
  perform public.receive_line_intake('gfs-line-249izgyn',payload);
  perform public.receive_line_intake('gfs-line-249izgyn',jsonb_build_array(
    jsonb_build_object('eventId',event_key || '-next','userId',line_uid,'at',now())));
  after_summary := public.line_intake_daily_summary('gfs-line-249izgyn',today);
  if before_summary is distinct from after_summary then raise exception 'Historical counts changed'; end if;
  if (select count(*) from public.line_intake_contacts where line_user_id=line_uid) <> 1
    or not exists(select 1 from public.line_intake_contacts where id=contact and customer_id is null and status='imported')
    or exists(select 1 from public.customers where id=cust) then raise exception 'Retry/new message recreated customer or queue entry'; end if;
  begin
    update public.line_intake_contacts set customer_id=gen_random_uuid() where id=contact;
    raise exception 'Foreign key no longer enforced';
  exception when foreign_key_violation then null;
  end;
end;
$test$;
select 'PASS: customer deletion, retained history/counts, duplicate/new message safety, foreign key enforcement' as result;
rollback;

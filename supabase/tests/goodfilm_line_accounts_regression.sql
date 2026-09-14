begin;
do $test$
declare uid text := 'U'||replace(gen_random_uuid()::text,'-',''); eid text := gen_random_uuid()::text; payload jsonb; a uuid; b uuid;
begin
  payload:=jsonb_build_array(jsonb_build_object('eventId',eid,'userId',uid,'at',now()));
  perform public.receive_line_intake('gfs-line-249izgyn',payload);
  perform public.receive_line_intake('gfs-line-095jvuls',payload);
  perform public.receive_line_intake('gfs-line-095jvuls',payload);
  select id into strict a from public.line_intake_contacts where account_key='gfs-line-249izgyn' and line_user_id=uid;
  select id into strict b from public.line_intake_contacts where account_key='gfs-line-095jvuls' and line_user_id=uid;
  if a=b or (select count(*) from public.line_intake_events where event_id=eid)<>2 then raise exception 'Account isolation/deduplication failed'; end if;
  if (select count(*) from public.line_intake_days where contact_id in(a,b))<>2 then raise exception 'Daily stats isolation failed'; end if;
  begin
    perform public.receive_line_intake('unknown',payload);
    raise exception 'Unknown account accepted';
  exception when raise_exception then
    if sqlerrm <> 'Invalid intake' then raise; end if;
  end;
end;
$test$;
select 'PASS: two-account isolation, retries and per-account days' as result;
rollback;

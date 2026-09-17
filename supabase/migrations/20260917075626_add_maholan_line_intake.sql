-- Add the car LINE OA without replacing unrelated changes to the intake RPCs.
set local lock_timeout = '5s';
alter table public.line_intake_contacts
  drop constraint line_intake_contacts_account_key_check,
  add constraint line_intake_contacts_account_key_check
  check (account_key in ('gfs-line-249izgyn','gfs-line-095jvuls','mhl-line-320opqkc','car-line-fkq6145q'));

do $migration$
declare definition text; updated text;
begin
  definition := pg_get_functiondef('public.receive_line_intake(text,jsonb)'::regprocedure);
  updated := replace(definition,
    '''gfs-line-249izgyn'',''gfs-line-095jvuls'',''mhl-line-320opqkc''',
    '''gfs-line-249izgyn'',''gfs-line-095jvuls'',''mhl-line-320opqkc'',''car-line-fkq6145q''');
  if updated = definition then raise exception 'Unexpected receive_line_intake definition; inspect before applying'; end if;
  execute updated;

  definition := pg_get_functiondef('public.resolve_line_intake(uuid,text,text,text)'::regprocedure);
  updated := replace(definition, 'case item.account_key when',
    'case item.account_key when ''car-line-fkq6145q'' then ''CAR LINE OA @fkq6145q / @maholan'' when');
  if updated = definition then raise exception 'Unexpected resolve_line_intake definition; inspect before applying'; end if;
  execute updated;
end;
$migration$;

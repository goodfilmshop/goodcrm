-- Reconsider LINE/Facebook dismissals through the existing atomic resolver.
-- Preserve row locking, caller RLS, ownership, validation and imported idempotency.
do $migration$
declare routine text; definition text; updated text;
begin
  foreach routine in array array['public.resolve_line_intake(uuid,text,text,text)',
    'public.resolve_facebook_intake(uuid,text,text,text)'] loop
    definition := pg_get_functiondef(routine::regprocedure);
    updated := replace(definition,
      'if item.status <> ''pending'' then',
      'if item.status <> ''pending'' and not (item.status = ''dismissed'' and p_decision in (''create'',''link'')) then');
    if updated = definition then raise exception 'Unexpected resolver definition: %', routine; end if;
    execute updated;
  end loop;
  definition := pg_get_functiondef('private.protect_intake_contact_update()'::regprocedure);
  updated := replace(definition,
    'old.status <> ''pending'' or new.status not in (''imported'',''dismissed'')',
    'not ((old.status = ''pending'' and new.status in (''imported'',''dismissed''))
      or (channel in (''line'',''facebook'') and old.status = ''dismissed'' and new.status = ''imported''))');
  if updated = definition then raise exception 'Unexpected intake update guard'; end if;
  execute updated;
end;
$migration$;

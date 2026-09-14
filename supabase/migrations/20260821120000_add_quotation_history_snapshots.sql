-- Keep the editable quotation document with the existing, RLS-protected case history row.
-- This preserves the exact items and customer details used when the quotation was issued.
alter table public.lead_follow_up_history
  add column if not exists quotation_snapshot jsonb;

alter table public.lead_follow_up_history
  drop constraint if exists lead_follow_up_history_quotation_snapshot_object;

alter table public.lead_follow_up_history
  add constraint lead_follow_up_history_quotation_snapshot_object
  check (
    quotation_snapshot is null
    or jsonb_typeof(quotation_snapshot) = 'object'
  ) not valid;

comment on column public.lead_follow_up_history.quotation_snapshot is
  'Editable quotation document snapshot for a quotation follow-up event.';

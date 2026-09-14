alter table public.lead_follow_up_history
  add constraint lead_follow_up_history_next_follow_up_at_required
  check (next_follow_up_at is not null) not valid;

comment on constraint lead_follow_up_history_next_follow_up_at_required
  on public.lead_follow_up_history
  is 'Requires a next follow-up timestamp for new or updated history rows; legacy rows remain unvalidated.';

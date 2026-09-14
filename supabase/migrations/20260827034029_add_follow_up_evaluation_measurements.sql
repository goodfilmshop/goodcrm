alter table public.lead_follow_up_history
  add column if not exists evaluation_panel_count integer,
  add column if not exists evaluation_area_sq_m numeric(12, 2);

alter table public.lead_follow_up_history
  drop constraint if exists lead_follow_up_history_evaluation_panel_count_nonnegative,
  drop constraint if exists lead_follow_up_history_evaluation_area_sq_m_nonnegative;

alter table public.lead_follow_up_history
  add constraint lead_follow_up_history_evaluation_panel_count_nonnegative
    check (evaluation_panel_count is null or evaluation_panel_count >= 0) not valid,
  add constraint lead_follow_up_history_evaluation_area_sq_m_nonnegative
    check (evaluation_area_sq_m is null or evaluation_area_sq_m >= 0) not valid;

comment on column public.lead_follow_up_history.evaluation_panel_count is
  'Number of panels recorded when the follow-up status is ประเมินราคา.';

comment on column public.lead_follow_up_history.evaluation_area_sq_m is
  'Area in square meters recorded when the follow-up status is ประเมินราคา.';

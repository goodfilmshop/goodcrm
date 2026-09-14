-- Let each CRM member keep an independent read cursor for every work menu
-- that exposes an unread badge.
alter table public.case_notification_reads
  drop constraint if exists case_notification_reads_notification_scope_check;

alter table public.case_notification_reads
  add constraint case_notification_reads_notification_scope_check
  check (
    notification_scope in (
      'cases',
      'measurement_queue',
      'installation_queue',
      'quotations'
    )
  );

comment on table public.case_notification_reads is
  'Per-user read cursors for CRM case and work-menu notifications.';

create index if not exists cases_installation_notification_id_idx
on public.cases (id)
where status = 'นัดคิวติดตั้ง';

create index if not exists lead_follow_up_history_quotation_followed_at_idx
on public.lead_follow_up_history (followed_at desc, id desc)
where quotation_numbers <> '{}'::text[];

create index if not exists general_tasks_due_created_at_idx
on public.general_tasks (due_at asc nulls last, created_at desc);

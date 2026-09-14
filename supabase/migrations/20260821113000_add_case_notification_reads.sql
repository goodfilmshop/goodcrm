-- Per-user read cursors for the case list and measurement queue notifications.
-- Counts are calculated only from rows visible to the authenticated member via
-- the existing cases RLS policies.

create table if not exists public.case_notification_reads (
  user_id uuid not null references auth.users(id) on delete cascade,
  notification_scope text not null check (notification_scope in ('cases', 'measurement_queue')),
  read_at timestamptz not null default now(),
  primary key (user_id, notification_scope)
);

create index if not exists case_notification_reads_user_read_at_idx
on public.case_notification_reads (user_id, read_at desc);

-- The receipt is private to the current authenticated CRM member.
revoke all on table public.case_notification_reads from anon;
revoke delete, references, trigger, truncate on table public.case_notification_reads from authenticated;
grant select, insert, update on table public.case_notification_reads to authenticated;

alter table public.case_notification_reads enable row level security;

create policy "active members can read their case notification receipts"
on public.case_notification_reads
for select
to authenticated
using (
  user_id = (select auth.uid())
  and (select private.is_active_crm_member())
);

create policy "active members can create their case notification receipts"
on public.case_notification_reads
for insert
to authenticated
with check (
  user_id = (select auth.uid())
  and (select private.is_active_crm_member())
);

create policy "active members can update their case notification receipts"
on public.case_notification_reads
for update
to authenticated
using (
  user_id = (select auth.uid())
  and (select private.is_active_crm_member())
)
with check (
  user_id = (select auth.uid())
  and (select private.is_active_crm_member())
);

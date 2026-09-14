-- Per-user read receipts for published announcements.
-- A CRM member sees a menu notification until this user opens the announcements page.

create table if not exists public.announcement_reads (
  announcement_id uuid not null references public.announcements(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  read_at timestamptz not null default now(),
  primary key (announcement_id, user_id)
);

create index if not exists announcement_reads_user_read_at_idx
on public.announcement_reads (user_id, read_at desc);

-- Newer Supabase projects may grant public-schema tables to anon by default.
-- This table is intentionally accessible only to authenticated CRM members.
revoke all on table public.announcement_reads from anon;
revoke delete, references, trigger, truncate on table public.announcement_reads from authenticated;
grant select, insert, update on table public.announcement_reads to authenticated;

alter table public.announcement_reads enable row level security;

create policy "active members can read their announcement receipts"
on public.announcement_reads
for select
to authenticated
using (
  user_id = (select auth.uid())
  and (select private.is_active_crm_member())
);

create policy "active members can create their announcement receipts"
on public.announcement_reads
for insert
to authenticated
with check (
  user_id = (select auth.uid())
  and (select private.is_active_crm_member())
);

create policy "active members can update their announcement receipts"
on public.announcement_reads
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

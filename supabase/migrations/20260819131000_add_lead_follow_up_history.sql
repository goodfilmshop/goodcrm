-- Follow-up history is stored per case so each lead case keeps an auditable
-- timeline of contact attempts, outcomes, and the next required action.

create table if not exists public.lead_follow_up_history (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.cases(id) on delete cascade,
  followed_at timestamptz not null default now(),
  activity_type text not null default 'follow_up',
  contact_channel text,
  outcome text,
  notes text,
  next_follow_up_at timestamptz,
  previous_status text,
  current_status text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null
);

comment on table public.lead_follow_up_history is
  'History of follow-up activities for an individual CRM case.';

comment on column public.lead_follow_up_history.next_follow_up_at is
  'Optional scheduled time for the next follow-up action.';

-- The case timeline is normally loaded newest-first.  The partial index also
-- supports future reminder views without indexing completed records.
create index if not exists lead_follow_up_history_case_followed_at_idx
on public.lead_follow_up_history (case_id, followed_at desc, id desc);

create index if not exists lead_follow_up_history_next_follow_up_at_idx
on public.lead_follow_up_history (next_follow_up_at)
where next_follow_up_at is not null;

create index if not exists lead_follow_up_history_created_by_idx
on public.lead_follow_up_history (created_by);

create index if not exists lead_follow_up_history_updated_by_idx
on public.lead_follow_up_history (updated_by);

drop trigger if exists lead_follow_up_history_set_updated_at
on public.lead_follow_up_history;

create trigger lead_follow_up_history_set_updated_at
before update on public.lead_follow_up_history
for each row execute function private.set_updated_at();

grant select, insert, update, delete
on public.lead_follow_up_history to authenticated;

alter table public.lead_follow_up_history enable row level security;

create policy "active members can read lead follow-up history"
on public.lead_follow_up_history
for select
to authenticated
using ((select private.is_active_crm_member()));

create policy "active members can create lead follow-up history"
on public.lead_follow_up_history
for insert
to authenticated
with check ((select private.is_active_crm_member()));

create policy "active members can update lead follow-up history"
on public.lead_follow_up_history
for update
to authenticated
using ((select private.is_active_crm_member()))
with check ((select private.is_active_crm_member()));

create policy "active members can delete lead follow-up history"
on public.lead_follow_up_history
for delete
to authenticated
using ((select private.is_active_crm_member()));

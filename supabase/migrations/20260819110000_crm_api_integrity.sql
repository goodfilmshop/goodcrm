-- Good CRM now uses Supabase as the operational data store.  These database
-- constraints make the API safe when two authenticated members submit at the
-- same time.

create unique index if not exists customers_phone_normalized_unique
on public.customers (phone_normalized)
where phone_normalized <> '';

alter table public.cases
  add column if not exists client_request_id text;

create unique index if not exists cases_client_request_id_unique
on public.cases (client_request_id)
where client_request_id is not null;

-- The CRM needs a small internal directory to populate the assignee list.
-- It intentionally exposes only the active member records, never auth.users
-- or email addresses, and is still restricted to approved CRM members.
drop policy if exists "members can view their own membership" on public.crm_members;

create policy "active members can read crm directory"
on public.crm_members
for select
to authenticated
using ((select private.is_active_crm_member()));

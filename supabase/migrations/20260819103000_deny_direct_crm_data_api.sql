-- Compatibility migration for the Supabase-only CRM API.  The prior version
-- of this file removed authenticated access and required a service-role key.
-- GOOD CRM now keeps the user's JWT on every request so RLS is enforced by
-- Supabase; do not revoke these grants.

grant select on public.crm_members to authenticated;
grant select, insert, update, delete on public.customers to authenticated;
grant select, insert, update, delete on public.cases to authenticated;

drop policy if exists "members can view their own membership" on public.crm_members;
drop policy if exists "active members can read customers" on public.customers;
drop policy if exists "active members can create customers" on public.customers;
drop policy if exists "active members can update customers" on public.customers;
drop policy if exists "active members can delete customers" on public.customers;
drop policy if exists "active members can read cases" on public.cases;
drop policy if exists "active members can create cases" on public.cases;
drop policy if exists "active members can update cases" on public.cases;
drop policy if exists "active members can delete cases" on public.cases;

create policy "members can view their own membership"
on public.crm_members
for select
to authenticated
using ((select auth.uid()) = user_id);

create policy "active members can read customers"
on public.customers
for select
to authenticated
using ((select private.is_active_crm_member()));

create policy "active members can create customers"
on public.customers
for insert
to authenticated
with check ((select private.is_active_crm_member()));

create policy "active members can update customers"
on public.customers
for update
to authenticated
using ((select private.is_active_crm_member()))
with check ((select private.is_active_crm_member()));

create policy "active members can delete customers"
on public.customers
for delete
to authenticated
using ((select private.is_active_crm_member()));

create policy "active members can read cases"
on public.cases
for select
to authenticated
using ((select private.is_active_crm_member()));

create policy "active members can create cases"
on public.cases
for insert
to authenticated
with check ((select private.is_active_crm_member()));

create policy "active members can update cases"
on public.cases
for update
to authenticated
using ((select private.is_active_crm_member()))
with check ((select private.is_active_crm_member()));

create policy "active members can delete cases"
on public.cases
for delete
to authenticated
using ((select private.is_active_crm_member()));

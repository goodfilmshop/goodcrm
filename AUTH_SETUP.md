# GOOD CRM authentication setup

GOOD CRM uses Supabase Auth (email/password) and Supabase Database with Row Level Security (RLS). There is no public sign-up path: a CRM administrator provisions each account.

## Configure the app

Copy `.env.example` to `.env` and set `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY`. The app does not require a Supabase service-role key or any Google Apps Script settings.

## Configure Supabase Auth

In **Authentication → Providers**, enable Email. In **Authentication → URL Configuration**, add the deployed GOOD CRM origin and `http://localhost:3000` for local testing. An invited or newly created account must verify its email before password sign-in if email confirmation is enabled. Enable [leaked password protection](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection) before production.

## Apply the CRM schema

Apply the migrations in `supabase/migrations` in filename order. They create `crm_members`, `customers`, and `cases`; enable RLS; preserve legacy CRM IDs; prevent duplicate phone numbers; and make case submission idempotent.

The app is deny-by-default: a signed-in user cannot access CRM data unless they have an active row in `crm_members`.

## Grant the first administrator

Create or invite the account in **Authentication → Users**, then run this SQL as a project administrator. Replace the values before executing it.

```sql
insert into public.crm_members (user_id, display_name, role, is_active)
select id, 'CRM Administrator', 'admin', true
from auth.users
where email = 'admin@example.com'
on conflict (user_id) do update
set display_name = excluded.display_name,
    role = excluded.role,
    is_active = true;
```

Use `manager` or `sales` for other approved users. Active members can access CRM rows under the current RLS policies.

## Verification

Run `npm start`, then open `http://localhost:3000`. `/api/protected/health` must return `401` without a Bearer token. After an approved user signs in, the server validates the Supabase user and their active membership before the CRM is displayed.

For production, complete [SECURITY_DEPLOYMENT.md](SECURITY_DEPLOYMENT.md) to configure the Thailand-only edge rule.

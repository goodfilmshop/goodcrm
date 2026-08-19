# GOOD CRM authentication setup

GOOD CRM uses Supabase Auth (email Magic Link) and Supabase Database with Row Level Security (RLS). There is no public sign-up path: a CRM administrator provisions each account.

## Configure the app

Copy `.env.example` to `.env` and set `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY`. The app does not require a Supabase service-role key or any Google Apps Script settings.

## Configure Supabase Auth

In **Authentication → Providers**, enable Email and disable **Allow new users to sign up**. In **Authentication → URL Configuration**, set the Site URL to the deployed GOOD CRM URL, and add that same origin plus `http://localhost:3000` for local testing to Redirect URLs.

Use the default **Magic link or OTP** email template, which contains `{{ .ConfirmationURL }}` and sends a one-time **Sign in** link. Custom SMTP is not required. The app sends a link only to existing Supabase users (`shouldCreateUser: false`), then confirms that the user has an active `crm_members` record before displaying the CRM.

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

Run `npm start`, then open `http://localhost:3000`. `/api/protected/health` must return `401` without a Bearer token. Enter an approved email, request a sign-in link, and open that link from the email in the same browser. The server validates the signed-in user and their active membership before the CRM is displayed.

For production, complete [SECURITY_DEPLOYMENT.md](SECURITY_DEPLOYMENT.md) to configure the Thailand-only edge rule.

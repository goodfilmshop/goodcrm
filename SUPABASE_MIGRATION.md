# Good CRM → Supabase

GOOD CRM now uses Supabase as its operational system of record:

- Supabase Auth authenticates users.
- `public.crm_members` is the approved-user allow-list.
- `public.customers` and `public.cases` store all CRM data under RLS.
- `/api/crm` forwards the signed-in user's JWT to Supabase, so every database query is checked by RLS. Google Apps Script is no longer used by the running application.

## Applied project setup

The project schema and CRM integrity migration are applied. The active administrator is `supaporn.gfs@gmail.com`.

## Optional legacy import

If historic Google Sheets data must be retained, `scripts/import-google-apps-script.mjs` can import it once before using the new CRM. It is an optional one-time migration utility, not part of the live app. It requires a Supabase server secret and the legacy Apps Script URL/secret in a temporary terminal session; never put those values in `.env` or browser code.

After importing, reconcile customer and case counts before retiring the old spreadsheet workflow.

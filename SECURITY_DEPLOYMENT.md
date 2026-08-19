# Thailand-only access deployment

GOOD CRM uses Supabase Auth plus RLS as its data security boundary. The web server additionally limits website access to Thailand when it receives a trusted country header from the edge.

## Required deployment steps

1. Set the server environment variables. Do not put them in browser code or source control.

   ```text
   SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
   SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
   GEO_RESTRICTION_ENABLED=true
   GEO_ALLOWED_COUNTRIES=TH
   GEO_COUNTRY_HEADER=cf-ipcountry
   GEO_ALLOW_LOCAL_DEVELOPMENT=false
   ```

2. Put the production hostname behind Cloudflare's orange-cloud proxy and create a **WAF custom rule**:

   ```text
   ip.geoip.country ne "TH"
   ```

   Set the action to **Block**. Firewall the origin so it accepts traffic only from Cloudflare; otherwise a caller could forge `CF-IPCountry` when reaching the origin directly.

3. Keep Supabase RLS enabled on all CRM tables. Do not expose a Supabase service-role or secret key to the browser.

## Verification

- A Thai IP can sign in and use the CRM.
- A non-Thai IP receives HTTP 403 at the edge.
- `/api/protected/health` returns `401` without a session.
- A signed-in user without an active `crm_members` row is denied.
- The server and browser source contain no service-role, Google Apps Script, or shared-secret credentials.

## Important limitation

IP geolocation limits website access by apparent network location. A Thailand-based VPN can appear to be in Thailand, and mobile or corporate networks can geolocate incorrectly. Use MFA and device management as additional controls when needed.

# GOOD CRM deployment preparation

Existing service discovered: https://goodcrm.onrender.com (free compute, Oregon),
service `srv-da2nid0n74is738bsfvg`, connected to `goodfilmshop/goodcrm` main.
Its existing environment contains the Supabase settings and has
`GEO_RESTRICTION_ENABLED=false`. This release preserves that existing setting;
the live service is not Thailand-only. The dashboard manages this service.
The YAML below is a separate provisioning scaffold, not its active configuration.
GitHub Pages now redirects to this Render site.

The application serves both the website and API through `npm start`.
Deploy the complete application, including `server.js`, `storage-overview.js`,
`storage-plan.json`, `line-intake.js`, `facebook-intake.js`, `public/`, package files,
and the test files required by `npm test`. Do not upload `.env`, `tmp/`, browser
profiles, or OneDrive conflict copies such as `*OILLY-NOTEBOOK*`.

`render.yaml` defines a free Node service in Oregon with automatic deployment
disabled. Its build installs the locked dependencies and runs the existing tests.
Supply the Supabase URL and publishable key using Render environment settings.
Do not commit secret keys. No database migration or webhook switch is automatic.

## Remaining launch requirements

1. Sign in to Render and connect the intended GitHub repository.
2. Publish a reviewed deployment branch containing the complete current app.
3. Create the service from that branch and supply the environment settings.
4. Configure the trusted country-filtering edge and prevent direct origin access
   as described in `SECURITY_DEPLOYMENT.md`. The existing Thailand-only restriction
   stays enabled: the direct Render URL will reject requests without a trusted
   country header. Do not assume Render supplies `cf-ipcountry`, or disable the
   restriction merely to make the URL work. This step needs an actual domain/edge
   configuration before the service can be released to users.
5. Verify the live authentication redirect configuration, database migrations,
   login, membership checks, reads/writes, and image upload with an authorized user.
6. Switch the public link only after those checks succeed.

No HTTP health-check path is configured because the existing routes enforce
country checks and the protected health endpoint additionally requires login.

References: https://render.com/docs/blueprint-spec and
https://render.com/docs/deploy-node-express-app

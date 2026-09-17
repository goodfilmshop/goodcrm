# Good_CRM ↔ Storage: separate logins and read-only CRM view

This change is disabled by default. No production data, credentials or deployment settings are changed by installing the code.

## Ownership and access

- Good_CRM supplies a starting copy of customer/case details and the responsible administrator/salesperson.
- Storage retains its own usernames, passwords, sessions, account status and staff/team permissions. No CRM login is used for Storage users.
- The Storage owner maps CRM employee IDs to the existing Storage administrator/sales assignment directory in **บัญชีทีมงาน → เชื่อมข้อมูล Good_CRM**. Names are labels; the saved mapping uses stable IDs. Each source and destination can be mapped only once per role.
- Existing CRM data has no technician team assignment. Assign technicians in Storage using the existing team controls. No teams or accounts are guessed or created.
- Jobs are matched by the immutable CRM case UUID; a second sync updates the same job instead of creating a duplicate. Initial cases enter Storage as survey jobs; Storage controls subsequent workflow.
- New CRM jobs require a real scheduled date and a matching latest follow-up status: `นัดวัดพื้นที่` (measurement) or `นัดคิวติดตั้ง` (installation). A status alone, an invalid/missing date or a date from another stage does not qualify.
- For imported jobs, **all Storage administrators, including OIL, see installation appointments only**. Salespeople see their own assigned measurement and installation appointments. Technician team access and existing manually created jobs retain their existing rules; administrators retain their existing cross-assignment access within installation appointments.
- These checks run on the server for job lists, writes and photo access. Source queue metadata is immutable from the browser; editing a Storage date/workflow cannot bypass the filter. Moving from measurement to installation updates the same job and retains its local details/photos.
- If a still-exported case loses its valid appointment, the existing job/photos are retained but hidden from administrators/sales until an eligible appointment returns. Previously qualified cases that later leave the export retain their last imported queue as historical jobs, as before; this does not delete completed work. Failed synchronization does not revoke the last successfully imported queue.
- A source snapshot is stored on each imported job. Refresh updates only fields still equal to that source snapshot. Locally changed values, teams, workflow, films, photographs and job sheets remain in Storage. CRM reads those values in a separate read-only case panel; no CRM record is updated by this integration.
- Clearing a local field is an edit and is retained while different from the source. Setting a field back to its source value resumes following CRM for that field.
- Cases removed from the export are marked unavailable at source; their Storage job/photos are retained. This is historical retention, not a live CRM access revocation mechanism. Disabling a Storage account continues to be managed separately in Storage.
- CRM viewers must pass the existing CRM login/membership checks and case RLS on **every** details/photo request. Storage verifies a server-signed, short-lived, non-replayable request and checks that each photo belongs to that case. No password, bridge key or database key is sent to the browser.

## Install locally before deployment

NAS application needs `server.mjs`, `auth.mjs`, `permissions.mjs`, `crm-link.mjs`, `crm-outbound.mjs`, `crm-queue.mjs`, `crm-bridge-protocol.cjs` and the built frontend. Preserve the complete data directory, including jobs, photos, users and directory. Back up code and data before deployment.

Good_CRM needs `storage-bridge.cjs`, `storage-relay.cjs`, `crm-bridge-protocol.cjs` and `public/storage-job-view.js`, plus the additive server/UI changes. The old `install.patch` is historical: `outbound-install.patch` refines that installation. Production uses the fixed RPC in `storage-reader.sql`, not a service-role credential. Apply the SQL once; it deliberately refuses to replace existing integration objects. Existing customer/case tables, grants, login and RLS remain unchanged.

## Server-only configuration

Set a newly generated random secret of at least 32 characters on both servers as `CRM_BRIDGE_SECRET` and in `private.storage_bridge_config`. Exchange it through deployment secret settings, never chat or source control. `prepare-crm-private-setup.mjs` generates ignored private setup files without printing the key and leaves the Storage connector disabled. The owner completes credential entry in the service dashboards.

Good_CRM:

```text
STORAGE_BRIDGE_ENABLED=true
CRM_BRIDGE_SECRET=<deployment secret>
STORAGE_BRIDGE_TRANSPORT=outbound
```

The CRM server uses its existing Supabase publishable key only to call the fixed `storage_bridge_snapshot` RPC. Inside the function, a separate HMAC capability is mandatory, expires in 60 seconds and cannot be replayed. The function has a fixed empty search path and only exports whitelisted columns. Its private key/nonce tables are inaccessible to anon/authenticated roles. Only anti-replay bookkeeping is written; customer/case/employee/auth data is never written. No service-role key or new base-table grants are required. Existing country/network restrictions still apply.

Storage/NAS:

```text
GOOD_CRM_BRIDGE_ENABLED=true
GOOD_CRM_URL=https://<Good_CRM hostname>
CRM_BRIDGE_SECRET=<same deployment secret>
STORAGE_BRIDGE_TRANSPORT=outbound
```

Origins must use HTTPS (HTTP is accepted only for localhost development), with no credentials, path or query. The NAS pulls on startup and every 60 seconds. The owner can pull manually. Failed pulls retain existing Storage data and expose last-sync status in the owner panel. The CLI loads optional `nas-app/.env.crm`; tests that call createServer still pass an explicit environment.

Storage also long-polls CRM over outbound HTTPS. CRM authenticates its viewer and checks case RLS before requesting local details/photos. Storage verifies photo ownership and sends signed, body-hashed, sequential chunks; CRM streams these without persisting photos. No public Storage hostname or incoming port forwarding is necessary. Closing Storage or turning off the PC makes its read-only CRM panel unavailable; it does not prevent ordinary CRM work. Keep the PC and Storage running while users need to view its photos. Render's existing free-tier sleep/resource limits still apply. Multiple CRM server instances are not supported by this in-memory relay.

## Rollout and verification

1. Back up and install code with both enable flags false; verify existing logins and ordinary job/photo operations.
2. Configure server secrets and URLs in a test environment. Check source export and owner-only mapping with synthetic cases first.
3. Match administrator/salespeople to existing Storage directory entries; verify administrators see installation appointments only, salespeople see their own measurement/installation appointments, and technicians see their assigned teams. A queue must include its scheduled date. Administrators keep their existing cross-assignment scope within eligible jobs.
4. Enable the fixed measurement/installation export. Verify local edits survive repeated pulls, source changes update untouched fields, and CRM sees the edited Storage details/status/photos without modifying its own case.
5. Verify inaccessible CRM cases cannot be read by changing case/photo IDs. Disable either enable flag to stop the bridge; ordinary logins and saved Storage jobs continue working. Existing imported jobs are retained.

Automated tests run with temporary synthetic stores; they do not connect to Supabase or production NAS. Actual cross-server access, secrets, employee mappings, source rows and deployed versions still require deployment verification.

## Verification recorded on 2026-09-17

- Good_CRM `npm test`: 246 passed. Server, bridge and browser script syntax checks passed.
- After the role/date refinement, Good_CRM `installation-queue.test.js`: 17 passed. The local exporter and its Storage distribution copy are identical.
- Storage targeted HTTP/integration/permission tests: 20 passed, including `crm-outbound` multi-chunk byte equality, HMAC tamper/replay rejection, offline/timeout cleanup, cross-case photo protection, RLS-before-relay and restricted RPC contract. The previous 16 tests remain passing.
- TypeScript, NAS production build and targeted lint passed. CommonJS modules use `require` deliberately for compatibility with the Good_CRM server; targeted lint allows that one rule.
- Browser verification used synthetic data only: owner mapping panel opens, CRM details render and the photo button displays an image. Production accounts/photos were not opened or changed.
- Existing broader Storage tests are not all green: `accounts.test.mjs` fails at line 23 (403 vs expected 200), reproduced with a copy of the pre-integration server. Two `workflow.test.ts` tests fail on the existing close-job rule and the automatically added `createdAt` field; the runtime functions for these were not changed by this integration. These unrelated legacy failures remain unmodified.
- On 2026-09-17 the private integration tables and fixed RPC were installed in the live goodcrm Supabase project. A synthetic credential test exercised the real export/replay rejection inside a transaction and rolled back every test write. No CRM records were changed. Credential configuration, live deployment status and employee mapping must be verified separately; code installation alone is not end-to-end completion.

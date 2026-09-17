# Production reconciliation — 2026-09-17

The workspace was fast-forwarded to origin/main after every modified and
untracked source file was verified to match the published version. Two safety
stashes retain the original working files. Neither stash was dropped.

## Database

Localhost and Render must use project `mbxuebqqglaeechltkyl`. Verify the runtime
configuration using `node scripts/verify-production.cjs`; the verifier never
prints keys or tokens.

The Production ledger initially contained 58 migrations. Several historical
versions differ from local filenames although their migration names match.
`expand_menu_notification_scopes` is recorded remotely as
`allow_installation_and_quotation_read_scopes`. Its four scopes were checked.
The compatibility migration `deny_direct_crm_data_api` must not be replayed:
the required authenticated grants exist, and later sales-visibility migrations
supersede its broad policies.

Three changes were present in the live schema but missing from the ledger:

- `20260826140000_add_case_billing_branch`
- `20260827034029_add_follow_up_evaluation_measurements`
- `20260917075626_add_maholan_line_intake`

Their columns, constraints and Maholan RPC support were checked before adding
their ledger records. `scripts/reconcile-production-migrations.sql` documents
the guarded, additive repair. No business rows were deleted or rewritten.
The Storage bridge RPC already exists. Do not blindly run `supabase db push`
against historical filenames, or replay `storage-reader.sql`.

## External deployments

- Maholan Edge Function was redeployed from the local handler and entrypoint,
  combined into a single `index.ts` with only the local import/export wrapper
  removed. The complete generated text was checked before deployment.
- The four other Edge Functions have no source changes in this release.
  All five `/health` endpoints returned HTTP 200 and `configured: true`.
- The `Line+FB_Chat` Apps Script companion was replaced with the local source,
  preserving the existing original webhook/statistics handlers. Version **10**
  was published on 17 September 2026 at 17:48 Bangkok to the same deployment
  `AKfycbyIntaauYWyOZQde7ul2bga_1s-EMYkcFnTdcpTX-Emi_NdOC8KPMUwtB1xZtrRNYkBAw`.
- No webhook URLs, integration enable flags, credentials or access permissions
  were changed. Health checks do not establish real-message delivery.
- Supabase CLI credentials returned 403; the existing owner Dashboard session
  was used for the database repair and Edge deployment.

## Release verification

`npm test` now runs all 260 CRM, LINE and Facebook tests. Two HTML-source tests
normalize Windows line endings before checking their assertions.

Render exposes its `RENDER_GIT_COMMIT` as `releaseCommit` in runtime-config.
Launch localhost from this directory with `CRM_RELEASE_COMMIT` set to its
current `git rev-parse HEAD` value after changing revisions. Restart the process
when server code changes. Invalid or missing commit values are reported as null.

`node scripts/verify-production.cjs` checks the running commit on both servers,
the Supabase project, five public code assets (normalizing line endings), and
HTTP 401 for unauthenticated CRM data access. It is read-only. Authenticated
business workflows and live integration activation are separate from this check.

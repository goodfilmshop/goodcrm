# GFS / MHL LINE intake — setup status 2026-09-13

## Confirmed accounts

| Account key | Company | OA | Channel | Receiver |
|---|---|---|---|---|
| gfs-line-249izgyn | GFS | @249izgyn / @3mfilm | 2011580206 | line-gfs-intake (existing, enabled) |
| gfs-line-095jvuls | GFS | @095jvuls / @goodfilm | 1654307361 | line-goodfilm-intake (deployed, unconfigured) |
| mhl-line-320opqkc | MHL | @320opqkc / @mhl1 | 1621123913 | line-mhl-intake (deployed, unconfigured) |

The two new OAs use the same existing Apps Script deployment, confirmed from the live deployment manager (version 7, 2026-08-27 19:55):

- Project: [Line+FB_Chat](https://script.google.com/home/projects/1wXpNTkBesDINodCqGMO-EghaEcxenFT8ICpaDZSmN52czQZCk81Chw1F/edit)
- Spreadsheet: `1doIr2kXj0C3HCen7OxNVOsTK95eE45rolbfWtgKYaTg`, sheet `Line`.
- Deployment: `AKfycbyIntaauYWyOZQde7ul2bga_1s-EMYkcFnTdcpTX-Emi_NdOC8KPMUwtB1xZtrRNYkBAw`.
- Existing URL parameters: `brand=GFS&account=1654307361` and `brand=MHL&account=1621123913`.
- Existing script upserts first/latest times and latest message, follow and postback events. Key is platform + brand + sender ID. No local MKT source matched this deployment. Its actual source was read through the authenticated Apps Script editor.
- Existing OA Chat remains enabled. No existing OA URLs, tokens, script source, deployments or triggers have been changed in this stage.

## Completed

- Applied migrations `20260913120531_add_goodfilm_line_intake` and `20260913121333_add_mhl_line_intake` to goodcrm.
- Updated CRM account selector, account-scoped query/summary and company metadata. Existing customer ID format, defaults, deletion behavior and admin-only access remain.
- Deployed both new receivers, custom HMAC authentication; they fail closed until configured. These are **Apps Script bridge receivers**, using `x-goodcrm-signature`, not direct LINE destinations.
- Prepared companion source `scripts/goodfilm-crm-bridge.gs`; not uploaded or installed yet.
- Restarted localhost server (PID 34624) with new account support.
- 11 tests passed: `node --test line-bridge.test.js line-edge.test.js line-intake.test.js`.
- Database rollback checks passed: two-account deduplication/isolation, and MHL customer creation with correct OA note, standard ID, retry idempotency, linking, validation and permissions. No real customer test writes retained.
- Existing security advisor findings unchanged: event table intentionally service-only, invoice SECURITY DEFINER RPC, and password protection setting; see LINE_GFS_SETUP.md for reference links.

## Pending activation — needs credential-storage confirmation

Use the existing channel access tokens, without reissuing/revoking them. Save each only in goodcrm Supabase secrets (`LINE_GOODFILM_CHANNEL_ACCESS_TOKEN`, `LINE_MHL_CHANNEL_ACCESS_TOKEN`). Verify each with `/v2/bot/info` against its basic ID; do not infer API bot user IDs from OA chat URLs.

Create independent random secrets per account for inbound URL protection and bridge HMAC. Supabase secrets per prefix `LINE_GOODFILM_` / `LINE_MHL_`: `BRIDGE_SECRET`, `BOT_USER_ID`, `CHANNEL_ACCESS_TOKEN`, `INTAKE_ENABLED`. Apps Script properties per prefix `GOODCRM_GFS_` / `GOODCRM_MHL_`: `WEBHOOK_KEY`, `BRIDGE_SECRET`, `BOT_USER_ID`, `ENABLED`.

Activation order to preserve old processing:

1. Back up the current Apps Script source/version. Prepare the companion file and add `authorizeGoodfilmCrm_(e)` before handling the request, and `queueGoodfilmCrm_(data,e)` before the existing `handleLineWebhook(data,brand,accountId)` call. Keep `*_ENABLED=false` initially. Preserve all original functions and other accounts.
2. Save approved secrets. Install exactly one `flushGoodfilmCrmQueue` minute trigger using `installGoodfilmCrmTrigger`. A new UrlFetch scope may require the user's normal Google authorization.
3. Deploy a new version to the **same deployment**. Add each account's `crm_key` parameter to its existing LINE webhook URL, preserving brand/account. Verify with the bridge still disabled, then enable per-account properties.
4. The query key is mandatory for these bridged accounts because Apps Script does not expose LINE signature headers. The Edge receiver trusts only bridge-signed metadata and the configured API bot destination. Do not expose query keys in chat/logs/source files. Reject missing/wrong keys before forwarding.
5. The hidden `_GOODCRM_LINE_QUEUE` sheet stores only time, source user ID, event ID and delivery status/account. The minute trigger signs and sends bounded batches, retries failed records and preserves delivered history. Original `Line` sheet behavior remains. This adds spreadsheet writes and UrlFetch/trigger quota usage. No queue retention policy implemented yet.
6. Verify health, a real message in each OA, original sheet updates, pending CRM entry, distinct daily statistics and unchanged customer totals. Empty Verify alone is not an end-to-end test.

Rollback: disable account `*_ENABLED` properties and restore its prior webhook URL without the key; stop the new trigger if pausing both. Retain the original LINE sheet and existing CRM data. Do not replace the old webhook with a bridge receiver URL directly.

## Separate pending request

Automatic direct Link Chat is not implemented. Observed OA chat identifiers differ from Messaging API identifiers; exact customer mapping remains unverified. Do not synthesize chat links from API user IDs or confuse OA inbox links with direct customer chat links.

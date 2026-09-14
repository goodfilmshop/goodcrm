# GFS LINE intake pilot — @249izgyn

Confirmed by the user on 2026-09-13: the intended account is **3M Dealer Support**, basic ID **@249izgyn**, premium ID **@3mfilm**, assigned to GFS in CRM. It is not the separate **บจก.กู๊ดฟิล์ม (@095jvuls)** account. After the user accepted the service terms, live inspection confirmed Messaging API active under **3M Dealer** provider (`2005534851`), channel `2011580206`. Chat remains enabled. The previously empty Webhook URL now points to the Supabase endpoint below. A new long-lived channel access token was issued with the user's authorization. Auto-reply messages and greeting messages remain enabled and unchanged.

Status (2026-09-13): pilot migration installed, Edge Function version 6 deployed, secrets configured, LINE Verify returned Success, and Use webhook, Webhook redelivery and Error statistics aggregation are enabled. The localhost server has been restarted and its authenticated queue displays configuration readiness. No outgoing messages are sent. The queue currently has zero contacts; a real LINE message test is still pending.

## Localhost deployment (selected by the user)

The user confirmed GOOD CRM runs only on `http://localhost:3000`. The receive-only Supabase Edge Function **line-gfs-intake** is deployed to the same goodcrm project; it does not expose the local computer. Its endpoint is:

`https://mbxuebqqglaeechltkyl.supabase.co/functions/v1/line-gfs-intake`

The endpoint verifies LINE's HMAC signature itself, so Supabase JWT verification is disabled for this function only. It fails closed until its configuration exists. It persists metadata with the already-tested ingestion RPC and enriches names in a background task. The server service credential stays inside Supabase; no service-role key is required on the local PC in cloud mode. Local `.env` now selects `LINE_GFS_INTAKE_MODE=cloud`, and the queue checks the function's `/health` endpoint for configuration readiness.

Configured **Edge Function Secrets**: `LINE_GFS_CHANNEL_SECRET`, `LINE_GFS_BOT_USER_ID`, `LINE_GFS_CHANNEL_ACCESS_TOKEN`, and `LINE_GFS_INTAKE_ENABLED=true`. Bot user ID `U0935eec41f6518c8613bab1d88af6869` was obtained from the token's `/v2/bot/info` response and basic ID verified as `@249izgyn`. Never use the developer's “Your user ID” as the bot user ID. No LINE credentials are stored in this document or the frontend.

The prior secrets-management access blocker is resolved: the user switched Supabase to the authorized `goodfilmshop` account, and secrets were saved through this project's dashboard. CLI secrets management still returned 403; do not switch projects or migrate existing CRM data to work around CLI access.

The localhost server was restarted to load cloud mode and the new queue API. The receiver remains online when the PC is off, subject to Supabase service availability. Test receipt from a real LINE user and confirm both the pending queue and unchanged customer totals before broad rollout. Existing MKT files and integrations have not been modified.

## Reconfiguration checklist (pilot is already connected)

1. Identify the deployed CRM URL and deployment checkout. Local files alone do not update the running service.
2. In LINE Developers, select the Messaging API channel belonging to **GFS @249izgyn**. Record the existing webhook URL and settings. If a URL is already in use, identify its owner and arrange forwarding before replacing it. Keep LINE OA Chat enabled.
3. Install only `supabase/migrations/20260913093152_add_line_gfs_intake.sql` if it is not already installed. Do not push all unrelated pending migrations.
4. Set the server-only variables listed in `.env.example` using the host's secret settings. Never paste credentials into chat or frontend files. `LINE_INTAKE_SUPABASE_SECRET_KEY` is a Supabase server secret / service-role credential; the existing browser publishable key is insufficient.
5. Validate the LINE channel access token by calling `GET https://api.line.me/v2/bot/info` from a trusted server tool. Confirm `basicId` is exactly `@249izgyn`; set `LINE_GFS_BOT_USER_ID` to the returned `userId`. Confirm the channel secret comes from the same channel. Do not rotate or revoke credentials used by MKT or another integration.
6. Deploy the server and frontend. Set `LINE_GFS_INTAKE_ENABLED=true` only after these checks. For the selected cloud mode, use the Supabase endpoint above. The alternative `https://<deployed-crm-host>/webhooks/line/gfs-249izgyn` is only for a separately deployed public CRM server with server-side credentials. Use LINE's Verify button, enable Use webhook and Webhook redelivery.
7. The exact webhook path accepts signed requests from outside Thailand. If a CDN/firewall also blocks countries, configure a narrowly scoped exception for this path, keeping the origin protected and the application's signature verification enabled.
8. Send one test message from a real user. Confirm it appears in **LINE รอคัดเข้า**, the daily unique total increments once, and CRM customer totals are unchanged. Send another message from the same user and check the total stays at one. Reply in the OA app, then confirm the reply checkbox and create or link the customer in CRM. Verify the OA app and the existing MKT schedule still work.

## Pilot behavior and limits

- New LINE customer IDs now match normal CRM creation: `CUST-YYMMDD-XXX`, using the Bangkok date and three uppercase hexadecimal characters. Migration `20260913110358_standard_line_customer_ids.sql` retries ID collisions up to five times against the existing unique constraint. It does not renumber existing customers. At deployment there were no remaining customers with the old `CUST-LINE-` prefix. SQL rollback verification passed for the format/date, repeat import idempotency, existing-customer linking, defaults and permissions; all 8 LINE tests passed. Security advisor findings remained unchanged from the deletion verification below.

- Customer deletion is supported by `20260913105921_allow_line_intake_customer_deletion.sql`: the LINE contact's foreign key uses `ON DELETE SET NULL`. The contact remains historically imported, preserving resolution time, daily counts and deduplication. The queue displays “ลูกค้าถูกลบแล้ว · เก็บประวัติการคัดเข้า” when an imported contact has no linked customer. Later messages do not recreate that customer or reopen the pending queue. Other customer relationships still enforce their own deletion rules.
- Deletion verification on 2026-09-13 passed using synthetic fixtures inside BEGIN/ROLLBACK: customer removed, intake/history retained, counts unchanged, duplicate and later messages handled, invalid customer links still rejected. No real customer was deleted. All 8 current LINE tests passed. Security advisor findings are outside this foreign-key change: intentional service-only event table without user RLS policies, the existing invoice SECURITY DEFINER RPC, and disabled leaked-password protection. References: [RLS advisory](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy), [RPC advisory](https://supabase.com/docs/guides/database/database-linter?lint=0029_authenticated_security_definer_function_executable), [password protection](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection).

- Only active CRM administrators can read or resolve the queue. GFS is fixed for this pilot; no other OA or company is enabled.
- Count only one-to-one user message events, not adding friends or group activity. Dates use Asia/Bangkok and LINE's event timestamp. Retries and out-of-order delivery are handled in the database transaction.
- Store user ID, first/last interaction time, per-day presence, opaque event IDs for deduplication, and an optional cached display name. No message body, attachments, reply token or profile photo is stored.
- In cloud mode, LINE profile names are fetched in a background task after receiving a message. In local mode, names may be fetched when an admin opens the queue. If unavailable, show the stable user ID. Names are not unique and cannot prove identity; verify before selecting an existing customer.
- New means first observed since this integration started. Previously known LINE users cannot be reliably classified from historical OA chats. Day totals cover the selected day; queue rows cover all days.
- “คัดเข้า CRM” counts identities created or linked on that day, not only newly created customer records. Linking does not create a customer. A new customer does not create a sales case automatically.
- An admin's checkbox is a manual confirmation of replying in OA; there is no automatic detection of an OA-app reply.
- No automatic expiry is currently configured for the pilot's metadata. Define retention before broad rollout. Dismissed identities remain for deduplication and statistics and do not reappear as new pending contacts.
- Delivery failures return an error so LINE can retry. Redelivery is not guaranteed; inspect LINE webhook error statistics if numbers appear incomplete.
- Disabling intake returns 503; stop LINE webhook delivery first when intentionally pausing, to avoid repeated failure alerts. Restore the previously recorded webhook when rolling back to a prior integration. Stored queue records remain available.

## Verification

### Additional OA activation checkpoint (2026-09-13)

- Goodfilm `@095jvuls` and MHL `@320opqkc`: cloud receivers deployed and existing tokens verified against each bot identity. Receiver secrets saved in Supabase; no tokens rotated.
- Google authorization completed. `testGoodcrmConnections` logged PASS for both channel IDs at 19:46:45 Bangkok.
- Existing Apps Script `Line+FB_Chat` source includes the metadata queue and connection-test function. Eight script properties saved; both `GOODCRM_GFS_ENABLED` and `GOODCRM_MHL_ENABLED` are now `true`.
- The SAME deployment was updated from version 7 to version 8 at 19:48 Bangkok, preserving the deployed URL and original Sheet handler. Each LINE URL now includes its account-specific configured `crm_key`; do not copy those URLs into documentation or logs.
- LINE Verify returned Success for both accounts after enabling. Use webhook and redelivery are enabled on both. Existing error aggregation remains enabled on GFS and disabled on MHL.
- One minute trigger `flushGoodfilmCrmQueue` installed successfully; trigger screen shows a successful execution at 19:50:51 and 0% errors. Queue retries failed deliveries and stores metadata only. Existing original `Line` sheet handling runs before queue insertion.
- Real-message verification is still pending: user asked to message @goodfilm and @mhl1 from personal LINE and identify the test display name. At 19:52 the new account queues had no contacts. Verify pending rows, unchanged customer totals and original Sheet updates before claiming end-to-end delivery.
- Local verification at this checkpoint: 11/11 LINE tests passed. This is not evidence of live end-to-end delivery for the two new accounts.

Run `npm run test:line-intake` and the existing `npm test` suite. Database integration checks should run inside BEGIN/ROLLBACK, including duplicate delivery, Bangkok midnight, repeat promotion, linking existing customers, and RLS denial for non-admins. Do not use production customer records as test targets.

Verified on 2026-09-13: all 7 LINE tests passed; SQL rollback checks passed for deduplication, midnight, idempotent create, linking, and unauthorized access. The UI was exercised using an isolated local fixture. The actual authenticated localhost queue loads successfully with zero contacts. LINE Verify succeeded after removing the SDK import to reduce Edge cold-start time; an empty signed verification event returns immediately after signature and destination validation, while actual messages require database commit before acknowledgment. Use webhook, redelivery and error aggregation were confirmed checked in the LINE page. A real user message has not yet been tested. Existing suite: 210/211 passed; the pre-existing `case history includes the case creation entry counted by the case list` test also fails with the LINE server additions removed (mock expects `lead_follow_up_history`, actual code requests `crm_invoices`). No MKT code was changed. The event deduplication table deliberately has RLS enabled without user policies: only the server service role can access it.

# Facebook intake checkpoint — 2026-09-13

User confirmed GFS pages 125106670932394 and 101634951180913; MHL page 109607531869658. Existing Meta app CRM_LEAD: 1703232694436408. All three pages are subscribed to messages, messaging_optins and messaging_postbacks. Existing callback points to the shared Line+FB_Chat Apps Script. Inspection of the saved original source found only LINE handling; do not infer successful Facebook storage from the project's name.

Implemented and installed separate facebook_intake_contacts/events/days tables, administrator RLS, receive/daily-summary/resolve functions, normal customer IDs and ON DELETE SET NULL. No changes to LINE tables or Apps Script. Local UI has a separate Facebook intake menu and three page tabs. Server restarted on port 3000, PID 15560.

Receiver deployed as facebook-intake v1, JWT disabled because POST requires raw-body x-hub-signature-256 HMAC and GET challenge requires a matching verification token. Fail closed until secrets and enabled flag exist. Incoming message metadata only; echoes ignored; page allowlist; duplicate events deduplicated. Profile enrichment is optional and needs Page tokens plus Meta profile permissions; fallback is the Page-scoped sender ID. No outbound messages.

## Activation update — 2026-09-13 21:43 Bangkok

User explicitly approved storing the app secret and three Page tokens in this Supabase project and changing the Facebook callback, then completed Meta password reauthentication. Stored FACEBOOK_APP_SECRET, FACEBOOK_VERIFY_TOKEN, FACEBOOK_INTAKE_ENABLED=true and the two GFS Page tokens. The cloud health endpoint returns configured=true with all three allowed Page IDs. Meta successfully saved the new Supabase callback; reopening its configuration shows the persisted URL and masked verification token. LINE settings and Apps Script remain unchanged.

MHL token storage completed at 21:46:57 Bangkok after the user specifically approved retrying its generation. FACEBOOK_PAGE_TOKEN_109607531869658 now appears in Supabase Secrets. The earlier automatic-review rejection is resolved. All three Page tokens are stored; actual profile enrichment still needs an inbound-message test.

Meta's messages v25.0 webhook test succeeded at 21:47:45 Bangkok. This verifies delivery of Meta's signed sample to the receiver, not real customer intake: the sample uses an unknown Page ID and is intentionally ignored. A subsequent aggregate query returned no Facebook contacts. Ask the user to send a new Messenger message to each of the three Pages, then verify per-Page pending contacts and names. Do not create or send customer messages on the user's behalf without specific authorization.

## Remaining activation

- Credential storage and Facebook callback change are completed and explicitly approved. Never print or commit credentials. Do not rotate existing credentials.
- Secret names: FACEBOOK_APP_SECRET, FACEBOOK_VERIFY_TOKEN, FACEBOOK_INTAKE_ENABLED; optional FACEBOOK_PAGE_TOKEN_125106670932394, FACEBOOK_PAGE_TOKEN_101634951180913, FACEBOOK_PAGE_TOKEN_109607531869658.
- Saved callback: https://mbxuebqqglaeechltkyl.supabase.co/functions/v1/facebook-intake . LINE webhook URLs and Apps Script remain intact.
- pages_messaging and pages_manage_metadata show Standard access and no submitted App Review. Do not claim general-customer support before checking access requirements and completing Meta review as applicable. Keep normal Business Suite replies. Test actual incoming messages for each page, including a non-app-role user before broad rollout.
- Verify actual inbound messages and profile enrichment separately; health/configuration success alone does not prove end-to-end message delivery or general-customer access.

## Validation

13/13 Facebook + LINE tests passed. SQL creation, duplicate receipt and customer promotion were tested inside BEGIN/ROLLBACK; duplicate receipt produced one contact and zero automatic customers, promotion produced contact_channel Facebook with normal CUST-YYMMDD-XXX ID. No permanent test customers. Migration installed successfully after an automatic-review rejection referencing a superseded duplicate draft was resolved by checking the corrected file and rollback tests.

Security advisor: facebook_intake_events has RLS with no client policies intentionally (service-role only), same as LINE events. Existing invoice SECURITY DEFINER and password protection warnings are unrelated. References: [event RLS](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy), [invoice definer](https://supabase.com/docs/guides/database/database-linter?lint=0029_authenticated_security_definer_function_executable), [password protection](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection).

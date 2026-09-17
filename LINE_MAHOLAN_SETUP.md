# LINE OA รถยนต์ · @maholan

Status 2026-09-17: prepared and tested, **not yet receiving real LINE events**.

- Basic ID: @fkq6145q; premium ID: @maholan
- Channel: 1657810104; provider: CAR
- CRM account key: car-line-fkq6145q
- Verified bot user ID: Uc4fb0b71602dff676e192ad957f33c8a
- Receiver: line-maholan-intake in project mbxuebqqglaeechltkyl
- Local migration 20260917075626 applied through SQL Editor (CLI account returned 403). Migration history is not recorded by the dashboard query; do not blindly reapply.
- Receiver deployed through dashboard as a single-file equivalent of handler.mjs + index.ts. JWT verification off; request HMAC and bot destination are checked. Health returned configured:true.
- Secrets LINE_MAHOLAN_CHANNEL_ACCESS_TOKEN, LINE_MAHOLAN_BRIDGE_SECRET, LINE_MAHOLAN_INTAKE_ENABLED saved in Supabase. Existing token reused, not rotated.
- Apps Script Line+FB_Chat deployment updated to version 9 (17 Sep 2026 15:15 Bangkok), preserving the existing URL and statistics handler. Only GOODCRM_ACCOUNTS mapping extended.
- GOODCRM_CAR_BOT_USER_ID, BRIDGE_SECRET, WEBHOOK_KEY saved in Script Properties. GOODCRM_CAR_ENABLED is deliberately false until webhook URL is ready.
- testGoodcrmConnections passed for channels 1621123913, 1654307361 and 1657810104 at 15:17 Bangkok. This test sends empty event arrays, not customer messages.
- Local intake tests: 12/12 passed. CRM restarted and fourth tab verified.

## Remaining activation

Browser automatic approval rejected adding crm_key to the LINE webhook URL because explicit approval did not yet cover transmitting a secret in a URL. A specific approval question is pending. **Do not bypass this rejection.**

After explicit approval, append the existing GOODCRM_CAR_WEBHOOK_KEY from Script Properties as crm_key to the current LINE webhook URL. Preserve brand=CAR and account=1657810104 and the existing Apps Script deployment path. Do not print or save the key in repository files.

Then set GOODCRM_CAR_ENABLED=true in Script Properties, verify the LINE webhook and verify an actual inbound message reaches the car account's pending list and existing statistics. No customer data should be created merely to test connectivity. No outbound messages are authorized.

If approval is declined, leave the CAR bridge disabled and the original LINE webhook unchanged.

# NEXORA Supabase migration status

This document describes the staged Firebase-to-Supabase migration on `feature/nexora-social-economy-mobile-overhaul`.

## Safety and cutover policy

- Firebase Auth remains the identity provider during the transition. Firebase UIDs are preserved.
- Firebase Firestore remains the authoritative game-data path by default.
- All `VITE_NEXORA_SUPABASE_*` switches below are opt-in and default to disabled when unset.
- Do not enable all switches together. Enable one domain at a time after real-player parity tests.
- Do not disable Firebase, merge PR #7, or promote the new frontend until all writes, reads, scheduled jobs, and reconciliation checks pass.
- NEXORA data is isolated in the `nexora` schema. Never alter the separate `public` schema.

## Supabase Edge Function

- Function: `nexora-economy`
- Latest deployed version at this checkpoint: verify in Supabase before release; economy and player-data functions have been redeployed during this migration wave.
- Gateway JWT verification is disabled because the function validates Firebase ID tokens itself (issuer, audience, signature, verified email, and non-anonymous provider).
- Service-role credentials are used only inside the Edge Function. RPC execution is revoked from `public`, `anon`, and `authenticated`.

## Implemented server-side operations

- Player onboarding and username availability.
- Wallet transfers with deterministic request IDs and wallet row locking.
- Daily stipend claims, skill upgrades, mission rewards, and trade-contract fulfillment.
- Market listing creation, purchase, cancellation, and purchase escrow/tax calculation.
- Manufacturing with server-side recipe/material validation.
- Property purchase, upgrade, rent collection, and lease toggling.
- Company founding, company-level upgrades, company revenue collection, and profit-vault upgrades/completion.
- Company auctions: creation, escrowed bids, outbid refunds, idempotent retries, settlement, ownership transfer, and audit/notification records.
- Social workflows: player search/public profiles, direct conversations/messages, global chat, blocks, reports, and organization invitations/acceptance.
- Server-validated achievement unlocking.
- Organization creation, join/leave, join-request decisions, member removal, role changes, join-mode changes, membership synchronization, treasury deposit/withdrawal, organization level upgrades, and research.
- Player settings, avatar changes, and notification read-state updates.

## Opt-in frontend switches

All are disabled unless explicitly set to the string `true`:

- `VITE_NEXORA_SUPABASE_SHADOW_READS`
- `VITE_NEXORA_SUPABASE_TRANSFERS`
- `VITE_NEXORA_SUPABASE_DAILY_STIPEND`
- `VITE_NEXORA_SUPABASE_SKILLS`
- `VITE_NEXORA_SUPABASE_MARKET`
- `VITE_NEXORA_SUPABASE_MISSIONS`
- `VITE_NEXORA_SUPABASE_CONTRACTS`
- `VITE_NEXORA_SUPABASE_PROPERTIES`
- `VITE_NEXORA_SUPABASE_MANUFACTURING`
- `VITE_NEXORA_SUPABASE_PROFILE`
- `VITE_NEXORA_SUPABASE_ACCOUNT`
- `VITE_NEXORA_SUPABASE_COMPANIES`
- `VITE_NEXORA_SUPABASE_ORG_TREASURY`
- `VITE_NEXORA_SUPABASE_ORGANIZATIONS`
- `VITE_NEXORA_SUPABASE_COMPANY_AUCTIONS`
- `VITE_NEXORA_SUPABASE_SOCIAL`
- `VITE_NEXORA_SUPABASE_ACHIEVEMENTS`
- `VITE_NEXORA_SUPABASE_PLAYER_READS`

## Remaining migration work before cutover

- Replace the remaining Firestore migration exporter. The current `api/migration-export.ts` still uses Vercel OIDC with Google Cloud Workload Identity Federation; a GitHub OIDC trust provider or a dedicated Supabase export credential must be configured before this can be removed.
- Baseline source-vs-target row-count reconciliation matched across all 29 imported top-level/subcollection mappings: 194 unique Firestore source paths in `firestore_import_payloads`, 194 target rows, and zero per-collection count deltas before the later synthetic concurrency QA accounts were added. Exclude the two documented `nx_conc_` QA accounts and their immutable test ledger rows from subsequent source reconciliation. `migration_batches` contains repeated batch attempts with different checksums, so summing `row_count` across batches overstates the unique source count; use `firestore_import_payloads` unique `source_path` counts for reconciliation. Per-collection cryptographic source checksums and a fresh GitHub exporter scan are still pending.
- Finish moving any residual game mutations that are still intentionally on Firebase, then verify each domain independently.
- Run an authenticated end-to-end test using a verified player session. Synthetic database tests cover core auction, social, and achievement workflows, but no live Firebase-authenticated player session has been tested.
- Run concurrency tests against parallel authenticated requests, including same-request retries, wallet conservation, auction escrow, and ownership transfer.
- Wait for CI to pass on the final PR head, then perform a supervised production cutover with a rollback window.

## Scheduled jobs

- Supabase `pg_cron` jobs are configured for company-auction settlement (every minute) and world-event rotation (every six hours).
- Both jobs call gated wrapper functions. `nexora.scheduler_flags` currently keeps both disabled so Supabase does not diverge from Firebase before cutover.
- Keep the existing Firebase scheduled functions enabled until reconciliation and cutover are approved.

## Verification notes

- SQL migrations are applied to the Supabase project; the economy and player-data Edge Functions have been redeployed.
- Synthetic transaction-scoped tests exercised company auction creation, two bids, escrow refund, settlement, idempotent retries, social messaging, blocks, reports, organization invites, and achievement unlocks. Test data was rolled back; no test records remain.
- Read-only reconciliation checks found no negative wallets, orphan wallet/inventory/company/property/member rows, mismatched organization member counts, or missing wallet `last_tx_id` references. The six system-reserve listings use `seller_uid=SYSTEM` intentionally.
- RPC privilege checks confirm service-role execution while `authenticated` is denied.
- The new player-data polling path and Social Hub Supabase path are opt-in; Firebase remains the default.
- A live authenticated player session, parallel live concurrency tests, per-collection cryptographic checksums, and a successful GitHub OIDC export/import run have not yet been verified. CI run 420 passed on the branch head before the latest Migration Console notice update; rerun CI for the latest commit before cutover. Do not describe the migration as complete until those checks pass.


## Scheduler cutover and rollback

- Supabase cron entries are active, but their guarded wrapper functions return `CUTOVER_DISABLED` while the corresponding `nexora.scheduler_flags.enabled` value is false.
- Firebase scheduled functions remain the active production schedulers by default.
- The Firebase scheduled callbacks now honor `NEXORA_SUPABASE_SCHEDULERS_ACTIVE=true` as an explicit cutover guard. Set it only after verifying the Supabase jobs and then enable the matching Supabase scheduler flags. Do not enable one side without disabling the other.
- Rollback order: set both Supabase scheduler flags to false first, then unset `NEXORA_SUPABASE_SCHEDULERS_ACTIVE` in Firebase Functions and redeploy the scheduled functions.
- This environment variable is intentionally not set by this migration. No scheduled production workload has been switched.


## Read parity hardening

- `useGameData.ts` now has a guarded Supabase player snapshot path. It is eligible only when the player-read flag and every required game write-domain flag are all enabled; otherwise the hook stays on Firebase (or performs an opt-in shadow read).
- The Supabase snapshot and Firebase fallback now use deterministic order/limit windows for transactions, listings, orders, company logs, notifications, organization requests, and organization treasury history.
- Added matching Firestore composite indexes in `firestore.indexes.json`; the Firebase rules deployment workflow now deploys those indexes alongside rules.
- Added a read-only **real-player parity check** to the Migration Console. It uses the signed-in Firebase player's own session to compare profile/private data, wallet, inventory, transactions, market, companies, auctions, properties, organizations, missions, claims, achievements, notifications, and world events against the Supabase player-data endpoint. It does not mutate player data.
- The parity check is implemented but has not yet been run with the owner's live signed-in player session. It must report zero differences before the read switch is enabled.


## Parallel wallet transfer QA (2026-11-18)

- Ran two simultaneous transfers of 80 credits from a synthetic 100-credit sender. Exactly one committed; the other returned `INSUFFICIENT_FUNDS`. Final balances were sender 20 / recipient 80, with one transfer ledger row.
- Ran two simultaneous calls with the same request UUID and 5-credit payload. One committed and one returned `replayed: true`; only one additional debit and one additional transaction were recorded.
- Reused that request UUID with a different amount; the RPC rejected it with `REQUEST_ID_CONFLICT`.
- The wallet conservation check passed: sender + recipient balance remained 100 credits through all cases.
- The database's immutable ledger trigger prevents deletion of committed transaction/audit rows. Two synthetic QA profiles and their wallets/usernames remain, marked with `QA TEST` titles and `QAConc...` usernames; their two immutable transfer rows and two immutable audit rows are intentionally retained as an audit trail. Test notifications were removed. These QA records must be excluded from Firestore source reconciliation and must never be imported back into Firebase.
- Post-test integrity checks: zero negative wallets, zero orphan wallets/inventory/companies/properties/organization members, and zero organization member-count mismatches.
- This is a synthetic concurrent database test, not a real-player authenticated session test. The Migration Console now includes a read-only real-player parity check for the owner to run after Pages is enabled.

## Imported real-player archive reconciliation

The imported Firestore archive for the actual player UID was compared directly with the matching Supabase rows (this validates the archived source snapshot; it is not yet a live Firebase-authenticated session test):

- Exact field-level matches: profile, private settings, username mapping, and wallet balance/earned/spent/last transaction fields.
- Exact count matches: inventory 9, transactions 84, company 1, company logs 43, market listings 2, market orders 17, organization membership 1, player missions 5, daily claims 3, contract claims 7, achievements 4, notifications 4, and properties 0.
- Field-level comparison returned zero mismatches for all 84 transaction records, all 9 inventory rows, the company row, all 43 company logs, and all 17 market orders.
- This is strong archived-data parity evidence. The live-player Migration Console check is still required because the archive snapshot predates this QA session and cannot prove the running Firebase session is current.

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
- Source-vs-target row-count reconciliation now matches exactly across all 29 imported top-level/subcollection mappings: 194 unique Firestore source paths in `firestore_import_payloads`, 194 target rows, and zero per-collection count deltas. `migration_batches` contains repeated batch attempts with different checksums, so summing `row_count` across batches overstates the unique source count; use `firestore_import_payloads` unique `source_path` counts for reconciliation. Per-collection cryptographic source checksums and a fresh GitHub exporter scan are still pending.
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

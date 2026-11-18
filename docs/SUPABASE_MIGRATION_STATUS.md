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
- Latest deployed version at this checkpoint: v21, ACTIVE
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

## Remaining migration work before cutover

- Complete the company auction lifecycle (create, bid escrow/refund, settlement, and scheduled settlement).
- Move remaining social systems: direct/global chat, player blocking/reporting, organization invitations, and conversation messages.
- Move achievement unlock writes and remaining player/org mutations.
- Replace Firestore snapshot reads in `useGameData.ts` with a verified Supabase read path only after all write paths for the same domains have been moved.
- Replace the Firestore migration exporter and scheduled/world-event jobs; retain the existing Firebase jobs until parity is proven.
- Add end-to-end tests using a verified test player, including concurrent requests, idempotent retries, wallet conservation, ownership checks, and full source-vs-target reconciliation.
- Run full CI on the final PR head and perform a supervised production cutover with a rollback window.

## Verification notes

- SQL migrations are applied to the Supabase project and the economy Edge Function is deployed.
- Safe validation tests exercise invalid-input and missing-record branches without modifying real player data.
- RPC privilege checks confirm `service_role` can execute the migration RPCs and `authenticated` cannot.
- A live authenticated player session and full end-to-end parity run have not yet been verified. Do not describe the migration as complete until those checks pass.

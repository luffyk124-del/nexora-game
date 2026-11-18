# NEXORA Firebase → Supabase migration audit

Updated: 2026-11-18

## Scope and safety boundary
- Firebase project: `gen-lang-client-0074900177`.
- Firestore database: `ai-studio-74843d9e-8228-49b7-a616-317cadd90bff`.
- Destination: existing OneState Supabase project `dmeupqmhsyojxlgalxrc`, isolated schema `nexora`.
- Do not modify OneState's `public` schema or its data.
- Keep Firebase operational until import, reconciliation, and rollback gates pass.
- Supabase `nexora` has no imported game rows yet; this does not prove Firestore is empty.

## Firestore collections found in source

### Realtime subscriptions in `src/hooks/useGameData.ts`
`profiles`, `users_private`, `wallets`, `inventory`, `transactions`, `market_listings`, `market_orders`, `companies`, `company_auctions`, `company_logs`, `properties`, `organizations`, `organization_members`, `organization_requests`, `organization_transactions`, `player_missions`, `daily_claims`, `contract_claims`, `player_achievements`, `notifications`, `world_events`.

### Additional collections in `src/services/gameService.ts`
- `usernames`: username uniqueness index; stores `uid`, `username`, `createdAt`.
- `audit_logs`: administrative/economy audit records.
- The service also reads/writes the subscribed collections above.
- `test` is only a Firebase connectivity probe, not game data.

### Destination mapping
- `profiles` → `nexora.player_profiles`
- `users_private` → `nexora.player_private`
- Other game collections map to same-named tables with snake_case columns.
- `company_auctions` and `usernames` destination tables have now been created.
- Game fields missing from `companies`, `organizations`, and `world_events` have now been added.

## Schema work completed (2026-11-18)
Migration `20261118052000_nexora_game_schema_completion_v1.sql` was applied to the existing Supabase project and committed on this branch. It:
- Added company vault, upgrade, owner-name, and auction metadata fields.
- Added organization capacity, join mode, research, and upgrade fields.
- Added world-event descriptions, sector targeting, revenue multiplier, and stack group.
- Created `nexora.company_auctions` and `nexora.usernames`.
- Expanded the transaction type constraint to include auction bid/refund/sale and vault-upgrade operations.
- Kept RLS enabled and revoked direct `anon`/`authenticated` access to both new tables.

Verification confirmed both new tables have RLS enabled and neither `anon` nor `authenticated` can SELECT them. No OneState `public` objects were touched.

### Remaining known schema mismatch
- `nexora.company_logs.details` is JSONB, while the TypeScript model currently treats it as a string. This needs a deliberate adapter or a separately reviewed type migration before imports; it was not silently changed.

## Server-side Firebase functions that must be migrated
The current Functions source exports:
- `upgradeCompanyProfitVault`
- `collectCompanyRevenueSecure`
- `nexoraDiagnostics`
- `rotateWorldEvents`
- `joinOrganizationSecure`
- `leaveOrganizationSecure`
- `approveOrganizationJoinRequestSecure`
- `kickOrganizationMemberSecure`
- `setOrganizationJoinModeSecure`
- `createCompanyAuctionSecure`
- `placeCompanyAuctionBidSecure`
- `settleExpiredCompanyAuctions`
- `searchPlayersSecure`
- `listBlockedPlayersSecure`
- `blockPlayerSecure`
- `unblockPlayerSecure`
- `reportPlayerSecure`
- `openDirectConversationSecure`
- `sendDirectMessageSecure`
- `sendGlobalChatMessageSecure`
- `invitePlayerToOrganizationSecure`
- `respondOrganizationInviteSecure`
- `getPublicPlayerProfileSecure`

These operations include wallet/economy transactions, organization permissions, auction escrow, moderation, and messaging. They must be reimplemented as trusted server-side operations (Supabase Edge Functions and narrowly scoped SQL RPCs) before switching client write paths.

## Identity migration requirement
Firebase UIDs and Supabase Auth user IDs are different identity namespaces. Preserve original Firebase UIDs as stable legacy IDs and create a trusted mapping from Supabase Auth ID to Firebase UID. Do not match accounts using unverified email addresses, and never let clients choose or edit their own legacy UID mapping. Guest accounts need a separate recovery strategy.

## Data export/import blocker
No connected Firebase Admin / Firestore export-import tool is currently available in this execution environment. Supabase tools manage the destination but cannot export Firestore documents. No Firestore data has been copied. A trusted Firestore export or authorized Admin SDK transfer path is required, followed by batched import with collection counts, checksums, and reconciliation.

## Required migration sequence
1. Finalize the source collection/type contracts, including the remaining company-log details mismatch.
2. Design and implement the trusted Supabase identity mapping.
3. Migrate all Firebase callable/scheduled functions to trusted Edge Functions/RPCs and test economy invariants.
4. Export Firestore through an authorized Admin path and import only into `nexora`.
5. Reconcile collection counts, ownership, wallet totals, ledger entries, auctions, organization membership, and moderation records.
6. Run isolated integration tests and mobile QA against the Supabase-backed game branch.
7. Switch the game and reports center only after all gates pass; retain Firebase rollback until post-release reconciliation.

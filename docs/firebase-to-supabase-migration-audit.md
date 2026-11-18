# NEXORA Firebase → Supabase migration audit

Updated: 2026-11-18

## Scope and safety boundary

- Firebase project: `gen-lang-client-0074900177`.
- Firestore database: `ai-studio-74843d9e-8228-49b7-a616-317cadd90bff`.
- Supabase destination: existing OneState project `dmeupqmhsyojxlgalxrc`, isolated schema `nexora`.
- Do not modify the OneState `public` schema or its tables.
- Do not delete, pause, or disable Firebase. Keep Firebase as the live source until import and reconciliation pass.
- Supabase `nexora` currently has no imported game rows. This does not prove Firestore is empty.

## Firestore collections found in the game source

### Realtime subscriptions in `src/hooks/useGameData.ts`
`profiles`, `users_private`, `wallets`, `inventory`, `transactions`, `market_listings`, `market_orders`, `companies`, `company_auctions`, `company_logs`, `properties`, `organizations`, `organization_members`, `organization_requests`, `organization_transactions`, `player_missions`, `daily_claims`, `contract_claims`, `player_achievements`, `notifications`, `world_events`.

### Additional collections written/read by `src/services/gameService.ts`
- `usernames` — username uniqueness index; document payload includes `uid`, `username`, `createdAt`.
- `audit_logs` — administrative/economy audit records.
- The service also reads/writes the collections listed above.

### Name mapping already present in the destination schema
- `profiles` → `nexora.player_profiles`
- `users_private` → `nexora.player_private`
- Other collections mostly map to same-named tables, with snake_case columns.
- `company_auctions` and `usernames` do not yet have destination tables.
- `test` is only used by the Firebase connectivity probe, not game data.

## Confirmed schema gaps

These are code/schema differences that must be resolved before switching the game client or server writes:

1. `nexora.companies` is missing game fields: `owner_name`, `vault_level`, `vault_balance`, `level_upgrade_started_at`, `level_upgrade_ends_at`, `level_upgrade_target_level`, `level_upgrade_cost`, `vault_upgrade_started_at`, `vault_upgrade_ends_at`, `vault_upgrade_target_level`, `auction_id`, `auction_ends_at`, `auction_status`.
2. `nexora.organizations` is missing `member_capacity`, `join_mode`, `research`, `upgrade_started_at`, `upgrade_ends_at`, `upgrade_target_level`.
3. `nexora.world_events` is missing `description_ar`, `description_en`, `affected_sectors`, `revenue_multiplier`, `stack_group`.
4. `nexora.company_logs.details` is currently JSONB, while the TypeScript game model expects a string. Resolve this deliberately in the migration contract rather than silently coercing records.
5. `nexora.transactions.type` currently excludes auction ledger values emitted by Cloud Functions: `company_auction_bid`, `company_auction_refund`, and `company_auction_sale`. The game also emits `company_collect` and `company_vault_upgrade`; confirm the full allowed set against every server transaction write before changing the constraint.
6. `company_auctions` requires a destination table for auction state and escrow metadata.
7. `usernames` requires a destination table with a unique normalized username key and a Firebase UID reference.

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

These operations include wallet/economy transactions, organization permission checks, auction escrow, moderation, and messaging. They must be reimplemented as trusted server-side operations (e.g. Supabase Edge Functions and narrowly scoped SQL RPCs) before any client-side write path is switched.

## Identity migration requirement

Firebase UIDs and Supabase Auth user IDs are different identity namespaces. Preserve every original Firebase UID as a stable legacy identifier and create a trusted mapping from the authenticated Supabase user ID to the original Firebase UID. Do not rewrite ownership references by matching unverified email addresses, and do not allow a client to choose or alter its own legacy UID mapping. Guest accounts need a separate migration/recovery strategy because they may not have a verified email identity.

## Data export/import blocker

No connected Firebase Admin / Firestore export-import tool is currently available in this execution environment. The Supabase project tools can manage the destination but cannot export source Firestore documents. Do not claim that any Firestore data has been copied. A trusted Firestore export or authorized Admin SDK transfer path is required; then import in batches with counts, checksums, and reconciliation by collection.

## Required migration sequence

1. Freeze and document the source collection/type contracts; keep Firebase operational.
2. Complete the destination schema and constraints for every collection and server operation.
3. Implement Supabase Auth identity mapping and trusted server-side game operations.
4. Export Firestore using an authorized Admin path and import into `nexora` only.
5. Reconcile document counts, user ownership, wallet totals, transaction ledgers, auctions, organization membership, and report/audit records.
6. Run isolated integration and mobile tests against the Supabase-backed branch.
7. Switch the game and reports center only after gates pass; preserve rollback to Firebase until post-release verification completes.

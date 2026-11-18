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
- `test` is only a Firebase connectivity probe, not game data.

### Destination mapping
- `profiles` → `nexora.player_profiles`
- `users_private` → `nexora.player_private`
- Other game collections map to same-named tables with snake_case columns.
- `company_auctions` and `usernames` destination tables have been created.
- Missing company, organization, and world-event fields have been added.

## Schema work completed (2026-11-18)
Migrations committed on this branch and applied to the existing Supabase project:
- `20261118052000_nexora_game_schema_completion_v1.sql`: adds company vault/upgrade/auction fields; organization capacity/join/research/upgrade fields; world-event descriptions/targeting/multipliers; creates `company_auctions` and `usernames`; expands allowed transaction types.
- `20261118052500_nexora_user_identity_map_foundation_v1.sql`: creates the locked `nexora.user_identity_map` table linking a Supabase Auth UUID to a verified legacy Firebase UID.
- `20261118053000_nexora_service_role_schema_access_v1.sql`: grants schema/table/function access to `service_role` only and sets default privileges for future NEXORA objects.

Verification confirmed:
- New tables have RLS enabled.
- `anon` and `authenticated` cannot read the new tables or reports.
- `service_role` has schema usage and required server-side privileges.
- The reports status/audit RPC remains restricted to `service_role`.
- No OneState `public` objects were touched.

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

These operations include wallet/economy transactions, organization permissions, auction escrow, moderation, and messaging. They must be reimplemented as trusted server-side operations before switching client write paths.

## Identity migration requirement
Firebase UIDs and Supabase Auth user IDs are different identity namespaces. The locked `nexora.user_identity_map` foundation now exists, but it contains no mappings. Preserve original Firebase UIDs as stable legacy IDs. Link accounts only after validating a Firebase ID token or completing a trusted admin-reviewed recovery; do not match by unverified email or let clients choose their legacy UID. Guest accounts need a separate recovery strategy.

## Owner-gated Firestore export endpoint added

- Added `api/migration-export.ts` on the unpublished game branch.
- Uses the existing Vercel OIDC → Google Workload Identity Federation → NEXORA runtime service-account path; no static Google service-account private key is introduced.
- Requires a verified, non-anonymous Firebase ID token and an existing owner authorization source: `diagnosticsOwner` custom claim, the existing server-side diagnostics UID/email allowlist, or `diagnostics_admins/{uid}` with `enabled=true` and `role='owner'`.
- Collection names are fixed to the audited NEXORA allowlist; the client cannot provide arbitrary Firestore paths or queries.
- Exports one bounded page (maximum 100 documents) at a time and returns an opaque continuation token. Responses are marked no-store.
- The endpoint has been committed but is not deployed; CI is still validating it. It must remain behind the draft PR until owner authorization and pagination tests pass.
- This endpoint only exports; it does not write to Firestore or Supabase and does not itself complete migration.

## Data export/import path

No direct Firebase Admin / Firestore connector is attached to this ChatGPT session. However, the existing Vercel API routes `api/company-vault.ts`, `api/organization-create.ts`, `api/organization-upgrade.ts`, and `api/account-delete.ts` already use Vercel OIDC plus Google Workload Identity Federation (`IdentityPoolClient`) to impersonate the NEXORA runtime service account and access the named Firestore database.

This provides a viable foundation for a new **admin-gated, paginated export endpoint** without Cloud Shell or a static Google service-account key. That exporter has not yet been implemented or deployed. It must verify an authorized owner before returning any source records, and the import side must write only to schema `nexora`.

No Firestore documents have been copied yet. A controlled export/import bridge must be implemented and tested, followed by collection counts, checksums, and reconciliation. Do not expose an unauthenticated export endpoint or return bulk player data to a public client.

## Required migration sequence
1. Finalize source collection/type contracts, including the company-log details mismatch.
2. Implement and test the trusted identity-linking flow.
3. Migrate Firebase callable/scheduled functions to Edge Functions/RPCs and test economy invariants.
4. Configure the `nexora` schema as an exposed Data API schema while keeping client table grants revoked.
5. Export Firestore through an authorized Admin path and import only into `nexora`.
6. Reconcile collection counts, ownership, wallet totals, ledger entries, auctions, organization membership, and moderation records.
7. Run isolated integration tests and mobile QA against the Supabase-backed game branch.
8. Switch the game and reports center only after all gates pass; retain Firebase rollback until post-release reconciliation.

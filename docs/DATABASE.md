# NEXORA Firestore Database & Security Schema

- **Official Database Engine**: Cloud Firestore Enterprise Edition
- **Database ID**: `ai-studio-74843d9e-8228-49b7-a616-317cadd90bff`
- **Formal Entity Blueprint**: `firebase-blueprint.json`
- **Enforced Security Rules**: `firestore.rules`

---

## 1. Collections & Document Structure

| Collection Path | Purpose | Ownership & Visibility | Key Fields |
| :--- | :--- | :--- | :--- |
| `test/connection` | Startup server connectivity check | Public `get` only | Health check path |
| `profiles/{uid}` | Public player progression & stats (zero PII) | Owner create/update (action-gated); signed-in read (`influence >= 0` list) | `uid`, `username`, `usernameLower`, `avatarId`, `title`, `level`, `xp`, `reputation`, `influence`, `skillPoints`, `skills`, `stats`, `orgId` |
| `usernames/{usernameLower}` | Unique lowercase username reservation | Signed-in `get`; create once by owner UID | `uid`, `username`, `createdAt` |
| `users_private/{uid}` | Owner-isolated PII & settings | Strictly `request.auth.uid == uid` | `uid`, `email`, `language`, `notificationsEnabled` |
| `wallets/{uid}` | Player N-Credits balance & totals | Owner `get`; update only via atomic `transactions/{txId}` | `uid`, `balance`, `totalEarned`, `totalSpent`, `lastTxId` |
| `transactions/{txId}` | Immutable financial ledger | `fromUid` or `toUid` read/list; create only when `isAuthorizedTransaction` passes; immutable | `id`, `fromUid`, `toUid`, `amount`, `fee`, `netAmount`, `type`, `referenceId`, `description`, `status` |
| `inventory/{uid}_{itemId}` | Player item/resource stacks | Owner read/list; increases gated by `market_buy`, `manufacturing`, or `cancelMarketListing` | `uid`, `itemId`, `quantity`, `lastListingId`, `updatedAt` |
| `market_listings/{listingId}` | Open player & system reserve sell offers | Signed-in read (`status == 'active'` list); atomic buy/cancel updates | `id`, `sellerUid`, `sellerName`, `itemId`, `quantity`, `remainingQty`, `unitPrice`, `status` |
| `market_orders/{orderId}` | Executed trade receipts | Buyer or seller read/list; create with `existsAfter(transactions/{txId})` | `id`, `listingId`, `buyerUid`, `sellerUid`, `itemId`, `quantity`, `unitPrice`, `totalPrice`, `taxAmount`, `txId` |
| `companies/{companyId}` | Player-owned businesses across 5 sectors | Public leaderboard list (`totalRevenue >= 0`) & owner list; atomic create/upgrade/hire/collect | `id`, `ownerUid`, `name`, `sector`, `level`, `capital`, `employeesCount`, `baseRevenuePerHour`, `expensePerHour`, `totalRevenue`, `lastCollectedAt` |
| `company_logs/{logId}` | Company operation audit history | Owner read/list; append-only | `id`, `companyId`, `ownerUid`, `action`, `amount`, `details` |
| `properties/{propertyId}` | Player-owned real estate (`shop`, `office`, `facility`) | Owner read/list; atomic buy/upgrade/collect + lease toggle | `id`, `ownerUid`, `name`, `type`, `level`, `purchasePrice`, `rentPerHour`, `maintenancePerHour`, `isRented`, `lastCollectedAt` |
| `organizations/{orgId}` | Economic syndicates & shared treasury | Signed-in read (`reputation >= 0` list); atomic deposit/withdraw/member-count gates | `id`, `name`, `tag`, `description`, `leaderUid`, `leaderName`, `treasuryBalance`, `memberCount`, `reputation`, `level` |
| `organization_members/{orgId}_{uid}` | Membership & RBAC roles/permissions | Member or self `get`; `uid` or `orgId` list; leader/officer RBAC writes | `orgId`, `uid`, `username`, `role`, `permissions`, `joinedAt` |
| `organization_requests/{reqId}` | Organization join applications | Applicant or `manage_members` read; pending create by applicant; manager approve/reject | `id`, `orgId`, `uid`, `username`, `status` |
| `organization_transactions/{txId}` | Organization treasury ledger | Org member `get`; `uid`/`orgId` list; append-only | `id`, `orgId`, `uid`, `username`, `type`, `amount`, `note` |
| `player_missions/{uid}_{missionId}` | Claimed missions lock | Owner read/list; create-once immutable | `uid`, `missionId`, `category`, `rewardCredits`, `rewardXp` |
| `daily_claims/{uid}_{dateKey}` | Daily stipend claim lock (`YYYY-MM-DD` UTC) | Owner read/list; create-once immutable | `uid`, `dateKey`, `amount` |
| `contract_claims/{uid}_{contractId}` | Daily trade contract lock | Owner read/list; create-once immutable | `uid`, `contractId`, `amount` |
| `player_achievements/{uid}_{achievementId}` | Unlocked achievement badges | Owner read/list; create-once immutable | `uid`, `achievementId`, `unlockedAt` |
| `notifications/{notifId}` | Player alerts | Owner read/list; create by owner; update `read` only | `id`, `uid`, `title`, `body`, `type`, `read` |
| `world_events/{eventId}` | Global market modifiers | Signed-in read (`active == true` list); canonical seed IDs create-once | `id`, `titleAr`, `titleEn`, `effectType`, `targetItemId`, `priceMultiplier`, `taxDelta`, `active` |
| `audit_logs/{logId}` | Sensitive action audit trail | Owner read/list; append-only | `id`, `uid`, `action`, `entityType`, `entityId` |

---

## 2. Query & Index Strategy
- **Zero Composite-Index Failures**: Leaderboard and directory queries (`profiles` by `influence`, `companies` by `totalRevenue`, `organizations` by `reputation`) pair `where(field, '>=', 0)` with `orderBy(field, 'desc')` on the **exact same field**, relying solely on Firestore single-field indexes while satisfying `allow list` rules statically.
- **Equality Multi-Filters**: `organization_requests` filters on `orgId == ...` and `status == 'pending'` (equality index merge).
- **No Unfiltered List Rules**: Every `allow list` rule in `firestore.rules` explicitly evaluates `resource.data` rather than blanket `isSignedIn()`.

---

## 3. Core Security Invariants
1. **Verified Email Gate**: Every non-health operation requires `request.auth != null && request.auth.token.email_verified == true`.
2. **Zero Client Balance Tampering**: `wallets/{uid}` updates fail unless accompanied by an atomic `transactions/{txId}` document whose `type`, `amount`, `netAmount`, and `referenceId` match the exact balance delta.
3. **Zero Free XP / Skill Point Farming**: `profiles/{uid}` updates are partitioned into explicit actions; XP, level, reputation, influence, and skillPoint gains require a concurrent atomic wallet transaction (`hasNewWalletTx`).
4. **Anti-Minting Inventory**: Inventory increases require an atomic `market_buy`, `manufacturing`, or verified listing cancellation (`lastListingId`).
5. **Immutable Ledgers & Claims**: Financial logs, audit trails, and claim records disallow `update` and `delete`.

# Changelog

## [1.1.0] - 2026-11-15
### Added — NEXORA Diagnostics System
- Added read-only, owner-restricted **NEXORA Diagnostics System** (`src/features/diagnostics/DiagnosticsView.tsx`, `src/services/diagnosticsService.ts`, `src/lib/diagnosticsSanitizer.ts`) integrated into `ProfileHubView` (`Settings` / `Diagnostics` tab).
- Implemented **Firebase Cloud Functions Gen 2** backend (`functions/src/index.ts`, `functions/src/diagnosticsCore.ts`, `firebase.json`) targeting named database `ai-studio-74843d9e-8228-49b7-a616-317cadd90bff` with server-side ID Token verification, Custom Claim / `diagnostics_admins/{uid}` / allowlist owner checks, sliding-window rate limiting, mutation/arbitrary-query rejection, and secret/PII redaction.
- Added read-only `diagnostics_admins/{uid}` rule (`allow list, create, update, delete: if false;`) to `firestore.rules` + `firebase-blueprint.json` and deployed rules via `DeployRules`.
- Added 10 Vitest security/redaction/schema tests in `src/tests/diagnostics.test.ts` and documented architecture in `docs/DIAGNOSTICS.md`.

## [1.0.2] - 2026-11-15
### Security & Documentation
- Eliminated all bare `allow list: if isSignedIn();` rules in `firestore.rules` using query-enforced `resource.data` filters aligned with single-field indexes (`profiles`, `companies`, `organizations`, `market_listings`, `world_events`, `organization_members`, `organization_requests`, `organization_transactions`).
- Closed client-tampering vectors on `profiles`, `inventory`, `market_listings`, `companies`, `properties`, and `organizations` via atomic `hasNewWalletTx` / `newWalletTx`, `lastListingId` refund checks, time-proportional collection caps, and strict `affectedKeys` action branches.
- Scoped `organization_requests` snapshot listener in `src/hooks/useGameData.ts` to members with `manage_members` permission.
- Unified `README.md`, `docs/ARCHITECTURE.md`, `docs/DATABASE.md`, and `PROJECT_STATUS.md` on the official Firebase stack (with zero legacy SQL/Supabase references).

## [1.0.1] - 2026-11-15
### Fixed & Added
- Guarded organization membership profile sync in `src/hooks/useGameData.ts` with `orgMemberLoaded` to prevent premature `orgId` clearing on initial snapshot load.
- Tightened `profiles/{uid}` `orgId` update validation in `firestore.rules` and redeployed rules via `DeployRules`.
- Added comprehensive `PROJECT_STATUS.md` as the official living project reference and expanded `.gitignore` secret exclusions.
- Initialized local Git repository on `main` and configured `origin` remote (`https://github.com/luffyk124-del/nexora-game.git`).

## [1.0.0] - 2026-11-15
### Added
- Initial playable MVP release of **NEXORA** with Arabic (`RTL`) default and English (`LTR`) support.
- Dark Premium mobile-first portrait shell with sticky header, notifications drawer, and 5-tab bottom navigation.
- Firebase Authentication (Google Sign-In) and atomic Cloud Firestore transaction engine.
- Hardened `firestore.rules` verified with `@firebase/eslint-plugin-security-rules`, preventing negative balances, duplicate mission/stipend claims, and unauthorized organization actions.
- Complete game systems: Wallets & Transfers, Open Market & Contracts, 3-Tier Manufacturing Chains, Companies (5 sectors), Real Estate Properties, 6-Skill Tree, Organizations with RBAC & Shared Treasury, Missions, Achievements, Leaderboards, and World Events.
- Automated Vitest test suite (`src/tests/economy.test.ts`).


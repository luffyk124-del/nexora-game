## [Unreleased] - 2026-11-15
### Currency & Audio Experience
- Added a shared Web Audio engine: the soundtrack and UI feedback reuse one lazily-created `AudioContext`; button tones are synthesized live with oscillators and gain envelopes, with no MP3/WAV assets or audio network requests.
- Added global short confirmation tones for buttons, navigation links, and role-button controls after the first user gesture. The first pointer/keyboard interaction attempts `AudioContext.resume()` synchronously within the gesture path and safely handles unsupported/blocked audio.
- Added responsive pressed states (`scale(0.975)`, brightness feedback), keyboard focus visibility, and reduced-motion support for interactive controls.
- Replaced the visible N-Credits label with the `$` symbol across onboarding, wallet, market, business, organization, mission rewards, and transaction history; wallet values and economy calculations remain unchanged.
- Added an original low-volume ambient electronic soundtrack using Web Audio, with smooth chord transitions and an explicit play/pause control in the app header.

### Organization Directory
- Added live organization search across name, tag, leader, and description.
- Added reputation, member-count, level, and treasury sorting with deterministic name tie-breaks.
- Added a localized empty-search state and four unit tests for the directory helper.

## [Unreleased] - 2026-11-15
### Build Compatibility
- Updated the root `esbuild` dev dependency to `^0.28.2` to satisfy Vite 8's declared optional peer dependency (`^0.27.0 || ^0.28.0`) and remove the observed npm `ERESOLVE` blocker.

### Test Coverage
- Added 7 focused regression tests for the server-side world event rotation engine, covering activation caps, expiry boundaries, active-event preservation, duplicate stack-group removal, and configured event durations.
- Validation is pending GitHub Actions; these tests are not yet counted as passing.

# Changelog

## [1.1.1] - 2026-11-15
### Security, Stability & UX Audit
- **Security Hardening (`firestore.rules` — staged locally pending deploy)**:
  - Separated staff hiring into dedicated transaction type `'company_hire'` across `src/types/game.ts`, `firebase-blueprint.json`, `src/services/gameService.ts`, and `firestore.rules`.
  - Bounded `market_buy` fee (`0 <= fee <= (amount * 0.12) + 0.5`), verified `market_buy` itemId + exact `remainingQty` delta and `manufacturing` canonical recipe IDs on `inventory`, validated `txId` + `market_buy` fields on `market_orders`, and restricted `organization_requests` pending `allow list` to members with `manage_members` permission.
- **Data Lifecycle & Service Fixes (`src/hooks/useGameData.ts`, `src/services/gameService.ts`, `src/lib/economy.ts`)**:
  - Reset all scoped listeners and state collections cleanly on sign-out, subscribed to `myPendingOrgIds`, refreshed `utcDateKey` automatically across UTC midnight, and deduplicated achievement unlock writes.
  - Added shared progression/cap constants (`COMPANY_MAX_LEVEL`, `COMPANY_MAX_STAFF`, `COMPANY_HIRE_COST`, `PROPERTY_MAX_LEVEL`, `LISTING_MAX_QTY`, `LISTING_MAX_PRICE`), `sanitizePositiveInt`, `getMissionProgress`, and `getAchievementProgress`, plus duplicate/capacity guards on organization join requests and approvals.
- **UI/UX & Performance (`src/features/*`, `src/i18n/translations.ts`, `vite.config.ts`)**:
  - Added localized Firebase Auth error feedback, active mission sorting + shortcut, `MAX` caps & busy/error handling for property lease/upgrade and org join decisions, sanitized numeric inputs and market preview clamping, leaderboard error/retry & empty states, owner-gated Diagnostics shortcut in Settings, lazy-loaded `DiagnosticsView`, and Vite `manualChunks` bundle splitting.
- **Regression Tests**: Added `src/tests/audit.test.ts` (7 tests, bringing suite total to 27/27 passing tests).

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


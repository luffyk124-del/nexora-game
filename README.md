# NEXORA

**NEXORA** is a portrait-first (Mobile-First) economic, corporate management, and social strategy simulation browser game built with **React 19**, **TypeScript**, **Tailwind CSS v4**, and **Firebase** (**Firebase Authentication** + **Cloud Firestore Enterprise Edition**).

Default UI language is **Arabic (`RTL`)** with instant switching to **English (`LTR`)**.

---

## Core Systems Implemented
- **Authentication & Onboarding**: Google Sign-In (`signInWithPopup`) with verified-email enforcement, unique username reservation (`usernames/{usernameLower}`), executive portrait selection, owner-isolated private data (`users_private/{uid}`), and `2,500 $` starting capital.
- **Ambient Soundtrack & UI Audio**: Original adaptive synth ambience and per-control synthesized feedback using one shared Web Audio context; no MP3/WAV files, no audio downloads, and audio unlock is tied to the first trusted user gesture.
- **Tactile Interaction**: Responsive pressed states, keyboard-visible focus, and reduced-motion-aware transitions across buttons and navigation links.
- **5-Tab Mobile-First Portrait Shell**: Home (`الرئيسية`), Business (`الأعمال`), Market (`السوق`), Organization (`المنظمة`), and Profile (`الشخصية`), paired with a sticky header and live notifications drawer.
- **Character & Skill Tree**: Level/XP progression and 6 functionally bound skills (`Trade`, `Management`, `Industry`, `Negotiation`, `Financial Analysis`, `Leadership`).
- **Interconnected Economy**: Atomic `$` wallets (`wallets/{uid}`) linked to an append-only ledger (`transactions/{txId}`), player-to-player transfers, open market listings/orders with dynamic supply-based pricing, tax rates, and active world events.
- **Manufacturing Chains**: 3-tier industrial chains (`Raw Materials` -> `Intermediate Goods` -> `Final Products`) and daily trade contracts.
- **Companies & Real Estate**: Found and upgrade companies across 5 sectors, hire staff, purchase and lease properties (`shop`, `office`, `facility`), and collect accrued hourly revenue.
- **Organizations & RBAC**: Found or join syndicates, manage member ranks (`leader`, `deputy`, `officer`, `member`) and permissions, approve/reject join applications, and operate a shared treasury.
- **NEXORA Diagnostics System**: Read-only, owner-restricted diagnostics dashboard (`Profile -> Settings / Diagnostics`) with Cloud Functions Gen 2 (`functions/`), secret/PII redaction, sanitized error monitoring, and unified JSON report export.

---

## Official Firebase Architecture
- **Authentication**: Firebase Auth (Google provider; `email_verified == true` enforced by `firestore.rules`).
- **Database**: Cloud Firestore Enterprise Edition (`projectId: gen-lang-client-0074900177`, `firestoreDatabaseId: ai-studio-74843d9e-8228-49b7-a616-317cadd90bff`).
- **Backend Functions**: Firebase Cloud Functions Gen 2 (`functions/src/index.ts`, Node 22) providing owner-restricted read-only diagnostics aggregations.
- **Data Integrity & Rules**: Server-side security rules (`firestore.rules`) enforce atomic multi-document transactions (`getAfter` / `existsAfter`), anti-negative wallet guards, anti-item-minting inventory locks, market escrow invariants, and organization RBAC checks.

---

## Documentation
- `PROJECT_STATUS.md` — Official living project status, implemented vs. planned scope, test results, open issues, and update log.
- `docs/ARCHITECTURE.md` — Technical architecture, client/Firebase layers, and atomic transaction workflows.
- `docs/DATABASE.md` — Complete Firestore collections, document schemas, relationships, indexes, and security invariants.
- `docs/DIAGNOSTICS.md` — Read-only Diagnostics System security model, Gen 2 Cloud Functions, and JSON report schema.
- `security_spec.md` — Data invariants and adversarial attack payload catalog.
- `CHANGELOG.md` — Version history.

---

## Scripts
- `npm run dev` — Start development server on port `3000`
- `npm run build` — Production build via Vite
- `npm run build --prefix functions` — Build Cloud Functions Gen 2 TypeScript backend
- `npm run lint` — TypeScript type checking (`tsc --noEmit`)
- `npm run lint:rules` — Validate `firestore.rules` with `@firebase/eslint-plugin-security-rules`
- `npm run test` — Run unit, economy, diagnostics, and security audit tests via Vitest (`src/tests/*.test.ts`)

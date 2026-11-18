# NEXORA Reports Center — Supabase setup and release gates

## Architecture
- Static Arabic frontend is built with Vite from `reports-center/`.
- Sign-in is username/password only. The UI accepts `MJNON` (case-insensitive), maps it to the internal Supabase Auth login `mjn.admin@nexora.invalid`, and calls `signInWithPassword`.
- Google OAuth is not used.
- The browser invokes `nexora-reports-admin`; it never reads or writes report tables directly.
- The Edge Function verifies the Supabase access token and requires an enabled row in `nexora.diagnostics_admins`.
- Report status changes and audit insertion use `nexora.set_player_report_status` atomically.
- Report tables remain in the isolated `nexora` schema with RLS enabled. Direct table access for `anon` and `authenticated` remains revoked.
- The Edge Function uses the server-side Supabase secret only. Never put a service-role/secret key in frontend code or Git.

## Administrator and authentication — configured
- Auth user `mjn.admin@nexora.invalid` has a confirmed email and an enabled `owner` row in `nexora.diagnostics_admins`.
- Public Auth signups have been disabled (confirmed by the project owner).
- The password is owned by the administrator and must never be committed or shared in chat.
- The `.invalid` address cannot receive email; password recovery must be performed by a trusted project owner in Supabase Dashboard.
- The username check in the browser is a UI restriction; actual authorization is enforced by the Edge Function allowlist.

## Supabase API schema and privileges — verified
- The project owner confirmed `nexora` is listed under Project Settings → API → Exposed schemas.
- Database privilege check: `service_role` has schema USAGE; `anon` and `authenticated` do not.
- RLS remains enabled on NEXORA tables. Do not grant direct client table access.

## Current deployment and data status
- Supabase Edge Function `nexora-reports-admin`: active, version 3, JWT verification enabled.
- Edge Function CORS is restricted to the GitHub Pages origin `https://luffyk124-del.github.io`.
- The atomic status/audit RPC migration is applied.
- Current counts at verification: `nexora.player_reports = 0`, `nexora.player_report_audit = 0`.
- `nexora.migration_batches = 0` and `nexora.firestore_import_payloads = 0`; no Firestore data import has occurred.
- No historical reports have been imported; an empty dashboard is expected until the migration is completed or the game starts writing reports to the new backend.
- The Reports Center frontend has not been published yet.
- Do not delete, disable, or modify the original Firebase project until the full game migration and data reconciliation are complete.

## Build and GitHub Pages deployment
From `reports-center/`:
- Install: `npm install`
- Build: `npm run build`
- Output: `dist/`
- Vite uses relative asset paths; `reports-center/public/.nojekyll` disables Jekyll processing.
- `.github/workflows/deploy-reports-center.yml` builds and deploys only `reports-center/dist` to GitHub Pages when changes reach `main`, or when manually dispatched.
- GitHub Pages source is configured as **GitHub Actions** (confirmed by the project owner).
- Expected project URL: `https://luffyk124-del.github.io/nexora-game/`.

## Remaining release gates
1. Merge only the Reports Center changes after reviewing the PR diff; do not merge the dependent game PR as part of this release.
2. Confirm the GitHub Pages workflow succeeds and the site loads at the expected URL.
3. Test valid MJNON login, invalid password, denied non-admin access, report listing, status updates, and audit history.
4. Import/reconcile historical Firestore report records and verify the game writes new reports to the intended backend.
5. Keep Firebase intact and preserve unpublished game versions until the complete game migration and data reconciliation are verified.

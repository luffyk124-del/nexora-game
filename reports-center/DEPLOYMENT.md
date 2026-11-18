# NEXORA Reports Center — Supabase setup and release gates

## Architecture
- Static Arabic frontend is built with Vite from `reports-center/`.
- Sign-in is username/password only. The UI accepts `MJNON` (case-insensitive), maps it to the internal Supabase Auth login `mjn.admin@nexora.invalid`, and calls `signInWithPassword`.
- Google OAuth is not used.
- The browser invokes `nexora-reports-admin`; it never reads or writes report tables directly.
- The Edge Function verifies the Supabase access token and requires an enabled row in `nexora.diagnostics_admins`.
- Report status changes and audit insertion use `nexora.set_player_report_status` atomically.
- Report tables remain in the isolated `nexora` schema with RLS enabled. Do not grant direct table access to `anon` or `authenticated`.
- The Edge Function uses the server-side Supabase secret only. Never put a service-role/secret key in frontend code or Git.

## Administrator provisioning — completed
- Auth user: `mjn.admin@nexora.invalid`.
- The account has a confirmed email.
- Its UUID is enabled in `nexora.diagnostics_admins` with role `owner`.
- The password is owned by the administrator and must never be committed or shared in chat.
- The `.invalid` address cannot receive email; password recovery must be performed by a trusted project owner in Supabase Dashboard.
- Keep public signups disabled in Supabase Authentication settings. There must be only one enabled Reports Center administrator.
- The username check in the browser is a UI restriction; actual authorization is enforced by the Edge Function allowlist.

## Supabase API schema exposure
The Edge Function queries the `nexora` schema through the Supabase Data API. In Project Settings → API, ensure `nexora` is listed under exposed schemas. Schema exposure does not grant table privileges. Keep grants and RLS restrictive.

## Current deployment and data status
- Supabase Edge Function `nexora-reports-admin`: active, version 2, JWT verification enabled.
- The atomic status/audit RPC migration is applied.
- The Auth user and enabled owner record are provisioned.
- Current counts at verification: `nexora.player_reports = 0`, `nexora.player_report_audit = 0`.
- `nexora.migration_batches = 0` and `nexora.firestore_import_payloads = 0`; no Firestore data import has occurred.
- No historical reports have been imported; an empty dashboard is expected until the migration is completed or the game starts writing reports to the new backend.
- The Reports Center frontend has not been published.
- Do not delete, disable, or modify the original Firebase project until the full game migration and data reconciliation are complete.

## Build and GitHub Pages deployment
From `reports-center/`:
- Install: `npm install`
- Build: `npm run build`
- Output: `dist/`
- Vite uses relative asset paths; `reports-center/public/.nojekyll` disables Jekyll processing.
- `.github/workflows/deploy-reports-center.yml` builds and deploys only `reports-center/dist` to GitHub Pages when changes reach `main`, or when manually dispatched.
- Before the first deployment, open repository Settings → Pages and select **GitHub Actions** as the build and deployment source. The workflow cannot enable this repository setting itself.
- Expected project site origin: `https://luffyk124-del.github.io`; final URL includes the repository path.

## Release checklist
1. Confirm Supabase Auth public signups are disabled.
2. Verify the `nexora` schema is exposed to the Edge Function Data API while direct client grants remain revoked.
3. Restrict Edge Function CORS to the final hosting origin before publishing.
4. Enable GitHub Pages with the GitHub Actions source in repository Settings.
5. Publish the static frontend only after the migration and security gates are verified.
6. Test valid MJNON login, invalid password, denied non-admin access, report list, status update, and audit history.
7. Import/reconcile any historical Firestore report records and verify the game writes new reports to the intended backend.
8. Keep PRs open and Firebase intact until the above release gates pass.

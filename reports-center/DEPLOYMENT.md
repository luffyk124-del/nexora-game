# NEXORA Reports Center — Supabase setup

## Current architecture
- The browser uses Supabase Auth with Google OAuth.
- The browser calls the `nexora-reports-admin` Edge Function; it does not access report tables directly.
- The Edge Function verifies the Supabase access token, then checks `nexora.diagnostics_admins` for the signed-in user's enabled admin record.
- Reports and audit data stay in the `nexora` schema. RLS remains enabled and direct client grants remain revoked.
- Trusted server access is granted to `service_role` only. Do not grant `anon` or `authenticated` access to the NEXORA tables.
- Status changes and audit insertion are committed atomically through `nexora.set_player_report_status`.
- The RPC is executable only by `service_role`; `anon` and `authenticated` have no execute permission.
- There is no public admin registration or first-user auto-promotion.

## Supabase API schema exposure
The Edge Function uses the Supabase Data API with `.schema("nexora")`. In Supabase Dashboard:
1. Open Project Settings → API.
2. Add `nexora` to the exposed schemas list and save.
3. Keep table privileges restricted: only `service_role` has access; `anon` and `authenticated` remain revoked.

Exposing a schema makes it addressable through the Data API; it does not grant table access by itself. Do not add client grants or public RLS policies.

## Required Supabase Auth setup
1. In Supabase Dashboard, open Authentication → Providers → Google and enable Google.
2. Configure the Google OAuth Web client ID and client secret in the Google provider settings.
3. In Authentication → URL Configuration, set the Site URL to the eventual Reports Center origin and add that exact origin/path to the Redirect URLs allow-list.
4. In Google Cloud OAuth client settings, add the Reports Center origin as an authorized JavaScript origin and the Supabase Auth callback URL shown on the Supabase Google provider page as an authorized redirect URI.
5. The front end uses `signInWithOAuth({ provider: 'google' })` and redirects back to the Reports Center page.

Google OAuth cannot be activated from the repository alone: the provider's client secret must be configured in the Supabase project dashboard or through the Supabase Management API. Never commit the Google client secret.

## Authorize the first administrator
After Google OAuth is enabled and the Reports Center is deployed to a private preview:
1. Sign in with the intended owner Google account.
2. Retrieve that account's Supabase Auth user UUID from Authentication → Users.
3. Insert that UUID into `nexora.diagnostics_admins` with `enabled = true` and `role = 'owner'` using a trusted project-owner database session.
4. Do not create an open registration endpoint or allow the first visitor to claim admin access.

Example SQL for a trusted project owner session (replace the placeholder with the verified Auth user UUID):
```sql
insert into nexora.diagnostics_admins (user_id, enabled, role)
values ('<VERIFIED_SUPABASE_AUTH_USER_UUID>', true, 'owner')
on conflict (user_id) do update
set enabled = true, role = 'owner', updated_at = now();
```

## Frontend deployment
- Vercel project root: `reports-center`.
- Build command: `npm run build`.
- Output directory: `dist`.
- Keep the preview private until Google OAuth, administrator authorization, and the list/update/audit flows have been tested.

## Migration status
- The Supabase Edge Function `nexora-reports-admin` is deployed as version 2 with JWT verification enabled.
- The status update path uses the atomic RPC `nexora.set_player_report_status`; the SQL migration is tracked at `supabase/migrations/20261118051500_nexora_reports_atomic_status_audit.sql`.
- The function source is tracked at `supabase/functions/nexora-reports-admin/index.ts`.
- Reports tables exist in schema `nexora`; RLS is enabled and client grants remain revoked.
- The Google provider credentials, first administrator record, `nexora` API schema exposure, Firestore data import, and final deployment are still pending.
- Do not delete or disable the original Firebase project until migration and data reconciliation are complete.

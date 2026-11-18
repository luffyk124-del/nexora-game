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

## Required Supabase Auth setup — username and password
- Google OAuth is not used by the Reports Center.
- The only accepted username in the front end is `MJNON` (case-insensitive).
- The front end maps that fixed username to the internal Supabase Auth email `mjn.admin@nexora.invalid` and calls `signInWithPassword`.
- Do not expose public sign-up. In Supabase Authentication settings, disable new user signups.
- In Authentication → Users, create exactly one administrator user with email `mjn.admin@nexora.invalid`, set a strong password, and mark the email as confirmed if the dashboard requires it. Do not send the password through ChatGPT or commit it to GitHub.
- The internal `.invalid` address is a login identifier only; it is not intended to receive email. Password reset by email is therefore not available. If the password is lost, reset it from the trusted Supabase dashboard.
- The username check in the browser is only a user-interface restriction. Actual authorization is enforced server-side by the Edge Function's enabled `nexora.diagnostics_admins` record. Keep this allowlist check; never trust the username field alone.

## Authorize the first administrator
After creating the single `mjn.admin@nexora.invalid` Auth user:
1. Retrieve that user's Supabase Auth UUID from Authentication → Users.
2. Insert that UUID into `nexora.diagnostics_admins` with `enabled = true` and `role = 'owner'` using a trusted project-owner database session.
3. Verify that no other Auth user has an enabled row in `nexora.diagnostics_admins`.
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
- Keep the preview private until the single username/password account, administrator authorization, and the list/update/audit flows have been tested.

## Migration status
- The Supabase Edge Function `nexora-reports-admin` is deployed as version 2 with JWT verification enabled.
- The status update path uses the atomic RPC `nexora.set_player_report_status`; the SQL migration is tracked at `supabase/migrations/20261118051500_nexora_reports_atomic_status_audit.sql`.
- The function source is tracked at `supabase/functions/nexora-reports-admin/index.ts`.
- Reports tables exist in schema `nexora`; RLS is enabled and client grants remain revoked.
- The single Auth user and first administrator record, `nexora` API schema exposure, Firestore data import, and final deployment are still pending.
- Do not delete or disable the original Firebase project until migration and data reconciliation are complete.

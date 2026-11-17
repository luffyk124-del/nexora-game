# NEXORA Reports Center — secure setup

## Authentication model
- Login is handled by the `loginReportsAdmin` callable function.
- The only accepted username is `MJNON`.
- The password is verified server-side using scrypt; only a salted scrypt hash is stored in Firebase Secret Manager.
- A successful login receives a Firebase custom token for the one fixed UID `nexora-reports-mjnon-admin`.
- Every reports callable checks both that UID and the `reportsAdmin` custom claim.
- There is no public registration flow and no password or hash in browser code or Git history.
- Login attempts are rate-limited per hashed IP in Firestore (5 failures per 10 minutes).

## One-time secret provisioning
Use a new password of at least 12 characters. Do not reuse a password that has been pasted into chat, a ticket, or source control.

From the repository root, run:

```bash
node functions/scripts/generate-reports-admin-hash.mjs
```

The script reads the password without echoing it and prints a salted scrypt hash. Copy that hash, then set the Firebase secret:

```bash
firebase functions:secrets:set REPORTS_ADMIN_PASSWORD_HASH --project gen-lang-client-0074900177
```

Paste the hash when prompted. Never put the password or hash in a source file, command-line argument, GitHub issue, or commit.

## Deploy only the Reports Center backend
After the secret is configured and the functions build succeeds:

```bash
cd functions
npm ci
npm run build
cd ..
firebase deploy --only functions:loginReportsAdmin,functions:listPlayerReportsAdmin,functions:updatePlayerReportAdmin,functions:listPlayerReportAuditAdmin --project gen-lang-client-0074900177
```

The existing Firestore rules deny direct client access to reports, audit, and admin collections. The new login-attempt collection also remains server-only under the global deny rule.

## Frontend
The standalone Vercel project root is `reports-center`; build command `npm run build`, output directory `dist`. Deploying the frontend alone does not activate login until the four callable functions and the secret are deployed.

# Reports Center — GitHub migration assessment

## Current migration branch
This branch prepares the Reports Center frontend for static hosting and validates its Vite build through GitHub Actions. It does not publish a public site and does not change Firebase.

## Security decision: do not publish the admin login on GitHub Pages
The Reports Center is an authenticated administrative portal. GitHub Pages is public static hosting and GitHub's acceptable-use guidance says Pages should not be used for sensitive transactions such as sending passwords. The login form sends the administrator password to the Firebase callable over HTTPS; therefore this portal should not be exposed on GitHub Pages.

## Recommended deployment topology
- GitHub: source control and GitHub Actions build/release automation.
- Firebase Hosting: serve the Reports Center frontend over HTTPS.
- Firebase Authentication + Cloud Functions: custom-token login and all privileged operations.
- Firestore: reports and audit data, accessed only by authorized server-side functions.

This keeps the frontend and backend on the Firebase platform, avoids the Vercel daily deployment API limit, and avoids using GitHub Pages for an admin password flow.

## Build locally
From this directory:
```bash
npm install --no-audit --no-fund --package-lock=false
npm run build
```

The app uses relative frontend asset paths and Vite's relative base so it can be built as a static artifact. The actual Firebase deployment remains blocked until the Reports Center secret is provisioned and the four callable functions are deployed and smoke-tested. No Firebase data or production player records are modified by this branch.


## Firebase Hosting one-time setup

The Firebase project must have a separate Hosting site so this admin console cannot overwrite the game's existing Hosting site.

Create the site once (the ID must be available in Firebase):
```bash
firebase hosting:sites:create nexora-reports-center --project gen-lang-client-0074900177
```

Then add a GitHub Actions repository secret named `FIREBASE_SERVICE_ACCOUNT`. Its value must be the JSON key for a dedicated Google Cloud service account that has only the Firebase Hosting deployment permissions needed for this site. Generate and add the key in Google Cloud / GitHub settings directly; never paste it into chat, commit it, or place it in frontend code. Prefer a dedicated deploy identity and rotate its key if it is ever exposed.

After the site exists and the secret is configured, run the workflow **Deploy NEXORA Reports Center to Firebase Hosting** manually from the GitHub Actions tab. It builds `reports-center/dist` and deploys only Hosting. It does not deploy Functions, Firestore rules, or game hosting.

## Backend activation remains separate

The login will not work until the Reports Center password hash is set in Firebase Secret Manager and the four Reports Center callable Functions are deployed. Follow the secret provisioning and backend deployment instructions above, then perform authenticated smoke tests before sharing the site URL.

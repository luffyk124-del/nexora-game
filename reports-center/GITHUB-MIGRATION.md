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

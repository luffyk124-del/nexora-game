# NEXORA GitHub Pages deployment

The production Pages workflow deploys the static Vite app to:

`https://luffyk124-del.github.io/nexora-game/`

## One-time repository setting

In GitHub, open **Settings → Pages** and set **Build and deployment → Source** to **GitHub Actions**. The workflow runs on pushes to `main` and can be manually dispatched after it exists on the default branch.

## Migration feature flags

The workflow reads repository Actions variables. Every Supabase flag defaults to `false` if not configured. Keep them false until the corresponding domain has passed its own QA.

For the player data read switch, the app also enforces a runtime safety gate: `VITE_NEXORA_SUPABASE_PLAYER_READS` only takes effect when every required write-domain flag is true. A partial migration therefore continues to use Firebase reads instead of mixing Supabase reads with Firebase writes.

Do not enable the full set of flags until:
- per-collection source/target reconciliation and checksums pass,
- a real signed-in player session has been verified,
- wallet, inventory, ownership, and auction escrow invariants pass under concurrent requests,
- the migration PR is approved and merged.

Firebase Auth remains the identity provider during this database migration. The app's Firebase Authorized Domain must include `luffyk124-del.github.io`.


## Real-player parity QA

After the Pages workflow is enabled and the app is deployed, open:

`https://luffyk124-del.github.io/nexora-game/?migration=1`

Sign in with the verified Firebase player account, then run **مطابقة اللاعب الحقيقي**. This reads the signed-in player's Firebase documents and the matching Supabase player snapshot without changing either database. Resolve every mismatch before enabling the read switch or any production cutover.

import { randomUUID } from 'node:crypto';
import { getApps, initializeApp } from 'firebase-admin/app';
import { FieldValue, getFirestore, Timestamp, type DocumentData, type Query } from 'firebase-admin/firestore';
import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import {
  ALLOWED_DIAGNOSTIC_COLLECTIONS,
  authorizeDiagnosticsActor,
  DiagnosticsSecurityError,
  maskUidServer,
  redactSecretsServer,
  sanitizeTextServer,
  SlidingWindowRateLimiter,
  validateDiagnosticsRequest,
  type DiagnosticStatus,
} from './diagnosticsCore.js';
import {
  buildWorldEventRotationPlan,
  type ExistingWorldEventRecord,
} from './worldEventsEngine.js';

const NEXORA_PROJECT_ID = 'gen-lang-client-0074900177';
const NEXORA_DATABASE_ID = 'ai-studio-74843d9e-8228-49b7-a616-317cadd90bff';
const NEXORA_AUTH_DOMAIN = 'gen-lang-client-0074900177.firebaseapp.com';

const adminApp = getApps().length > 0 ? getApps()[0] : initializeApp();
const db = getFirestore(adminApp, NEXORA_DATABASE_ID);
const rateLimiter = new SlidingWindowRateLimiter(6, 60_000);

function toHttpsError(err: unknown): HttpsError {
  if (err instanceof DiagnosticsSecurityError) {
    const map: Record<DiagnosticsSecurityError['code'], 'unauthenticated' | 'permission-denied' | 'invalid-argument' | 'resource-exhausted'> = {
      UNAUTHENTICATED: 'unauthenticated',
      PERMISSION_DENIED: 'permission-denied',
      INVALID_ARGUMENT: 'invalid-argument',
      RESOURCE_EXHAUSTED: 'resource-exhausted',
    };
    return new HttpsError(map[err.code], err.message);
  }
  return new HttpsError('internal', 'Internal diagnostics check failure.');
}

function parseAllowlist(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Read-only owner-restricted Cloud Function Gen 2 for NEXORA Diagnostics.
 * - Verifies Firebase ID token (via onCall auth context).
 * - Enforces verified email + owner authorization (Custom Claims, diagnostics_admins/{uid}, or server env allowlist).
 * - Rejects arbitrary collection names, free-form queries, and all mutations.
 * - Aggregates collection counts using Firestore count() without full collection downloads or PII leaks.
 */

type VaultCompany = {
  id: string; ownerUid: string; name: string; sector?: string; level: number; auctionId?: string;
  employeesCount: number; baseRevenuePerHour: number; expensePerHour: number;
  totalRevenue: number; vaultLevel?: number; vaultBalance?: number; lastCollectedAt?: unknown;
};
type VaultProfile = {
  xp: number; level: number; skillPoints: number; reputation: number; influence: number;
  skills: { management?: number; finance?: number; leadership?: number };
};
type VaultWallet = { balance: number; totalEarned: number; totalSpent: number };
const VAULT_MAX_LEVEL = 25;
const VAULT_MATERIAL_SETS = [
  { copper_wire: 20, crude_alloy: 10 },
  { silicon_ore: 20, energy_cells: 15 },
  { carbon_fiber: 15, precision_frame: 10 },
  { rare_minerals: 20, quantum_server: 5 },
] as const;
const VAULT_UPGRADES = Array.from({ length: VAULT_MAX_LEVEL - 1 }, (_, index) => ({
  cost: Math.round(1_500 * Math.pow(1.32, index)),
  materials: Object.fromEntries(Object.entries(VAULT_MATERIAL_SETS[index % VAULT_MATERIAL_SETS.length]).map(([itemId, qty]) => [itemId, Math.round(qty * (1 + index * 0.12))])),
}));
const REPUTATION_YIELD_TIERS = [
  { min: 0, bonus: 0 }, { min: 60, bonus: 0.02 }, { min: 160, bonus: 0.04 },
  { min: 350, bonus: 0.06 }, { min: 700, bonus: 0.08 },
] as const;

function vaultLevelOf(company: VaultCompany): number {
  const level = typeof company.vaultLevel === 'number' && Number.isFinite(company.vaultLevel)
    ? Math.floor(company.vaultLevel) : 1;
  return Math.max(1, Math.min(VAULT_MAX_LEVEL, level));
}
function timestampMillis(value: unknown, fallback: number): number {
  if (value instanceof Timestamp) return value.toMillis();
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') { const parsed = Date.parse(value); return Number.isFinite(parsed) ? parsed : fallback; }
  if (value && typeof value === 'object' && 'seconds' in value && typeof (value as {seconds?: unknown}).seconds === 'number') {
    return Number((value as {seconds:number}).seconds) * 1000;
  }
  return fallback;
}
function companyNetHourly(company: VaultCompany, profile: VaultProfile, events: DocumentData[], nowMs: number): number {
  const levelMultiplier = 1 + (company.level - 1) * 0.32;
  const staffBonus = 1 + Math.max(0, company.employeesCount - 1) * 0.05;
  const management = Math.max(0, Number(profile.skills?.management) || 0);
  const finance = Math.max(0, Number(profile.skills?.finance) || 0);
  const managementBonus = 1 + management * 0.08;
  const tier = [...REPUTATION_YIELD_TIERS].reverse().find((item) => profile.reputation >= item.min) ?? REPUTATION_YIELD_TIERS[0];
  const reputationBonus = 1 + tier.bonus;
  const seenGroups = new Set<string>();
  let eventMultiplier = 1;
  let accepted = 0;
  for (const event of events) {
    if (event.active !== true) continue;
    const startsAt = timestampMillis(event.startsAt, 0);
    const endsAt = timestampMillis(event.endsAt, 0);
    if ((startsAt > 0 && nowMs < startsAt) || (endsAt > 0 && nowMs >= endsAt)) continue;
    const group = String(event.stackGroup || event.effectType || event.id);
    if (seenGroups.has(group)) continue;
    seenGroups.add(group);
    if (company.sector && Array.isArray(event.affectedSectors) && event.affectedSectors.includes(company.sector) && typeof event.revenueMultiplier === 'number') {
      eventMultiplier *= event.revenueMultiplier;
    }
    accepted += 1;
    if (accepted >= 3) break;
  }
  eventMultiplier = Number(Math.max(0.75, Math.min(1.4, eventMultiplier)).toFixed(3));
  const gross = Math.round(company.baseRevenuePerHour * levelMultiplier * staffBonus * managementBonus * eventMultiplier * reputationBonus);
  const rawExpense = company.expensePerHour * (1 + (company.level - 1) * 0.2) + Math.max(0, company.employeesCount - 3) * 8;
  const expense = Math.round(rawExpense * (1 - Math.min(0.45, finance * 0.05)));
  return Math.max(15, gross - expense);
}
function calculatedVaultBalance(company: VaultCompany, netHourly: number, nowMs: number): number {
  const level = vaultLevelOf(company);
  const capacity = Math.max(3_500, Math.floor((Math.max(0, netHourly) * 4 * level) / VAULT_MAX_LEVEL));
  const stored = typeof company.vaultBalance === 'number' && Number.isFinite(company.vaultBalance)
    ? Math.max(0, company.vaultBalance) : 0;
  const last = timestampMillis(company.lastCollectedAt, nowMs);
  const elapsed = Math.max(0, nowMs - last);
  return Math.min(capacity, stored + Math.max(0, Math.floor((Math.max(0, netHourly) * elapsed) / 3_600_000)));
}
function levelForXp(totalXp: number): number {
  let level = 1;
  let remaining = Math.max(0, Math.floor(totalXp));
  while (level < 100) {
    const step = 200 + Math.max(0, level - 1) * 120;
    if (remaining < step) return level;
    remaining -= step;
    level += 1;
  }
  return 100;
}
function vaultHttpsError(error: unknown): HttpsError {
  const message = error instanceof Error ? error.message : 'INTERNAL';
  const known: Record<string, ConstructorParameters<typeof HttpsError>[0]> = {
    COMPANY_NOT_FOUND: 'not-found', ACCOUNT_NOT_FOUND: 'failed-precondition',
    UNAUTHORIZED: 'permission-denied', VAULT_MAX_LEVEL: 'failed-precondition',
    INSUFFICIENT_FUNDS: 'failed-precondition', MISSING_VAULT_MATERIALS: 'failed-precondition',
    NOTHING_TO_COLLECT: 'failed-precondition', INVALID_ARGUMENT: 'invalid-argument',
  };
  return new HttpsError(known[message] ?? 'internal', known[message] ? message : 'Company vault operation failed.');
}

export const upgradeCompanyProfitVault = onCall(
  { region: 'us-central1', maxInstances: 10, timeoutSeconds: 30, memory: '256MiB' },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'UNAUTHENTICATED');
    const companyId = typeof request.data?.companyId === 'string' ? request.data.companyId.trim() : '';
    if (!companyId || companyId.length > 128) throw new HttpsError('invalid-argument', 'INVALID_ARGUMENT');
    try {
      return await db.runTransaction(async (tx) => {
        const uid = request.auth!.uid;
        const companyRef = db.doc(`companies/${companyId}`);
        const walletRef = db.doc(`wallets/${uid}`);
        const profileRef = db.doc(`profiles/${uid}`);
        const [companySnap, walletSnap, profileSnap, eventsSnap] = await Promise.all([
          tx.get(companyRef), tx.get(walletRef), tx.get(profileRef),
          tx.get(db.collection('world_events').where('active', '==', true)),
        ]);
        if (!companySnap.exists) throw new Error('COMPANY_NOT_FOUND');
        if (!walletSnap.exists || !profileSnap.exists) throw new Error('ACCOUNT_NOT_FOUND');
        const company = companySnap.data() as VaultCompany;
        const wallet = walletSnap.data() as VaultWallet;
        const profile = profileSnap.data() as VaultProfile;
        if (company.ownerUid !== uid) throw new Error('UNAUTHORIZED');
        if (company.auctionId) throw new Error('COMPANY_IN_AUCTION');
        const oldLevel = vaultLevelOf(company);
        if (oldLevel >= VAULT_MAX_LEVEL) throw new Error('VAULT_MAX_LEVEL');
        const upgrade = VAULT_UPGRADES[oldLevel - 1];
        if (wallet.balance < upgrade.cost) throw new Error('INSUFFICIENT_FUNDS');
        const inventorySnaps = await Promise.all(Object.entries(upgrade.materials).map(([itemId]) => tx.get(db.doc(`inventory/${uid}_${itemId}`))));
        const itemEntries = Object.entries(upgrade.materials);
        for (let i = 0; i < itemEntries.length; i += 1) {
          const required = itemEntries[i][1];
          if (!inventorySnaps[i].exists || Number(inventorySnaps[i].data()?.quantity ?? 0) < required) {
            throw new Error('MISSING_VAULT_MATERIALS');
          }
        }
        const now = Date.now();
        const events = eventsSnap.docs.map((docSnap) => docSnap.data());
        const netHourly = companyNetHourly(company, profile, events, now);
        const preserved = calculatedVaultBalance(company, netHourly, now);
        const txId = `tx_${randomUUID()}`;
        const logId = `clog_${crypto.randomUUID()}`;
        tx.update(walletRef, {
          balance: wallet.balance - upgrade.cost,
          totalSpent: wallet.totalSpent + upgrade.cost,
          lastTxId: txId,
          updatedAt: FieldValue.serverTimestamp(),
        });
        itemEntries.forEach(([itemId, required], index) => {
          const itemRef = db.doc(`inventory/${uid}_${itemId}`);
          const current = Number(inventorySnaps[index].data()?.quantity ?? 0);
          tx.update(itemRef, { quantity: current - required, updatedAt: FieldValue.serverTimestamp() });
        });
        tx.update(companyRef, {
          vaultLevel: oldLevel + 1,
          vaultBalance: preserved,
          lastCollectedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });
        tx.create(db.doc(`transactions/${txId}`), {
          id: txId, fromUid: uid, toUid: 'SYSTEM', amount: upgrade.cost, fee: 0,
          netAmount: upgrade.cost, type: 'company_vault_upgrade', referenceId: companyId,
          description: `Upgraded ${company.name} profit vault to Lv.${oldLevel + 1}`,
          status: 'completed', createdAt: FieldValue.serverTimestamp(),
        });
        tx.create(db.doc(`company_logs/${logId}`), {
          id: logId, companyId, ownerUid: uid, action: 'vault_upgrade', amount: -upgrade.cost,
          details: `Profit vault upgraded to Lv.${oldLevel + 1}; preserved ${preserved}`,
          createdAt: FieldValue.serverTimestamp(),
        });
        return { ok: true, vaultLevel: oldLevel + 1, vaultBalance: preserved, capacity: Math.max(3_500, Math.floor((Math.max(0, netHourly) * 4 * (oldLevel + 1)) / VAULT_MAX_LEVEL)) };
      });
    } catch (error) { throw vaultHttpsError(error); }
  }
);

export const collectCompanyRevenueSecure = onCall(
  { region: 'us-central1', maxInstances: 10, timeoutSeconds: 30, memory: '256MiB' },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'UNAUTHENTICATED');
    const companyId = typeof request.data?.companyId === 'string' ? request.data.companyId.trim() : '';
    if (!companyId || companyId.length > 128) throw new HttpsError('invalid-argument', 'INVALID_ARGUMENT');
    try {
      return await db.runTransaction(async (tx) => {
        const uid = request.auth!.uid;
        const companyRef = db.doc(`companies/${companyId}`);
        const walletRef = db.doc(`wallets/${uid}`);
        const profileRef = db.doc(`profiles/${uid}`);
        const [companySnap, walletSnap, profileSnap, eventsSnap] = await Promise.all([
          tx.get(companyRef), tx.get(walletRef), tx.get(profileRef),
          tx.get(db.collection('world_events').where('active', '==', true)),
        ]);
        if (!companySnap.exists) throw new Error('COMPANY_NOT_FOUND');
        if (!walletSnap.exists || !profileSnap.exists) throw new Error('ACCOUNT_NOT_FOUND');
        const company = companySnap.data() as VaultCompany;
        const wallet = walletSnap.data() as VaultWallet;
        const profile = profileSnap.data() as VaultProfile;
        if (company.ownerUid !== uid) throw new Error('UNAUTHORIZED');
        if (company.auctionId) throw new Error('COMPANY_IN_AUCTION');
        const now = Date.now();
        const lastCollected = timestampMillis(company.lastCollectedAt, now);
        if (now - lastCollected < 30_000) throw new Error('NOTHING_TO_COLLECT');
        const events = eventsSnap.docs.map((docSnap) => docSnap.data());
        const netHourly = companyNetHourly(company, profile, events, now);
        const payout = calculatedVaultBalance(company, netHourly, now);
        if (payout < 1) throw new Error('NOTHING_TO_COLLECT');
        const txId = `tx_${crypto.randomUUID()}`;
        const logId = `clog_${crypto.randomUUID()}`;
        const xpGain = Math.min(80, Math.max(10, Math.floor(payout / 15)));
        const nextXp = profile.xp + xpGain;
        const nextLevel = levelForXp(nextXp);
        const levelsGained = Math.max(0, nextLevel - profile.level);
        const leadershipBonus = 1 + (Math.max(0, Number(profile.skills?.leadership) || 0) * 0.1);
        tx.update(walletRef, {
          balance: wallet.balance + payout,
          totalEarned: wallet.totalEarned + payout,
          lastTxId: txId,
          updatedAt: FieldValue.serverTimestamp(),
        });
        tx.update(companyRef, {
          totalRevenue: company.totalRevenue + payout,
          vaultBalance: 0,
          lastCollectedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });
        tx.update(profileRef, {
          xp: nextXp,
          level: nextLevel,
          skillPoints: profile.skillPoints + levelsGained * 2,
          reputation: profile.reputation + Math.round(2 * leadershipBonus),
          influence: profile.influence + Math.round(1 * leadershipBonus),
          updatedAt: FieldValue.serverTimestamp(),
        });
        tx.create(db.doc(`transactions/${txId}`), {
          id: txId, fromUid: 'SYSTEM', toUid: uid, amount: payout, fee: 0,
          netAmount: payout, type: 'company_collect', referenceId: companyId,
          description: `Company revenue collected: ${company.name}`,
          status: 'completed', createdAt: FieldValue.serverTimestamp(),
        });
        tx.create(db.doc(`company_logs/${logId}`), {
          id: logId, companyId, ownerUid: uid, action: 'collect', amount: payout,
          details: `Collected +$${payout}`, createdAt: FieldValue.serverTimestamp(),
        });
        return { ok: true, payout };
      });
    } catch (error) { throw vaultHttpsError(error); }
  }
);

export const nexoraDiagnostics = onCall(
  {
    region: 'us-central1',
    cors: true,
    maxInstances: 2,
    timeoutSeconds: 30,
    memory: '256MiB',
    enforceAppCheck: process.env.NEXORA_ENFORCE_APP_CHECK === 'true',
  },
  async (request) => {
    try {
      const { action, locale } = validateDiagnosticsRequest(request.data);

      if (!request.auth) {
        throw new DiagnosticsSecurityError('UNAUTHENTICATED', 'Authentication is required.');
      }

      const token = request.auth.token;
      const uid = request.auth.uid;

      // Check read-only Admin-managed diagnostics_admins/{uid} document
      let adminDocEnabled = false;
      try {
        const adminSnap = await db.doc(`diagnostics_admins/${uid}`).get();
        const adminData = adminSnap.data();
        adminDocEnabled =
          adminSnap.exists && adminData?.enabled === true && adminData?.role === 'owner';
      } catch {
        adminDocEnabled = false;
      }

      const authResult = authorizeDiagnosticsActor(
        {
          uid,
          email: typeof token.email === 'string' ? token.email : null,
          emailVerified: token.email_verified === true,
          claims: token as Record<string, unknown>,
        },
        adminDocEnabled,
        {
          allowedUids: parseAllowlist(process.env.DIAGNOSTICS_ALLOWED_UIDS),
          allowedEmails: parseAllowlist(process.env.DIAGNOSTICS_ALLOWED_EMAILS),
        }
      );

      rateLimiter.consume(uid);

      const nowIso = new Date().toISOString();

      if (action === 'health_ping') {
        return redactSecretsServer({
          ok: true,
          status: 'healthy' as DiagnosticStatus,
          checkedAt: nowIso,
          verifiedBy: authResult.verifiedBy,
          runtime: 'nodejs22-gen2',
        });
      }

      // 1. Firestore Health Ping
      const pingStart = Date.now();
      let firestoreStatus: DiagnosticStatus = 'healthy';
      let firestoreMsg = 'Connected to named Firestore Enterprise database.';
      try {
        await db.doc('test/connection').get();
      } catch (err) {
        firestoreStatus = 'error';
        firestoreMsg = sanitizeTextServer(err instanceof Error ? err.message : String(err));
      }
      const latencyMs = Date.now() - pingStart;

      // 2. Server-side count() aggregations across fixed allowlist
      const countMap = new Map<string, number | null>();
      const databaseCollections = await Promise.all(
        ALLOWED_DIAGNOSTIC_COLLECTIONS.map(async (spec) => {
          try {
            const agg = await db.collection(spec.name).count().get();
            const count = agg.data().count;
            countMap.set(spec.name, count);
            return {
              name: spec.name,
              category: spec.category,
              piiRestricted: spec.piiRestricted,
              count,
              countSource: 'admin_aggregation' as const,
              status: 'healthy' as DiagnosticStatus,
              note: spec.piiRestricted
                ? 'PII/restricted collection: aggregate count only.'
                : 'Verified via Admin SDK count().',
            };
          } catch (err) {
            countMap.set(spec.name, null);
            return {
              name: spec.name,
              category: spec.category,
              piiRestricted: spec.piiRestricted,
              count: null,
              countSource: 'unavailable' as const,
              status: 'warning' as DiagnosticStatus,
              note: sanitizeTextServer(err instanceof Error ? err.message : 'Count query failed'),
            };
          }
        })
      );

      // 3. Bounded referential integrity checks (max 50 docs, zero PII returned)
      const warnings: string[] = [];
      const failedChecks: string[] = [];

      let orphanedOrgRefs = 0;
      let invalidSkillProfiles = 0;
      let profilesSampled = 0;
      try {
        const profSnap = await db.collection('profiles').limit(50).get();
        profilesSampled = profSnap.size;
        for (const docSnap of profSnap.docs) {
          const data = docSnap.data();
          if (typeof data.skillPoints !== 'number' || data.skillPoints < 0 || !data.skills) {
            invalidSkillProfiles += 1;
          }
          if (typeof data.orgId === 'string' && data.orgId.length > 0) {
            const memberExists = (
              await db.doc(`organization_members/${data.orgId}_${docSnap.id}`).get()
            ).exists;
            if (!memberExists) {
              orphanedOrgRefs += 1;
            }
          }
        }
      } catch (err) {
        warnings.push(`Profile integrity check warning: ${sanitizeTextServer(String(err))}`);
      }

      if (orphanedOrgRefs > 0) {
        warnings.push(`Detected ${orphanedOrgRefs} profile(s) with orphaned orgId references.`);
      }
      if (invalidSkillProfiles > 0) {
        failedChecks.push(`Detected ${invalidSkillProfiles} profile(s) with invalid skill structure.`);
      }

      let negativeWallets = 0;
      try {
        const negWalletAgg = await db.collection('wallets').where('balance', '<', 0).count().get();
        negativeWallets = negWalletAgg.data().count;
        if (negativeWallets > 0) {
          failedChecks.push(`Detected ${negativeWallets} wallet(s) with negative balance.`);
        }
      } catch (err) {
        warnings.push(`Wallet check warning: ${sanitizeTextServer(String(err))}`);
      }

      let inconsistentListings = 0;
      try {
        const badListings = await db
          .collection('market_listings')
          .where('status', '==', 'active')
          .where('remainingQty', '<=', 0)
          .count()
          .get();
        inconsistentListings = badListings.data().count;
        if (inconsistentListings > 0) {
          warnings.push(`Detected ${inconsistentListings} active market listing(s) with remainingQty <= 0.`);
        }
      } catch (err) {
        warnings.push(`Market listing check warning: ${sanitizeTextServer(String(err))}`);
      }

      const profilesCount = countMap.get('profiles') ?? 0;
      const walletsCount = countMap.get('wallets') ?? 0;
      const profileWalletMismatch = Math.abs(profilesCount - walletsCount);
      if (profileWalletMismatch > 0) {
        warnings.push(
          `Count delta between profiles (${profilesCount}) and wallets (${walletsCount}).`
        );
      }

      const gameSystems = [
        {
          key: 'characters' as const,
          labelAr: 'نظام الشخصيات',
          labelEn: 'Characters',
          status: (invalidSkillProfiles > 0 ? 'error' : profilesCount > 0 ? 'healthy' : 'warning') as DiagnosticStatus,
          collectionsChecked: ['profiles', 'usernames'],
          metrics: {
            profilesCount,
            usernamesCount: countMap.get('usernames') ?? 0,
            sampledChecked: profilesSampled,
          },
          issues: invalidSkillProfiles > 0 ? [`${invalidSkillProfiles} malformed profile docs`] : [],
        },
        {
          key: 'wallets_economy' as const,
          labelAr: 'المحافظ والاقتصاد',
          labelEn: 'Wallets & Economy',
          status: (negativeWallets > 0 ? 'error' : profileWalletMismatch > 0 ? 'warning' : 'healthy') as DiagnosticStatus,
          collectionsChecked: ['wallets', 'transactions'],
          metrics: {
            walletsCount,
            transactionsCount: countMap.get('transactions') ?? 0,
            negativeWallets,
            profileWalletDelta: profileWalletMismatch,
          },
          issues: negativeWallets > 0 ? [`${negativeWallets} negative wallet balances`] : [],
        },
        {
          key: 'companies' as const,
          labelAr: 'الشركات والمصانع',
          labelEn: 'Companies',
          status: 'healthy' as DiagnosticStatus,
          collectionsChecked: ['companies', 'company_logs'],
          metrics: {
            companiesCount: countMap.get('companies') ?? 0,
            companyLogsCount: countMap.get('company_logs') ?? 0,
          },
          issues: [],
        },
        {
          key: 'market_orders' as const,
          labelAr: 'السوق والطلبات',
          labelEn: 'Market & Orders',
          status: (inconsistentListings > 0 ? 'warning' : 'healthy') as DiagnosticStatus,
          collectionsChecked: ['market_listings', 'market_orders', 'world_events'],
          metrics: {
            listingsCount: countMap.get('market_listings') ?? 0,
            ordersCount: countMap.get('market_orders') ?? 0,
            inconsistentListings,
          },
          issues: inconsistentListings > 0 ? [`${inconsistentListings} active listings with 0 remainingQty`] : [],
        },
        {
          key: 'organizations' as const,
          labelAr: 'المنظمات والأعضاء',
          labelEn: 'Organizations & Members',
          status: (orphanedOrgRefs > 0 ? 'warning' : 'healthy') as DiagnosticStatus,
          collectionsChecked: [
            'organizations',
            'organization_members',
            'organization_requests',
            'organization_transactions',
          ],
          metrics: {
            organizationsCount: countMap.get('organizations') ?? 0,
            membersCount: countMap.get('organization_members') ?? 0,
            requestsCount: countMap.get('organization_requests') ?? 0,
            orphanedOrgRefs,
          },
          issues: orphanedOrgRefs > 0 ? [`${orphanedOrgRefs} orphaned orgId references`] : [],
        },
        {
          key: 'missions_achievements' as const,
          labelAr: 'المهام والإنجازات',
          labelEn: 'Missions & Achievements',
          status: 'healthy' as DiagnosticStatus,
          collectionsChecked: ['player_missions', 'daily_claims', 'contract_claims', 'player_achievements'],
          metrics: {
            missionClaimsCount: countMap.get('player_missions') ?? 0,
            dailyClaimsCount: countMap.get('daily_claims') ?? 0,
            contractClaimsCount: countMap.get('contract_claims') ?? 0,
            achievementsCount: countMap.get('player_achievements') ?? 0,
          },
          issues: [],
        },
        {
          key: 'inventory_properties' as const,
          labelAr: 'المخزون والعقارات',
          labelEn: 'Inventory & Properties',
          status: 'healthy' as DiagnosticStatus,
          collectionsChecked: ['inventory', 'properties'],
          metrics: {
            inventoryStacksCount: countMap.get('inventory') ?? 0,
            propertiesCount: countMap.get('properties') ?? 0,
          },
          issues: [],
        },
        {
          key: 'skills_progression' as const,
          labelAr: 'المهارات والتقدم',
          labelEn: 'Skills & Progression',
          status: (invalidSkillProfiles > 0 ? 'error' : 'healthy') as DiagnosticStatus,
          collectionsChecked: ['profiles'],
          metrics: {
            sampledProfiles: profilesSampled,
            invalidSkillProfiles,
          },
          issues: invalidSkillProfiles > 0 ? [`${invalidSkillProfiles} profiles missing skills map`] : [],
        },
      ];

      const appCheckEnforced = process.env.NEXORA_ENFORCE_APP_CHECK === 'true';

      const report = {
        reportVersion: '1.0.0',
        generatedAt: nowIso,
        projectIdentifier: {
          appName: 'NEXORA' as const,
          projectId: NEXORA_PROJECT_ID,
          firestoreDatabaseId: NEXORA_DATABASE_ID,
          authDomain: NEXORA_AUTH_DOMAIN,
        },
        environment: {
          mode: 'production-cloud-function',
          executionSource: 'cloud_function_gen2' as const,
          backendDeployed: true,
          appCheckEnforced,
          locale,
        },
        firebaseHealth: {
          overallStatus: (firestoreStatus === 'error' ? 'error' : 'healthy') as DiagnosticStatus,
          firestore: {
            status: firestoreStatus,
            latencyMs,
            message: firestoreMsg,
          },
          authentication: {
            status: 'healthy' as DiagnosticStatus,
            provider: 'google.com' as const,
            emailVerified: true,
            ownerVerifiedBy: authResult.verifiedBy,
            maskedUid: maskUidServer(uid),
            message: `Verified Firebase ID Token (${authResult.verifiedBy}).`,
          },
          backendFunctions: {
            status: 'healthy' as DiagnosticStatus,
            runtime: 'nodejs22-gen2',
            functionName: 'nexoraDiagnostics',
            lastCheckAt: nowIso,
            message: 'Cloud Function Gen 2 executed read-only aggregation successfully.',
          },
          lastSuccessfulCheckAt: nowIso,
        },
        authenticationHealth: {
          status: 'healthy' as DiagnosticStatus,
          signedIn: true,
          emailVerified: true,
          ownerAuthorized: true,
          authMechanism: 'Firebase Auth Google Sign-In + Server ID Token Verification',
          userStoragePattern: 'Public profiles/{uid} separated from owner-only users_private/{uid}',
        },
        databaseCollections,
        gameSystems,
        securityChecks: {
          overallStatus: (failedChecks.length > 0 ? 'error' : warnings.length > 0 ? 'warning' : 'healthy') as DiagnosticStatus,
          ownerAuthorizationVerified: true,
          rulesValidationStatus: 'healthy' as DiagnosticStatus,
          piiRedactionActive: true,
          arbitraryQueriesBlocked: true,
          mutationsBlocked: true,
          appCheckStatus: (appCheckEnforced ? 'healthy' : 'warning') as DiagnosticStatus,
          collectionsNeedingReview: [
            {
              collection: 'organization_members',
              severity: 'info' as const,
              reason: 'allow list supports orgId scoping; verify member privacy stays non-PII.',
            },
            {
              collection: 'organization_requests',
              severity: 'info' as const,
              reason: 'allow list permits pending query; client listener is gated by manage_members.',
            },
          ],
          checks: [
            {
              id: 'server_id_token',
              label: 'Server-side ID Token & Verified Email',
              status: 'healthy' as DiagnosticStatus,
              detail: `Verified via ${authResult.verifiedBy}`,
            },
            {
              id: 'read_only_enforcement',
              label: 'Read-Only & Mutation Rejection',
              status: 'healthy' as DiagnosticStatus,
              detail: 'Only run_diagnostics & health_ping allowed.',
            },
            {
              id: 'app_check',
              label: 'Firebase App Check Enforcement',
              status: (appCheckEnforced ? 'healthy' : 'warning') as DiagnosticStatus,
              detail: appCheckEnforced
                ? 'enforceAppCheck is enabled.'
                : 'enforceAppCheck is optional until site key is configured.',
            },
          ],
        },
        recentSanitizedErrors: [],
        warnings,
        failedChecks,
      };

      return redactSecretsServer(report);
    } catch (err) {
      throw toHttpsError(err);
    }
  }
);

/**
 * Scheduled Cloud Function Gen 2 to expire ended world_events and rotate fresh
 * non-stacking economic events on the NEXORA named Firestore database.
 */
export const rotateWorldEvents = onSchedule(
  {
    schedule: 'every 6 hours',
    region: 'us-central1',
    maxInstances: 1,
    timeoutSeconds: 30,
    memory: '256MiB',
  },
  async () => {
    const nowMs = Date.now();
    const snap = await db.collection('world_events').get();
    const existing: ExistingWorldEventRecord[] = snap.docs.map((docSnap) => {
      const data = docSnap.data();
      const endsAt = data.endsAt as { toMillis?: () => number } | undefined;
      return {
        id: docSnap.id,
        active: data.active === true,
        stackGroup: typeof data.stackGroup === 'string' ? data.stackGroup : undefined,
        endsAtMs: typeof endsAt?.toMillis === 'function' ? endsAt.toMillis() : null,
      };
    });

    const plan = buildWorldEventRotationPlan(existing, nowMs, 3);
    if (plan.toDeactivateIds.length === 0 && plan.toActivate.length === 0) {
      return;
    }

    const batch = db.batch();
    for (const id of plan.toDeactivateIds) {
      batch.set(
        db.collection('world_events').doc(id),
        { active: false },
        { merge: true }
      );
    }

    for (const entry of plan.toActivate) {
      const { durationHours: _dh, ...templateFields } = entry.template;
      batch.set(db.collection('world_events').doc(entry.template.id), {
        ...templateFields,
        startsAt: Timestamp.fromMillis(entry.startsAtMs),
        endsAt: Timestamp.fromMillis(entry.endsAtMs),
        active: true,
        createdAt: FieldValue.serverTimestamp(),
      });
    }

    await batch.commit();
  }
);



type OrganizationJoinMode = 'open' | 'request' | 'closed';

export const joinOrganizationSecure = onCall(
  { cors: true, maxInstances: 20 },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError('unauthenticated', 'UNAUTHENTICATED');
    const orgId = typeof request.data?.orgId === 'string' ? request.data.orgId.trim() : '';
    if (!/^org_[a-zA-Z0-9_-]{8,128}$/.test(orgId)) throw new HttpsError('invalid-argument', 'INVALID_ORG_ID');

    try {
      return await db.runTransaction(async (tx) => {
        const orgRef = db.doc(`organizations/${orgId}`);
        const profileRef = db.doc(`profiles/${uid}`);
        const memberRef = db.doc(`organization_members/${orgId}_${uid}`);
        const requestRef = db.doc(`organization_requests/join_${orgId}_${uid}`);
        const [orgSnap, profileSnap, memberSnap, requestSnap] = await Promise.all([
          tx.get(orgRef), tx.get(profileRef), tx.get(memberRef), tx.get(requestRef),
        ]);
        if (!orgSnap.exists || !profileSnap.exists) throw new HttpsError('not-found', 'NOT_FOUND');
        const org = orgSnap.data()!;
        const profile = profileSnap.data()!;
        if (profile.orgId) throw new HttpsError('failed-precondition', 'ALREADY_IN_ORG');
        if (memberSnap.exists) throw new HttpsError('already-exists', 'ALREADY_ORG_MEMBER');
        const mode: OrganizationJoinMode = org.joinMode === 'open' || org.joinMode === 'closed' ? org.joinMode : 'request';
        if (mode === 'closed') throw new HttpsError('failed-precondition', 'ORG_JOIN_CLOSED');
        const memberCount = Math.max(0, Number(org.memberCount) || 0);
        const orgLevel = Math.max(1, Number(org.level) || 1);
        const capacity = typeof org.memberCapacity === 'number' ? org.memberCapacity : Math.min(70, 20 + (orgLevel - 1) * 5);
        if (memberCount >= capacity) throw new HttpsError('resource-exhausted', 'ORG_FULL');

        if (mode === 'request') {
          if (requestSnap.exists && requestSnap.data()?.status === 'pending') {
            throw new HttpsError('already-exists', 'REQUEST_ALREADY_PENDING');
          }
          tx.set(requestRef, {
            id: requestRef.id, orgId, uid,
            username: typeof profile.username === 'string' ? profile.username : 'Player',
            status: 'pending', createdAt: FieldValue.serverTimestamp(),
          });
          return { status: 'requested' as const };
        }

        tx.set(memberRef, {
          orgId, uid,
          username: typeof profile.username === 'string' ? profile.username : 'Player',
          role: 'member', permissions: [], joinedAt: FieldValue.serverTimestamp(),
        });
        tx.update(profileRef, { orgId, updatedAt: FieldValue.serverTimestamp() });
        tx.update(orgRef, { memberCount: memberCount + 1, updatedAt: FieldValue.serverTimestamp() });
        return { status: 'joined' as const };
      });
    } catch (error) {
      if (error instanceof HttpsError) throw error;
      throw new HttpsError('internal', 'ORGANIZATION_JOIN_FAILED');
    }
  }
);

export const leaveOrganizationSecure = onCall(
  { region: 'us-central1', maxInstances: 20 },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError('unauthenticated', 'UNAUTHENTICATED');
    const orgId = typeof request.data?.orgId === 'string' ? request.data.orgId.trim() : '';
    if (!/^org_[a-zA-Z0-9_-]{8,128}$/.test(orgId)) {
      throw new HttpsError('invalid-argument', 'INVALID_ORG_ID');
    }
    return db.runTransaction(async (tx) => {
      const orgRef = db.doc('organizations/' + orgId);
      const memberRef = db.doc('organization_members/' + orgId + '_' + uid);
      const profileRef = db.doc('profiles/' + uid);
      const [orgSnap, memberSnap, profileSnap] = await Promise.all([
        tx.get(orgRef), tx.get(memberRef), tx.get(profileRef),
      ]);
      if (!orgSnap.exists || !memberSnap.exists || !profileSnap.exists) {
        throw new HttpsError('not-found', 'NOT_FOUND');
      }
      const org = orgSnap.data()!;
      const member = memberSnap.data()!;
      const profile = profileSnap.data()!;
      if (member.uid !== uid || member.orgId !== orgId || profile.orgId !== orgId) {
        throw new HttpsError('failed-precondition', 'MEMBERSHIP_MISMATCH');
      }
      if (member.role === 'leader' || org.leaderUid === uid) {
        throw new HttpsError('failed-precondition', 'LEADER_CANNOT_LEAVE');
      }
      const count = Math.max(1, Number(org.memberCount) || 1);
      tx.delete(memberRef);
      tx.update(profileRef, { orgId: null, updatedAt: FieldValue.serverTimestamp() });
      tx.update(orgRef, {
        memberCount: Math.max(1, count - 1),
        updatedAt: FieldValue.serverTimestamp(),
      });
      return { ok: true };
    });
  }
);

export const approveOrganizationJoinRequestSecure = onCall(
  { region: 'us-central1', maxInstances: 20 },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError('unauthenticated', 'UNAUTHENTICATED');
    const orgId = typeof request.data?.orgId === 'string' ? request.data.orgId.trim() : '';
    const reqId = typeof request.data?.reqId === 'string' ? request.data.reqId.trim() : '';
    const applicantUid = typeof request.data?.applicantUid === 'string' ? request.data.applicantUid.trim() : '';
    const decision = request.data?.decision;
    if (!/^org_[a-zA-Z0-9_-]{8,128}$/.test(orgId) || !reqId || reqId.length > 160 ||
        !applicantUid || applicantUid.length > 128 || !['approved', 'rejected'].includes(decision)) {
      throw new HttpsError('invalid-argument', 'INVALID_ARGUMENT');
    }

    return db.runTransaction(async (tx) => {
      const orgRef = db.doc('organizations/' + orgId);
      const actorRef = db.doc('organization_members/' + orgId + '_' + uid);
      const reqRef = db.doc('organization_requests/' + reqId);
      const profileRef = db.doc('profiles/' + applicantUid);
      const memberRef = db.doc('organization_members/' + orgId + '_' + applicantUid);
      const [orgSnap, actorSnap, reqSnap, profileSnap, memberSnap] = await Promise.all([
        tx.get(orgRef), tx.get(actorRef), tx.get(reqRef), tx.get(profileRef), tx.get(memberRef),
      ]);
      if (!orgSnap.exists || !actorSnap.exists || !reqSnap.exists) {
        throw new HttpsError('not-found', 'NOT_FOUND');
      }
      const org = orgSnap.data()!;
      const actor = actorSnap.data()!;
      const canManage = org.leaderUid === uid || actor.role === 'deputy' ||
        (Array.isArray(actor.permissions) && actor.permissions.includes('manage_members'));
      if (!canManage) throw new HttpsError('permission-denied', 'UNAUTHORIZED');
      const joinRequest = reqSnap.data()!;
      if (joinRequest.status !== 'pending') throw new HttpsError('failed-precondition', 'REQUEST_ALREADY_HANDLED');
      if (joinRequest.orgId !== orgId || joinRequest.uid !== applicantUid) {
        throw new HttpsError('failed-precondition', 'REQUEST_MISMATCH');
      }
      if (decision === 'rejected') {
        tx.update(reqRef, { status: 'rejected' });
        return { ok: true, status: 'rejected' };
      }
      if (!profileSnap.exists) throw new HttpsError('not-found', 'APPLICANT_NOT_FOUND');
      if (memberSnap.exists) throw new HttpsError('already-exists', 'ALREADY_ORG_MEMBER');
      const profile = profileSnap.data()!;
      if (profile.orgId) throw new HttpsError('failed-precondition', 'APPLICANT_IN_OTHER_ORG');
      const memberCount = Math.max(0, Number(org.memberCount) || 0);
      const level = Math.max(1, Number(org.level) || 1);
      const capacity = typeof org.memberCapacity === 'number'
        ? org.memberCapacity : Math.min(70, 20 + (level - 1) * 5);
      if (memberCount >= capacity) throw new HttpsError('resource-exhausted', 'ORG_FULL');
      tx.update(reqRef, { status: 'approved' });
      tx.create(memberRef, {
        orgId, uid: applicantUid,
        username: typeof profile.username === 'string' ? profile.username : 'Player',
        role: 'member', permissions: [], joinedAt: FieldValue.serverTimestamp(),
      });
      tx.update(profileRef, { orgId, updatedAt: FieldValue.serverTimestamp() });
      tx.update(orgRef, { memberCount: memberCount + 1, updatedAt: FieldValue.serverTimestamp() });
      return { ok: true, status: 'approved' };
    });
  }
);

export const kickOrganizationMemberSecure = onCall(
  { region: 'us-central1', maxInstances: 20 },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError('unauthenticated', 'UNAUTHENTICATED');
    const orgId = typeof request.data?.orgId === 'string' ? request.data.orgId.trim() : '';
    const targetUid = typeof request.data?.targetUid === 'string' ? request.data.targetUid.trim() : '';
    if (!/^org_[a-zA-Z0-9_-]{8,128}$/.test(orgId) || !targetUid || targetUid.length > 128 || targetUid === uid) {
      throw new HttpsError('invalid-argument', 'INVALID_ARGUMENT');
    }
    return db.runTransaction(async (tx) => {
      const orgRef = db.doc('organizations/' + orgId);
      const actorRef = db.doc('organization_members/' + orgId + '_' + uid);
      const targetRef = db.doc('organization_members/' + orgId + '_' + targetUid);
      const profileRef = db.doc('profiles/' + targetUid);
      const [orgSnap, actorSnap, targetSnap, profileSnap] = await Promise.all([
        tx.get(orgRef), tx.get(actorRef), tx.get(targetRef), tx.get(profileRef),
      ]);
      if (!orgSnap.exists || !actorSnap.exists || !targetSnap.exists || !profileSnap.exists) {
        throw new HttpsError('not-found', 'NOT_FOUND');
      }
      const org = orgSnap.data()!;
      const actor = actorSnap.data()!;
      const target = targetSnap.data()!;
      const canManage = org.leaderUid === uid || actor.role === 'deputy' ||
        (Array.isArray(actor.permissions) && actor.permissions.includes('manage_members'));
      if (!canManage) throw new HttpsError('permission-denied', 'UNAUTHORIZED');
      const roleWeight: Record<string, number> = { leader: 4, deputy: 3, officer: 2, member: 1 };
      if (target.role === 'leader' || (roleWeight[actor.role] || 0) <= (roleWeight[target.role] || 0)) {
        throw new HttpsError('permission-denied', 'RANK_TOO_HIGH');
      }
      const profile = profileSnap.data()!;
      if (profile.orgId !== orgId) throw new HttpsError('failed-precondition', 'PROFILE_MEMBERSHIP_MISMATCH');
      tx.delete(targetRef);
      tx.update(profileRef, { orgId: null, updatedAt: FieldValue.serverTimestamp() });
      tx.update(orgRef, {
        memberCount: Math.max(1, (Number(org.memberCount) || 1) - 1),
        updatedAt: FieldValue.serverTimestamp(),
      });
      return { ok: true };
    });
  }
);

export const setOrganizationJoinModeSecure = onCall(
  { cors: true, maxInstances: 10 },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError('unauthenticated', 'UNAUTHENTICATED');
    const orgId = typeof request.data?.orgId === 'string' ? request.data.orgId.trim() : '';
    const mode = request.data?.mode;
    if (!/^org_[a-zA-Z0-9_-]{8,128}$/.test(orgId) || !['open', 'request', 'closed'].includes(mode)) {
      throw new HttpsError('invalid-argument', 'INVALID_ARGUMENT');
    }
    const orgRef = db.doc(`organizations/${orgId}`);
    const memberRef = db.doc(`organization_members/${orgId}_${uid}`);
    await db.runTransaction(async (tx) => {
      const [orgSnap, memberSnap] = await Promise.all([tx.get(orgRef), tx.get(memberRef)]);
      if (!orgSnap.exists || !memberSnap.exists) throw new HttpsError('not-found', 'NOT_FOUND');
      const org = orgSnap.data()!;
      const member = memberSnap.data()!;
      const canManage = org.leaderUid === uid || member.role === 'deputy' || (Array.isArray(member.permissions) && member.permissions.includes('manage_org'));
      if (!canManage) throw new HttpsError('permission-denied', 'PERMISSION_DENIED');
      tx.update(orgRef, { joinMode: mode, updatedAt: FieldValue.serverTimestamp() });
    });
    return { ok: true, mode };
  }
);


type AuctionCompany = {
  id: string;
  ownerUid: string;
  ownerName: string;
  name: string;
  level: number;
  auctionId?: string;
  levelUpgradeEndsAt?: number;
  vaultUpgradeEndsAt?: number;
  employeesCount?: number;
  baseRevenuePerHour?: number;
  expensePerHour?: number;
  vaultLevel?: number;
  vaultBalance?: number;
  lastCollectedAt?: unknown;
};
type AuctionProfile = {
  username?: string;
  level: number;
  stats?: Record<string, number>;
};
type AuctionWallet = { balance: number; totalEarned: number; totalSpent: number };
type AuctionRecord = {
  id: string;
  companyId: string;
  sellerUid: string;
  sellerName: string;
  companyName: string;
  companyLevel: number;
  startingPrice: number;
  currentBid: number;
  highestBidderUid?: string | null;
  highestBidderName?: string | null;
  endsAt: number;
  status: string;
};

function companyOwnershipLimit(levelValue: number): number {
  const level = Math.max(1, Math.min(100, Math.floor(Number(levelValue) || 1)));
  return Math.min(10, 1 + Math.floor(((level - 1) * 9) / 49));
}

export const createCompanyAuctionSecure = onCall(
  { region: 'us-central1', maxInstances: 20 },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError('unauthenticated', 'UNAUTHENTICATED');
    const companyId = typeof request.data?.companyId === 'string' ? request.data.companyId.trim() : '';
    const rawPrice = request.data?.startingPrice;
    if (!/^cmp_[a-zA-Z0-9_-]{6,128}$/.test(companyId) || typeof rawPrice !== 'number' || !Number.isSafeInteger(rawPrice)) {
      throw new HttpsError('invalid-argument', 'INVALID_ARGUMENT');
    }

    return db.runTransaction(async (tx) => {
      const companyRef = db.doc(`companies/${companyId}`);
      const profileRef = db.doc(`profiles/${uid}`);
      const eventsQuery = db.collection('world_events').where('active', '==', true);
      const [companySnap, profileSnap, eventsSnap] = await Promise.all([
        tx.get(companyRef), tx.get(profileRef), tx.get(eventsQuery),
      ]);
      if (!companySnap.exists || !profileSnap.exists) throw new HttpsError('not-found', 'NOT_FOUND');
      const company = companySnap.data() as AuctionCompany & VaultCompany;
      const profile = profileSnap.data() as AuctionProfile & VaultProfile;
      if (company.ownerUid !== uid) throw new HttpsError('permission-denied', 'NOT_COMPANY_OWNER');
      if (company.level < 50) throw new HttpsError('failed-precondition', 'COMPANY_LEVEL_TOO_LOW');
      if (company.auctionId) throw new HttpsError('already-exists', 'AUCTION_ALREADY_ACTIVE');
      if (company.levelUpgradeEndsAt || company.vaultUpgradeEndsAt) {
        throw new HttpsError('failed-precondition', 'COMPANY_UPGRADE_IN_PROGRESS');
      }
      const minPrice = company.level * 1_000;
      const maxPrice = company.level * 100_000;
      if (rawPrice !== 0 && (rawPrice < minPrice || rawPrice > maxPrice)) {
        throw new HttpsError('invalid-argument', 'START_PRICE_OUT_OF_RANGE');
      }

      const now = Date.now();
      const netHourly = companyNetHourly(company, profile, eventsSnap.docs.map((item) => item.data()), now);
      const preservedVaultBalance = calculatedVaultBalance(company, netHourly, now);
      const auctionId = `auc_${randomUUID()}`;
      const endsAt = now + 24 * 60 * 60 * 1000;
      const sellerName = typeof profile.username === 'string' ? profile.username : company.ownerName;
      tx.create(db.doc(`company_auctions/${auctionId}`), {
        id: auctionId,
        companyId,
        sellerUid: uid,
        sellerName,
        companyName: company.name,
        companyLevel: company.level,
        startingPrice: rawPrice,
        currentBid: 0,
        highestBidderUid: null,
        highestBidderName: null,
        endsAt,
        status: 'active',
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      tx.update(companyRef, {
        auctionId,
        auctionEndsAt: endsAt,
        auctionStatus: 'active',
        vaultBalance: preservedVaultBalance,
        lastCollectedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      return { ok: true, auctionId, endsAt, minPrice, maxPrice };
    });
  }
);

export const placeCompanyAuctionBidSecure = onCall(
  { region: 'us-central1', maxInstances: 30 },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError('unauthenticated', 'UNAUTHENTICATED');
    const auctionId = typeof request.data?.auctionId === 'string' ? request.data.auctionId.trim() : '';
    const bidAmount = request.data?.bidAmount;
    if (!/^auc_[a-zA-Z0-9_-]{8,128}$/.test(auctionId) || typeof bidAmount !== 'number' || !Number.isSafeInteger(bidAmount) || bidAmount < 1 || bidAmount > 10_000_000) {
      throw new HttpsError('invalid-argument', 'INVALID_ARGUMENT');
    }

    return db.runTransaction(async (tx) => {
      const auctionRef = db.doc(`company_auctions/${auctionId}`);
      const auctionSnap = await tx.get(auctionRef);
      if (!auctionSnap.exists) throw new HttpsError('not-found', 'AUCTION_NOT_FOUND');
      const auction = auctionSnap.data() as AuctionRecord;
      if (auction.status !== 'active' || auction.endsAt <= Date.now()) throw new HttpsError('failed-precondition', 'AUCTION_ENDED');
      if (auction.sellerUid === uid) throw new HttpsError('permission-denied', 'CANNOT_BID_OWN_AUCTION');
      if (auction.highestBidderUid === uid) throw new HttpsError('already-exists', 'ALREADY_HIGHEST_BIDDER');

      const companyRef = db.doc(`companies/${auction.companyId}`);
      const profileRef = db.doc(`profiles/${uid}`);
      const walletRef = db.doc(`wallets/${uid}`);
      const [companySnap, profileSnap, walletSnap] = await Promise.all([tx.get(companyRef), tx.get(profileRef), tx.get(walletRef)]);
      if (!companySnap.exists || !profileSnap.exists || !walletSnap.exists) throw new HttpsError('not-found', 'ACCOUNT_OR_COMPANY_NOT_FOUND');
      const company = companySnap.data() as AuctionCompany;
      const profile = profileSnap.data() as AuctionProfile;
      const wallet = walletSnap.data() as AuctionWallet;
      if (company.ownerUid !== auction.sellerUid || company.auctionId !== auctionId) throw new HttpsError('failed-precondition', 'AUCTION_COMPANY_MISMATCH');
      const owned = Math.max(0, Math.floor(profile.stats?.companiesOwned || 0));
      if (owned >= companyOwnershipLimit(profile.level)) throw new HttpsError('failed-precondition', 'COMPANY_OWNERSHIP_LIMIT');

      const minBid = auction.currentBid > 0
        ? auction.currentBid + Math.max(100, Math.ceil(auction.currentBid * 0.05))
        : Math.max(1, auction.startingPrice);
      if (bidAmount < minBid) throw new HttpsError('invalid-argument', 'BID_TOO_LOW');
      if (wallet.balance < bidAmount) throw new HttpsError('failed-precondition', 'INSUFFICIENT_FUNDS');

      const oldUid = typeof auction.highestBidderUid === 'string' ? auction.highestBidderUid : null;
      const oldBid = Math.max(0, Math.floor(auction.currentBid || 0));
      const oldWalletRef = oldUid ? db.doc(`wallets/${oldUid}`) : null;
      const oldWalletSnap = oldWalletRef ? await tx.get(oldWalletRef) : null;
      if (oldUid && (!oldWalletSnap || !oldWalletSnap.exists)) throw new HttpsError('failed-precondition', 'PREVIOUS_ESCROW_ACCOUNT_MISSING');

      const bidTxId = `tx_${randomUUID()}`;
      tx.update(walletRef, {
        balance: wallet.balance - bidAmount,
        totalSpent: wallet.totalSpent + bidAmount,
        lastTxId: bidTxId,
        updatedAt: FieldValue.serverTimestamp(),
      });
      tx.create(db.doc(`transactions/${bidTxId}`), {
        id: bidTxId, fromUid: uid, toUid: 'SYSTEM', amount: bidAmount, fee: 0,
        netAmount: bidAmount, type: 'company_auction_bid', referenceId: auctionId,
        description: `Escrow bid for ${auction.companyName}`, status: 'completed',
        createdAt: FieldValue.serverTimestamp(),
      });

      if (oldUid && oldWalletRef && oldWalletSnap?.exists) {
        const oldWallet = oldWalletSnap.data() as AuctionWallet;
        const refundTxId = `tx_${randomUUID()}`;
        tx.update(oldWalletRef, {
          balance: oldWallet.balance + oldBid,
          totalSpent: Math.max(0, oldWallet.totalSpent - oldBid),
          totalEarned: oldWallet.totalEarned,
          lastTxId: refundTxId,
          updatedAt: FieldValue.serverTimestamp(),
        });
        tx.create(db.doc(`transactions/${refundTxId}`), {
          id: refundTxId, fromUid: 'SYSTEM', toUid: oldUid, amount: oldBid, fee: 0,
          netAmount: oldBid, type: 'company_auction_refund', referenceId: auctionId,
          description: `Outbid refund for ${auction.companyName}`, status: 'completed',
          createdAt: FieldValue.serverTimestamp(),
        });
      }

      tx.update(auctionRef, {
        currentBid: bidAmount,
        highestBidderUid: uid,
        highestBidderName: typeof profile.username === 'string' ? profile.username : 'Player',
        updatedAt: FieldValue.serverTimestamp(),
      });
      return { ok: true, currentBid: bidAmount, nextMinimumBid: bidAmount + Math.max(100, Math.ceil(bidAmount * 0.05)) };
    });
  }
);

async function settleCompanyAuction(auctionId: string): Promise<void> {
  await db.runTransaction(async (tx) => {
    const auctionRef = db.doc(`company_auctions/${auctionId}`);
    const auctionSnap = await tx.get(auctionRef);
    if (!auctionSnap.exists) return;
    const auction = auctionSnap.data() as AuctionRecord;
    if (auction.status !== 'active' || auction.endsAt > Date.now()) return;

    const companyRef = db.doc(`companies/${auction.companyId}`);
    const sellerProfileRef = db.doc(`profiles/${auction.sellerUid}`);
    const sellerWalletRef = db.doc(`wallets/${auction.sellerUid}`);
    const winnerUid = typeof auction.highestBidderUid === 'string' ? auction.highestBidderUid : null;
    const [companySnap, sellerProfileSnap, sellerWalletSnap] = await Promise.all([
      tx.get(companyRef), tx.get(sellerProfileRef), tx.get(sellerWalletRef),
    ]);
    const company = companySnap.exists ? companySnap.data() as AuctionCompany : null;
    const releaseCompany = () => {
      if (company?.auctionId === auctionId) {
        tx.update(companyRef, {
          auctionId: FieldValue.delete(),
          auctionEndsAt: FieldValue.delete(),
          auctionStatus: FieldValue.delete(),
          lastCollectedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });
      }
    };

    if (!winnerUid) {
      releaseCompany();
      tx.update(auctionRef, { status: 'ended_no_bids', updatedAt: FieldValue.serverTimestamp() });
      return;
    }

    const winnerProfileRef = db.doc(`profiles/${winnerUid}`);
    const winnerWalletRef = db.doc(`wallets/${winnerUid}`);
    const [winnerProfileSnap, winnerWalletSnap] = await Promise.all([
      tx.get(winnerProfileRef), tx.get(winnerWalletRef),
    ]);
    const winnerProfile = winnerProfileSnap.exists ? winnerProfileSnap.data() as AuctionProfile : null;
    const winnerWallet = winnerWalletSnap.exists ? winnerWalletSnap.data() as AuctionWallet : null;
    const sellerProfile = sellerProfileSnap.exists ? sellerProfileSnap.data() as AuctionProfile : null;
    const sellerWallet = sellerWalletSnap.exists ? sellerWalletSnap.data() as AuctionWallet : null;
    const winnerOwned = Math.max(0, Math.floor(winnerProfile?.stats?.companiesOwned || 0));
    const canTransfer = Boolean(
      company && company.auctionId === auctionId && company.ownerUid === auction.sellerUid &&
      winnerProfile && winnerWallet && sellerProfile && sellerWallet &&
      winnerOwned < companyOwnershipLimit(winnerProfile.level)
    );

    if (!winnerWallet) {
      // The winning bid is still held in escrow. Keep the auction active and the
      // company locked so the scheduled settlement can retry instead of marking
      // the auction refunded when no wallet exists to receive the refund.
      return;
    }

    if (!canTransfer || !company || !winnerProfile || !sellerProfile || !sellerWallet) {
      const refundTxId = `tx_${randomUUID()}`;
      tx.update(winnerWalletRef, {
        balance: winnerWallet.balance + auction.currentBid,
        totalSpent: Math.max(0, winnerWallet.totalSpent - auction.currentBid),
        lastTxId: refundTxId,
        updatedAt: FieldValue.serverTimestamp(),
      });
      tx.create(db.doc(`transactions/${refundTxId}`), {
        id: refundTxId, fromUid: 'SYSTEM', toUid: winnerUid, amount: auction.currentBid,
        fee: 0, netAmount: auction.currentBid, type: 'company_auction_refund',
        referenceId: auctionId, description: `Auction settlement refund for ${auction.companyName}`,
        status: 'completed', createdAt: FieldValue.serverTimestamp(),
      });
      releaseCompany();
      tx.update(auctionRef, { status: 'ended_refunded', updatedAt: FieldValue.serverTimestamp() });
      return;
    }

    const sellerStats = { ...(sellerProfile.stats || {}) };
    const winnerStats = { ...(winnerProfile.stats || {}) };
    sellerStats.companiesOwned = Math.max(0, Math.floor(sellerStats.companiesOwned || 0) - 1);
    winnerStats.companiesOwned = winnerOwned + 1;
    const payoutTxId = `tx_${randomUUID()}`;
    const logId = `clog_${randomUUID()}`;
    tx.update(companyRef, {
      ownerUid: winnerUid,
      ownerName: typeof winnerProfile.username === 'string' ? winnerProfile.username : 'Player',
      auctionId: FieldValue.delete(),
      auctionEndsAt: FieldValue.delete(),
      auctionStatus: FieldValue.delete(),
      lastCollectedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    tx.update(sellerProfileRef, { stats: sellerStats, updatedAt: FieldValue.serverTimestamp() });
    tx.update(winnerProfileRef, { stats: winnerStats, updatedAt: FieldValue.serverTimestamp() });
    tx.update(sellerWalletRef, {
      balance: sellerWallet.balance + auction.currentBid,
      totalEarned: sellerWallet.totalEarned + auction.currentBid,
      lastTxId: payoutTxId,
      updatedAt: FieldValue.serverTimestamp(),
    });
    tx.create(db.doc(`transactions/${payoutTxId}`), {
      id: payoutTxId, fromUid: 'SYSTEM', toUid: auction.sellerUid, amount: auction.currentBid,
      fee: 0, netAmount: auction.currentBid, type: 'company_auction_sale',
      referenceId: auctionId, description: `Sold company ${auction.companyName}`,
      status: 'completed', createdAt: FieldValue.serverTimestamp(),
    });
    tx.create(db.doc(`company_logs/${logId}`), {
      id: logId, companyId: auction.companyId, ownerUid: winnerUid,
      action: 'auction_purchase', amount: -auction.currentBid,
      details: `Acquired ${auction.companyName} from auction`,
      createdAt: FieldValue.serverTimestamp(),
    });
    tx.update(auctionRef, {
      status: 'ended_sold',
      winnerUid,
      winnerName: typeof winnerProfile.username === 'string' ? winnerProfile.username : 'Player',
      settledAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
  });
}

export const settleExpiredCompanyAuctions = onSchedule(
  { schedule: 'every 1 minutes', timeZone: 'UTC', region: 'us-central1', maxInstances: 1 },
  async () => {
    const now = Date.now();
    const snapshot = await db.collection('company_auctions').where('status', '==', 'active').get();
    for (const auctionDoc of snapshot.docs) {
      const auction = auctionDoc.data() as AuctionRecord;
      if (auction.endsAt <= now) await settleCompanyAuction(auctionDoc.id);
    }
  }
);


type SocialProfile = {
  username?: string;
  usernameLower?: string;
  avatarId?: string;
  title?: string;
  level?: number;
  reputation?: number;
  influence?: number;
  orgId?: string | null;
};
type SocialMember = { role?: string; permissions?: string[] };
type SocialOrganization = {
  id: string; name: string; tag: string; leaderUid: string; memberCount: number;
  level: number; memberCapacity?: number;
};

function cleanChatText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return '';
  return value.replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}


export const searchPlayersSecure = onCall(
  { region: 'us-central1', maxInstances: 20 },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'UNAUTHENTICATED');
    const prefix = cleanChatText(request.data?.prefix, 24).toLowerCase();
    if (prefix.length < 2) return { players: [] };
    const snapshot = await db.collection('profiles')
      .orderBy('usernameLower')
      .startAt(prefix)
      .endAt(prefix + '\uf8ff')
      .limit(15)
      .get();
    return {
      players: snapshot.docs
        .filter((docSnap) => docSnap.id !== request.auth!.uid)
        .map((docSnap) => {
          const data = docSnap.data() as SocialProfile;
          return {
            uid: docSnap.id,
            username: typeof data.username === 'string' ? data.username : 'Player',
            avatarId: typeof data.avatarId === 'string' ? data.avatarId : 'default',
            title: typeof data.title === 'string' ? data.title : '',
            level: Math.max(1, Number(data.level) || 1),
            reputation: Math.max(0, Number(data.reputation) || 0),
            influence: Math.max(0, Number(data.influence) || 0),
            orgId: typeof data.orgId === 'string' ? data.orgId : null,
          };
        }),
    };
  }
);

function socialBlockRef(ownerUid: string, targetUid: string) {
  return db.doc('user_blocks/' + ownerUid + '__' + targetUid);
}

export const listBlockedPlayersSecure = onCall(
  { region: 'us-central1', maxInstances: 20 },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError('unauthenticated', 'UNAUTHENTICATED');
    const snapshot = await db.collection('user_blocks').where('ownerUid', '==', uid).limit(200).get();
    return { blockedUids: snapshot.docs.map((docSnap) => docSnap.data().targetUid).filter((value): value is string => typeof value === 'string') };
  }
);

export const blockPlayerSecure = onCall(
  { region: 'us-central1', maxInstances: 20 },
  async (request) => {
    const uid = request.auth?.uid;
    const targetUid = typeof request.data?.targetUid === 'string' ? request.data.targetUid.trim() : '';
    if (!uid) throw new HttpsError('unauthenticated', 'UNAUTHENTICATED');
    if (!targetUid || targetUid === uid || targetUid.length > 128) throw new HttpsError('invalid-argument', 'INVALID_TARGET');
    const [ownerSnap, targetSnap] = await Promise.all([
      db.doc('profiles/' + uid).get(), db.doc('profiles/' + targetUid).get(),
    ]);
    if (!ownerSnap.exists || !targetSnap.exists) throw new HttpsError('not-found', 'PLAYER_NOT_FOUND');
    await socialBlockRef(uid, targetUid).set({
      ownerUid: uid, targetUid, createdAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    return { ok: true };
  }
);

export const unblockPlayerSecure = onCall(
  { region: 'us-central1', maxInstances: 20 },
  async (request) => {
    const uid = request.auth?.uid;
    const targetUid = typeof request.data?.targetUid === 'string' ? request.data.targetUid.trim() : '';
    if (!uid) throw new HttpsError('unauthenticated', 'UNAUTHENTICATED');
    if (!targetUid || targetUid === uid || targetUid.length > 128) throw new HttpsError('invalid-argument', 'INVALID_TARGET');
    await socialBlockRef(uid, targetUid).delete();
    return { ok: true };
  }
);

export const reportPlayerSecure = onCall(
  { region: 'us-central1', maxInstances: 20 },
  async (request) => {
    const uid = request.auth?.uid;
    const targetUid = typeof request.data?.targetUid === 'string' ? request.data.targetUid.trim() : '';
    const reason = request.data?.reason;
    const allowedReasons = ['harassment', 'spam', 'inappropriate', 'impersonation', 'other'];
    if (!uid) throw new HttpsError('unauthenticated', 'UNAUTHENTICATED');
    if (!targetUid || targetUid === uid || targetUid.length > 128 || !allowedReasons.includes(reason)) {
      throw new HttpsError('invalid-argument', 'INVALID_REPORT');
    }
    const targetRef = db.doc('profiles/' + targetUid);
    const reporterRef = db.doc('profiles/' + uid);
    const rateRef = db.doc('chat_rate_limits/report_' + uid);
    const reportRef = db.collection('player_reports').doc('report_' + randomUUID());
    await db.runTransaction(async (tx) => {
      const [reporterSnap, targetSnap, rateSnap] = await Promise.all([
        tx.get(reporterRef), tx.get(targetRef), tx.get(rateRef),
      ]);
      if (!reporterSnap.exists || !targetSnap.exists) throw new HttpsError('not-found', 'PLAYER_NOT_FOUND');
      const lastReported = rateSnap.exists ? timestampMillis(rateSnap.data()?.lastSentAt, 0) : 0;
      if (Date.now() - lastReported < 30_000) throw new HttpsError('resource-exhausted', 'REPORT_RATE_LIMIT');
      tx.create(reportRef, {
        id: reportRef.id, reporterUid: uid, targetUid, reason,
        status: 'open', createdAt: FieldValue.serverTimestamp(),
      });
      tx.set(rateRef, { lastSentAt: FieldValue.serverTimestamp() }, { merge: true });
    });
    return { ok: true };
  }
);

export const openDirectConversationSecure = onCall(
  { region: 'us-central1', maxInstances: 20 },
  async (request) => {
    const uid = request.auth?.uid;
    const targetUid = typeof request.data?.targetUid === 'string' ? request.data.targetUid.trim() : '';
    if (!uid) throw new HttpsError('unauthenticated', 'UNAUTHENTICATED');
    if (!targetUid || targetUid === uid || targetUid.length > 128) throw new HttpsError('invalid-argument', 'INVALID_TARGET');
    const participants = [uid, targetUid].sort();
    const conversationId = 'dm_' + participants.join('_');
    const conversationRef = db.doc('conversations/' + conversationId);
    return db.runTransaction(async (tx) => {
      const [senderSnap, targetSnap, conversationSnap, outgoingBlockSnap, incomingBlockSnap] = await Promise.all([
        tx.get(db.doc('profiles/' + uid)),
        tx.get(db.doc('profiles/' + targetUid)),
        tx.get(conversationRef),
        tx.get(socialBlockRef(uid, targetUid)),
        tx.get(socialBlockRef(targetUid, uid)),
      ]);
      if (!senderSnap.exists || !targetSnap.exists) throw new HttpsError('not-found', 'PLAYER_NOT_FOUND');
      if (outgoingBlockSnap.exists || incomingBlockSnap.exists) throw new HttpsError('permission-denied', 'PLAYER_BLOCKED');
      if (!conversationSnap.exists) {
        const sender = senderSnap.data() as SocialProfile;
        const target = targetSnap.data() as SocialProfile;
        const names: Record<string, string> = {};
        const avatars: Record<string, string> = {};
        names[uid] = typeof sender.username === 'string' ? sender.username : 'Player';
        names[targetUid] = typeof target.username === 'string' ? target.username : 'Player';
        avatars[uid] = typeof sender.avatarId === 'string' ? sender.avatarId : 'default';
        avatars[targetUid] = typeof target.avatarId === 'string' ? target.avatarId : 'default';
        tx.create(conversationRef, {
          id: conversationId, participants, participantNames: names, participantAvatars: avatars,
          lastMessage: '', lastMessageAt: FieldValue.serverTimestamp(), lastSenderUid: '',
          createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
        });
      } else {
        const existing = conversationSnap.data()!;
        if (!Array.isArray(existing.participants) || !participants.every((id) => existing.participants.includes(id))) {
          throw new HttpsError('permission-denied', 'CONVERSATION_ACCESS_DENIED');
        }
      }
      return { conversationId };
    });
  }
);

export const sendDirectMessageSecure = onCall(
  { region: 'us-central1', maxInstances: 30 },
  async (request) => {
    const uid = request.auth?.uid;
    const targetUid = typeof request.data?.targetUid === 'string' ? request.data.targetUid.trim() : '';
    const messageText = cleanChatText(request.data?.text, 1000);
    if (!uid) throw new HttpsError('unauthenticated', 'UNAUTHENTICATED');
    if (!targetUid || targetUid === uid || targetUid.length > 128 || !messageText) throw new HttpsError('invalid-argument', 'INVALID_MESSAGE');
    const participants = [uid, targetUid].sort();
    const conversationId = 'dm_' + participants.join('_');
    const conversationRef = db.doc('conversations/' + conversationId);
    const senderProfileRef = db.doc('profiles/' + uid);
    const targetProfileRef = db.doc('profiles/' + targetUid);
    const rateRef = db.doc('chat_rate_limits/dm_' + uid);
    const messageRef = conversationRef.collection('messages').doc('msg_' + randomUUID());

    await db.runTransaction(async (tx) => {
      const [senderSnap, targetSnap, conversationSnap, rateSnap, outgoingBlockSnap, incomingBlockSnap] = await Promise.all([
        tx.get(senderProfileRef), tx.get(targetProfileRef), tx.get(conversationRef), tx.get(rateRef),
        tx.get(socialBlockRef(uid, targetUid)), tx.get(socialBlockRef(targetUid, uid)),
      ]);
      if (!senderSnap.exists || !targetSnap.exists) throw new HttpsError('not-found', 'PLAYER_NOT_FOUND');
      if (outgoingBlockSnap.exists || incomingBlockSnap.exists) throw new HttpsError('permission-denied', 'PLAYER_BLOCKED');
      const lastSent = rateSnap.exists ? timestampMillis(rateSnap.data()?.lastSentAt, 0) : 0;
      if (Date.now() - lastSent < 1_000) throw new HttpsError('resource-exhausted', 'CHAT_RATE_LIMIT');
      const sender = senderSnap.data() as SocialProfile;
      const target = targetSnap.data() as SocialProfile;
      const names: Record<string, string> = {};
      const avatars: Record<string, string> = {};
      names[uid] = typeof sender.username === 'string' ? sender.username : 'Player';
      names[targetUid] = typeof target.username === 'string' ? target.username : 'Player';
      avatars[uid] = typeof sender.avatarId === 'string' ? sender.avatarId : 'default';
      avatars[targetUid] = typeof target.avatarId === 'string' ? target.avatarId : 'default';
      if (conversationSnap.exists) {
        const existing = conversationSnap.data()!;
        if (!Array.isArray(existing.participants) || !participants.every((id) => existing.participants.includes(id))) {
          throw new HttpsError('permission-denied', 'CONVERSATION_ACCESS_DENIED');
        }
        tx.update(conversationRef, {
          lastMessage: messageText.slice(0, 120),
          lastMessageAt: FieldValue.serverTimestamp(),
          lastSenderUid: uid,
          updatedAt: FieldValue.serverTimestamp(),
        });
      } else {
        tx.create(conversationRef, {
          id: conversationId, participants, participantNames: names, participantAvatars: avatars,
          lastMessage: messageText.slice(0, 120), lastMessageAt: FieldValue.serverTimestamp(),
          lastSenderUid: uid, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
        });
      }
      tx.create(messageRef, {
        id: messageRef.id, senderUid: uid, senderName: names[uid],
        text: messageText, createdAt: FieldValue.serverTimestamp(),
      });
      tx.set(rateRef, { lastSentAt: FieldValue.serverTimestamp() }, { merge: true });
    });
    return { ok: true };
  }
);

export const sendGlobalChatMessageSecure = onCall(
  { region: 'us-central1', maxInstances: 30 },
  async (request) => {
    const uid = request.auth?.uid;
    const messageText = cleanChatText(request.data?.text, 280);
    if (!uid) throw new HttpsError('unauthenticated', 'UNAUTHENTICATED');
    if (!messageText) throw new HttpsError('invalid-argument', 'EMPTY_MESSAGE');
    const profileRef = db.doc('profiles/' + uid);
    const rateRef = db.doc('chat_rate_limits/global_' + uid);
    const messageRef = db.collection('global_chat_messages').doc('gmsg_' + randomUUID());
    await db.runTransaction(async (tx) => {
      const [profileSnap, rateSnap] = await Promise.all([tx.get(profileRef), tx.get(rateRef)]);
      if (!profileSnap.exists) throw new HttpsError('not-found', 'PROFILE_NOT_FOUND');
      const lastSent = rateSnap.exists ? timestampMillis(rateSnap.data()?.lastSentAt, 0) : 0;
      if (Date.now() - lastSent < 3_000) throw new HttpsError('resource-exhausted', 'CHAT_RATE_LIMIT');
      const profile = profileSnap.data() as SocialProfile;
      tx.create(messageRef, {
        id: messageRef.id, senderUid: uid,
        senderName: typeof profile.username === 'string' ? profile.username : 'Player',
        avatarId: typeof profile.avatarId === 'string' ? profile.avatarId : 'default',
        text: messageText, createdAt: FieldValue.serverTimestamp(),
      });
      tx.set(rateRef, { lastSentAt: FieldValue.serverTimestamp() }, { merge: true });
    });
    return { ok: true };
  }
);

export const invitePlayerToOrganizationSecure = onCall(
  { region: 'us-central1', maxInstances: 20 },
  async (request) => {
    const uid = request.auth?.uid;
    const targetUid = typeof request.data?.targetUid === 'string' ? request.data.targetUid.trim() : '';
    if (!uid) throw new HttpsError('unauthenticated', 'UNAUTHENTICATED');
    if (!targetUid || targetUid === uid || targetUid.length > 128) throw new HttpsError('invalid-argument', 'INVALID_TARGET');
    const inviterProfileRef = db.doc('profiles/' + uid);
    const targetRef = db.doc('profiles/' + targetUid);
    return db.runTransaction(async (tx) => {
      const inviterProfileSnap = await tx.get(inviterProfileRef);
      if (!inviterProfileSnap.exists) throw new HttpsError('not-found', 'PROFILE_NOT_FOUND');
      const orgId = typeof inviterProfileSnap.data()?.orgId === 'string'
        ? inviterProfileSnap.data()!.orgId as string
        : '';
      if (!orgId) throw new HttpsError('failed-precondition', 'NOT_IN_ORG');
      const memberRef = db.doc('organization_members/' + orgId + '_' + uid);
      const orgRef = db.doc('organizations/' + orgId);
      const inviteRef = db.doc('organization_invites/' + orgId + '_' + targetUid);
      const [memberSnap, orgSnap, targetSnap, inviteSnap] = await Promise.all([
        tx.get(memberRef), tx.get(orgRef), tx.get(targetRef), tx.get(inviteRef),
      ]);
      if (!memberSnap.exists || !orgSnap.exists || !targetSnap.exists) throw new HttpsError('not-found', 'NOT_FOUND');
      const member = memberSnap.data() as SocialMember;
      const org = orgSnap.data() as SocialOrganization;
      const canInvite = member.role === 'leader' || member.role === 'deputy' ||
        (Array.isArray(member.permissions) && member.permissions.includes('manage_members'));
      if (!canInvite) throw new HttpsError('permission-denied', 'INVITE_PERMISSION_REQUIRED');
      const target = targetSnap.data() as SocialProfile;
      if (target.orgId) throw new HttpsError('failed-precondition', 'TARGET_ALREADY_IN_ORG');
      if (inviteSnap.exists && inviteSnap.data()?.status === 'pending') throw new HttpsError('already-exists', 'INVITE_ALREADY_PENDING');
      tx.set(inviteRef, {
        id: inviteRef.id, orgId, orgName: org.name, orgTag: org.tag,
        targetUid, inviterUid: uid,
        inviterName: typeof inviterProfileSnap.data()?.username === 'string' ? inviterProfileSnap.data()!.username : 'Player',
        status: 'pending', createdAt: FieldValue.serverTimestamp(),
      });
      return { ok: true };
    });
  }
);

export const respondOrganizationInviteSecure = onCall(
  { region: 'us-central1', maxInstances: 20 },
  async (request) => {
    const uid = request.auth?.uid;
    const inviteId = typeof request.data?.inviteId === 'string' ? request.data.inviteId.trim() : '';
    const response = request.data?.response;
    if (!uid) throw new HttpsError('unauthenticated', 'UNAUTHENTICATED');
    if (!inviteId || inviteId.length > 160 || !['accept', 'decline'].includes(response)) {
      throw new HttpsError('invalid-argument', 'INVALID_ARGUMENT');
    }
    return db.runTransaction(async (tx) => {
      const inviteRef = db.doc('organization_invites/' + inviteId);
      const inviteSnap = await tx.get(inviteRef);
      if (!inviteSnap.exists) throw new HttpsError('not-found', 'INVITE_NOT_FOUND');
      const invite = inviteSnap.data()!;
      if (invite.targetUid !== uid || invite.status !== 'pending') throw new HttpsError('permission-denied', 'INVITE_NOT_AVAILABLE');
      if (response === 'decline') {
        tx.update(inviteRef, { status: 'rejected', respondedAt: FieldValue.serverTimestamp() });
        return { ok: true, status: 'rejected' };
      }
      const orgId = typeof invite.orgId === 'string' ? invite.orgId : '';
      const orgRef = db.doc('organizations/' + orgId);
      const profileRef = db.doc('profiles/' + uid);
      const memberRef = db.doc('organization_members/' + orgId + '_' + uid);
      const [orgSnap, profileSnap, memberSnap] = await Promise.all([tx.get(orgRef), tx.get(profileRef), tx.get(memberRef)]);
      if (!orgSnap.exists || !profileSnap.exists) throw new HttpsError('not-found', 'ORG_OR_PROFILE_NOT_FOUND');
      const org = orgSnap.data() as SocialOrganization;
      const profile = profileSnap.data() as SocialProfile;
      if (profile.orgId || memberSnap.exists) throw new HttpsError('failed-precondition', 'ALREADY_IN_ORG');
      const capacity = typeof org.memberCapacity === 'number' ? org.memberCapacity : Math.min(70, 20 + (org.level - 1) * 5);
      if (org.memberCount >= capacity) throw new HttpsError('resource-exhausted', 'ORG_FULL');
      tx.create(memberRef, {
        orgId, uid, username: typeof profile.username === 'string' ? profile.username : 'Player',
        role: 'member', permissions: [], joinedAt: FieldValue.serverTimestamp(),
      });
      tx.update(profileRef, { orgId, updatedAt: FieldValue.serverTimestamp() });
      tx.update(orgRef, { memberCount: org.memberCount + 1, updatedAt: FieldValue.serverTimestamp() });
      tx.update(inviteRef, { status: 'accepted', respondedAt: FieldValue.serverTimestamp() });
      return { ok: true, status: 'accepted' };
    });
  }
);

export const getPublicPlayerProfileSecure = onCall(
  { region: 'us-central1', maxInstances: 20 },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'UNAUTHENTICATED');
    const targetUid = typeof request.data?.targetUid === 'string' ? request.data.targetUid.trim() : '';
    if (!targetUid || targetUid.length > 128) throw new HttpsError('invalid-argument', 'INVALID_TARGET');
    const snap = await db.doc('profiles/' + targetUid).get();
    if (!snap.exists) throw new HttpsError('not-found', 'PLAYER_NOT_FOUND');
    const data = snap.data() as SocialProfile;
    return {
      uid: targetUid,
      username: typeof data.username === 'string' ? data.username : 'Player',
      avatarId: typeof data.avatarId === 'string' ? data.avatarId : 'default',
      title: typeof data.title === 'string' ? data.title : '',
      level: Math.max(1, Number(data.level) || 1),
      reputation: Math.max(0, Number(data.reputation) || 0),
      influence: Math.max(0, Number(data.influence) || 0),
      orgId: typeof data.orgId === 'string' ? data.orgId : null,
    };
  }
);


// Dedicated NEXORA Reports Center API. Access is restricted to verified report administrators.
async function requireReportsAdmin(request: CallableRequest<unknown>): Promise<string> {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'UNAUTHENTICATED');
  if (request.auth?.token.email_verified !== true) {
    throw new HttpsError('permission-denied', 'VERIFIED_EMAIL_REQUIRED');
  }
  const claims = request.auth.token as Record<string, unknown>;
  if (claims.reportsAdmin === true) return uid;
  const adminSnap = await db.doc('reports_admins/' + uid).get();
  if (adminSnap.exists && adminSnap.data()?.enabled === true) return uid;
  throw new HttpsError('permission-denied', 'REPORTS_ADMIN_REQUIRED');
}

export const listPlayerReportsAdmin = onCall(
  { region: 'us-central1', maxInstances: 10, timeoutSeconds: 30 },
  async (request) => {
    await requireReportsAdmin(request);
    const status = typeof request.data?.status === 'string' ? request.data.status : 'all';
    const allowed = ['all', 'open', 'reviewing', 'closed'];
    if (!allowed.includes(status)) throw new HttpsError('invalid-argument', 'INVALID_STATUS');
    const limit = Math.max(1, Math.min(100, Number(request.data?.limit) || 50));
    let query: Query = db.collection('player_reports').orderBy('createdAt', 'desc').limit(limit);
    if (status !== 'all') query = db.collection('player_reports').where('status', '==', status).orderBy('createdAt', 'desc').limit(limit);
    const snapshot = await query.get();
    return {
      reports: snapshot.docs.map((item) => {
        const data = item.data();
        const createdAt = data.createdAt;
        return {
          id: item.id,
          reporterUid: typeof data.reporterUid === 'string' ? data.reporterUid : '',
          targetUid: typeof data.targetUid === 'string' ? data.targetUid : '',
          reason: typeof data.reason === 'string' ? data.reason : 'other',
          status: typeof data.status === 'string' ? data.status : 'open',
          createdAt: createdAt && typeof createdAt.toMillis === 'function' ? createdAt.toMillis() : null,
          reviewedAt: data.reviewedAt && typeof data.reviewedAt.toMillis === 'function' ? data.reviewedAt.toMillis() : null,
          reviewedBy: typeof data.reviewedBy === 'string' ? data.reviewedBy : null,
        };
      }),
    };
  }
);

export const updatePlayerReportAdmin = onCall(
  { region: 'us-central1', maxInstances: 10, timeoutSeconds: 30 },
  async (request) => {
    const adminUid = await requireReportsAdmin(request);
    const reportId = typeof request.data?.reportId === 'string' ? request.data.reportId.trim() : '';
    const status = request.data?.status;
    if (!reportId || reportId.length > 180 || !['reviewing', 'closed', 'open'].includes(status)) {
      throw new HttpsError('invalid-argument', 'INVALID_REPORT_UPDATE');
    }
    const reportRef = db.collection('player_reports').doc(reportId);
    const auditRef = db.collection('player_report_audit').doc('audit_' + randomUUID());
    await db.runTransaction(async (tx) => {
      const reportSnap = await tx.get(reportRef);
      if (!reportSnap.exists) throw new HttpsError('not-found', 'REPORT_NOT_FOUND');
      tx.update(reportRef, {
        status,
        reviewedBy: adminUid,
        reviewedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      tx.create(auditRef, {
        reportId,
        actorUid: adminUid,
        action: 'status_changed',
        newStatus: status,
        createdAt: FieldValue.serverTimestamp(),
      });
    });
    return { ok: true };
  }
);

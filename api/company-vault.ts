import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { FieldValue, Firestore, Timestamp, type DocumentData } from '@google-cloud/firestore';
import { IdentityPoolClient } from 'google-auth-library';
import { createRemoteJWKSet, jwtVerify } from 'jose';

const PROJECT_ID = 'gen-lang-client-0074900177';
const PROJECT_NUMBER = '145581837596';
const DATABASE_ID = 'ai-studio-74843d9e-8228-49b7-a616-317cadd90bff';
const SERVICE_ACCOUNT = 'nexora-vercel-runtime@gen-lang-client-0074900177.iam.gserviceaccount.com';
const WIF_AUDIENCE = `//iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/nexora-vercel-pool/providers/nexora-vercel`;
const FIREBASE_ISSUER = `https://securetoken.google.com/${PROJECT_ID}`;
const FIREBASE_KEYS = createRemoteJWKSet(
  new URL('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com')
);

type ApiRequest = IncomingMessage & { body?: unknown };
type ApiResponse = ServerResponse & {
  status: (code: number) => ApiResponse;
  json: (body: unknown) => void;
};
type VaultCompany = {
  ownerUid: string;
  name: string;
  sector?: string;
  level: number;
  employeesCount: number;
  baseRevenuePerHour: number;
  expensePerHour: number;
  totalRevenue?: number;
  vaultLevel?: number;
  vaultBalance?: number;
  lastCollectedAt?: unknown;
};
type VaultProfile = {
  xp: number;
  level: number;
  skillPoints: number;
  reputation: number;
  influence: number;
  skills?: { management?: number; finance?: number; leadership?: number };
};
type VaultWallet = { balance: number; totalEarned: number; totalSpent: number };

const VAULT_CAPACITIES = [3500, 7000, 14000, 25000, 40000] as const;
const VAULT_UPGRADES = [
  { cost: 1500, materials: { copper_wire: 20, crude_alloy: 10 } },
  { cost: 4000, materials: { silicon_ore: 20, energy_cells: 15 } },
  { cost: 10000, materials: { carbon_fiber: 15, precision_frame: 10 } },
  { cost: 25000, materials: { rare_minerals: 20, quantum_server: 5 } },
] as const;
const REPUTATION_YIELD_TIERS = [
  { min: 0, bonus: 0 },
  { min: 60, bonus: 0.02 },
  { min: 160, bonus: 0.04 },
  { min: 350, bonus: 0.06 },
  { min: 700, bonus: 0.08 },
] as const;

function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function vaultLevelOf(company: VaultCompany): number {
  const level = Number.isFinite(company.vaultLevel) ? Math.floor(company.vaultLevel as number) : 1;
  return Math.max(1, Math.min(5, level));
}

function timestampMillis(value: unknown, fallback: number): number {
  if (value instanceof Timestamp) return value.toMillis();
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  if (value && typeof value === 'object' && 'seconds' in value && typeof (value as { seconds?: unknown }).seconds === 'number') {
    return Number((value as { seconds: number }).seconds) * 1000;
  }
  return fallback;
}

function companyNetHourly(company: VaultCompany, profile: VaultProfile, events: DocumentData[], nowMs: number): number {
  const levelMultiplier = 1 + (numberOrZero(company.level) - 1) * 0.32;
  const staffBonus = 1 + Math.max(0, numberOrZero(company.employeesCount) - 1) * 0.05;
  const management = Math.max(0, numberOrZero(profile.skills?.management));
  const finance = Math.max(0, numberOrZero(profile.skills?.finance));
  const managementBonus = 1 + management * 0.08;
  const tier = [...REPUTATION_YIELD_TIERS].reverse().find((item) => numberOrZero(profile.reputation) >= item.min) ?? REPUTATION_YIELD_TIERS[0];
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
    if (
      company.sector &&
      Array.isArray(event.affectedSectors) &&
      event.affectedSectors.includes(company.sector) &&
      typeof event.revenueMultiplier === 'number'
    ) {
      eventMultiplier *= event.revenueMultiplier;
    }
    accepted += 1;
    if (accepted >= 3) break;
  }

  eventMultiplier = Number(Math.max(0.75, Math.min(1.4, eventMultiplier)).toFixed(3));
  const gross = Math.round(
    numberOrZero(company.baseRevenuePerHour) *
      levelMultiplier *
      staffBonus *
      managementBonus *
      eventMultiplier *
      reputationBonus
  );
  const rawExpense =
    numberOrZero(company.expensePerHour) * (1 + (numberOrZero(company.level) - 1) * 0.2) +
    Math.max(0, numberOrZero(company.employeesCount) - 3) * 8;
  const expense = Math.round(rawExpense * (1 - Math.min(0.45, finance * 0.05)));
  return Math.max(15, gross - expense);
}

function calculatedVaultBalance(company: VaultCompany, netHourly: number, nowMs: number): number {
  const level = vaultLevelOf(company);
  const capacity = VAULT_CAPACITIES[level - 1];
  const stored = Math.max(0, numberOrZero(company.vaultBalance));
  const last = timestampMillis(company.lastCollectedAt, nowMs);
  const elapsed = Math.max(0, nowMs - last);
  return Math.min(capacity, stored + Math.max(0, Math.floor((Math.max(0, netHourly) * elapsed) / 3_600_000)));
}

function levelForXp(totalXp: number): number {
  let level = 1;
  let remaining = Math.max(0, Math.floor(totalXp));
  while (level < 200) {
    const step = 200 + Math.max(0, level - 1) * 120;
    if (remaining < step) return level;
    remaining -= step;
    level += 1;
  }
  return 200;
}

async function verifyPlayer(req: ApiRequest): Promise<string> {
  const header = req.headers.authorization;
  const match = typeof header === 'string' ? /^Bearer\s+(.+)$/i.exec(header) : null;
  if (!match) throw new VaultError('UNAUTHENTICATED', 401);

  const { payload } = await jwtVerify(match[1], FIREBASE_KEYS, {
    issuer: FIREBASE_ISSUER,
    audience: PROJECT_ID,
    algorithms: ['RS256'],
  });
  if (typeof payload.sub !== 'string' || payload.sub.length === 0 || payload.sub.length > 128) {
    throw new VaultError('UNAUTHENTICATED', 401);
  }
  return payload.sub;
}

class VaultError extends Error {
  constructor(public readonly code: string, public readonly status: number) {
    super(code);
  }
}

function firestoreForRequest(req: ApiRequest): Firestore {
  const rawToken = req.headers['x-vercel-oidc-token'];
  const oidcToken = Array.isArray(rawToken) ? rawToken[0] : rawToken;
  if (typeof oidcToken !== 'string' || oidcToken.length < 40) {
    throw new VaultError('VERCEL_OIDC_TOKEN_MISSING', 503);
  }

  const authClient = new IdentityPoolClient({
    audience: WIF_AUDIENCE,
    subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
    token_url: 'https://sts.googleapis.com/v1/token',
    service_account_impersonation_url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${SERVICE_ACCOUNT}:generateAccessToken`,
    subject_token_supplier: {
      getSubjectToken: async () => oidcToken,
    },
  });
  authClient.scopes = ['https://www.googleapis.com/auth/cloud-platform'];

  return new Firestore({
    projectId: PROJECT_ID,
    databaseId: DATABASE_ID,
    authClient,
  });
}

async function upgradeVault(db: Firestore, uid: string, companyId: string) {
  return db.runTransaction(async (tx) => {
    const companyRef = db.doc(`companies/${companyId}`);
    const walletRef = db.doc(`wallets/${uid}`);
    const profileRef = db.doc(`profiles/${uid}`);
    const [companySnap, walletSnap, profileSnap, eventsSnap] = await Promise.all([
      tx.get(companyRef),
      tx.get(walletRef),
      tx.get(profileRef),
      tx.get(db.collection('world_events').where('active', '==', true)),
    ]);

    if (!companySnap.exists) throw new VaultError('COMPANY_NOT_FOUND', 404);
    if (!walletSnap.exists || !profileSnap.exists) throw new VaultError('ACCOUNT_NOT_FOUND', 409);
    const company = companySnap.data() as VaultCompany;
    const wallet = walletSnap.data() as VaultWallet;
    const profile = profileSnap.data() as VaultProfile;
    if (company.ownerUid !== uid) throw new VaultError('UNAUTHORIZED', 403);

    const oldLevel = vaultLevelOf(company);
    if (oldLevel >= 5) throw new VaultError('VAULT_MAX_LEVEL', 409);
    const upgrade = VAULT_UPGRADES[oldLevel - 1];
    if (numberOrZero(wallet.balance) < upgrade.cost) throw new VaultError('INSUFFICIENT_FUNDS', 409);

    const itemEntries = Object.entries(upgrade.materials);
    const inventorySnaps = await Promise.all(
      itemEntries.map(([itemId]) => tx.get(db.doc(`inventory/${uid}_${itemId}`)))
    );
    for (let index = 0; index < itemEntries.length; index += 1) {
      const required = itemEntries[index][1];
      if (!inventorySnaps[index].exists || numberOrZero(inventorySnaps[index].data()?.quantity) < required) {
        throw new VaultError('MISSING_VAULT_MATERIALS', 409);
      }
    }

    const now = Date.now();
    const events = eventsSnap.docs.map((snapshot) => snapshot.data());
    const netHourly = companyNetHourly(company, profile, events, now);
    const preserved = calculatedVaultBalance(company, netHourly, now);
    const txId = `tx_${randomUUID()}`;
    const logId = `clog_${randomUUID()}`;

    tx.update(walletRef, {
      balance: numberOrZero(wallet.balance) - upgrade.cost,
      totalSpent: numberOrZero(wallet.totalSpent) + upgrade.cost,
      lastTxId: txId,
      updatedAt: FieldValue.serverTimestamp(),
    });
    itemEntries.forEach(([itemId, required], index) => {
      const current = numberOrZero(inventorySnaps[index].data()?.quantity);
      tx.update(db.doc(`inventory/${uid}_${itemId}`), {
        quantity: current - required,
        updatedAt: FieldValue.serverTimestamp(),
      });
    });
    tx.update(companyRef, {
      vaultLevel: oldLevel + 1,
      vaultBalance: preserved,
      lastCollectedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    tx.create(db.doc(`transactions/${txId}`), {
      id: txId,
      fromUid: uid,
      toUid: 'SYSTEM',
      amount: upgrade.cost,
      fee: 0,
      netAmount: upgrade.cost,
      type: 'company_vault_upgrade',
      referenceId: companyId,
      description: `Upgraded ${company.name} profit vault to Lv.${oldLevel + 1}`,
      status: 'completed',
      createdAt: FieldValue.serverTimestamp(),
    });
    tx.create(db.doc(`company_logs/${logId}`), {
      id: logId,
      companyId,
      ownerUid: uid,
      action: 'vault_upgrade',
      amount: -upgrade.cost,
      details: `Profit vault upgraded to Lv.${oldLevel + 1}; preserved ${preserved}`,
      createdAt: FieldValue.serverTimestamp(),
    });
    return { ok: true, vaultLevel: oldLevel + 1, vaultBalance: preserved, capacity: VAULT_CAPACITIES[oldLevel] };
  });
}

async function collectVault(db: Firestore, uid: string, companyId: string) {
  return db.runTransaction(async (tx) => {
    const companyRef = db.doc(`companies/${companyId}`);
    const walletRef = db.doc(`wallets/${uid}`);
    const profileRef = db.doc(`profiles/${uid}`);
    const [companySnap, walletSnap, profileSnap, eventsSnap] = await Promise.all([
      tx.get(companyRef),
      tx.get(walletRef),
      tx.get(profileRef),
      tx.get(db.collection('world_events').where('active', '==', true)),
    ]);

    if (!companySnap.exists) throw new VaultError('COMPANY_NOT_FOUND', 404);
    if (!walletSnap.exists || !profileSnap.exists) throw new VaultError('ACCOUNT_NOT_FOUND', 409);
    const company = companySnap.data() as VaultCompany;
    const wallet = walletSnap.data() as VaultWallet;
    const profile = profileSnap.data() as VaultProfile;
    if (company.ownerUid !== uid) throw new VaultError('UNAUTHORIZED', 403);

    const now = Date.now();
    const lastCollected = timestampMillis(company.lastCollectedAt, now);
    if (now - lastCollected < 30_000) throw new VaultError('NOTHING_TO_COLLECT', 409);
    const events = eventsSnap.docs.map((snapshot) => snapshot.data());
    const netHourly = companyNetHourly(company, profile, events, now);
    const payout = calculatedVaultBalance(company, netHourly, now);
    if (payout < 1) throw new VaultError('NOTHING_TO_COLLECT', 409);

    const txId = `tx_${randomUUID()}`;
    const logId = `clog_${randomUUID()}`;
    const xpGain = Math.min(80, Math.max(10, Math.floor(payout / 15)));
    const nextXp = numberOrZero(profile.xp) + xpGain;
    const nextLevel = levelForXp(nextXp);
    const levelsGained = Math.max(0, nextLevel - numberOrZero(profile.level));
    const leadershipBonus = 1 + Math.max(0, numberOrZero(profile.skills?.leadership)) * 0.1;

    tx.update(walletRef, {
      balance: numberOrZero(wallet.balance) + payout,
      totalEarned: numberOrZero(wallet.totalEarned) + payout,
      lastTxId: txId,
      updatedAt: FieldValue.serverTimestamp(),
    });
    tx.update(companyRef, {
      totalRevenue: numberOrZero(company.totalRevenue) + payout,
      vaultBalance: 0,
      lastCollectedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    tx.update(profileRef, {
      xp: nextXp,
      level: nextLevel,
      skillPoints: numberOrZero(profile.skillPoints) + levelsGained * 2,
      reputation: numberOrZero(profile.reputation) + Math.round(2 * leadershipBonus),
      influence: numberOrZero(profile.influence) + Math.round(1 * leadershipBonus),
      updatedAt: FieldValue.serverTimestamp(),
    });
    tx.create(db.doc(`transactions/${txId}`), {
      id: txId,
      fromUid: 'SYSTEM',
      toUid: uid,
      amount: payout,
      fee: 0,
      netAmount: payout,
      type: 'company_collect',
      referenceId: companyId,
      description: `Company revenue collected: ${company.name}`,
      status: 'completed',
      createdAt: FieldValue.serverTimestamp(),
    });
    tx.create(db.doc(`company_logs/${logId}`), {
      id: logId,
      companyId,
      ownerUid: uid,
      action: 'collect',
      amount: payout,
      details: `Collected +$${payout}`,
      createdAt: FieldValue.serverTimestamp(),
    });
    return { ok: true, payout };
  });
}

export default async function handler(req: ApiRequest, res: ApiResponse): Promise<void> {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'METHOD_NOT_ALLOWED' });
    return;
  }

  const body = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {};
  const action = body.action;
  const companyId = typeof body.companyId === 'string' ? body.companyId.trim() : '';
  if ((action !== 'upgrade' && action !== 'collect') || !companyId || companyId.length > 128) {
    res.status(400).json({ error: 'INVALID_ARGUMENT' });
    return;
  }

  try {
    const uid = await verifyPlayer(req);
    const db = firestoreForRequest(req);
    const result = action === 'upgrade'
      ? await upgradeVault(db, uid, companyId)
      : await collectVault(db, uid, companyId);
    res.status(200).json(result);
  } catch (error) {
    if (error instanceof VaultError) {
      res.status(error.status).json({ error: error.code });
      return;
    }
    const message = error instanceof Error ? error.message : '';
    if (message.includes('invalid_grant') || message.includes('unauthorized_client') || message.includes('PERMISSION_DENIED')) {
      res.status(503).json({ error: 'BACKEND_IDENTITY_NOT_READY' });
      return;
    }
    res.status(500).json({ error: 'COMPANY_VAULT_OPERATION_FAILED' });
  }
}

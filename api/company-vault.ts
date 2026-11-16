import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
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
type Data = Record<string, unknown>;
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
type RestDocument = { name: string; fields?: Record<string, unknown> };
type RestWrite = {
  update: { name: string; fields: Record<string, unknown> };
  updateMask: { fieldPaths: string[] };
  updateTransforms?: Array<{ fieldPath: string; setToServerValue: 'REQUEST_TIME' }>;
  currentDocument?: { exists: boolean };
};

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

class VaultError extends Error {
  constructor(public readonly code: string, public readonly status: number) {
    super(code);
  }
}

function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function vaultLevelOf(company: VaultCompany): number {
  const raw = numberOrZero(company.vaultLevel);
  return Math.max(1, Math.min(5, raw ? Math.floor(raw) : 1));
}

function timestampMillis(value: unknown, fallback: number): number {
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

function decodeValue(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  const item = value as Record<string, unknown>;
  if ('stringValue' in item) return item.stringValue;
  if ('integerValue' in item) return Number(item.integerValue);
  if ('doubleValue' in item) return Number(item.doubleValue);
  if ('booleanValue' in item) return item.booleanValue;
  if ('timestampValue' in item) return item.timestampValue;
  if ('nullValue' in item) return null;
  if ('referenceValue' in item) return item.referenceValue;
  if ('bytesValue' in item) return item.bytesValue;
  if ('mapValue' in item) {
    const fields = (item.mapValue as { fields?: Record<string, unknown> } | undefined)?.fields ?? {};
    return Object.fromEntries(Object.entries(fields).map(([key, child]) => [key, decodeValue(child)]));
  }
  if ('arrayValue' in item) {
    const values = (item.arrayValue as { values?: unknown[] } | undefined)?.values ?? [];
    return values.map(decodeValue);
  }
  return item;
}

function decodeDocument(document: RestDocument): Data {
  const fields = document.fields ?? {};
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, decodeValue(value)]));
}

function encodeValue(value: unknown): unknown {
  if (value === null || value === undefined) return { nullValue: 'NULL_VALUE' };
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') {
    return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  }
  throw new Error('UNSUPPORTED_FIRESTORE_VALUE');
}

function documentName(path: string): string {
  return `projects/${PROJECT_ID}/databases/${DATABASE_ID}/documents/${path}`;
}

function updateWrite(path: string, fields: Data, serverTimestampFields: string[] = [], createOnly = false): RestWrite {
  const encoded = Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined).map(([key, value]) => [key, encodeValue(value)])
  );
  return {
    update: { name: documentName(path), fields: encoded },
    updateMask: { fieldPaths: Object.keys(encoded) },
    ...(serverTimestampFields.length
      ? { updateTransforms: serverTimestampFields.map((fieldPath) => ({ fieldPath, setToServerValue: 'REQUEST_TIME' as const })) }
      : {}),
    ...(createOnly ? { currentDocument: { exists: false } } : {}),
  };
}

class FirestoreRest {
  constructor(private readonly authClient: IdentityPoolClient) {}

  private async request<T>(method: string, body: Data): Promise<T> {
    const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/${DATABASE_ID}/documents:${method}`;
    const response = await this.authClient.fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return response.data as T;
  }

  async begin(): Promise<string> {
    const result = await this.request<{ transaction?: string }>('beginTransaction', { options: { readWrite: {} } });
    if (!result.transaction) throw new Error('FIRESTORE_TRANSACTION_START_FAILED');
    return result.transaction;
  }

  async getMany(transaction: string, paths: string[]): Promise<Array<Data | null>> {
    const rows = await this.request<Array<{ found?: RestDocument; missing?: string }>>('batchGet', {
      documents: paths.map(documentName),
      transaction,
    });
    const documents = new Map<string, Data | null>();
    for (const row of rows) {
      if (row.found) documents.set(row.found.name, decodeDocument(row.found));
      else if (row.missing) documents.set(row.missing, null);
    }
    return paths.map((path) => documents.get(documentName(path)) ?? null);
  }

  async getActiveEvents(transaction: string): Promise<Data[]> {
    const rows = await this.request<Array<{ document?: RestDocument }>>('runQuery', {
      structuredQuery: {
        from: [{ collectionId: 'world_events' }],
        where: {
          fieldFilter: {
            field: { fieldPath: 'active' },
            op: 'EQUAL',
            value: { booleanValue: true },
          },
        },
      },
      transaction,
    });
    return rows.flatMap((row) => row.document ? [decodeDocument(row.document)] : []);
  }

  async commit(transaction: string, writes: RestWrite[]): Promise<void> {
    await this.request('commit', { transaction, writes });
  }

  async rollback(transaction: string): Promise<void> {
    await this.request('rollback', { transaction });
  }

  async runTransaction<T>(work: (transaction: string) => Promise<{ result: T; writes: RestWrite[] }>): Promise<T> {
    const transaction = await this.begin();
    try {
      const staged = await work(transaction);
      await this.commit(transaction, staged.writes);
      return staged.result;
    } catch (error) {
      await this.rollback(transaction).catch(() => undefined);
      throw error;
    }
  }
}

function companyNetHourly(company: VaultCompany, profile: VaultProfile, events: Data[], nowMs: number): number {
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

function firestoreForRequest(req: ApiRequest): FirestoreRest {
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
    subject_token_supplier: { getSubjectToken: async () => oidcToken },
  });
  authClient.scopes = ['https://www.googleapis.com/auth/cloud-platform'];
  return new FirestoreRest(authClient);
}

async function upgradeVault(db: FirestoreRest, uid: string, companyId: string) {
  return db.runTransaction(async (transaction) => {
    const [[companyRaw, walletRaw, profileRaw], events] = await Promise.all([
      db.getMany(transaction, [`companies/${companyId}`, `wallets/${uid}`, `profiles/${uid}`]),
      db.getActiveEvents(transaction),
    ]);
    if (!companyRaw) throw new VaultError('COMPANY_NOT_FOUND', 404);
    if (!walletRaw || !profileRaw) throw new VaultError('ACCOUNT_NOT_FOUND', 409);
    const company = companyRaw as VaultCompany;
    const wallet = walletRaw as unknown as VaultWallet;
    const profile = profileRaw as unknown as VaultProfile;
    if (company.ownerUid !== uid) throw new VaultError('UNAUTHORIZED', 403);

    const oldLevel = vaultLevelOf(company);
    if (oldLevel >= 5) throw new VaultError('VAULT_MAX_LEVEL', 409);
    const upgrade = VAULT_UPGRADES[oldLevel - 1];
    if (numberOrZero(wallet.balance) < upgrade.cost) throw new VaultError('INSUFFICIENT_FUNDS', 409);

    const itemEntries = Object.entries(upgrade.materials);
    const inventoryPaths = itemEntries.map(([itemId]) => `inventory/${uid}_${itemId}`);
    const inventorySnaps = await db.getMany(transaction, inventoryPaths);
    for (let index = 0; index < itemEntries.length; index += 1) {
      const required = itemEntries[index][1];
      if (!inventorySnaps[index] || numberOrZero(inventorySnaps[index]?.quantity) < required) {
        throw new VaultError('MISSING_VAULT_MATERIALS', 409);
      }
    }

    const now = Date.now();
    const netHourly = companyNetHourly(company, profile, events, now);
    const preserved = calculatedVaultBalance(company, netHourly, now);
    const txId = `tx_${randomUUID()}`;
    const logId = `clog_${randomUUID()}`;
    const writes: RestWrite[] = [
      updateWrite(`wallets/${uid}`, {
        balance: numberOrZero(wallet.balance) - upgrade.cost,
        totalSpent: numberOrZero(wallet.totalSpent) + upgrade.cost,
        lastTxId: txId,
      }, ['updatedAt']),
      ...itemEntries.map(([itemId, required], index) =>
        updateWrite(`inventory/${uid}_${itemId}`, {
          quantity: numberOrZero(inventorySnaps[index]?.quantity) - required,
        }, ['updatedAt'])
      ),
      updateWrite(`companies/${companyId}`, {
        vaultLevel: oldLevel + 1,
        vaultBalance: preserved,
      }, ['lastCollectedAt', 'updatedAt']),
      updateWrite(`transactions/${txId}`, {
        id: txId, fromUid: uid, toUid: 'SYSTEM', amount: upgrade.cost, fee: 0,
        netAmount: upgrade.cost, type: 'company_vault_upgrade', referenceId: companyId,
        description: `Upgraded ${company.name} profit vault to Lv.${oldLevel + 1}`, status: 'completed',
      }, ['createdAt'], true),
      updateWrite(`company_logs/${logId}`, {
        id: logId, companyId, ownerUid: uid, action: 'vault_upgrade', amount: -upgrade.cost,
        details: `Profit vault upgraded to Lv.${oldLevel + 1}; preserved ${preserved}`,
      }, ['createdAt'], true),
    ];
    return {
      result: { ok: true, vaultLevel: oldLevel + 1, vaultBalance: preserved, capacity: VAULT_CAPACITIES[oldLevel] },
      writes,
    };
  });
}

async function collectVault(db: FirestoreRest, uid: string, companyId: string) {
  return db.runTransaction(async (transaction) => {
    const [[companyRaw, walletRaw, profileRaw], events] = await Promise.all([
      db.getMany(transaction, [`companies/${companyId}`, `wallets/${uid}`, `profiles/${uid}`]),
      db.getActiveEvents(transaction),
    ]);
    if (!companyRaw) throw new VaultError('COMPANY_NOT_FOUND', 404);
    if (!walletRaw || !profileRaw) throw new VaultError('ACCOUNT_NOT_FOUND', 409);
    const company = companyRaw as VaultCompany;
    const wallet = walletRaw as unknown as VaultWallet;
    const profile = profileRaw as unknown as VaultProfile;
    if (company.ownerUid !== uid) throw new VaultError('UNAUTHORIZED', 403);

    const now = Date.now();
    const lastCollected = timestampMillis(company.lastCollectedAt, now);
    if (now - lastCollected < 30_000) throw new VaultError('NOTHING_TO_COLLECT', 409);
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
    const writes: RestWrite[] = [
      updateWrite(`wallets/${uid}`, {
        balance: numberOrZero(wallet.balance) + payout,
        totalEarned: numberOrZero(wallet.totalEarned) + payout,
        lastTxId: txId,
      }, ['updatedAt']),
      updateWrite(`companies/${companyId}`, {
        totalRevenue: numberOrZero(company.totalRevenue) + payout,
        vaultBalance: 0,
      }, ['lastCollectedAt', 'updatedAt']),
      updateWrite(`profiles/${uid}`, {
        xp: nextXp,
        level: nextLevel,
        skillPoints: numberOrZero(profile.skillPoints) + levelsGained * 2,
        reputation: numberOrZero(profile.reputation) + Math.round(2 * leadershipBonus),
        influence: numberOrZero(profile.influence) + Math.round(1 * leadershipBonus),
      }, ['updatedAt']),
      updateWrite(`transactions/${txId}`, {
        id: txId, fromUid: 'SYSTEM', toUid: uid, amount: payout, fee: 0,
        netAmount: payout, type: 'company_collect', referenceId: companyId,
        description: `Company revenue collected: ${company.name}`, status: 'completed',
      }, ['createdAt'], true),
      updateWrite(`company_logs/${logId}`, {
        id: logId, companyId, ownerUid: uid, action: 'collect', amount: payout,
        details: `Collected +$${payout}`,
      }, ['createdAt'], true),
    ];
    return { result: { ok: true, payout }, writes };
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

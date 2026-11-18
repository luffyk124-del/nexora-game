import type { IncomingMessage, ServerResponse } from 'node:http';
import { IdentityPoolClient } from 'google-auth-library';
import { createRemoteJWKSet, jwtVerify } from 'jose';

const PROJECT_ID = 'gen-lang-client-0074900177';
const PROJECT_NUMBER = '145581837596';
const DATABASE_ID = 'ai-studio-74843d9e-8228-49b7-a616-317cadd90bff';
const SERVICE_ACCOUNT = 'nexora-vercel-runtime@gen-lang-client-0074900177.iam.gserviceaccount.com';
const WIF_AUDIENCE = `//iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/nexora-vercel-pool/providers/nexora-vercel`;
const FIREBASE_ISSUER = `https://securetoken.google.com/${PROJECT_ID}`;
const FIREBASE_KEYS = createRemoteJWKSet(new URL('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com'));

const EXPORT_COLLECTIONS = new Set([
  'profiles', 'usernames', 'users_private', 'wallets', 'transactions', 'inventory',
  'market_listings', 'market_orders', 'companies', 'company_auctions', 'company_logs',
  'properties', 'organizations', 'organization_members', 'organization_requests',
  'organization_transactions', 'player_missions', 'daily_claims', 'contract_claims',
  'player_achievements', 'notifications', 'world_events', 'audit_logs', 'user_blocks',\n  'chat_rate_limits', 'conversations', 'global_chat_messages', 'organization_invites', 'conversation_messages',
]);

type Req = IncomingMessage & { body?: unknown };
type Res = ServerResponse & { status: (code: number) => Res; json: (body: unknown) => void };
type Data = Record<string, unknown>;
type TokenActor = { uid: string; email: string | null; claims: Record<string, unknown> };

class ExportError extends Error {
  constructor(public readonly status: number, public readonly code: string) { super(code); }
}

function decodeValue(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw;
  const value = raw as Data;
  if ('stringValue' in value) return value.stringValue;
  if ('integerValue' in value) return Number(value.integerValue);
  if ('doubleValue' in value) return value.doubleValue;
  if ('booleanValue' in value) return value.booleanValue;
  if ('nullValue' in value) return null;
  if ('timestampValue' in value) return value.timestampValue;
  if ('referenceValue' in value) return value.referenceValue;
  if ('bytesValue' in value) return value.bytesValue;
  if ('geoPointValue' in value) return value.geoPointValue;
  if ('mapValue' in value) {
    const fields = ((value.mapValue as Data).fields ?? {}) as Data;
    return Object.fromEntries(Object.entries(fields).map(([key, item]) => [key, decodeValue(item)]));
  }
  if ('arrayValue' in value) return (((value.arrayValue as Data).values ?? []) as unknown[]).map(decodeValue);
  return value;
}

function decodeDocument(doc: Data) {
  const fields = (doc.fields ?? {}) as Data;
  const name = String(doc.name ?? '');
  const id = name.split('/').pop() ?? '';
  return {
    id,
    path: name,
    fields: Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, decodeValue(value)])),
  };
}

async function verifyActor(req: Req): Promise<TokenActor> {
  const header = req.headers.authorization;
  const match = typeof header === 'string' ? /^Bearer\\s+(.+)$/i.exec(header) : null;
  if (!match) throw new ExportError(401, 'UNAUTHENTICATED');
  const { payload } = await jwtVerify(match[1], FIREBASE_KEYS, {
    issuer: FIREBASE_ISSUER, audience: PROJECT_ID, algorithms: ['RS256'],
  });
  const firebase = payload.firebase && typeof payload.firebase === 'object'
    ? payload.firebase as Record<string, unknown> : {};
  if (typeof payload.sub !== 'string' || !payload.sub || payload.email_verified !== true || firebase.sign_in_provider === 'anonymous') {
    throw new ExportError(403, 'VERIFIED_OWNER_REQUIRED');
  }
  return {
    uid: payload.sub,
    email: typeof payload.email === 'string' ? payload.email : null,
    claims: payload as Record<string, unknown>,
  };
}

function firestoreClient(req: Req) {
  const raw = req.headers['x-vercel-oidc-token'];
  const oidcToken = Array.isArray(raw) ? raw[0] : raw;
  if (typeof oidcToken !== 'string' || oidcToken.length < 40) throw new ExportError(503, 'BACKEND_IDENTITY_NOT_READY');
  const client = new IdentityPoolClient({
    audience: WIF_AUDIENCE,
    subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
    token_url: 'https://sts.googleapis.com/v1/token',
    service_account_impersonation_url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${SERVICE_ACCOUNT}:generateAccessToken`,
    subject_token_supplier: { getSubjectToken: async () => oidcToken },
  });
  client.scopes = ['https://www.googleapis.com/auth/cloud-platform'];
  return client;
}

async function firestoreRequest<T>(client: IdentityPoolClient, url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<T> {
  const response = await client.fetch(url, init);
  return response.data as T;
}

async function authorizeOwner(req: Req, client: IdentityPoolClient, actor: TokenActor): Promise<void> {
  if (actor.claims.diagnosticsOwner === true) return;
  const allowUids = (process.env.DIAGNOSTICS_ALLOWED_UIDS ?? '').split(',').map(v => v.trim()).filter(Boolean);
  const allowEmails = (process.env.DIAGNOSTICS_ALLOWED_EMAILS ?? '').split(',').map(v => v.trim().toLowerCase()).filter(Boolean);
  if (allowUids.includes(actor.uid) || (actor.email && allowEmails.includes(actor.email.toLowerCase()))) return;

  const path = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/${DATABASE_ID}/documents/diagnostics_admins/${encodeURIComponent(actor.uid)}`;
  try {
    const doc = await firestoreRequest<Data>(client, path, { method: 'GET' });
    const fields = (doc.fields ?? {}) as Data;
    const enabled = decodeValue(fields.enabled);
    const role = decodeValue(fields.role);
    if (enabled === true && role === 'owner') return;
  } catch (error) {
    const status = (error as { response?: { status?: number } })?.response?.status;
    if (status !== 404) throw new ExportError(503, 'OWNER_AUTHORIZATION_CHECK_FAILED');
  }
  throw new ExportError(403, 'OWNER_ONLY');
}

export default async function handler(req: Req, res: Res): Promise<void> {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method !== 'POST') { res.status(405).json({ error: 'METHOD_NOT_ALLOWED' }); return; }

  try {
    const actor = await verifyActor(req);
    const client = firestoreClient(req);
    await authorizeOwner(req, client, actor);

    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body as Data : {};
    const collection = typeof body.collection === 'string' ? body.collection : '';
    if (!EXPORT_COLLECTIONS.has(collection)) throw new ExportError(400, 'COLLECTION_NOT_ALLOWED');

    const pageSize = typeof body.pageSize === 'number' && Number.isInteger(body.pageSize)
      ? Math.max(1, Math.min(100, body.pageSize)) : 100;
    const pageToken = typeof body.pageToken === 'string' ? body.pageToken : '';
    if (pageToken.length > 8192) throw new ExportError(400, 'INVALID_PAGE_TOKEN');

    const sourcePath = collection === 'conversation_messages' ? `conversations/${parentId}/messages` : collection;\n    const base = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/${DATABASE_ID}/documents/${sourcePath}`;
    const url = new URL(base);
    url.searchParams.set('pageSize', String(pageSize));
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    const result = await firestoreRequest<{ documents?: Data[]; nextPageToken?: string }>(client, url.toString(), { method: 'GET' });
    const documents = (result.documents ?? []).map(decodeDocument);
    res.status(200).json({
      ok: true,
      collection,
      count: documents.length,
      documents,
      nextPageToken: result.nextPageToken ?? null,
      hasMore: Boolean(result.nextPageToken),
    });
  } catch (error) {
    if (error instanceof ExportError) { res.status(error.status).json({ error: error.code }); return; }
    const status = (error as { response?: { status?: number } })?.response?.status;
    if (status === 403) { res.status(503).json({ error: 'FIRESTORE_EXPORT_PERMISSION_DENIED' }); return; }
    res.status(500).json({ error: 'MIGRATION_EXPORT_FAILED' });
  }
}

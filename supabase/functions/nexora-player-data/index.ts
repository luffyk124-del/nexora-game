import { createClient } from "npm:@supabase/supabase-js@2.95.0";
import { createRemoteJWKSet, jwtVerify } from "npm:jose@5.10.0";

const FIREBASE_PROJECT_ID = "gen-lang-client-0074900177";
const FIREBASE_ISSUER = `https://securetoken.google.com/${FIREBASE_PROJECT_ID}`;
const FIREBASE_KEYS = createRemoteJWKSet(
  new URL("https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com"),
);
const ORIGINS = new Set([
  "https://nexora-game-wkbi2g3f9-manus24.vercel.app",
  "https://nexora-game-git-feature-nexora-social-economy-mo-add6d8-manus24.vercel.app",
  "https://luffyk124-del.github.io",
]);
function isAllowedOrigin(origin: string | null): boolean {
  return !origin ||
    ORIGINS.has(origin) ||
    /^https:\/\/nexora-game-[a-z0-9-]+\.vercel\.app$/.test(origin);
}


const headers = (origin: string | null) => ({
  "Access-Control-Allow-Origin": origin && isAllowedOrigin(origin)
    ? origin
    : "https://nexora-game-wkbi2g3f9-manus24.vercel.app",
  "Access-Control-Allow-Headers": "authorization, apikey, x-client-info, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
  "Vary": "Origin",
});

function json(body: unknown, status: number, origin: string | null) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers(origin), "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function getServiceKey(): string | null {
  const direct = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (direct) return direct;
  const raw = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed.default === "string" ? parsed.default : null;
  } catch {
    return null;
  }
}

async function verifyPlayer(req: Request): Promise<string | null> {
  const auth = req.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return null;
  try {
    const { payload } = await jwtVerify(auth.slice(7), FIREBASE_KEYS, {
      issuer: FIREBASE_ISSUER,
      audience: FIREBASE_PROJECT_ID,
      algorithms: ["RS256"],
    });
    const firebase = payload.firebase && typeof payload.firebase === "object"
      ? payload.firebase as Record<string, unknown>
      : {};
    if (
      typeof payload.sub !== "string" ||
      !payload.sub ||
      payload.email_verified !== true ||
      firebase.sign_in_provider === "anonymous"
    ) return null;
    return payload.sub;
  } catch {
    return null;
  }
}

function camelKey(key: string): string {
  return key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object" && !(value instanceof Date)) {
    const normalized = Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [camelKey(key), normalize(item)]),
    ) as Record<string, unknown>;
    // Preserve the existing React game-domain interfaces during the read-only migration.
    if ("userId" in normalized) {
      normalized.uid = normalized.userId;
      delete normalized.userId;
    }
    if ("isRead" in normalized) {
      normalized.read = normalized.isRead;
      delete normalized.isRead;
    }
    if ("propertyType" in normalized) {
      normalized.type = normalized.propertyType;
      delete normalized.propertyType;
    }
    return normalized;
  }
  return value;
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("Origin");
  if (!isAllowedOrigin(origin)) return json({ error: "FORBIDDEN_ORIGIN" }, 403, origin);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: headers(origin) });
  if (req.method !== "POST") return json({ error: "METHOD_NOT_ALLOWED" }, 405, origin);

  const uid = await verifyPlayer(req);
  if (!uid) return json({ error: "UNAUTHENTICATED_OR_UNVERIFIED" }, 401, origin);

  const url = Deno.env.get("SUPABASE_URL");
  const key = getServiceKey();
  if (!url || !key) return json({ error: "SERVER_CONFIGURATION_ERROR" }, 500, origin);

  const admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const db = admin.schema("nexora");

  const run = async (name: string, query: PromiseLike<{ data: unknown; error: { message: string } | null }>) => {
    const result = await query;
    if (result.error) throw new Error(`${name}: ${result.error.message}`);
    return normalize(result.data);
  };

  try {
    const [profile, privateData, wallet, inventory, sent, received, listings, orders,
      companies, auctions, companyLogs, properties, organizations, membership, myPendingRequests,
      missionClaims, dailyClaims, contractClaims, achievements, notifications, worldEvents] =
      await Promise.all([
        run("profile", db.from("player_profiles").select("*").eq("user_id", uid).maybeSingle()),
        run("private", db.from("player_private").select("*").eq("user_id", uid).maybeSingle()),
        run("wallet", db.from("wallets").select("*").eq("user_id", uid).maybeSingle()),
        run("inventory", db.from("inventory").select("*").eq("user_id", uid).limit(200)),
        run("sent_transactions", db.from("transactions").select("*").eq("from_uid", uid).order("created_at", { ascending: false }).limit(30)),
        run("received_transactions", db.from("transactions").select("*").eq("to_uid", uid).order("created_at", { ascending: false }).limit(30)),
        run("market_listings", db.from("market_listings").select("*").eq("status", "active").order("created_at", { ascending: false }).limit(100)),
        run("market_orders", db.from("market_orders").select("*").eq("buyer_uid", uid).order("created_at", { ascending: false }).limit(25)),
        run("companies", db.from("companies").select("*").eq("owner_uid", uid).limit(50)),
        run("company_auctions", db.from("company_auctions").select("*").eq("status", "active").limit(100)),
        run("company_logs", db.from("company_logs").select("*").eq("owner_uid", uid).order("created_at", { ascending: false }).limit(25)),
        run("properties", db.from("properties").select("*").eq("owner_uid", uid).limit(100)),
        run("organizations", db.from("organizations").select("*").order("reputation", { ascending: false }).limit(40)),
        run("membership", db.from("organization_members").select("*").eq("user_id", uid).limit(1).maybeSingle()),
        run("my_pending_requests", db.from("organization_requests").select("org_id").eq("user_id", uid).eq("status", "pending").limit(100)),
        run("missions", db.from("player_missions").select("*").eq("user_id", uid).limit(200)),
        run("daily_claims", db.from("daily_claims").select("*").eq("user_id", uid).eq("date_key", new Date().toISOString().slice(0, 10)).limit(2)),
        run("contract_claims", db.from("contract_claims").select("*").eq("user_id", uid).limit(200)),
        run("achievements", db.from("player_achievements").select("*").eq("user_id", uid).limit(200)),
        run("notifications", db.from("notifications").select("*").eq("user_id", uid).order("created_at", { ascending: false }).limit(30)),
        run("world_events", db.from("world_events").select("*").eq("active", true).limit(100)),
      ]);

    const member = membership as Record<string, unknown> | null;
    const orgId = typeof member?.orgId === "string" ? member.orgId : null;

    const [orgMembers, orgRequests, orgTransactions] = orgId
      ? await Promise.all([
          run("organization_members", db.from("organization_members").select("*").eq("org_id", orgId).limit(200)),
          run("organization_requests", db.from("organization_requests").select("*").eq("org_id", orgId).eq("status", "pending").limit(100)),
          run("organization_transactions", db.from("organization_transactions").select("*").eq("org_id", orgId).order("created_at", { ascending: false }).limit(40)),
        ])
      : [[], [], []];

    const txMap = new Map<string, Record<string, unknown>>();
    for (const tx of [...(sent as Record<string, unknown>[]), ...(received as Record<string, unknown>[])]) {
      if (typeof tx.id === "string") txMap.set(tx.id, tx);
    }
    const transactions = [...txMap.values()].sort((a, b) =>
      String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")),
    ).slice(0, 40);

    return json({
      ok: true,
      player: {
        profile,
        privateData,
        wallet,
        inventory,
        transactions,
        marketListings: listings,
        marketOrders: orders,
        companies,
        companyAuctions: auctions,
        companyLogs,
        properties,
        organizations,
        myOrgMember: membership,
        orgMembers,
        orgRequests,
        myPendingOrgIds: (myPendingRequests as Record<string, unknown>[]).map((item) => item.orgId),
        orgTransactions,
        claimedMissions: missionClaims,
        claimedDailyToday: (dailyClaims as Record<string, unknown>[]).some((item) =>
          item.dateKey === new Date().toISOString().slice(0, 10)
        ),
        claimedContractsToday: (contractClaims as Record<string, unknown>[]).map((item) => item.contractId),
        unlockedAchievements: (achievements as Record<string, unknown>[]).map((item) => item.achievementId),
        notifications,
        worldEvents,
      },
    }, 200, origin);
  } catch (error) {
    console.error("NEXORA player data query failed:", error);
    return json({ error: "PLAYER_DATA_READ_FAILED" }, 500, origin);
  }
});

import { createClient } from "npm:@supabase/supabase-js@2.95.0";
import { createRemoteJWKSet, jwtVerify } from "npm:jose@5.10.0";

const FIREBASE_PROJECT_ID = "gen-lang-client-0074900177";
const FIREBASE_ISSUER = `https://securetoken.google.com/${FIREBASE_PROJECT_ID}`;
const FIREBASE_KEYS = createRemoteJWKSet(
  new URL("https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com"),
);

const ALLOWED_ORIGINS = new Set([
  "https://nexora-game-wkbi2g3f9-manus24.vercel.app",
  "https://nexora-game-git-feature-nexora-social-economy-mo-add6d8-manus24.vercel.app",
  "https://luffyk124-del.github.io",
]);

function corsHeaders(origin: string | null): Record<string, string> {
  const allowed = origin && ALLOWED_ORIGINS.has(origin)
    ? origin
    : "https://nexora-game-wkbi2g3f9-manus24.vercel.app";
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Headers": "authorization, apikey, x-client-info, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

function response(body: unknown, status: number, origin: string | null): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(origin),
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
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

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("Origin");
  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    return response({ error: "FORBIDDEN_ORIGIN" }, 403, origin);
  }
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }
  if (req.method !== "POST") {
    return response({ error: "METHOD_NOT_ALLOWED" }, 405, origin);
  }

  const authorization = req.headers.get("Authorization") ?? "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!token) return response({ error: "UNAUTHENTICATED" }, 401, origin);

  let firebaseUid = "";
  try {
    const { payload } = await jwtVerify(token, FIREBASE_KEYS, {
      issuer: FIREBASE_ISSUER,
      audience: FIREBASE_PROJECT_ID,
      algorithms: ["RS256"],
    });
    const firebaseClaims = payload.firebase && typeof payload.firebase === "object"
      ? payload.firebase as Record<string, unknown>
      : {};
    if (
      typeof payload.sub !== "string" ||
      payload.sub.length < 1 ||
      payload.email_verified !== true ||
      firebaseClaims.sign_in_provider === "anonymous"
    ) {
      return response({ error: "VERIFIED_PLAYER_REQUIRED" }, 403, origin);
    }
    firebaseUid = payload.sub;
  } catch {
    return response({ error: "INVALID_FIREBASE_TOKEN" }, 401, origin);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = getServiceKey();
  if (!supabaseUrl || !serviceKey) {
    return response({ error: "SERVER_CONFIGURATION_ERROR" }, 500, origin);
  }

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const db = admin.schema("nexora");

  const [profileResult, walletResult] = await Promise.all([
    db.from("player_profiles")
      .select("user_id,username,level,xp")
      .eq("user_id", firebaseUid)
      .maybeSingle(),
    db.from("wallets")
      .select("user_id")
      .eq("user_id", firebaseUid)
      .maybeSingle(),
  ]);

  if (profileResult.error || walletResult.error) {
    return response({ error: "PLAYER_LOOKUP_FAILED" }, 500, origin);
  }

  if (!profileResult.data) {
    return response({
      authenticated: true,
      migrated: false,
      reason: "PLAYER_PROFILE_NOT_FOUND",
    }, 404, origin);
  }

  if (!walletResult.data) {
    return response({
      authenticated: true,
      migrated: false,
      reason: "PLAYER_WALLET_NOT_FOUND",
    }, 409, origin);
  }

  return response({
    authenticated: true,
    migrated: true,
    player: {
      userId: profileResult.data.user_id,
      username: profileResult.data.username,
      level: profileResult.data.level,
      xp: profileResult.data.xp,
    },
  }, 200, origin);
});

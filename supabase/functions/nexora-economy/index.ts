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
function isAllowedOrigin(origin: string | null): boolean {
  return !origin || ALLOWED_ORIGINS.has(origin) ||
    /^https:\/\/nexora-game-[a-z0-9-]+\.vercel\.app$/.test(origin);
}
function getServiceKey(): string | null {
  const direct = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (direct) return direct;
  const raw = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed.default === "string" ? parsed.default : null;
  } catch { return null; }
}
function json(body: unknown, status: number, origin: string | null): Response {
  const allowedOrigin = origin && isAllowedOrigin(origin)
    ? origin
    : "https://nexora-game-wkbi2g3f9-manus24.vercel.app";
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Access-Control-Allow-Origin": allowedOrigin,
      "Access-Control-Allow-Headers": "authorization, apikey, x-client-info, content-type",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Max-Age": "86400",
      "Vary": "Origin",
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
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
    if (typeof payload.sub !== "string" || !payload.sub ||
        payload.email_verified !== true || firebase.sign_in_provider === "anonymous") return null;
    return payload.sub;
  } catch { return null; }
}
Deno.serve(async (req: Request) => {
  const origin = req.headers.get("Origin");
  if (!isAllowedOrigin(origin)) return json({ error: "FORBIDDEN_ORIGIN" }, 403, origin);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: {
    "Access-Control-Allow-Origin": origin ?? "null",
    "Access-Control-Allow-Headers": "authorization, apikey, x-client-info, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  }});
  if (req.method !== "POST") return json({ error: "METHOD_NOT_ALLOWED" }, 405, origin);

  const uid = await verifyPlayer(req);
  if (!uid) return json({ error: "UNAUTHENTICATED_OR_UNVERIFIED" }, 401, origin);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
  } catch { return json({ error: "INVALID_JSON" }, 400, origin); }

  const action = typeof body.action === "string" ? body.action : "transfer";
  const url = Deno.env.get("SUPABASE_URL");
  const key = getServiceKey();
  if (!url || !key) return json({ error: "SERVER_CONFIGURATION_ERROR" }, 500, origin);
  const admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

  if (action === "claim_daily_stipend") {
    const { data, error } = await admin.schema("nexora").rpc("claim_daily_stipend", {
      p_user_id: uid,
    });
    if (error) {
      const message = error.message.split(/[\\n:]/)[0].trim();
      if (["ALREADY_CLAIMED_TODAY", "ACCOUNT_NOT_FOUND"].includes(message)) {
        return json({ error: message }, 400, origin);
      }
      console.error("NEXORA daily stipend RPC failed:", error.message);
      return json({ error: "DAILY_STIPEND_FAILED" }, 500, origin);
    }
    return json(data, 200, origin);
  }
  if (action !== "transfer") return json({ error: "UNKNOWN_ACTION" }, 400, origin);

  const recipientUsername = typeof body.recipientUsername === "string" ? body.recipientUsername.trim() : "";
  const amount = body.amount;
  const note = typeof body.note === "string" ? body.note.slice(0, 180) : "";
  const requestId = typeof body.requestId === "string" ? body.requestId : "";
  if (!/^[A-Za-z0-9_]{3,24}$/.test(recipientUsername)) return json({ error: "RECIPIENT_NOT_FOUND" }, 400, origin);
  if (!Number.isSafeInteger(amount) || (amount as number) < 1 || (amount as number) > 10000000) {
    return json({ error: "INVALID_AMOUNT" }, 400, origin);
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) {
    return json({ error: "INVALID_REQUEST_ID" }, 400, origin);
  }

  const { data, error } = await admin.schema("nexora").rpc("transfer_credits", {
    p_sender_uid: uid,
    p_recipient_username: recipientUsername,
    p_amount: amount,
    p_note: note,
    p_request_id: requestId,
  });
  if (error) {
    const allowed = new Set([
      "RECIPIENT_NOT_FOUND", "SELF_OR_MISSING_RECIPIENT", "INVALID_AMOUNT",
      "INSUFFICIENT_FUNDS", "INVALID_REQUEST_ID", "REQUEST_ID_CONFLICT",
    ]);
    const message = error.message.split(/[\n:]/)[0].trim();
    if (allowed.has(message)) return json({ error: message }, 400, origin);
    console.error("NEXORA transfer RPC failed:", error.message);
    return json({ error: "TRANSFER_FAILED" }, 500, origin);
  }
  return json(data, 200, origin);
});

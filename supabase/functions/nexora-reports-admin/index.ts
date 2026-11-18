import { createClient } from "npm:@supabase/supabase-js@2.95.0";

const allowedOrigin = "https://luffyk124-del.github.io";
const cors = {
  "Access-Control-Allow-Origin": allowedOrigin,
  "Vary": "Origin",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("Origin");
  if (origin && origin !== allowedOrigin) return new Response("Forbidden origin", { status: 403 });
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return reply({ error: "METHOD_NOT_ALLOWED" }, 405);

  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (!url || !serviceKey) return reply({ error: "SERVER_CONFIGURATION_ERROR" }, 500);

  let secret: string;
  try { secret = JSON.parse(serviceKey).default; } catch { return reply({ error: "SERVER_CONFIGURATION_ERROR" }, 500); }
  if (!secret) return reply({ error: "SERVER_CONFIGURATION_ERROR" }, 500);

  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!token) return reply({ error: "UNAUTHENTICATED" }, 401);

  const admin = createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: userData, error: userError } = await admin.auth.getUser(token);
  if (userError || !userData.user) return reply({ error: "UNAUTHENTICATED" }, 401);

  const { data: adminRecord, error: adminError } = await admin
    .schema("nexora").from("diagnostics_admins")
    .select("user_id,role,enabled")
    .eq("user_id", userData.user.id)
    .eq("role", "owner")
    .eq("enabled", true)
    .maybeSingle();
  if (adminError || !adminRecord) return reply({ error: "REPORTS_ADMIN_REQUIRED" }, 403);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return reply({ error: "INVALID_JSON" }, 400); }
  const db = admin.schema("nexora");
  const action = body.action;

  if (action === "list") {
    const status = typeof body.status === "string" ? body.status : "all";
    if (!["all", "open", "reviewing", "closed"].includes(status)) return reply({ error: "INVALID_STATUS" }, 400);
    const limit = Math.min(100, Math.max(1, Number(body.limit) || 50));
    let q = db.from("player_reports").select("id,reporter_uid,target_uid,reason,status,created_at,reviewed_at,reviewed_by").order("created_at", { ascending: false }).limit(limit);
    if (status !== "all") q = q.eq("status", status);
    const { data, error } = await q;
    if (error) return reply({ error: "REPORTS_QUERY_FAILED" }, 500);
    return reply({ reports: (data || []).map((r) => ({ id:r.id, reporterUid:r.reporter_uid, targetUid:r.target_uid, reason:r.reason, status:r.status, createdAt:r.created_at ? new Date(r.created_at).getTime() : null, reviewedAt:r.reviewed_at ? new Date(r.reviewed_at).getTime() : null, reviewedBy:r.reviewed_by })) });
  }

  if (action === "update") {
    const reportId = typeof body.reportId === "string" ? body.reportId.trim() : "";
    const status = body.status;
    if (!reportId || reportId.length > 180 || !["open", "reviewing", "closed"].includes(status as string)) return reply({ error: "INVALID_REPORT_UPDATE" }, 400);
    const { data, error } = await db.rpc("set_player_report_status", {
      p_report_id: reportId,
      p_status: status,
      p_actor_uid: userData.user.id,
    });
    if (error) return reply({ error: "REPORT_UPDATE_FAILED" }, 500);
    if (data !== true) return reply({ error: "REPORT_NOT_FOUND" }, 404);
    return reply({ ok: true });
  }

  if (action === "audit") {
    const limit = Math.min(100, Math.max(1, Number(body.limit) || 50));
    const { data, error } = await db.from("player_report_audit").select("id,report_id,actor_uid,action,new_status,created_at").order("created_at", { ascending: false }).limit(limit);
    if (error) return reply({ error: "AUDIT_QUERY_FAILED" }, 500);
    return reply({ entries: (data || []).map((e) => ({ id:e.id, reportId:e.report_id, actorUid:e.actor_uid, action:e.action, newStatus:e.new_status, createdAt:e.created_at ? new Date(e.created_at).getTime() : null })) });
  }
  return reply({ error: "UNKNOWN_ACTION" }, 400);
});

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
async function verifyPlayer(req: Request): Promise<{ uid: string; email: string } | null> {
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
        typeof payload.email !== "string" || payload.email_verified !== true ||
        firebase.sign_in_provider === "anonymous") return null;
    return { uid: payload.sub, email: payload.email };
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

  const player = await verifyPlayer(req);
  if (!player) return json({ error: "UNAUTHENTICATED_OR_UNVERIFIED" }, 401, origin);
  const uid = player.uid;

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

  if (action === "sync_org_membership") {
    const orgId = body.orgId === null ? null : typeof body.orgId === "string" ? body.orgId : undefined;
    if (orgId === undefined || (typeof orgId === "string" && orgId.length>160)) return json({ error: "INVALID_ARGUMENT" }, 400, origin);
    const { data, error } = await admin.schema("nexora").rpc("sync_self_org_membership", {
      p_user_id: uid, p_org_id: orgId,
    });
    if (error) {
      const message = error.message.split(/[\\n:]/)[0].trim();
      if (["UNAUTHORIZED","ACCOUNT_NOT_FOUND","UNAUTHENTICATED"].includes(message)) return json({ error: message }, 400, origin);
      console.error("NEXORA membership sync RPC failed:", error.message);
      return json({ error: "ORG_MEMBERSHIP_SYNC_FAILED" }, 500, origin);
    }
    return json(data, 200, origin);
  }

  if (action === "update_org_member_role") {
    const orgId = typeof body.orgId === "string" ? body.orgId : "";
    const targetUid = typeof body.targetUid === "string" ? body.targetUid : "";
    const newRole = typeof body.newRole === "string" ? body.newRole : "";
    if (!orgId || !targetUid || orgId.length>160 || targetUid.length>128) return json({ error: "INVALID_ARGUMENT" }, 400, origin);
    const { data, error } = await admin.schema("nexora").rpc("update_org_member_role", {
      p_actor_uid: uid, p_org_id: orgId, p_target_uid: targetUid, p_new_role: newRole,
    });
    if (error) {
      const message = error.message.split(/[\\n:]/)[0].trim();
      if (["INVALID_ARGUMENT","INVALID_ROLE","UNAUTHORIZED","MEMBER_NOT_FOUND"].includes(message)) return json({ error: message }, 400, origin);
      console.error("NEXORA organization role RPC failed:", error.message);
      return json({ error: "ORG_ROLE_UPDATE_FAILED" }, 500, origin);
    }
    return json(data, 200, origin);
  }

  if (action === "start_org_upgrade" || action === "complete_org_upgrade" || action === "research_org") {
    const orgId = typeof body.orgId === "string" ? body.orgId : "";
    if (!orgId || orgId.length > 160) return json({ error: "NOT_FOUND" }, 400, origin);
    const rpcName = action === "start_org_upgrade" ? "start_organization_upgrade"
      : action === "complete_org_upgrade" ? "complete_organization_upgrade" : "research_organization";
    const args: Record<string, unknown> = { p_user_id: uid, p_org_id: orgId };
    if (action === "research_org") {
      const researchId = typeof body.researchId === "string" ? body.researchId : "";
      args.p_research_id = researchId;
    }
    const { data, error } = await admin.schema("nexora").rpc(rpcName, args);
    if (error) {
      const message = error.message.split(/[\\n:]/)[0].trim();
      if (["NOT_FOUND","UNAUTHORIZED","UPGRADE_IN_PROGRESS","MAX_LEVEL","INSUFFICIENT_TREASURY",
        "UPGRADE_NOT_READY","INVALID_RESEARCH","RESEARCH_MAX_LEVEL"].includes(message)) return json({ error: message }, 400, origin);
      console.error("NEXORA organization upgrade RPC failed:", error.message);
      return json({ error: "ORGANIZATION_UPGRADE_FAILED" }, 500, origin);
    }
    return json(data, 200, origin);
  }

  if (action === "company_upgrade" || action === "company_complete" || action === "company_collect" ||
      action === "company_vault_upgrade" || action === "company_vault_complete") {
    const companyId = typeof body.companyId === "string" ? body.companyId : "";
    if (!companyId || companyId.length > 160) return json({ error: "COMPANY_NOT_FOUND" }, 400, origin);
    let rpcName: string;
    let args: Record<string, unknown>;
    if (action === "company_upgrade" || action === "company_collect" || action === "company_vault_upgrade") {
      const requestId = typeof body.requestId === "string" ? body.requestId : "";
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) return json({ error: "INVALID_REQUEST" }, 400, origin);
      rpcName = action === "company_upgrade" ? "start_company_upgrade"
        : action === "company_collect" ? "collect_company_revenue" : "upgrade_company_vault";
      args = { p_user_id: uid, p_company_id: companyId, p_request_id: requestId };
    } else {
      rpcName = action === "company_complete" ? "complete_company_upgrade" : "complete_company_vault_upgrade";
      args = { p_user_id: uid, p_company_id: companyId };
    }
    const { data, error } = await admin.schema("nexora").rpc(rpcName, args);
    if (error) {
      const message = error.message.split(/[\\n:]/)[0].trim();
      const allowed = ["INVALID_REQUEST","COMPANY_NOT_FOUND","UNAUTHORIZED","COMPANY_IN_AUCTION","MAX_LEVEL",
        "UPGRADE_IN_PROGRESS","INSUFFICIENT_FUNDS","ACCOUNT_NOT_FOUND","NO_UPGRADE_IN_PROGRESS",
        "UPGRADE_NOT_FINISHED","INVALID_UPGRADE_STATE","NOTHING_TO_COLLECT"];
      if (allowed.includes(message)) return json({ error: message }, 400, origin);
      console.error("NEXORA company lifecycle RPC failed:", error.message);
      return json({ error: "COMPANY_OPERATION_FAILED" }, 500, origin);
    }
    return json(data, 200, origin);
  }

  if (action === "deposit_org_treasury" || action === "withdraw_org_treasury") {
    const orgId = typeof body.orgId === "string" ? body.orgId : "";
    const amount = body.amount;
    const requestId = typeof body.requestId === "string" ? body.requestId : "";
    if (!orgId || orgId.length > 160) return json({ error: "NOT_FOUND" }, 400, origin);
    if (!Number.isSafeInteger(amount) || (amount as number)<1 || (amount as number)>10000000) return json({ error: "INVALID_AMOUNT" }, 400, origin);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) return json({ error: "INVALID_REQUEST" }, 400, origin);
    const rpcName = action === "deposit_org_treasury" ? "deposit_org_treasury" : "withdraw_org_treasury";
    const { data, error } = await admin.schema("nexora").rpc(rpcName, {
      p_user_id: uid, p_org_id: orgId, p_amount: amount, p_request_id: requestId,
    });
    if (error) {
      const message = error.message.split(/[\\n:]/)[0].trim();
      if (["INVALID_REQUEST","INVALID_AMOUNT","NOT_FOUND","UNAUTHORIZED","INSUFFICIENT_FUNDS","INSUFFICIENT_TREASURY"].includes(message)) return json({ error: message }, 400, origin);
      console.error("NEXORA organization treasury RPC failed:", error.message);
      return json({ error: "ORG_TREASURY_OPERATION_FAILED" }, 500, origin);
    }
    return json(data, 200, origin);
  }

  if (action === "check_username") {
    const username = typeof body.username === "string" ? body.username.trim() : "";
    if (!/^[A-Za-z0-9_]{3,24}$/.test(username)) return json({ error: "INVALID_USERNAME" }, 400, origin);
    const { data, error } = await admin.schema("nexora").from("usernames")
      .select("username_lower").eq("username_lower", username.toLowerCase()).maybeSingle();
    if (error) {
      console.error("NEXORA username availability query failed:", error.message);
      return json({ error: "USERNAME_CHECK_FAILED" }, 500, origin);
    }
    return json({ ok: true, available: !data }, 200, origin);
  }

  if (action === "found_company") {
    const name = typeof body.name === "string" ? body.name : "";
    const sector = typeof body.sector === "string" ? body.sector : "";
    const requestId = typeof body.requestId === "string" ? body.requestId : "";
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) return json({ error: "INVALID_REQUEST_ID" }, 400, origin);
    const { data, error } = await admin.schema("nexora").rpc("found_company", {
      p_user_id: uid, p_name: name, p_sector: sector, p_request_id: requestId,
    });
    if (error) {
      const message = error.message.split(/[\\n:]/)[0].trim();
      if (["INVALID_REQUEST","INVALID_NAME","INVALID_SECTOR","ACCOUNT_NOT_FOUND","COMPANY_OWNERSHIP_LIMIT","INSUFFICIENT_FUNDS"].includes(message)) return json({ error: message }, 400, origin);
      console.error("NEXORA company founding RPC failed:", error.message);
      return json({ error: "COMPANY_FOUNDING_FAILED" }, 500, origin);
    }
    return json(data, 200, origin);
  }

  if (action === "create_player_character") {
    const username = typeof body.username === "string" ? body.username : "";
    const avatarId = typeof body.avatarId === "string" ? body.avatarId : "";
    const language = body.language;
    if (!/^[A-Za-z0-9_]{3,24}$/.test(username.trim())) return json({ error: "INVALID_USERNAME" }, 400, origin);
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(avatarId)) return json({ error: "INVALID_AVATAR" }, 400, origin);
    if (language !== "ar" && language !== "en") return json({ error: "INVALID_LANGUAGE" }, 400, origin);
    const { data, error } = await admin.schema("nexora").rpc("create_player_character", {
      p_user_id: uid, p_email: player.email, p_username: username.trim(),
      p_avatar_id: avatarId, p_language: language,
    });
    if (error) {
      const message = error.message.split(/[\\n:]/)[0].trim();
      if (["INVALID_USERNAME","INVALID_AVATAR","INVALID_LANGUAGE","INVALID_EMAIL","USERNAME_TAKEN","PROFILE_EXISTS"].includes(message)) {
        return json({ error: message }, 400, origin);
      }
      console.error("NEXORA player creation RPC failed:", error.message);
      return json({ error: "PLAYER_CREATION_FAILED" }, 500, origin);
    }
    return json(data, 200, origin);
  }

  if (action === "update_player_settings" || action === "update_player_avatar" ||
      action === "mark_notification_read" || action === "mark_notifications_read") {
    let rpcName: string;
    let rpcArgs: Record<string, unknown>;
    if (action === "update_player_settings") {
      const language = body.language;
      const notificationsEnabled = body.notificationsEnabled;
      if (language !== "ar" && language !== "en") return json({ error: "INVALID_LANGUAGE" }, 400, origin);
      if (typeof notificationsEnabled !== "boolean") return json({ error: "INVALID_ARGUMENT" }, 400, origin);
      rpcName = "update_player_settings";
      rpcArgs = { p_user_id: uid, p_language: language, p_notifications_enabled: notificationsEnabled };
    } else if (action === "update_player_avatar") {
      const avatarId = typeof body.avatarId === "string" ? body.avatarId : "";
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(avatarId)) return json({ error: "INVALID_AVATAR" }, 400, origin);
      rpcName = "update_player_avatar";
      rpcArgs = { p_user_id: uid, p_avatar_id: avatarId };
    } else if (action === "mark_notification_read") {
      const notificationId = typeof body.notificationId === "string" ? body.notificationId : "";
      if (!notificationId || notificationId.length > 160) return json({ error: "NOTIFICATION_NOT_FOUND" }, 400, origin);
      rpcName = "mark_notification_read";
      rpcArgs = { p_user_id: uid, p_notification_id: notificationId };
    } else {
      const notificationIds = Array.isArray(body.notificationIds)
        ? body.notificationIds.filter((value): value is string => typeof value === "string").slice(0, 200)
        : [];
      rpcName = "mark_notifications_read";
      rpcArgs = { p_user_id: uid, p_notification_ids: notificationIds };
    }
    const { data, error } = await admin.schema("nexora").rpc(rpcName, rpcArgs);
    if (error) {
      const message = error.message.split(/[\\n:]/)[0].trim();
      if (["INVALID_LANGUAGE","INVALID_ARGUMENT","INVALID_AVATAR","ACCOUNT_NOT_FOUND","NOTIFICATION_NOT_FOUND"].includes(message)) return json({ error: message }, 400, origin);
      console.error("NEXORA player settings/notification RPC failed:", error.message);
      return json({ error: "PLAYER_UPDATE_FAILED" }, 500, origin);
    }
    return json(data, 200, origin);
  }

  if (action === "manufacture_recipe") {
    const recipeId = typeof body.recipeId === "string" ? body.recipeId : "";
    const batchQuantity = body.batchQuantity;
    const requestId = typeof body.requestId === "string" ? body.requestId : "";
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) return json({ error: "INVALID_REQUEST_ID" }, 400, origin);
    if (!Number.isSafeInteger(batchQuantity) || (batchQuantity as number)<1 || (batchQuantity as number)>999) return json({ error: "INVALID_QUANTITY" }, 400, origin);
    const { data, error } = await admin.schema("nexora").rpc("manufacture_recipe", {
      p_user_id: uid, p_recipe_id: recipeId, p_batch_quantity: batchQuantity, p_request_id: requestId,
    });
    if (error) {
      const message = error.message.split(/[\\n:]/)[0].trim();
      if (["INVALID_RECIPE","INVALID_QUANTITY","INDUSTRY_SKILL_TOO_LOW","INSUFFICIENT_FUNDS","MISSING_INPUTS","ACCOUNT_NOT_FOUND","INVALID_TOTAL"].includes(message)) return json({ error: message }, 400, origin);
      console.error("NEXORA manufacturing RPC failed:", error.message);
      return json({ error: "MANUFACTURING_FAILED" }, 500, origin);
    }
    return json(data, 200, origin);
  }

  if (action === "buy_property") {
    const name = typeof body.name === "string" ? body.name : "";
    const propertyType = typeof body.propertyType === "string" ? body.propertyType : "";
    const requestId = typeof body.requestId === "string" ? body.requestId : "";
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) {
      return json({ error: "INVALID_REQUEST_ID" }, 400, origin);
    }
    const { data, error } = await admin.schema("nexora").rpc("buy_property", {
      p_user_id: uid, p_name: name, p_type: propertyType, p_request_id: requestId,
    });
    if (error) {
      const message = error.message.split(/[\\n:]/)[0].trim();
      if (["INVALID_REQUEST_ID","INVALID_NAME","INVALID_PROPERTY_TYPE","ACCOUNT_NOT_FOUND","INSUFFICIENT_FUNDS"].includes(message)) return json({ error: message }, 400, origin);
      console.error("NEXORA property purchase RPC failed:", error.message);
      return json({ error: "PROPERTY_PURCHASE_FAILED" }, 500, origin);
    }
    return json(data, 200, origin);
  }

  if (action === "upgrade_property" || action === "collect_property_rent" || action === "toggle_property_lease") {
    const propertyId = typeof body.propertyId === "string" ? body.propertyId : "";
    if (!propertyId || propertyId.length > 160) return json({ error: "PROPERTY_NOT_FOUND" }, 400, origin);
    let rpcName: string;
    let rpcArgs: Record<string, unknown>;
    if (action === "upgrade_property" || action === "collect_property_rent") {
      const requestId = typeof body.requestId === "string" ? body.requestId : "";
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) return json({ error: "INVALID_REQUEST_ID" }, 400, origin);
      rpcName = action;
      rpcArgs = action === "upgrade_property"
        ? { p_user_id: uid, p_property_id: propertyId, p_request_id: requestId }
        : { p_user_id: uid, p_property_id: propertyId, p_request_id: requestId };
    } else {
      if (typeof body.isRented !== "boolean") return json({ error: "INVALID_ARGUMENT" }, 400, origin);
      rpcName = "toggle_property_lease";
      rpcArgs = { p_user_id: uid, p_property_id: propertyId, p_is_rented: body.isRented };
    }
    const { data, error } = await admin.schema("nexora").rpc(rpcName, rpcArgs);
    if (error) {
      const message = error.message.split(/[\\n:]/)[0].trim();
      const allowed = ["PROPERTY_NOT_FOUND","UNAUTHORIZED","MAX_LEVEL","INSUFFICIENT_FUNDS","NOTHING_TO_COLLECT","PROPERTY_VACANT","ACCOUNT_NOT_FOUND"];
      if (allowed.includes(message)) return json({ error: message }, 400, origin);
      console.error("NEXORA property RPC failed:", error.message);
      return json({ error: "PROPERTY_OPERATION_FAILED" }, 500, origin);
    }
    return json(data, 200, origin);
  }

  if (action === "fulfill_trade_contract") {
    const contractId = typeof body.contractId === "string" ? body.contractId : "";
    if (!contractId || contractId.length > 80) return json({ error: "INVALID_CONTRACT" }, 400, origin);
    const { data, error } = await admin.schema("nexora").rpc("fulfill_trade_contract", {
      p_user_id: uid, p_contract_id: contractId,
    });
    if (error) {
      const message = error.message.split(/[\\n:]/)[0].trim();
      if (["INVALID_CONTRACT","CONTRACT_ALREADY_FULFILLED","MISSING_INPUTS","ACCOUNT_NOT_FOUND"].includes(message)) {
        return json({ error: message }, 400, origin);
      }
      console.error("NEXORA trade contract RPC failed:", error.message);
      return json({ error: "CONTRACT_FULFILL_FAILED" }, 500, origin);
    }
    return json(data, 200, origin);
  }

  if (action === "claim_mission_reward") {
    const missionId = typeof body.missionId === "string" ? body.missionId : "";
    if (!missionId || missionId.length > 80) return json({ error: "INVALID_MISSION" }, 400, origin);
    const { data, error } = await admin.schema("nexora").rpc("claim_mission_reward", {
      p_user_id: uid, p_mission_id: missionId,
    });
    if (error) {
      const message = error.message.split(/[\\n:]/)[0].trim();
      if (["INVALID_MISSION","MISSION_ALREADY_CLAIMED","MISSION_NOT_COMPLETE","ACCOUNT_NOT_FOUND"].includes(message)) {
        return json({ error: message }, 400, origin);
      }
      console.error("NEXORA mission reward RPC failed:", error.message);
      return json({ error: "MISSION_REWARD_FAILED" }, 500, origin);
    }
    return json(data, 200, origin);
  }

  if (action === "cancel_market_listing") {
    const listingId = typeof body.listingId === "string" ? body.listingId : "";
    if (!listingId || listingId.length > 160) return json({ error: "LISTING_NOT_FOUND" }, 400, origin);
    const { data, error } = await admin.schema("nexora").rpc("cancel_market_listing", {
      p_user_id: uid, p_listing_id: listingId,
    });
    if (error) {
      const message = error.message.split(/[\\n:]/)[0].trim();
      if (["LISTING_NOT_FOUND","CANNOT_CANCEL_LISTING"].includes(message)) return json({ error: message }, 400, origin);
      console.error("NEXORA listing cancellation RPC failed:", error.message);
      return json({ error: "MARKET_CANCELLATION_FAILED" }, 500, origin);
    }
    return json(data, 200, origin);
  }

  if (action === "create_market_listing") {
    const itemId = typeof body.itemId === "string" ? body.itemId : "";
    const quantity = body.quantity;
    const unitPrice = body.unitPrice;
    const requestId = typeof body.requestId === "string" ? body.requestId : "";
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) {
      return json({ error: "INVALID_REQUEST_ID" }, 400, origin);
    }
    if (!Number.isSafeInteger(quantity) || !Number.isSafeInteger(unitPrice)) {
      return json({ error: "INVALID_LISTING_PARAMS" }, 400, origin);
    }
    const { data, error } = await admin.schema("nexora").rpc("create_market_listing", {
      p_user_id: uid, p_item_id: itemId, p_quantity: quantity,
      p_unit_price: unitPrice, p_request_id: requestId,
    });
    if (error) {
      const message = error.message.split(/[\\n:]/)[0].trim();
      if (["INVALID_ITEM","INVALID_LISTING_PARAMS","INSUFFICIENT_INVENTORY","ACCOUNT_NOT_FOUND","INVALID_REQUEST_ID"].includes(message)) {
        return json({ error: message }, 400, origin);
      }
      console.error("NEXORA listing RPC failed:", error.message);
      return json({ error: "MARKET_LISTING_FAILED" }, 500, origin);
    }
    return json(data, 200, origin);
  }

  if (action === "buy_market_listing") {
    const listingId = typeof body.listingId === "string" ? body.listingId : "";
    const quantity = body.quantity;
    const requestId = typeof body.requestId === "string" ? body.requestId : "";
    if (!listingId || listingId.length > 160) return json({ error: "LISTING_NOT_FOUND" }, 400, origin);
    if (!Number.isSafeInteger(quantity) || (quantity as number) < 1 || (quantity as number) > 10000) {
      return json({ error: "INVALID_QUANTITY" }, 400, origin);
    }
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) {
      return json({ error: "INVALID_REQUEST_ID" }, 400, origin);
    }
    const { data, error } = await admin.schema("nexora").rpc("buy_market_listing", {
      p_buyer_uid: uid, p_listing_id: listingId, p_quantity: quantity,
      p_request_id: requestId,
    });
    if (error) {
      const message = error.message.split(/[\\n:]/)[0].trim();
      const allowed = ["INVALID_REQUEST_ID","INVALID_QUANTITY","INVALID_TOTAL","LISTING_NOT_FOUND",
        "INSUFFICIENT_LISTING_QTY","CANNOT_BUY_OWN_LISTING","ACCOUNT_NOT_FOUND","INSUFFICIENT_FUNDS"];
      if (allowed.includes(message)) return json({ error: message }, 400, origin);
      console.error("NEXORA market purchase RPC failed:", error.message);
      return json({ error: "MARKET_PURCHASE_FAILED" }, 500, origin);
    }
    return json(data, 200, origin);
  }

  if (action === "upgrade_skill") {
    const skillKey = typeof body.skillKey === "string" ? body.skillKey : "";
    if (!["trade","management","industry","negotiation","finance","leadership"].includes(skillKey)) {
      return json({ error: "INVALID_SKILL" }, 400, origin);
    }
    const { data, error } = await admin.schema("nexora").rpc("upgrade_player_skill", {
      p_user_id: uid,
      p_skill_key: skillKey,
    });
    if (error) {
      const message = error.message.split(/[\\n:]/)[0].trim();
      if (["INVALID_SKILL","NO_SKILL_POINTS","SKILL_MAXED","ACCOUNT_NOT_FOUND"].includes(message)) {
        return json({ error: message }, 400, origin);
      }
      console.error("NEXORA skill upgrade RPC failed:", error.message);
      return json({ error: "SKILL_UPGRADE_FAILED" }, 500, origin);
    }
    return json(data, 200, origin);
  }

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

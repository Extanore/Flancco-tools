// remove-partner-member — Slot I (rol-gebaseerd partner-team)
// -------------------------------------------------------------
// Doel: laat een partner-eigenaar (role='partner', permissions.manage_users=true)
// een teamlid uit zijn tenant verwijderen. Verschilt van het bestaande
// `delete-user` door:
//   1. Anti-self-delete (caller mag zichzelf niet verwijderen).
//   2. Anti-last-owner: als verwijderen tot 0 owners (manage_users=true) zou
//      leiden binnen die tenant → 400 (lockout-protectie).
//   3. Cleanup van techniekers-rij, user_roles-rij, en optioneel auth.users
//      (alleen als de gebruiker geen andere user_roles in andere tenants heeft).
//
// Auth-model:
//   - verify_jwt=false (custom auth in handler).
//   - Caller MOET role='admin' OF (role='partner' + matching partner_id +
//     permissions.manage_users=true). Anders → 403.
//
// Endpoint:
//   POST /functions/v1/remove-partner-member
//   Authorization: Bearer <user-JWT>
//   Body: { user_id_to_remove: uuid, partner_id: uuid }

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// ─── Config ──────────────────────────────────────────────────────────────────

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const ALLOWED_ORIGINS = (Deno.env.get("ALLOWED_ORIGINS")
  || "https://app.flancco-platform.be,https://flancco-platform.be,https://www.flancco-platform.be"
).split(",").map((s) => s.trim()).filter(Boolean);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── CORS / utils ────────────────────────────────────────────────────────────

function corsFor(req: Request) {
  const origin = req.headers.get("Origin") || "";
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  } as Record<string, string>;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, "Content-Type": "application/json" },
  });
}

// ─── Handler ────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  const corsHeaders = corsFor(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: "method not allowed" }, corsHeaders);

  try {
    if (!SUPABASE_URL || !SERVICE_KEY) {
      console.error("remove-partner-member: missing SUPABASE_URL or SERVICE_KEY");
      return json(500, { error: "Server misconfigured" }, corsHeaders);
    }

    const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    if (!token) return json(401, { error: "Geen Authorization-header meegegeven", step: "no_token" }, corsHeaders);

    const admin = createClient(SUPABASE_URL, SERVICE_KEY);

    // 1) JWT-validatie via service-role client — eerst, voor input-leak-preventie.
    const { data: userData, error: userErr } = await admin.auth.getUser(token);
    if (userErr || !userData?.user) {
      return json(401, { error: "Sessie verlopen of ongeldig — log uit en opnieuw in", step: "get_user" }, corsHeaders);
    }
    const caller = userData.user;

    // 2) Body parsen + valideren NA auth-resolve.
    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const userIdToRemove = String(body.user_id_to_remove || "").trim();
    const partner_id = String(body.partner_id || "").trim();

    if (!UUID_RE.test(userIdToRemove)) {
      return json(400, { error: "Ongeldig user_id_to_remove" }, corsHeaders);
    }
    if (!UUID_RE.test(partner_id)) {
      return json(400, { error: "Ongeldig partner_id" }, corsHeaders);
    }

    // 3) Anti-self-delete (caller mag zichzelf niet verwijderen).
    if (userIdToRemove === caller.id) {
      return json(400, { error: "Je kan jezelf niet verwijderen", step: "self_delete" }, corsHeaders);
    }

    // 4) Caller-rol resolveren.
    const { data: callerRole, error: callerRoleErr } = await admin
      .from("user_roles")
      .select("role, partner_id, permissions")
      .eq("user_id", caller.id)
      .maybeSingle();

    if (callerRoleErr) {
      console.error("remove-partner-member: caller-role lookup failed", callerRoleErr);
      return json(500, { error: "Kon rolprofiel niet ophalen" }, corsHeaders);
    }
    if (!callerRole) {
      return json(403, { error: "Geen rol gevonden voor deze gebruiker" }, corsHeaders);
    }

    const isAdmin = callerRole.role === "admin";
    const isPartnerOwner = callerRole.role === "partner"
      && callerRole.partner_id === partner_id
      && callerRole.permissions
      && (callerRole.permissions as Record<string, unknown>).manage_users === true;

    if (!isAdmin && !isPartnerOwner) {
      return json(403, { error: "Geen rechten om teamleden te verwijderen voor deze partner", step: "forbidden" }, corsHeaders);
    }

    // 5) Doel-rij ophalen voor authz + last-owner check.
    const { data: targetRole, error: targetErr } = await admin
      .from("user_roles")
      .select("role, partner_id, permissions")
      .eq("user_id", userIdToRemove)
      .maybeSingle();

    if (targetErr) {
      console.error("remove-partner-member: target-role lookup failed", targetErr);
      return json(500, { error: "Fout bij opzoeken doelgebruiker" }, corsHeaders);
    }
    if (!targetRole) {
      return json(404, { error: "Doelgebruiker niet gevonden in user_roles", step: "target_not_found" }, corsHeaders);
    }
    if (targetRole.role === "admin") {
      return json(403, { error: "Mag geen admin-account verwijderen via dit endpoint", step: "admin_target" }, corsHeaders);
    }
    if (!isAdmin && targetRole.partner_id !== partner_id) {
      return json(403, { error: "Mag enkel eigen teamleden verwijderen", step: "tenant_mismatch" }, corsHeaders);
    }

    // 6) Anti-last-owner — als doel een owner (manage_users=true) is, controleer
    //    of er minstens één andere owner overblijft binnen deze tenant.
    const targetIsOwner = !!(targetRole.permissions
      && (targetRole.permissions as Record<string, unknown>).manage_users === true);

    if (targetIsOwner) {
      const { data: ownersInTenant, error: ownersErr } = await admin
        .from("user_roles")
        .select("user_id")
        .eq("partner_id", partner_id)
        .eq("role", "partner")
        .filter("permissions->>manage_users", "eq", "true");

      if (ownersErr) {
        console.error("remove-partner-member: owners-count failed", ownersErr);
        return json(500, { error: "Fout bij controle minstens-één-owner regel" }, corsHeaders);
      }

      const otherOwners = (ownersInTenant || []).filter((o: { user_id: string }) => o.user_id !== userIdToRemove);
      if (otherOwners.length === 0) {
        return json(400, {
          error: "Kan laatste eigenaar niet verwijderen — wijs eerst een andere collega toe als beheerder",
          step: "last_owner",
        }, corsHeaders);
      }
    }

    // 7) Cleanup techniekers-rij van DEZE tenant (anderen niet aanraken).
    //    Tenant-scope houdt re-use van het auth-account in andere tenants safe.
    const { error: techErr } = await admin
      .from("techniekers")
      .delete()
      .eq("user_id", userIdToRemove)
      .eq("partner_id", partner_id);

    if (techErr) {
      console.error("remove-partner-member: techniekers delete failed", techErr);
      return json(500, { error: "Verwijderen techniekers-rij mislukt: " + techErr.message }, corsHeaders);
    }

    // 8) user_roles-rij verwijderen.
    const { error: roleDelErr } = await admin
      .from("user_roles")
      .delete()
      .eq("user_id", userIdToRemove);

    if (roleDelErr) {
      console.error("remove-partner-member: user_roles delete failed", roleDelErr);
      return json(500, { error: "Verwijderen user_roles mislukt: " + roleDelErr.message }, corsHeaders);
    }

    // 9) auth.users — alleen verwijderen als de user geen andere user_roles heeft.
    //    (User_roles heeft UNIQUE(user_id), dus na vorige delete is hij overal weg.)
    //    Bij Supabase delete cascadeert dit veilig; maar techniekers in ANDERE tenants
    //    blijven bestaan zonder user_id (FK SET NULL via delete-cascade niet altijd
    //    geconfigureerd). Defensief checken voor rij-restanten.
    const { count: techCount } = await admin
      .from("techniekers")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userIdToRemove);

    let authDeleted = false;
    if ((techCount || 0) === 0) {
      const { error: authErr } = await admin.auth.admin.deleteUser(userIdToRemove);
      if (authErr) {
        // Niet fataal — user_roles is weg, dus toegang is geblokkeerd. Loggen + doorgaan.
        console.warn("remove-partner-member: auth.users delete failed (non-fatal):", authErr.message);
      } else {
        authDeleted = true;
      }
    }

    console.log(JSON.stringify({
      fn: "remove-partner-member",
      partner_id,
      auth_deleted: authDeleted,
      target_was_owner: targetIsOwner,
    }));

    return json(200, {
      success: true,
      auth_deleted: authDeleted,
      message: "Teamlid verwijderd",
    }, corsHeaders);
  } catch (err) {
    console.error("remove-partner-member exception:", err);
    return json(500, { error: (err as Error).message || "Onbekende fout" }, corsFor(req));
  }
});

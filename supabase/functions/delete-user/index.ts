// delete-user v4 — verify_jwt=false (handle auth in code voor betere errors)
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';

// CORS — Allow-Origin gewhitelist op productie-domeinen (admin/portal + calculator).
// Override via ALLOWED_ORIGINS env var (comma-separated) voor staging-domeinen.
const ALLOWED_ORIGINS = (Deno.env.get('ALLOWED_ORIGINS')
  ?? 'https://flancco-platform.be,https://app.flancco-platform.be,https://www.flancco-platform.be,https://calculator.flancco-platform.be'
).split(',').map((s) => s.trim()).filter(Boolean);

function corsFor(req: Request): Record<string, string> {
  const origin = req.headers.get('Origin') || '';
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0] ?? 'null';
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Max-Age': '3600',
    'Vary': 'Origin',
  };
}

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

function json(status: number, body: unknown, corsHeaders: Record<string, string>) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

/*
  delete-user v4 — verwijdert een gebruiker uit Supabase Auth + user_roles.

  Authz:
    - Flancco admin (role='admin') -> mag iedereen verwijderen behalve zichzelf.
    - Partner-eigenaar (role='partner', permissions.manage_users=true)
        -> mag enkel eigen teamleden verwijderen (partner_id match). Admin-accounts zijn uit bounds.

  JWT-validatie gebeurt in code via service-role client (verify_jwt=false op platform-niveau)
  zodat de frontend een nette foutmelding ontvangt i.p.v. een generieke platform-401.
*/
Deno.serve(async (req: Request) => {
  const corsHeaders = corsFor(req);

  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST')    return json(405, { error: 'method not allowed' }, corsHeaders);

  try {
    const authHeader = req.headers.get('Authorization') || '';
    const token = authHeader.replace(/^Bearer\s+/i, '');
    if (!token) {
      return json(401, { error: 'Geen Authorization-header meegegeven', step: 'no_token' }, corsHeaders);
    }

    const body = await req.json().catch(() => ({}));
    const userIdToDelete: string = body.userIdToDelete;
    if (!userIdToDelete) {
      return json(400, { error: 'userIdToDelete is verplicht', step: 'no_user_id' }, corsHeaders);
    }

    const adminClient = createClient(SUPABASE_URL, SERVICE_KEY);

    // Validate JWT via service role
    const { data: userData, error: userErr } = await adminClient.auth.getUser(token);
    if (userErr || !userData?.user) {
      return json(401, {
        error: 'Sessie verlopen of ongeldig - log uit en opnieuw in',
        step: 'get_user',
        detail: userErr?.message || 'user is null',
      }, corsHeaders);
    }
    const caller = userData.user;

    if (userIdToDelete === caller.id) {
      return json(400, { error: 'Je kan jezelf niet verwijderen', step: 'self_delete' }, corsHeaders);
    }

    // Caller role + permissions
    const { data: callerRole, error: callerRoleErr } = await adminClient
      .from('user_roles')
      .select('role, partner_id, permissions')
      .eq('user_id', caller.id)
      .single();
    if (callerRoleErr || !callerRole) {
      return json(403, {
        error: 'Geen rol gevonden voor deze gebruiker',
        step: 'caller_role_lookup',
        detail: callerRoleErr?.message,
      }, corsHeaders);
    }

    const isAdmin = callerRole.role === 'admin';
    const hasManageUsers = !!callerRole.permissions?.manage_users;
    if (!isAdmin && !hasManageUsers) {
      return json(403, {
        error: 'Geen rechten om gebruikers te verwijderen',
        step: 'permission_check',
      }, corsHeaders);
    }

    // Target role (required — voorkomt dat we willekeurige UIDs verwijderen)
    const { data: targetRole, error: targetErr } = await adminClient
      .from('user_roles')
      .select('role, partner_id')
      .eq('user_id', userIdToDelete)
      .maybeSingle();
    if (targetErr) {
      return json(500, {
        error: 'Fout bij opzoeken doelgebruiker',
        step: 'target_lookup',
        detail: targetErr.message,
      }, corsHeaders);
    }

    // Partner-caller tenant-check
    if (!isAdmin) {
      if (!callerRole.partner_id) {
        return json(403, { error: 'Partner zonder partner_id kan geen team beheren', step: 'no_partner_id' }, corsHeaders);
      }
      if (!targetRole) {
        return json(404, { error: 'Doelgebruiker niet gevonden in user_roles', step: 'target_not_found' }, corsHeaders);
      }
      if (targetRole.role === 'admin') {
        return json(403, { error: 'Mag geen admin-account verwijderen', step: 'target_is_admin' }, corsHeaders);
      }
      if (targetRole.partner_id !== callerRole.partner_id) {
        return json(403, { error: 'Mag enkel eigen teamleden verwijderen', step: 'tenant_mismatch' }, corsHeaders);
      }
    }

    // 1) user_roles opruimen (indien aanwezig)
    if (targetRole) {
      const delRoleRes = await adminClient.from('user_roles').delete().eq('user_id', userIdToDelete);
      if (delRoleRes.error) {
        return json(500, {
          error: 'user_roles delete mislukt: ' + delRoleRes.error.message,
          step: 'delete_user_roles',
        }, corsHeaders);
      }
    }

    // 2) auth.users verwijderen
    const { error: authErr } = await adminClient.auth.admin.deleteUser(userIdToDelete);
    if (authErr) {
      return json(500, {
        error: 'auth.users delete mislukt: ' + authErr.message,
        step: 'delete_auth_user',
      }, corsHeaders);
    }

    return json(200, { ok: true, success: true }, corsHeaders);
  } catch (e) {
    return json(500, { error: (e as Error).message || 'Onbekende fout', step: 'exception' }, corsHeaders);
  }
});

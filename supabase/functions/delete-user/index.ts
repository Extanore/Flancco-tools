// delete-user v4 — verify_jwt=false (handle auth in code voor betere errors)
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

function json(status: number, body: unknown) {
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
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST')    return json(405, { error: 'method not allowed' });

  try {
    const authHeader = req.headers.get('Authorization') || '';
    const token = authHeader.replace(/^Bearer\s+/i, '');
    if (!token) {
      return json(401, { error: 'Geen Authorization-header meegegeven', step: 'no_token' });
    }

    const body = await req.json().catch(() => ({}));
    const userIdToDelete: string = body.userIdToDelete;
    if (!userIdToDelete) {
      return json(400, { error: 'userIdToDelete is verplicht', step: 'no_user_id' });
    }

    const adminClient = createClient(SUPABASE_URL, SERVICE_KEY);

    // Validate JWT via service role
    const { data: userData, error: userErr } = await adminClient.auth.getUser(token);
    if (userErr || !userData?.user) {
      return json(401, {
        error: 'Sessie verlopen of ongeldig - log uit en opnieuw in',
        step: 'get_user',
        detail: userErr?.message || 'user is null',
      });
    }
    const caller = userData.user;

    if (userIdToDelete === caller.id) {
      return json(400, { error: 'Je kan jezelf niet verwijderen', step: 'self_delete' });
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
      });
    }

    const isAdmin = callerRole.role === 'admin';
    const hasManageUsers = !!callerRole.permissions?.manage_users;
    if (!isAdmin && !hasManageUsers) {
      return json(403, {
        error: 'Geen rechten om gebruikers te verwijderen',
        step: 'permission_check',
      });
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
      });
    }

    // Partner-caller tenant-check
    if (!isAdmin) {
      if (!callerRole.partner_id) {
        return json(403, { error: 'Partner zonder partner_id kan geen team beheren', step: 'no_partner_id' });
      }
      if (!targetRole) {
        return json(404, { error: 'Doelgebruiker niet gevonden in user_roles', step: 'target_not_found' });
      }
      if (targetRole.role === 'admin') {
        return json(403, { error: 'Mag geen admin-account verwijderen', step: 'target_is_admin' });
      }
      if (targetRole.partner_id !== callerRole.partner_id) {
        return json(403, { error: 'Mag enkel eigen teamleden verwijderen', step: 'tenant_mismatch' });
      }
    }

    // 1) user_roles opruimen (indien aanwezig)
    if (targetRole) {
      const delRoleRes = await adminClient.from('user_roles').delete().eq('user_id', userIdToDelete);
      if (delRoleRes.error) {
        return json(500, {
          error: 'user_roles delete mislukt: ' + delRoleRes.error.message,
          step: 'delete_user_roles',
        });
      }
    }

    // 2) auth.users verwijderen
    const { error: authErr } = await adminClient.auth.admin.deleteUser(userIdToDelete);
    if (authErr) {
      return json(500, {
        error: 'auth.users delete mislukt: ' + authErr.message,
        step: 'delete_auth_user',
      });
    }

    return json(200, { ok: true, success: true });
  } catch (e) {
    return json(500, { error: (e as Error).message || 'Onbekende fout', step: 'exception' });
  }
});

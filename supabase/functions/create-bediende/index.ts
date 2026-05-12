import { createClient } from 'jsr:@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

/*
  create-bediende — maakt een nieuwe gebruiker aan in Supabase Auth + user_roles + techniekers.

  Caller-contexten (authz):
    • admin / bediende  → Flancco-intern account (user_roles.role='bediende', partner_id=NULL)
    • partner (met permissions.manage_users=true) → team-lid van die partner
        (user_roles.role='partner', partner_id=<caller's partner_id>)

  Partner-caller kan NOOIT een admin aanmaken of de partner_id spoofen — die wordt
  server-side overschreven met de partner_id van de caller.
*/

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    const body = await req.json();
    const { email, password, voornaam, naam, telefoon, functie, start_datum, adres, postcode, gemeente } = body || {};

    if (!email || !password || !voornaam || !naam) {
      return json({ error: 'Verplichte velden ontbreken (email, password, voornaam, naam)' }, 400);
    }
    if (typeof password !== 'string' || password.length < 6) {
      return json({ error: 'Wachtwoord moet minstens 6 tekens zijn' }, 400);
    }

    const authHeader = req.headers.get('Authorization') || '';
    if (!authHeader) return json({ error: 'Niet ingelogd' }, 401);

    // 1) Verifieer caller
    const userClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } }
    );
    const { data: userData } = await userClient.auth.getUser();
    if (!userData?.user) return json({ error: 'Niet ingelogd' }, 401);

    const { data: callerRole } = await userClient
      .from('user_roles')
      .select('role, partner_id, permissions')
      .eq('user_id', userData.user.id)
      .single();

    const isFlanccoInternal = callerRole?.role === 'admin' || callerRole?.role === 'bediende';
    const isPartnerOwner    = callerRole?.role === 'partner'
                              && !!callerRole?.partner_id
                              && !!callerRole?.permissions?.manage_users;

    if (!isFlanccoInternal && !isPartnerOwner) {
      return json({ error: 'Geen rechten om gebruikers aan te maken' }, 403);
    }

    // 2) Bepaal role + partner_id o.b.v. caller-context (ALTIJD server-side — geen payload)
    let newUserRole: 'bediende' | 'partner';
    let newUserPartnerId: string | null;
    let defaultPermissions: Record<string, boolean>;

    if (isPartnerOwner) {
      newUserRole = 'partner';
      newUserPartnerId = callerRole!.partner_id!;
      // Teamleden krijgen standaard geen super-admin of team-beheer rechten.
      defaultPermissions = {
        manage_pricing: false,
        manage_partners: false,
        manage_users: false,
        verlof_beheer: false,
      };
    } else {
      newUserRole = 'bediende';
      newUserPartnerId = null;
      defaultPermissions = {
        manage_pricing: false,
        manage_partners: false,
        manage_users: false,
        verlof_beheer: true,
      };
    }

    // 3) Service-role client voor auth + DB-writes
    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    // 4) auth.users aanmaken
    const { data: newUser, error: authErr } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { voornaam, naam },
    });
    if (authErr || !newUser?.user) {
      return json({ error: 'Auth aanmaken faalde: ' + (authErr?.message || 'onbekend') }, 500);
    }
    const newUserId = newUser.user.id;

    // 5) user_roles insert
    const { error: roleErr } = await admin.from('user_roles').insert({
      user_id: newUserId,
      role: newUserRole,
      partner_id: newUserPartnerId,
      permissions: defaultPermissions,
    });
    if (roleErr) {
      await admin.auth.admin.deleteUser(newUserId);
      return json({ error: 'user_roles aanmaken faalde: ' + roleErr.message }, 500);
    }

    // 6) techniekers insert (type_personeel='bediende' — back-office medewerker)
    const { data: techRow, error: techErr } = await admin.from('techniekers').insert({
      naam,
      voornaam,
      email,
      telefoon: telefoon || null,
      functie: functie || null,
      start_datum: start_datum || null,
      adres: adres || null,
      postcode: postcode || null,
      gemeente: gemeente || null,
      type_personeel: 'bediende',
      user_id: newUserId,
      partner_id: newUserPartnerId,
      actief: true,
    }).select('id').single();

    if (techErr || !techRow) {
      await admin.from('user_roles').delete().eq('user_id', newUserId);
      await admin.auth.admin.deleteUser(newUserId);
      return json({ error: 'techniekers-rij aanmaken faalde: ' + (techErr?.message || 'onbekend') }, 500);
    }

    // 7) Default verlof_saldi — enkel voor Flancco-intern (partners beheren eigen saldi separaat)
    if (!isPartnerOwner) {
      const jaar = new Date().getFullYear();
      const { data: verlofTypes } = await admin
        .from('verlof_types')
        .select('id, code')
        .in('code', ['vakantie', 'adv']);

      if (verlofTypes && verlofTypes.length > 0) {
        const defaults: Record<string, number> = { vakantie: 20, adv: 12 };
        const saldoRows = verlofTypes.map((vt: { id: string; code: string }) => ({
          technieker_id: techRow.id,
          jaar,
          verlof_type_id: vt.id,
          saldo_dagen: defaults[vt.code] || 0,
          opgenomen_dagen: 0,
        }));
        await admin.from('verlof_saldi').insert(saldoRows);
      }
    }

    return json({
      ok: true,
      technieker_id: techRow.id,
      user_id: newUserId,
      role: newUserRole,
      partner_id: newUserPartnerId,
    });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

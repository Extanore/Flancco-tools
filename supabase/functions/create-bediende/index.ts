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

// Email-config — zelfde env-conventies als invite-partner-member.
const RESEND_KEY = Deno.env.get('RESEND_API_KEY') ?? '';
const FROM_DEFAULT = Deno.env.get('EMAIL_FROM_ADDRESS') ?? 'Flancco Platform <noreply@flancco-platform.be>';
const REPLY_TO_DEFAULT = Deno.env.get('EMAIL_REPLY_TO') ?? 'gillian.geernaert@flancco.be';
const APP_BASE_URL = (Deno.env.get('APP_BASE_URL') ?? 'https://app.flancco-platform.be/').replace(/\/?$/, '/');

/*
  create-bediende — maakt een nieuwe gebruiker aan in Supabase Auth + user_roles + techniekers,
  en stuurt een welkom-mail met magic-link "Direct inloggen"-knop.

  Caller-contexten (authz):
    • admin / bediende  → Flancco-intern account (user_roles.role='bediende', partner_id=NULL)
    • partner (met permissions.manage_users=true) → team-lid van die partner
        (user_roles.role='partner', partner_id=<caller's partner_id>)

  Partner-caller kan NOOIT een admin aanmaken of de partner_id spoofen — die wordt
  server-side overschreven met de partner_id van de caller.

  Mail-flow (audit-fix 2026-05-13):
  Voorheen werd er nooit een mail verstuurd → nieuwe gebruikers wisten niet dat hun
  account klaar stond. Nu sturen we na succesvolle aanmaak een branded welkom-mail
  met zowel de inloggegevens (email + tijdelijk wachtwoord) als een magic-link
  "Direct inloggen"-knop. Dat geeft één-klik-toegang zonder wachtwoord-friction.
*/

function escHtml(s: string | null | undefined): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escUrl(s: string | null | undefined): string {
  const v = String(s ?? '').trim();
  if (!v) return '';
  if (/^https?:/i.test(v)) {
    return v.replace(/"/g, '%22').replace(/</g, '%3C').replace(/>/g, '%3E');
  }
  return '';
}

function sanitizeHex(value: string | null | undefined, fallback: string): string {
  const v = String(value ?? '').trim();
  if (/^#?[0-9a-fA-F]{6}$/.test(v)) return v.startsWith('#') ? v : `#${v}`;
  return fallback;
}

interface BrandInfo {
  name: string;
  primaryColor: string;
  logoUrl: string;
  email: string;
  isFlancco: boolean;
}

async function loadBrand(
  sb: ReturnType<typeof createClient>,
  partnerId: string | null,
): Promise<BrandInfo> {
  if (!partnerId) {
    return {
      name: 'Flancco BV',
      primaryColor: '#1A1A2E',
      logoUrl: '',
      email: '',
      isFlancco: true,
    };
  }
  const { data } = await sb.from('partners')
    .select('slug, naam, bedrijfsnaam, kleur_primair, logo_url, email')
    .eq('id', partnerId)
    .maybeSingle();
  const slug = String(data?.slug || 'flancco').toLowerCase();
  const isFlancco = slug === 'flancco';
  return {
    name: data?.bedrijfsnaam || data?.naam || 'Flancco BV',
    primaryColor: sanitizeHex(data?.kleur_primair, '#1A1A2E'),
    logoUrl: data?.logo_url || '',
    email: data?.email || '',
    isFlancco,
  };
}

interface WelcomeEmailInput {
  brand: BrandInfo;
  recipient: { email: string; voornaam: string; naam: string };
  tempPassword: string;
  magicLinkUrl: string | null;
  loginUrl: string;
  inviterDisplay: string;
  context: 'bediende' | 'partner_member';
}

function buildWelcomeEmail(opts: WelcomeEmailInput): { subject: string; html: string } {
  const { brand, recipient, tempPassword, magicLinkUrl, loginUrl, inviterDisplay, context } = opts;
  const primary = brand.primaryColor;
  const accent = '#E74C3C';
  const safeBrandName = escHtml(brand.name);
  const safeRecipient = escHtml((recipient.voornaam + ' ' + recipient.naam).trim() || recipient.email);
  const safeInviter = escHtml(inviterDisplay);

  const subject = context === 'partner_member'
    ? `${brand.name} heeft je toegevoegd aan het Flancco-platform`
    : `Welkom bij Flancco — je account staat klaar`;

  const headerLogo = brand.logoUrl
    ? `<img src="${escUrl(brand.logoUrl)}" alt="${safeBrandName}" style="max-height:40px;max-width:200px;display:block">`
    : `<div style="font-size:18px;font-weight:700;color:#fff;letter-spacing:0.3px">${safeBrandName}</div>`;

  const intro = context === 'partner_member'
    ? `${safeInviter} heeft je toegevoegd aan het team van <strong>${safeBrandName}</strong> op het Flancco partner-platform. Je kan nu contracten, klanten en interventies binnen jouw tenant beheren.`
    : `${safeInviter} heeft een Flancco-account voor je aangemaakt. Je kan vanaf nu het admin-dashboard gebruiken voor planning, rapportering en facturatie.`;

  // Eén-klik magic-link banner (alleen tonen als generatie gelukt is).
  const magicLinkBanner = magicLinkUrl
    ? `
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#F0F9FF;border:1px solid #BAE6FD;border-radius:10px;margin-top:18px">
        <tr><td style="padding:18px 20px">
          <div style="font-size:11px;font-weight:600;color:#0369A1;letter-spacing:0.5px;text-transform:uppercase;margin-bottom:10px">Eén-klik login</div>
          <div style="font-size:13px;color:#0C4A6E;line-height:1.55">Klik op de knop hieronder om direct in te loggen — zonder je wachtwoord te moeten intypen. De link blijft beperkte tijd geldig.</div>
        </td></tr>
      </table>`
    : '';

  // Inloggegevens-box altijd tonen — magic-link kan verlopen, wachtwoord is fallback.
  const credentialsBox = `
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#F9FAFB;border:1px solid #E5E7EB;border-radius:10px;margin-top:18px">
        <tr><td style="padding:18px 20px">
          <div style="font-size:11px;font-weight:600;color:#6B7280;letter-spacing:0.5px;text-transform:uppercase;margin-bottom:10px">Inloggegevens</div>
          <div style="font-size:13px;color:#374151;margin-bottom:6px"><strong style="color:${primary}">E-mail:</strong> ${escHtml(recipient.email)}</div>
          <div style="font-size:13px;color:#374151"><strong style="color:${primary}">Tijdelijk wachtwoord:</strong> <code style="display:inline-block;background:#fff;border:1px solid #E5E7EB;padding:4px 10px;border-radius:6px;font-family:'SF Mono',Menlo,Consolas,monospace;font-size:13px;color:${primary};margin-left:4px">${escHtml(tempPassword)}</code></div>
        </td></tr>
      </table>`;

  // CTA-target: magic-link voor instant login, anders generieke login-url.
  const ctaHref = magicLinkUrl || loginUrl;
  const ctaLabel = magicLinkUrl ? 'Direct inloggen' : 'Inloggen op het platform';

  const html = `<!doctype html>
<html lang="nl">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:${primary}">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f3f4f6;padding:24px 12px">
  <tr><td align="center">
    <table role="presentation" width="560" cellspacing="0" cellpadding="0" style="max-width:560px;width:100%;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 4px 18px rgba(0,0,0,0.06)">
      <tr><td style="background:${primary};padding:24px 28px">${headerLogo}</td></tr>
      <tr><td style="padding:32px 28px 8px">
        <div style="font-size:11px;font-weight:600;color:${accent};letter-spacing:0.5px;text-transform:uppercase;margin-bottom:10px">Welkom</div>
        <h1 style="margin:0 0 14px;font-size:22px;line-height:1.3;color:${primary};font-weight:700">Hallo ${safeRecipient}</h1>
        <p style="margin:0 0 12px;font-size:15px;line-height:1.6;color:#4B5563">${intro}</p>
      </td></tr>
      <tr><td style="padding:8px 28px 8px">${magicLinkBanner}${credentialsBox}</td></tr>
      <tr><td style="padding:22px 28px 8px">
        <a href="${escUrl(ctaHref)}" style="display:inline-block;background:${primary};color:#ffffff;text-decoration:none;padding:14px 28px;border-radius:8px;font-size:14px;font-weight:600">${escHtml(ctaLabel)}</a>
      </td></tr>
      <tr><td style="padding:18px 28px 8px">
        <div style="background:#FEF3F2;border-left:3px solid ${accent};padding:12px 14px;border-radius:4px;font-size:13px;color:#7F1D1D;line-height:1.5"><strong>Belangrijk:</strong> Wijzig je wachtwoord direct na je eerste login via Instellingen &gt; Mijn account.</div>
      </td></tr>
      <tr><td style="padding:22px 28px 28px;border-top:1px solid #E5E7EB;font-size:12px;color:#9CA3AF;line-height:1.6">
        Vragen? Reageer op deze e-mail.
        <br>${brand.isFlancco ? 'Flancco BV' : safeBrandName + ' &middot; via Flancco-platform'}
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
  return { subject, html };
}

Deno.serve(async (req) => {
  const corsHeaders = corsFor(req);

  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const body = await req.json();
    const { email, password, voornaam, naam, telefoon, functie, start_datum, adres, postcode, gemeente } = body || {};

    if (!email || !password || !voornaam || !naam) {
      return json({ error: 'Verplichte velden ontbreken (email, password, voornaam, naam)' }, 400, corsHeaders);
    }
    if (typeof password !== 'string' || password.length < 6) {
      return json({ error: 'Wachtwoord moet minstens 6 tekens zijn' }, 400, corsHeaders);
    }

    const authHeader = req.headers.get('Authorization') || '';
    if (!authHeader) return json({ error: 'Niet ingelogd' }, 401, corsHeaders);

    // 1) Verifieer caller
    const userClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } }
    );
    const { data: userData } = await userClient.auth.getUser();
    if (!userData?.user) return json({ error: 'Niet ingelogd' }, 401, corsHeaders);

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
      return json({ error: 'Geen rechten om gebruikers aan te maken' }, 403, corsHeaders);
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
      return json({ error: 'Auth aanmaken faalde: ' + (authErr?.message || 'onbekend') }, 500, corsHeaders);
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
      return json({ error: 'user_roles aanmaken faalde: ' + roleErr.message }, 500, corsHeaders);
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
      return json({ error: 'techniekers-rij aanmaken faalde: ' + (techErr?.message || 'onbekend') }, 500, corsHeaders);
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

    // 8) Branded welkom-mail met magic-link "Direct inloggen"-knop
    // Audit-fix 2026-05-13: voorheen werd nooit een mail verstuurd — nieuwe
    // gebruikers wisten dus niet dat hun account klaar stond. Mail-failure is
    // best-effort: gebruiker is wel aangemaakt en kan inloggen met password.
    let emailSent = false;
    let emailError: string | null = null;
    let magicLinkUrl: string | null = null;

    try {
      // Belangrijk: redirectTo MOET naar /admin/ wijzen, niet naar root.
      // Cloudflare Worker (_worker.js) herleidt root (/) naar /onboard/ — daar
      // draait geen Supabase JS-SDK, dus de hash-tokens van de magic-link gaan
      // verloren en user landt zonder sessie op de publieke wizard. Door direct
      // naar /admin/ te wijzen pakt admin/index.html (met detectSessionInUrl=true)
      // de tokens op en activeert de sessie automatisch.
      const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
        type: 'magiclink',
        email,
        options: { redirectTo: APP_BASE_URL + 'admin/' },
      });
      if (linkErr) {
        console.warn('create-bediende: magic-link gen faalde:', linkErr.message);
      } else {
        magicLinkUrl = (linkData?.properties as { action_link?: string } | undefined)?.action_link ?? null;
      }
    } catch (e) {
      console.warn('create-bediende: magic-link exception:', (e as Error).message);
    }

    if (RESEND_KEY) {
      try {
        const brand = await loadBrand(admin, newUserPartnerId);
        const inviterDisplay = (userData.user.user_metadata as Record<string, unknown> | undefined)?.full_name as string
          || userData.user.email
          || 'een beheerder';
        const context: 'bediende' | 'partner_member' = isPartnerOwner ? 'partner_member' : 'bediende';

        const { subject, html } = buildWelcomeEmail({
          brand,
          recipient: { email, voornaam, naam },
          tempPassword: password,
          magicLinkUrl,
          loginUrl: APP_BASE_URL,
          inviterDisplay: String(inviterDisplay),
          context,
        });
        const replyTo = !brand.isFlancco && brand.email ? brand.email : REPLY_TO_DEFAULT;
        const resp = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: FROM_DEFAULT,
            reply_to: [replyTo],
            to: [email],
            subject,
            html,
          }),
        });
        if (resp.ok) {
          emailSent = true;
        } else {
          // Geen Resend-detail in error (security-hygiëne) — alleen status-code.
          emailError = `Resend ${resp.status}`;
        }
      } catch (e) {
        emailError = (e as Error).message;
      }
    } else {
      emailError = 'RESEND_API_KEY niet geconfigureerd';
    }

    // 9) Logging — geen PII; alleen rol + outcome
    console.log(JSON.stringify({
      fn: 'create-bediende',
      role: newUserRole,
      partner_id: newUserPartnerId,
      email_sent: emailSent,
      email_error: emailError,
    }));

    return json({
      ok: true,
      technieker_id: techRow.id,
      user_id: newUserId,
      role: newUserRole,
      partner_id: newUserPartnerId,
      email_sent: emailSent,
      email_error: emailError,
    }, 200, corsHeaders);
  } catch (e) {
    return json({ error: (e as Error).message }, 500, corsHeaders);
  }
});

function json(body: unknown, status: number, corsHeaders: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

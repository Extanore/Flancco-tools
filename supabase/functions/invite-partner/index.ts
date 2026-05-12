// invite-partner v6 — verify_jwt=false (handle auth in code voor betere errors)
//
// SECURITY HARDENING (audit-fix 2026-05-12):
//  - SEC-C4: temp_password wordt NIET meer in response geretourneerd.
//    Wachtwoord komt enkel via de invite-mail bij de partner terecht.
//    Bij Resend-failure: admin moet via user-management een password-reset
//    initiëren (separate flow, geen plaintext exposure).
//  - SEC-H1: CORS whitelist in plaats van Allow-Origin: *
//
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';

const ALLOWED_ORIGINS = (Deno.env.get('ALLOWED_ORIGINS')
  ?? 'https://flancco-platform.be,https://app.flancco-platform.be,https://www.flancco-platform.be'
).split(',').map((s) => s.trim()).filter(Boolean);

function corsFor(req: Request) {
  const origin = req.headers.get('Origin') || '';
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0] ?? 'null';
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Max-Age': '3600',
    'Vary': 'Origin',
  } as Record<string, string>;
}

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const RESEND_KEY   = Deno.env.get('RESEND_API_KEY') ?? '';
const FROM_DEFAULT = Deno.env.get('EMAIL_FROM_ADDRESS') ?? 'Flancco Platform <noreply@flancco-platform.be>';
const REPLY_TO     = Deno.env.get('EMAIL_REPLY_TO')      ?? 'gillian.geernaert@flancco.be';
const APP_BASE_URL = (Deno.env.get('APP_BASE_URL') ?? 'https://app.flancco-platform.be/').replace(/\/?$/, '/');

function json(status: number, body: unknown, corsHeaders: Record<string, string>) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

function esc(s: string | null | undefined): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

function buildInviteEmailHTML(opts: { partnerName: string; email: string; tempPassword: string; loginUrl: string; inviterName: string; }): string {
  const NAVY = '#1A1A2E';
  const RED  = '#E74C3C';
  return `<!doctype html>
<html lang="nl">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Welkom bij het Flancco Partner Platform</title></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1A1A2E">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f3f4f6;padding:24px 12px">
    <tr><td align="center">
      <table role="presentation" width="560" cellspacing="0" cellpadding="0" style="max-width:560px;width:100%;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 4px 18px rgba(0,0,0,0.06)">
        <tr><td style="background:${NAVY};padding:26px 28px">
          <div style="font-size:22px;font-weight:700;color:#ffffff;letter-spacing:-0.3px">FLANC<span style="color:${RED}">O</span></div>
          <div style="font-size:12px;color:rgba(255,255,255,0.7);margin-top:2px;letter-spacing:0.5px;text-transform:uppercase">Partner Platform</div>
        </td></tr>
        <tr><td style="padding:32px 28px 8px">
          <div style="font-size:11px;font-weight:600;color:${RED};letter-spacing:0.5px;text-transform:uppercase;margin-bottom:10px">Uitnodiging</div>
          <h1 style="margin:0 0 14px;font-size:24px;line-height:1.3;color:${NAVY};font-weight:700">Welkom, ${esc(opts.partnerName)}</h1>
          <p style="margin:0 0 18px;font-size:15px;line-height:1.6;color:#4B5563">${esc(opts.inviterName)} heeft een account voor je aangemaakt in het <strong>Flancco Partner Platform</strong>. Hiermee beheer je je contracten, klanten en interventies op één centrale plek.</p>
        </td></tr>
        <tr><td style="padding:8px 28px 4px">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#F9FAFB;border:1px solid #E5E7EB;border-radius:10px">
            <tr><td style="padding:18px 20px">
              <div style="font-size:11px;font-weight:600;color:#6B7280;letter-spacing:0.5px;text-transform:uppercase;margin-bottom:10px">Je inloggegevens</div>
              <div style="font-size:13px;color:#374151;margin-bottom:6px"><strong style="color:${NAVY}">E-mail:</strong> ${esc(opts.email)}</div>
              <div style="font-size:13px;color:#374151"><strong style="color:${NAVY}">Tijdelijk wachtwoord:</strong> <code style="display:inline-block;background:#ffffff;border:1px solid #E5E7EB;padding:4px 10px;border-radius:6px;font-family:'SF Mono',Menlo,Consolas,monospace;font-size:13px;color:${NAVY};margin-left:4px">${esc(opts.tempPassword)}</code></div>
            </td></tr>
          </table>
        </td></tr>
        <tr><td style="padding:22px 28px 8px">
          <a href="${esc(opts.loginUrl)}" style="display:inline-block;background:${NAVY};color:#ffffff;text-decoration:none;padding:14px 28px;border-radius:8px;font-size:14px;font-weight:600">Inloggen op platform</a>
        </td></tr>
        <tr><td style="padding:20px 28px 8px">
          <div style="background:#FEF3F2;border-left:3px solid ${RED};padding:12px 14px;border-radius:4px;font-size:13px;color:#7F1D1D;line-height:1.5"><strong>Belangrijk:</strong> wijzig je wachtwoord direct na je eerste login via Instellingen &gt; Account.</div>
        </td></tr>
        <tr><td style="padding:22px 28px 28px;border-top:1px solid #E5E7EB;margin-top:20px;font-size:12px;color:#9CA3AF;line-height:1.6">
          Vragen? Reageer op deze email — je bericht komt rechtstreeks bij Gillian Geernaert.
          <br>Flancco BV · Droogijsstralen · HVAC · Zonnepaneelreiniging
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

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

    const adminClient = createClient(SUPABASE_URL, SERVICE_KEY);

    const { data: userData, error: userErr } = await adminClient.auth.getUser(token);
    if (userErr || !userData?.user) {
      return json(401, {
        error: 'Sessie verlopen of ongeldig — log uit en opnieuw in',
        step: 'get_user',
        detail: userErr?.message || 'user is null',
      }, corsHeaders);
    }
    const caller = userData.user;

    const { data: roleData, error: roleErr } = await adminClient
      .from('user_roles').select('role').eq('user_id', caller.id).single();
    if (roleErr || !roleData) {
      return json(403, {
        error: 'Geen rol gevonden voor deze gebruiker',
        step: 'role_lookup',
        detail: roleErr?.message,
      }, corsHeaders);
    }
    if (roleData.role !== 'admin') {
      return json(403, {
        error: 'Alleen admins kunnen partners uitnodigen',
        step: 'role_check',
        got_role: roleData.role,
      }, corsHeaders);
    }

    const body = await req.json().catch(() => ({}));
    const email: string = (body.email || '').trim().toLowerCase();
    const partner_id: string = body.partner_id;
    if (!email || !partner_id) {
      return json(400, { error: 'E-mail en partner_id zijn verplicht' }, corsHeaders);
    }

    const { data: existingUsers } = await adminClient.auth.admin.listUsers();
    const existingUser = existingUsers?.users?.find((u: { email?: string }) => (u.email || '').toLowerCase() === email);
    if (existingUser) {
      const { data: existingRole } = await adminClient
        .from('user_roles').select('*').eq('user_id', existingUser.id).maybeSingle();
      if (existingRole) {
        return json(409, { error: 'Dit e-mailadres heeft al een account' }, corsHeaders);
      }
    }

    const { data: partner } = await adminClient
      .from('partners').select('bedrijfsnaam,naam').eq('id', partner_id).single();
    const partnerName = partner?.bedrijfsnaam || partner?.naam || 'Partner';

    const tempPassword = 'Flancco_' + crypto.randomUUID().substring(0, 8);
    const { data: newUser, error: createError } = await adminClient.auth.admin.createUser({
      email, password: tempPassword, email_confirm: true,
    });
    if (createError || !newUser?.user) {
      return json(400, { error: createError?.message || 'Aanmaken gebruiker mislukt' }, corsHeaders);
    }

    const { error: roleError } = await adminClient.from('user_roles').insert({
      user_id: newUser.user.id, role: 'partner', partner_id,
    });
    if (roleError) {
      await adminClient.auth.admin.deleteUser(newUser.user.id);
      return json(500, { error: 'Fout bij aanmaken rol: ' + roleError.message }, corsHeaders);
    }

    const loginUrl = APP_BASE_URL;
    const inviterName = caller.user_metadata?.full_name || caller.email || 'een Flancco-beheerder';

    let emailSent = false;
    let emailError: string | null = null;
    if (RESEND_KEY) {
      try {
        const html = buildInviteEmailHTML({ partnerName, email, tempPassword, loginUrl, inviterName });
        const res = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: FROM_DEFAULT,
            reply_to: [REPLY_TO],
            to: [email],
            subject: `Welkom bij het Flancco Partner Platform`,
            html,
          }),
        });
        if (res.ok) {
          emailSent = true;
        } else {
          emailError = `Resend ${res.status}`;
        }
      } catch (e) {
        emailError = (e as Error).message;
      }
    } else {
      emailError = 'RESEND_API_KEY niet geconfigureerd';
    }

    // SEC-C4: temp_password NIET in response. Alleen email-bezorging is bron.
    // Bij email-failure: admin moet via user-management password-reset initiëren.
    return json(200, {
      success: true,
      user_id: newUser.user.id,
      email,
      login_url: loginUrl,
      email_sent: emailSent,
      email_error: emailError,
      message: emailSent
        ? 'Partner account aangemaakt en uitnodiging verstuurd'
        : 'Partner account aangemaakt — maar email kon niet verstuurd worden. Initieer een password-reset via user-management.',
    }, corsHeaders);
  } catch (err) {
    return json(500, { error: (err as Error).message || 'Onbekende fout' }, corsHeaders);
  }
});

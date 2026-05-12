// =========================================================================
// send-notification-email (v4)
// Triggered by pg-trigger trg_dispatch_notification_email via pg_net.
// - Respects notification_preferences.email (per user, per event_type)
// - Sends branded email via Resend
// - Marks notifications.email_sent = true on success
// - v4: recipient-lookup includeert nu ook admin-users (admins monitoren alle partners).
//        notification_preferences blijft per-user gate, dus admin moet event_type op email=true hebben.
// =========================================================================

import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

interface Payload { notification_id: string }
interface Notification {
  id: string;
  partner_id: string;
  user_id: string | null;
  type: string;
  title: string;
  body: string | null;
  link_url: string | null;
  email_sent: boolean;
  created_at: string;
}
interface Partner { id: string; bedrijfsnaam: string | null; naam: string | null; logo_url: string | null; kleur_primair: string | null; kleur_donker: string | null; website: string | null; }

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const RESEND_KEY   = Deno.env.get('RESEND_API_KEY') ?? '';
const FROM_DEFAULT = Deno.env.get('EMAIL_FROM_ADDRESS') ?? 'Flancco Platform <noreply@flancco-platform.be>';
const REPLY_TO     = Deno.env.get('EMAIL_REPLY_TO')      ?? 'gillian.geernaert@flancco.be';
const APP_BASE_URL = (Deno.env.get('APP_BASE_URL') ?? 'https://app.flancco-platform.be/').replace(/\/?$/, '/');

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

function json(status: number, body: unknown, corsHeaders: Record<string, string>) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

function esc(s: string | null | undefined): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

function buildEmailHTML(notif: Notification, partner: Partner): string {
  const primary = partner.kleur_primair || '#098979';
  const dark    = partner.kleur_donker  || '#1A1A2E';
  const brand   = partner.bedrijfsnaam || partner.naam || 'Flancco';
  const logoTag = partner.logo_url
    ? `<img src="${esc(partner.logo_url)}" alt="${esc(brand)}" style="max-height:44px;max-width:160px;object-fit:contain;display:block">`
    : `<div style="font-size:20px;font-weight:700;color:#ffffff;letter-spacing:-0.3px">${esc(brand)}</div>`;

  const cta = notif.link_url ? `${APP_BASE_URL}${notif.link_url.startsWith('/') ? notif.link_url.slice(1) : notif.link_url}` : APP_BASE_URL;

  return `<!doctype html>
<html lang="nl">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(notif.title)}</title></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1A1A2E">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f3f4f6;padding:24px 12px">
    <tr><td align="center">
      <table role="presentation" width="560" cellspacing="0" cellpadding="0" style="max-width:560px;width:100%;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 4px 18px rgba(0,0,0,0.06)">
        <tr><td style="background:${esc(dark)};padding:22px 28px">${logoTag}</td></tr>
        <tr><td style="padding:32px 28px 12px">
          <div style="font-size:11px;font-weight:600;color:${esc(primary)};letter-spacing:0.5px;text-transform:uppercase;margin-bottom:8px">Notificatie</div>
          <h1 style="margin:0 0 12px;font-size:22px;line-height:1.3;color:#1A1A2E;font-weight:700">${esc(notif.title)}</h1>
          ${notif.body ? `<p style="margin:0 0 24px;font-size:15px;line-height:1.6;color:#4B5563">${esc(notif.body)}</p>` : ''}
          <a href="${esc(cta)}" style="display:inline-block;background:${esc(primary)};color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:8px;font-size:14px;font-weight:600">Open platform</a>
        </td></tr>
        <tr><td style="padding:24px 28px 28px;border-top:1px solid #e5e7eb;font-size:12px;color:#9ca3af;line-height:1.6">
          Je ontvangt deze email omdat je email-alerts hebt aangezet voor <strong>${esc(notif.type.replace(/_/g,' '))}</strong>.
          <br>Voorkeuren aanpassen via Instellingen &gt; Notificaties.
        </td></tr>
      </table>
      <div style="font-size:11px;color:#9ca3af;margin-top:12px">${esc(brand)}${partner.website ? ` &middot; <a href="${esc(partner.website)}" style="color:#6b7280">${esc(partner.website.replace(/^https?:\/\//,''))}</a>` : ''}</div>
    </td></tr>
  </table>
</body></html>`;
}

Deno.serve(async (req: Request) => {
  const corsHeaders = corsFor(req);

  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json(405, { error: 'method not allowed' }, corsHeaders);

  if (!SUPABASE_URL || !SERVICE_KEY) return json(500, { error: 'supabase env missing' }, corsHeaders);

  let payload: Payload;
  try { payload = await req.json() as Payload; } catch { return json(400, { error: 'invalid json' }, corsHeaders); }
  if (!payload.notification_id) return json(400, { error: 'notification_id required' }, corsHeaders);

  const sb = createClient(SUPABASE_URL, SERVICE_KEY);

  const { data: notif, error: nErr } = await sb.from('notifications').select('*').eq('id', payload.notification_id).single();
  if (nErr || !notif) return json(404, { error: 'notification not found', detail: nErr?.message }, corsHeaders);
  if (notif.email_sent) return json(200, { skipped: 'already_sent' }, corsHeaders);

  // Recipient-lookup: partner-role users onder deze partner + alle admin-users (admins monitoren alles).
  let recipientUserIds: string[] = [];
  if (notif.user_id) {
    recipientUserIds = [notif.user_id];
  } else {
    const ids = new Set<string>();
    const { data: partnerRoles } = await sb
      .from('user_roles')
      .select('user_id')
      .eq('partner_id', notif.partner_id)
      .eq('role', 'partner');
    (partnerRoles ?? []).forEach((r: { user_id: string }) => { if (r.user_id) ids.add(r.user_id); });
    const { data: adminRoles } = await sb
      .from('user_roles')
      .select('user_id')
      .eq('role', 'admin');
    (adminRoles ?? []).forEach((r: { user_id: string }) => { if (r.user_id) ids.add(r.user_id); });
    recipientUserIds = Array.from(ids);
  }
  if (recipientUserIds.length === 0) return json(200, { skipped: 'no_recipients' }, corsHeaders);

  const { data: prefs } = await sb
    .from('notification_preferences')
    .select('user_id, email')
    .in('user_id', recipientUserIds)
    .eq('event_type', notif.type)
    .eq('email', true);
  const optedIn = new Set((prefs ?? []).map((p: { user_id: string }) => p.user_id));
  const sendTo = recipientUserIds.filter((u) => optedIn.has(u));
  if (sendTo.length === 0) {
    await sb.from('notifications').update({ email_sent: true }).eq('id', notif.id);
    return json(200, { skipped: 'no_opt_in', checked_users: recipientUserIds.length }, corsHeaders);
  }

  const { data: partner } = await sb.from('partners').select('id,bedrijfsnaam,naam,logo_url,kleur_primair,kleur_donker,website').eq('id', notif.partner_id).single();
  if (!partner) return json(404, { error: 'partner not found' }, corsHeaders);

  const emails: { email: string; user_id: string }[] = [];
  for (const uid of sendTo) {
    const { data: userResp } = await sb.auth.admin.getUserById(uid);
    const email = userResp?.user?.email;
    if (email) emails.push({ email, user_id: uid });
  }
  if (emails.length === 0) {
    await sb.from('notifications').update({ email_sent: true }).eq('id', notif.id);
    return json(200, { skipped: 'no_emails' }, corsHeaders);
  }

  if (!RESEND_KEY) {
    await sb.from('notifications').update({ email_sent: true }).eq('id', notif.id);
    return json(200, { skipped: 'resend_not_configured' }, corsHeaders);
  }

  const html = buildEmailHTML(notif as Notification, partner as Partner);
  const subject = notif.title;

  const results: unknown[] = [];
  for (const { email } of emails) {
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${RESEND_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ from: FROM_DEFAULT, reply_to: [REPLY_TO], to: [email], subject, html }),
      });
      const out = await res.json().catch(() => ({}));
      results.push({ email, ok: res.ok, status: res.status, detail: out });
    } catch (e) {
      results.push({ email, ok: false, error: (e as Error).message });
    }
  }

  await sb.from('notifications').update({ email_sent: true }).eq('id', notif.id);

  // Strip per-recipient Resend detail uit response — vermijdt leak van provider-error-bodies + adressen.
  const sent_count = results.filter((r) => !!(r as { ok?: boolean })?.ok).length;
  const failed_count = results.length - sent_count;
  return json(200, { sent_count, failed_count }, corsHeaders);
});

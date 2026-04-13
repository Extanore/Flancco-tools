import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const resendApiKey = Deno.env.get("RESEND_API_KEY");

    // Verify JWT from request
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Niet geautoriseerd" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Create service client for DB access
    const sb = createClient(supabaseUrl, supabaseServiceKey);

    // Verify user role (admin or partner)
    const anonClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!);
    const { data: { user }, error: authError } = await anonClient.auth.getUser(
      authHeader.replace("Bearer ", "")
    );
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Ongeldige sessie" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: role } = await sb
      .from("user_roles")
      .select("role, partner_id")
      .eq("user_id", user.id)
      .single();

    if (!role || (role.role !== "admin" && role.role !== "partner")) {
      return new Response(JSON.stringify({ error: "Geen toegang" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Get contract_id from body
    const { contract_id } = await req.json();
    if (!contract_id) {
      return new Response(JSON.stringify({ error: "contract_id vereist" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Fetch contract + partner
    const { data: contract, error: cErr } = await sb
      .from("contracten")
      .select("*, partners(*)")
      .eq("id", contract_id)
      .single();

    if (cErr || !contract) {
      return new Response(JSON.stringify({ error: "Contract niet gevonden" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Partner can only send their own contracts
    if (role.role === "partner" && contract.partner_id !== role.partner_id) {
      return new Response(JSON.stringify({ error: "Geen toegang tot dit contract" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!contract.klant_email) {
      return new Response(JSON.stringify({ error: "Klant heeft geen emailadres" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const partner = contract.partners;
    const tekenUrl = `https://extanore.github.io/Flancco-tools/calculator/?contract=${contract.teken_token}`;

    // Parse sectoren for summary
    let sectorenHtml = "";
    try {
      const sectoren = typeof contract.sectoren === "string"
        ? JSON.parse(contract.sectoren)
        : contract.sectoren || [];
      const sectorLabels: Record<string, string> = {
        zon: "Zonnepanelen",
        warmtepomp: "Warmtepomp",
        ventilatie: "Ventilatie",
        verwarming: "Verwarming",
      };
      sectorenHtml = sectoren
        .map((s: any) => `<li>${sectorLabels[s.sector] || s.sector}</li>`)
        .join("");
    } catch {
      sectorenHtml = "<li>Onderhoudsdiensten</li>";
    }

    const totaal = contract.totaal_incl_btw
      ? `€ ${Number(contract.totaal_incl_btw).toFixed(2).replace(".", ",")}`
      : "Zie contract";

    const primaryColor = partner?.kleur_primair || "#1A1A2E";

    // Build email HTML
    const emailHtml = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;margin-top:32px;margin-bottom:32px;">
    <tr>
      <td style="background:${primaryColor};padding:32px;text-align:center;">
        ${partner?.logo_url ? `<img src="${partner.logo_url}" alt="${partner?.naam}" style="max-height:60px;margin-bottom:12px;">` : ""}
        <h1 style="color:#fff;margin:0;font-size:22px;">${partner?.naam || "Flancco"}</h1>
      </td>
    </tr>
    <tr>
      <td style="padding:32px;">
        <h2 style="color:#1a1a2e;margin-top:0;">Uw onderhoudscontract ter ondertekening</h2>
        <p>Beste ${contract.klant_naam || "klant"},</p>
        <p>${partner?.naam || "Uw installateur"} heeft een onderhoudscontract voor u opgesteld. Hieronder vindt u een beknopt overzicht:</p>

        <table style="width:100%;background:#f8f9fa;border-radius:8px;padding:16px;margin:20px 0;">
          <tr><td style="padding:8px;">
            <strong>Diensten:</strong>
            <ul style="margin:8px 0;padding-left:20px;">${sectorenHtml}</ul>
          </td></tr>
          <tr><td style="padding:8px;">
            <strong>Frequentie:</strong> ${contract.frequentie || "Jaarlijks"}
          </td></tr>
          <tr><td style="padding:8px;">
            <strong>Totaal per beurt incl. BTW:</strong> ${totaal}
          </td></tr>
        </table>

        <p style="text-align:center;margin:32px 0;">
          <a href="${tekenUrl}" style="display:inline-block;background:${primaryColor};color:#fff;padding:16px 40px;border-radius:8px;text-decoration:none;font-size:16px;font-weight:600;">
            Bekijk &amp; teken uw contract
          </a>
        </p>

        <p style="color:#666;font-size:13px;">Deze link is uniek voor u en kan eenmalig worden gebruikt om het contract te ondertekenen.</p>

        <hr style="border:none;border-top:1px solid #eee;margin:24px 0;">
        <p style="color:#888;font-size:13px;">
          ${partner?.naam || "Flancco"}<br>
          ${partner?.contact_email ? `${partner.contact_email}<br>` : ""}
          ${partner?.contact_telefoon ? `${partner.contact_telefoon}<br>` : ""}
          ${partner?.website ? `${partner.website}` : ""}
        </p>
      </td>
    </tr>
  </table>
</body>
</html>`;

    // Send email via Resend
    if (!resendApiKey) {
      // If no Resend key, just update verzonden_op and return success with warning
      await sb.from("contracten").update({ verzonden_op: new Date().toISOString() }).eq("id", contract_id);
      return new Response(
        JSON.stringify({
          success: true,
          warning: "RESEND_API_KEY niet geconfigureerd — email niet verzonden, maar contract gemarkeerd als verzonden.",
          teken_url: tekenUrl,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const emailRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: `${partner?.naam || "Flancco"} <contracts@flancco.be>`,
        to: [contract.klant_email],
        subject: `Uw onderhoudscontract van ${partner?.naam || "Flancco"} ter ondertekening`,
        html: emailHtml,
      }),
    });

    if (!emailRes.ok) {
      const errBody = await emailRes.text();
      return new Response(
        JSON.stringify({ error: "Email verzenden mislukt", details: errBody }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Update contract: verzonden_op
    await sb.from("contracten").update({ verzonden_op: new Date().toISOString() }).eq("id", contract_id);

    return new Response(
      JSON.stringify({ success: true, message: "Email verzonden naar " + contract.klant_email }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: "Server fout", details: String(err) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

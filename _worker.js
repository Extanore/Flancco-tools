// =============================================================
// Flancco platform — Workers Assets entry-script
// =============================================================
// Host-based routing zodat één Worker meerdere subdomains dekt:
//
//   app.flancco-platform.be         → /onboard/ als default root (publieke wizard)
//   app.flancco-platform.be/admin/  → admin-portaal (directe URL voor ingelogden)
//   calculator.flancco-platform.be  → /calculator/ als default root
//   flancco-platform.be (apex)      → 301 naar app.*
//   www.flancco-platform.be         → 301 naar app.*
//   *.workers.dev (dev-URL)         → pass-through, pad bepaalt app
//
// Cloudflare Workers Assets auto-detecteert een file _worker.js in de
// assets-root als entry-script; hij wordt NIET als statisch bestand
// geserveerd. De ASSETS-binding staat in wrangler.jsonc.

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const host = url.hostname.toLowerCase();
    const path = url.pathname;

    // --- Apex + www → canonical app-subdomain (HSTS-preload ready)
    if (host === "flancco-platform.be" || host === "www.flancco-platform.be") {
      const target = new URL(url);
      target.hostname = "app.flancco-platform.be";
      return Response.redirect(target.toString(), 301);
    }

    // --- app.flancco-platform.be → publieke onboarding-wizard als root
    // Admins komen rechtstreeks via /admin/ binnen (bookmark of "Inloggen"-CTA op /onboard/).
    // Prospects landen op /onboard/ — daar staat de "Reeds partner? Inloggen"-knop voor admins
    // die de root via een gedeelde link bezoeken.
    if (host === "app.flancco-platform.be") {
      if (path === "/" || path === "") {
        // Preserve query-string (vb. ?lang=fr, ?utm=...) bij root-redirect
        return Response.redirect(
          "https://app.flancco-platform.be/onboard/" + url.search,
          302,
        );
      }
      return env.ASSETS.fetch(request);
    }

    // --- calculator.flancco-platform.be → publieke calculator host
    if (host === "calculator.flancco-platform.be") {
      if (path === "/" || path === "") {
        // Preserve query-string (vb. ?contract=<token>, ?partner=<slug>) bij root-redirect.
        // Zonder deze preservatie zouden tekenlinks na 302-hop naar /calculator/ de token
        // kwijt zijn → "Partner niet gevonden"-error.
        return Response.redirect(
          "https://calculator.flancco-platform.be/calculator/" + url.search,
          302,
        );
      }
      return env.ASSETS.fetch(request);
    }

    // --- Fallback: Workers dev-URL, CF-preview-URLs, directe IP-access
    // Geen host-rewrite; serveer alles wat er staat via asset-binding.
    return env.ASSETS.fetch(request);
  },
};

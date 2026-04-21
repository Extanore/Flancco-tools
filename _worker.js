// =============================================================
// Flancco platform — Workers Assets entry-script
// =============================================================
// Host-based routing zodat één Worker meerdere subdomains dekt:
//
//   app.flancco-platform.be         → /admin/ als default root
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

    // --- app.flancco-platform.be → admin + portal host
    if (host === "app.flancco-platform.be") {
      if (path === "/" || path === "") {
        return Response.redirect("https://app.flancco-platform.be/admin/", 302);
      }
      return env.ASSETS.fetch(request);
    }

    // --- calculator.flancco-platform.be → publieke calculator host
    if (host === "calculator.flancco-platform.be") {
      if (path === "/" || path === "") {
        return Response.redirect(
          "https://calculator.flancco-platform.be/calculator/",
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

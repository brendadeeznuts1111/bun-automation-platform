// Sitemap XML route — lists all public GET routes with metadata.
//
// Ref: https://www.sitemaps.org/protocol.html
// Ref: https://bun.com/docs/runtime/http/routing

import type { BunRequest } from "bun";
import { router } from "./router";
import { withMiddleware } from "./shared";

// --- Routes object reference (set by server.ts) ----------------------------

let routesRef: Record<string, unknown> = {};

/** Called by server.ts so the sitemap can enumerate routes. */
export function setSitemapRoutesRef(ref: Record<string, unknown>): void {
  routesRef = ref;
}

// --- Handler ----------------------------------------------------------------

function sitemapHandler(req: BunRequest): Response {
  const url = new URL(req.url);
  const base = `${url.protocol}//${url.host}`;
  const lastmod = new Date().toISOString();

  // Route metadata — priority and changefreq per route pattern
  // Ref: https://www.sitemaps.org/protocol.html#xmlTagDefinitions
  const routeMeta: Record<string, { priority: number; changefreq: string }> = {
    "/health": { priority: 0.9, changefreq: "always" },
    "/metrics": { priority: 0.8, changefreq: "always" },
    "/dashboard": { priority: 1.0, changefreq: "hourly" },
    "/manifest.json": { priority: 0.6, changefreq: "weekly" },
    "/sw.js": { priority: 0.4, changefreq: "monthly" },
    "/features": { priority: 0.7, changefreq: "daily" },
    "/protocol": { priority: 0.5, changefreq: "weekly" },
    "/api/openapi.json": { priority: 0.8, changefreq: "daily" },
    "/api/semver": { priority: 0.6, changefreq: "weekly" },
    "/api/pwa/validate": { priority: 0.5, changefreq: "weekly" },
    "/api/pwa/compare": { priority: 0.4, changefreq: "weekly" },
    "/api/diagrams": { priority: 0.5, changefreq: "weekly" },
    "/api/config": { priority: 0.4, changefreq: "weekly" },
    "/api/ffi": { priority: 0.3, changefreq: "monthly" },
    "/api/hash": { priority: 0.3, changefreq: "monthly" },
    "/api/transpile": { priority: 0.4, changefreq: "weekly" },
    "/api/compress": { priority: 0.3, changefreq: "monthly" },
    "/api/utils": { priority: 0.3, changefreq: "monthly" },
    "/api/redis": { priority: 0.3, changefreq: "monthly" },
  };

  // Auth-required routes get lower priority
  const authRoutes = new Set([
    "/tasks",
    "/sessions",
    "/api/tasks.jsonl",
    "/api/sessions.jsonl",
    "/api/audit.jsonl",
    "/api/audit/stream",
    "/api/export/bundle.tar",
    "/api/s3/backup",
    "/api/logs",
    "/api/processes",
    "/api/fs",
    "/api/runtime",
    "/api/sql",
    "/api/image",
    "/api/screenshot",
    "/api/mermaid",
  ]);

  // Only advertise routes a crawler can actually GET. Previously POST-only
  // routes were listed, so crawlers fetched them and got 404/405.
  // /bun-com/* is an internal comparison snapshot and is deliberately excluded.
  const paths = Object.entries(routesRef)
    .filter(([p, handlers]) => {
      if (p.includes(":") || p === "/sitemap.xml" || p.startsWith("/bun-com/")) return false;
      // JUSTIFIED: routes is Record<string, unknown>; narrowing to the method map
      return Boolean((handlers as { GET?: unknown }).GET);
    })
    .map(([p]) => p);

  const urls = paths
    .map((p) => {
      const meta = routeMeta[p] ?? {
        priority: authRoutes.has(p) ? 0.3 : 0.5,
        changefreq: authRoutes.has(p) ? "hourly" : "weekly",
      };
      return `  <url>
    <loc>${base}${p}</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>${meta.changefreq}</changefreq>
    <priority>${meta.priority.toFixed(1)}</priority>
  </url>`;
    })
    .join("\n");

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>`;

  return new Response(xml, {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
      "X-Sitemap-Route-Count": paths.length.toString(),
    },
  });
}

// --- Route exports ---------------------------------------------------------

export const sitemapRoutes = router({
  "/sitemap.xml": { GET: withMiddleware(sitemapHandler) },
});

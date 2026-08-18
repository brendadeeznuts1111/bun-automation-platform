// Dashboard HTML route — dev-only status page.
//
// The HTML template lives in src/views/dashboard.html (imported as text with
// HMR support). Dynamic values are injected via string replacement on
// {{placeholder}} tokens. HTMLRewriter handles CSP nonce and feature flag
// injection per-request.
//
// Ref: https://bun.com/docs/runtime/http/routing
// Ref: node_modules/bun-types/docs/guides/runtime/import-html.mdx
// Ref: node_modules/bun-types/docs/runtime/html-rewriter.mdx

import { listFeatures } from "../features/registry";
// Import the HTML template as a text string.
// With `with { type: "text" }`, Bun reloads the file on change (HMR in --hot mode).
// JUSTIFIED: Bun types HTML imports as HTMLBundle, but `with { type: "text" }`
// returns a plain string per docs/guides/runtime/import-html.mdx
import dashboardBundle from "../views/dashboard.html" with { type: "text" };
import { getPoolStatus } from "../workers/pool";
import { router } from "./router";
import { withMiddleware } from "./shared";

const dashboardHtml = dashboardBundle as unknown as string;

// --- Feature flag config (set by server.ts) --------------------------------

export interface DashboardConfig {
  ENABLE_PWA: boolean;
  ENABLE_TLS: boolean;
  ENABLE_HTTP3: boolean;
  ENABLE_SITEMAP: boolean;
  ENABLE_HTML_REWRITER: boolean;
  NODE_ENV: string;
}

let config: DashboardConfig = {
  ENABLE_PWA: false,
  ENABLE_TLS: false,
  ENABLE_HTTP3: false,
  ENABLE_SITEMAP: false,
  ENABLE_HTML_REWRITER: false,
  NODE_ENV: "development",
};

/** Called by server.ts to pass feature flags. */
export function setDashboardConfig(cfg: DashboardConfig): void {
  config = cfg;
}

// --- PWA link tags (injected into <head> when PWA is enabled) ---------------

const PWA_LINKS = `<link rel="manifest" href="/manifest.json">
  <link rel="icon" type="image/png" sizes="128x128" href="/icons/icon-128.png">
  <link rel="apple-touch-icon" sizes="180x180" href="/icons/apple-touch-icon.png">
  <meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)">
  <meta name="theme-color" content="#1f2020" media="(prefers-color-scheme: dark)">
  <meta name="msapplication-TileColor" content="#1f2020">`;

// --- Handler ---------------------------------------------------------------

const dashboardHandler = withMiddleware((): Response => {
  const pool = getPoolStatus();
  const features = listFeatures()
    .map(
      (f) =>
        `<tr><td>${f.key}</td><td>${f.status}</td><td>${f.active ? "✅ active" : f.blocked ? "⚠️ blocked" : "❌ off"}</td><td>${f.description}</td></tr>`,
    )
    .join("\n");

  // Build the PWA link tags (empty string when PWA is disabled)
  const pwaLinks = config.ENABLE_PWA ? PWA_LINKS : "";

  // Replace all {{placeholder}} tokens with dynamic values
  let html = dashboardHtml
    .replaceAll("{{PWA_LINKS}}", pwaLinks)
    .replaceAll(
      "{{DEV_FEATURES_BUTTON}}",
      config.NODE_ENV === "development" ? '<button id="nav-features" onclick="fetchFeatures()">Features</button>' : "",
    )
    .replaceAll(
      "{{PWA_INSTALL_BUTTON}}",
      config.ENABLE_PWA
        ? '<button class="pwa-install" id="pwa-install-btn" onclick="installPWA()">Install App</button>'
        : "",
    )
    .replaceAll("{{BUN_VERSION}}", Bun.version)
    .replaceAll(
      "{{PWA_SW_BADGE}}",
      config.ENABLE_PWA ? '<span class="sw-badge" id="sw-status">SW: checking...</span>' : "",
    )
    .replaceAll("{{NODE_ENV}}", config.NODE_ENV)
    .replaceAll("{{TLS_CLASS}}", config.ENABLE_TLS ? "" : "err")
    .replaceAll("{{TLS_STATUS}}", config.ENABLE_TLS ? "Enabled" : "Off")
    .replaceAll("{{HTTP3_CLASS}}", config.ENABLE_HTTP3 ? "" : "warn")
    .replaceAll("{{HTTP3_STATUS}}", config.ENABLE_HTTP3 ? "Enabled" : "Off")
    .replaceAll("{{POOL_IDLE}}", String(pool.idle))
    .replaceAll("{{POOL_TOTAL}}", String(pool.total))
    .replaceAll("{{UPTIME}}", String(Math.floor(process.uptime())))
    .replaceAll("{{PWA_CLASS}}", config.ENABLE_PWA ? "" : "warn")
    .replaceAll("{{PWA_STATUS}}", config.ENABLE_PWA ? "Enabled" : "Off")
    .replaceAll("{{FEATURES_TABLE}}", features)
    .replaceAll(
      "{{SITEMAP_API_ROW}}",
      config.ENABLE_SITEMAP
        ? '<div class="api-row"><a href="/sitemap.xml" class="api-method api-get">GET</a><span class="api-path">/sitemap.xml</span><span class="api-desc">sitemap with priority + changefreq metadata</span></div>'
        : "",
    );

  // Handle PWA conditional sections: when PWA is enabled, remove the markers
  // (keeping the content). When disabled, remove everything between them.
  if (config.ENABLE_PWA) {
    html = html.replaceAll("{{PWA_SECTIONS_START}}", "").replaceAll("{{PWA_SECTIONS_END}}", "");
  } else {
    // Remove everything between PWA_SECTIONS markers (including markers)
    html = html.replace(/\{\{PWA_SECTIONS_START\}\}[\s\S]*?\{\{PWA_SECTIONS_END\}\}/g, "");
  }

  let response = new Response(html, { headers: { "Content-Type": "text/html" } });

  // HTMLRewriter: dynamically inject theme-color meta, feature-flag script,
  // CSP nonce attributes, and a data-rewritten attribute into the dashboard HTML.
  // Ref: node_modules/bun-types/docs/runtime/html-rewriter.mdx
  // Ref: node_modules/bun-types/docs/runtime/color.mdx — Bun.color normalizes the input
  if (config.ENABLE_HTML_REWRITER) {
    const activeFlags = listFeatures()
      .filter((f) => f.active)
      .map((f) => `'${f.key}': true`)
      .join(",");
    // Generate per-request CSP nonce using Bun.CryptoHasher
    // Ref: node_modules/bun-types/docs/runtime/hashing.mdx
    const nonce = Bun.CryptoHasher.hash("sha256", crypto.randomUUID() + process.uptime(), "hex").slice(0, 32);
    const flagScript = `<script nonce="${nonce}">window.__FEATURE_FLAGS__ = {${activeFlags}};</script>`;
    // Use Bun.color to normalize the theme color to a CSS-compatible hex string.
    // In production, use black; in development, use the Dracula green (#50fa7b).
    const rawThemeColor = config.NODE_ENV === "production" ? "#000000" : "#50fa7b";
    const themeColor = Bun.color(rawThemeColor, "css") ?? rawThemeColor;
    response = new HTMLRewriter()
      .on("head", {
        element(el) {
          // Inject theme-color meta based on environment
          el.append(`<meta name="theme-color" content="${themeColor}">`, { html: true });
          // Inject feature flags as a client-side global (with CSP nonce)
          el.append(flagScript, { html: true });
        },
      })
      .on("script", {
        element(el) {
          // Add nonce to all existing <script> tags for CSP compliance
          if (!el.getAttribute("nonce")) {
            el.setAttribute("nonce", nonce);
          }
        },
      })
      .on("body", {
        element(el) {
          el.setAttribute("data-html-rewritten", "true");
        },
      })
      .transform(response);
    // Add Content-Security-Policy header with nonce
    const csp = `default-src 'self'; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; manifest-src 'self';`;
    const headers = new Headers(response.headers);
    headers.set("Content-Security-Policy", csp);
    response = new Response(response.body, { status: response.status, headers });
  }

  return response;
});

// --- Route exports ---------------------------------------------------------

export const dashboardRoutes = router({
  "/dashboard": { GET: dashboardHandler },
});

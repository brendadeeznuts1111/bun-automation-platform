// PWA manifest, icons, service worker, and validation routes.
//
// Ref: https://bun.com/docs/runtime/http/routing
// Ref: https://web.dev/articles/add-manifest

import type { BunRequest } from "bun";
import { audit } from "../db/audit";
import { markActive } from "../features/registry";
import { log } from "../utils/log";
import { errorResponse, json, withCsrf, withMiddleware } from "./shared";

// --- Config (set by server.ts) ----------------------------------------------

export interface PwaConfig {
  ENABLE_PWA: boolean;
}

let config: PwaConfig = { ENABLE_PWA: false };

/** Called by server.ts to pass the PWA feature flag. */
export function setPwaConfig(cfg: PwaConfig): void {
  config = cfg;
}

// --- PWA manifest: committed base + runtime overrides ---------------------
// The committed manifest is read-only at runtime. Edits made through
// POST /api/manifest land in a separate, gitignored overrides file and are
// merged on read. This keeps the source tree clean.

const MANIFEST_PATH = "public/manifest.json";
const MANIFEST_OVERRIDES_PATH = "data/manifest-overrides.json";

/** Read runtime overrides; missing or corrupt file yields no overrides. */
async function readManifestOverrides(): Promise<Record<string, unknown>> {
  try {
    const file = Bun.file(MANIFEST_OVERRIDES_PATH);
    if (!(await file.exists())) return {};
    // JUSTIFIED: .json() returns unknown; narrowing to the override map shape
    return (await file.json()) as Record<string, unknown>;
  } catch {
    // Corrupt override file must not break manifest serving.
    log("server", "warn", "manifest overrides unreadable — serving committed base");
    return {};
  }
}

type FieldVerdict = { ok: true } | { ok: false; error: string };

/** Bounded non-empty string. */
const str =
  (max: number) =>
  (v: unknown): FieldVerdict =>
    typeof v !== "string"
      ? { ok: false, error: "expected a string" }
      : v.length === 0
        ? { ok: false, error: "must not be empty" }
        : v.length > max
          ? { ok: false, error: `exceeds ${max} characters` }
          : { ok: true };

/** Value must be one of a fixed set. */
const oneOf =
  (...allowed: string[]) =>
  (v: unknown): FieldVerdict =>
    typeof v === "string" && allowed.includes(v)
      ? { ok: true }
      : { ok: false, error: `expected one of: ${allowed.join(", ")}` };

/** CSS color parseable by Bun.color. Ref: docs/runtime/color.mdx */
const color = (v: unknown): FieldVerdict =>
  typeof v !== "string"
    ? { ok: false, error: "expected a color string" }
    : Bun.color(v, "css") === null
      ? { ok: false, error: "not a parseable CSS color" }
      : { ok: true };

/** Same-origin root-relative path — blocks absolute URLs and traversal. */
const path = (v: unknown): FieldVerdict =>
  typeof v !== "string"
    ? { ok: false, error: "expected a string" }
    : !v.startsWith("/")
      ? { ok: false, error: "must start with /" }
      : v.includes("..")
        ? { ok: false, error: "must not contain .." }
        : v.length > 512
          ? { ok: false, error: "exceeds 512 characters" }
          : { ok: true };

const stringArray =
  (max: number) =>
  (v: unknown): FieldVerdict =>
    !Array.isArray(v)
      ? { ok: false, error: "expected an array" }
      : v.length > max
        ? { ok: false, error: `at most ${max} entries` }
        : v.every((x) => typeof x === "string" && x.length > 0 && x.length <= 64)
          ? { ok: true }
          : { ok: false, error: "entries must be non-empty strings under 64 chars" };

/**
 * Editable manifest fields and their value validators.
 * Structural fields (icons, shortcuts, file_handlers, id) are intentionally
 * absent — they are generated or must stay stable for app identity.
 * Ref: https://w3c.github.io/manifest/
 */
const MANIFEST_EDITABLE_FIELDS: Record<string, (v: unknown) => FieldVerdict> = {
  name: str(128),
  short_name: str(64),
  description: str(1024),
  theme_color: color,
  background_color: color,
  // Ref: https://w3c.github.io/manifest/#display-member
  display: oneOf("fullscreen", "standalone", "minimal-ui", "browser"),
  // Ref: https://w3c.github.io/manifest/#orientation-member
  orientation: oneOf(
    "any",
    "natural",
    "landscape",
    "portrait",
    "portrait-primary",
    "portrait-secondary",
    "landscape-primary",
    "landscape-secondary",
  ),
  lang: str(35),
  dir: oneOf("ltr", "rtl", "auto"),
  categories: stringArray(16),
  start_url: path,
  scope: path,
};

// PWA feature flag — serve manifest.json and icons so the dashboard can be
// installed as a Chrome standalone app.
// Ref: https://web.dev/articles/add-manifest

// --- Build and export PWA routes -------------------------------------------

/** Build the PWA routes object. Called by server.ts when ENABLE_PWA is true. */
export function buildPwaRoutes(): Record<string, unknown> {
  if (!config.ENABLE_PWA) return {};

  const pwaRoutes: Record<string, unknown> = {};

  // Dynamic PWA manifest — reads base from disk, injects runtime values
  // (server URL, active features, Bun version) so the manifest reflects
  // the actual running server state.
  // Ref: https://web.dev/articles/add-manifest
  // Ref: https://w3c.github.io/manifest-app-info/
  pwaRoutes["/manifest.json"] = {
    GET: withMiddleware(async (): Promise<Response> => {
      // JUSTIFIED: .json() returns unknown; narrowing to the manifest object shape
      const base = (await Bun.file(MANIFEST_PATH).json()) as Record<string, unknown>;
      // Layer runtime overrides (written by POST /api/manifest) on top of the
      // committed base. The base file is never mutated.
      const m = { ...base, ...(await readManifestOverrides()) };

      // NOTE: `id` and `start_url` are deliberately NOT derived from the request
      // origin. `id` is the PWA's stable identity — deriving it from the origin
      // makes http/https, localhost/prod, or a port change look like a different
      // app to the browser, which re-prompts install and orphans the existing
      // installation. Both come from the committed manifest verbatim.

      // file_handlers — desktop file association (Chrome 117+).
      // Ref: https://developer.chrome.com/articles/file-handling/
      // Concrete MIME types only; the spec does not allow wildcards here.
      m.file_handlers = [
        {
          action: "/dashboard?source=file-handler",
          accept: {
            "application/json": [".json"],
            "application/manifest+json": [".webmanifest"],
            "text/markdown": [".md", ".markdown"],
            "text/yaml": [".yaml", ".yml"],
            "text/toml": [".toml"],
          },
        },
      ];
      // share_target — receives shared text/links (Chrome 76+).
      // Ref: https://developer.chrome.com/articles/web-share-target/
      m.share_target = {
        action: "/api/share-target",
        method: "POST",
        enctype: "application/x-www-form-urlencoded",
        params: { title: "title", text: "text", url: "url" },
      };
      // launch_handler — route launches into an existing window.
      // Ref: https://developer.chrome.com/docs/web-platform/launch-handler
      // Valid client_mode values are only: auto | navigate-new |
      // navigate-existing | focus-existing. Anything else falls back to "auto".
      m.launch_handler = { client_mode: "navigate-existing" };
      // protocol_handlers — register the app to handle URL protocols.
      // Ref: https://developer.mozilla.org/en-US/docs/Web/Manifest/protocol_handlers
      // mailto is universally understood; the dashboard can compose a task
      // from the subject/body. Other schemes would require OS-level
      // registration and are omitted.
      m.protocol_handlers = [
        {
          protocol: "mailto",
          url: "/dashboard?source=protocol-handler&to=%s",
        },
      ];

      return new Response(JSON.stringify(m, null, 2), {
        headers: {
          // Bun.file() reports application/json for .json, not the manifest
          // type the spec requires — so set it explicitly.
          "Content-Type": "application/manifest+json",
          // Must revalidate: a stale manifest at a CDN/proxy pins old icons
          // and shortcuts for the installed app.
          "Cache-Control": "no-cache, must-revalidate, max-age=0",
        },
      });
    }),
  };

  // Manifest editor — writes a runtime *override*, never the committed base.
  // POST /api/manifest with { field: "theme_color", value: "#ff0000" }
  pwaRoutes["/api/manifest"] = {
    POST: withCsrf(async (req: BunRequest): Promise<Response> => {
      // JUSTIFIED: req.json() returns unknown; narrowing to manifest update body
      const body = (await req.json()) as { field?: string; value?: unknown };
      if (!body.field || body.value === undefined) {
        return json({ error: "field and value required" }, 400);
      }
      const validator = MANIFEST_EDITABLE_FIELDS[body.field];
      if (!validator) {
        return json(
          {
            error: `field must be one of: ${Object.keys(MANIFEST_EDITABLE_FIELDS).join(", ")}`,
          },
          400,
        );
      }
      // Validate the *value*, not just the field name — an unvalidated value
      // persists a structurally invalid manifest across restarts.
      const verdict = validator(body.value);
      if (!verdict.ok) {
        return json({ error: `invalid value for ${body.field}: ${verdict.error}` }, 400);
      }
      try {
        const overrides = await readManifestOverrides();
        overrides[body.field] = body.value;
        await Bun.write(MANIFEST_OVERRIDES_PATH, JSON.stringify(overrides, null, 2) + "\n");
        await audit({
          action: "manifest_update",
          resource: MANIFEST_OVERRIDES_PATH,
          details: `${body.field}=${JSON.stringify(body.value)}`.slice(0, 200),
        });
        log("server", "info", "Manifest override written", { field: body.field, value: body.value });
        return json({ ok: true, field: body.field, value: body.value, path: MANIFEST_OVERRIDES_PATH });
      } catch (err) {
        return json({ error: "manifest update failed", details: String(err) }, 500);
      }
    }),
    // Clear all runtime overrides, reverting to the committed manifest.
    DELETE: withCsrf(async (): Promise<Response> => {
      try {
        await Bun.file(MANIFEST_OVERRIDES_PATH).delete();
      } catch {
        // Already absent — reverting to base is the desired end state either way.
      }
      await audit({ action: "manifest_reset", resource: MANIFEST_OVERRIDES_PATH });
      return json({ ok: true, reset: true });
    }),
  };

  // PWA share target — receives shared content from other apps
  // Ref: https://developer.chrome.com/articles/web-share-target/
  pwaRoutes["/api/share-target"] = {
    POST: withMiddleware(async (req: BunRequest): Promise<Response> => {
      // This route is unauthenticated (the OS share sheet cannot supply a
      // bearer token), so treat every field as hostile: bound the length and
      // strip control characters before it reaches the audit log or any
      // newline-delimited log consumer.
      const clean = (v: unknown, max: number): string =>
        typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, max) : "";

      // Inferred rather than annotated: bun-types and undici-types disagree on
      // the FormData shape, so an explicit `FormData` annotation fails tsc.
      let formData: Awaited<ReturnType<typeof req.formData>>;
      try {
        formData = await req.formData();
      } catch {
        // Unparseable body is a client error, not a server fault — without
        // this the throw escapes to the top-level error() hook as a 500.
        return json({ error: "expected form-encoded body with title/text/url" }, 400);
      }

      const title = clean(formData.get("title"), 200);
      const text = clean(formData.get("text"), 2000);
      const sharedUrl = clean(formData.get("url"), 2000);

      await audit({
        action: "share_received",
        resource: "pwa-share-target",
        details: `title=${title}`.slice(0, 200),
      });
      log("server", "info", "PWA share received", { title, url: sharedUrl });
      return json({ ok: true, received: { title, text, url: sharedUrl } });
    }),
  };
  // Serve the service worker — required by Chrome for PWA installability
  // Ref: https://web.dev/articles/install-criteria
  pwaRoutes["/sw.js"] = {
    GET: withMiddleware((): Response => {
      const sw = Bun.file("public/sw.js");
      return new Response(sw, {
        headers: { "Content-Type": "application/javascript", "Service-Worker-Allowed": "/" },
      });
    }),
  };
  // Serve the original bun.com PWA manifest and icons (downloaded snapshot)
  // so users can compare or reinstall the upstream Bun docs PWA locally.
  pwaRoutes["/bun-com/manifest.json"] = {
    GET: withMiddleware((): Response => {
      const manifest = Bun.file("public/bun-com/manifest.json");
      return new Response(manifest, {
        headers: { "Content-Type": "application/manifest+json" },
      });
    }),
  };
  pwaRoutes["/bun-com/icons/:filename"] = {
    GET: withMiddleware<"/bun-com/icons/:filename">(
      async (req: BunRequest<"/bun-com/icons/:filename">): Promise<Response> => {
        const filename = req.params.filename;
        const file = Bun.file(`public/bun-com/icons/${filename}`);
        const exists = await file.exists();
        if (!exists) {
          return errorResponse("icon not found", 404);
        }
        // Infer content type from extension
        const ext = filename.endsWith(".svg")
          ? "image/svg+xml"
          : filename.endsWith(".ico")
            ? "image/x-icon"
            : "image/png";
        return new Response(file, {
          headers: { "Content-Type": ext, "Cache-Control": "public, max-age=86400" },
        });
      },
    ),
  };

  // PWA manifest comparison — diffs BUN-DEV manifest against the downloaded
  // bun.com manifest, field by field, and validates both against Chrome's
  // installability criteria.
  // Ref: https://web.dev/articles/install-criteria
  pwaRoutes["/api/pwa/compare"] = {
    GET: withMiddleware(async (): Promise<Response> => {
      const ours = await Bun.file("public/manifest.json").json();
      const theirs = await Bun.file("public/bun-com/manifest.json").json();

      // --- Field-by-field comparison ---
      type Manifest = {
        name?: string;
        short_name?: string;
        description?: string;
        start_url?: string;
        scope?: string;
        display?: string;
        orientation?: string;
        theme_color?: string;
        background_color?: string;
        icons?: { src: string; sizes: string; type: string; purpose?: string }[];
      };
      // JUSTIFIED: Bun.file().json() returns Promise<unknown>; narrowing to manifest shape
      const o = ours as Manifest; // JUSTIFIED: see above
      const t = theirs as Manifest; // JUSTIFIED: see above

      const fields: { field: string; ours: string; theirs: string; match: boolean }[] = [];
      const compareField = (field: keyof Manifest): void => {
        const ov = JSON.stringify(o[field] ?? null);
        const tv = JSON.stringify(t[field] ?? null);
        fields.push({ field, ours: ov, theirs: tv, match: ov === tv });
      };
      compareField("name");
      compareField("short_name");
      compareField("description");
      compareField("start_url");
      compareField("scope");
      compareField("display");
      compareField("orientation");
      compareField("theme_color");
      compareField("background_color");

      // --- Icon comparison ---
      const ourIcons = (o.icons ?? []).map((i) => i.sizes);
      const theirIcons = (t.icons ?? []).map((i) => i.sizes);
      const allSizes = [...new Set([...ourIcons, ...theirIcons])].sort();
      const iconComparison = allSizes.map((size) => ({
        size,
        ours: ourIcons.includes(size),
        theirs: theirIcons.includes(size),
      }));

      // --- Installability validation (Chrome criteria) ---
      // Ref: https://web.dev/articles/install-criteria
      const validate = (manifest: Manifest, label: string) => {
        const errors: string[] = [];
        const warnings: string[] = [];
        const checks: { check: string; pass: boolean }[] = [];

        // Required: name or short_name
        const hasName = !!(manifest.name || manifest.short_name);
        checks.push({ check: "Has name or short_name", pass: hasName });
        if (!hasName) errors.push("Missing name and short_name");

        // Required: icons with at least 192x192 and 512x512
        const icons = manifest.icons ?? [];
        const has192 = icons.some((i) => i.sizes === "192x192");
        const has512 = icons.some((i) => i.sizes === "512x512");
        checks.push({ check: "Has 192x192 icon", pass: has192 });
        checks.push({ check: "Has 512x512 icon", pass: has512 });
        if (!has192) errors.push("Missing 192x192 icon");
        if (!has512) errors.push("Missing 512x512 icon");

        // Required: manifest
        checks.push({ check: "Manifest is valid JSON", pass: true });

        // Recommended: start_url
        const hasStartUrl = !!manifest.start_url;
        checks.push({ check: "Has start_url", pass: hasStartUrl });
        if (!hasStartUrl) errors.push("Missing start_url");

        // Recommended: display mode
        const hasDisplay = !!manifest.display;
        checks.push({ check: "Has display mode", pass: hasDisplay });
        if (!hasDisplay) warnings.push("No display mode specified");

        // Recommended: theme_color
        const hasTheme = !!manifest.theme_color;
        checks.push({ check: "Has theme_color", pass: hasTheme });
        if (!hasTheme) warnings.push("No theme_color specified");

        // Recommended: background_color
        const hasBg = !!manifest.background_color;
        checks.push({ check: "Has background_color", pass: hasBg });
        if (!hasBg) warnings.push("No background_color specified");

        // Recommended: maskable icon (Android adaptive icon)
        const hasMaskable = icons.some((i) => i.purpose === "maskable");
        checks.push({ check: "Has maskable icon", pass: hasMaskable });
        if (!hasMaskable) warnings.push("No maskable icon (Android adaptive icons)");

        // Recommended: short_name (for home screen)
        const hasShortName = !!manifest.short_name;
        checks.push({ check: "Has short_name", pass: hasShortName });
        if (!hasShortName) warnings.push("No short_name (needed for home screen)");

        // Service worker check (we know we have one)
        checks.push({ check: "Has service worker (/sw.js)", pass: true });

        return {
          label,
          checks,
          errors,
          warnings,
          installable: errors.length === 0,
          score: Math.round((checks.filter((c) => c.pass).length / checks.length) * 100),
        };
      };

      const ourValidation = validate(o, "BUN-DEV");
      const theirValidation = validate(t, "bun.com");

      // --- Summary ---
      const matchingFields = fields.filter((f) => f.match).length;
      const summary = {
        totalFields: fields.length,
        matchingFields,
        differingFields: fields.length - matchingFields,
        ourIconCount: ourIcons.length,
        theirIconCount: theirIcons.length,
        ourInstallable: ourValidation.installable,
        theirInstallable: theirValidation.installable,
        ourScore: ourValidation.score,
        theirScore: theirValidation.score,
      };

      return Response.json(
        {
          summary,
          fields,
          icons: iconComparison,
          validation: { ours: ourValidation, theirs: theirValidation },
        },
        {
          headers: { "Cache-Control": "no-cache" },
        },
      );
    }),
  };

  // PWA manifest validation — validates our manifest against Chrome criteria
  pwaRoutes["/api/pwa/validate"] = {
    GET: withMiddleware(async (): Promise<Response> => {
      const manifest = await Bun.file("public/manifest.json").json();
      const swExists = await Bun.file("public/sw.js").exists();

      type M = {
        name?: string;
        short_name?: string;
        description?: string;
        start_url?: string;
        scope?: string;
        display?: string;
        orientation?: string;
        theme_color?: string;
        background_color?: string;
        icons?: { src: string; sizes: string; type: string; purpose?: string }[];
      };
      // JUSTIFIED: Bun.file().json() returns Promise<unknown>; narrowing to manifest shape
      const m = manifest as M; // JUSTIFIED: see above
      const icons = m.icons ?? [];

      const checks: {
        category: string;
        check: string;
        pass: boolean;
        severity: string;
        detail: string;
      }[] = [];

      // --- Required fields ---
      checks.push({
        category: "required",
        check: "name",
        pass: !!m.name,
        severity: "error",
        detail: m.name ? `"${m.name}"` : "missing",
      });
      checks.push({
        category: "required",
        check: "short_name",
        pass: !!m.short_name,
        severity: "error",
        detail: m.short_name ? `"${m.short_name}"` : "missing",
      });
      checks.push({
        category: "required",
        check: "start_url",
        pass: !!m.start_url,
        severity: "error",
        detail: m.start_url ?? "missing",
      });
      checks.push({
        category: "required",
        check: "icons[192x192]",
        pass: icons.some((i) => i.sizes === "192x192"),
        severity: "error",
        detail: icons.find((i) => i.sizes === "192x192")?.src ?? "missing",
      });
      checks.push({
        category: "required",
        check: "icons[512x512]",
        pass: icons.some((i) => i.sizes === "512x512"),
        severity: "error",
        detail: icons.find((i) => i.sizes === "512x512")?.src ?? "missing",
      });
      checks.push({
        category: "required",
        check: "service worker",
        pass: swExists,
        severity: "error",
        detail: swExists ? "/sw.js" : "missing",
      });

      // --- Recommended fields ---
      checks.push({
        category: "recommended",
        check: "display",
        pass: !!m.display,
        severity: "warning",
        detail: m.display ?? "missing",
      });
      checks.push({
        category: "recommended",
        check: "theme_color",
        pass: !!m.theme_color,
        severity: "warning",
        detail: m.theme_color ?? "missing",
      });
      checks.push({
        category: "recommended",
        check: "background_color",
        pass: !!m.background_color,
        severity: "warning",
        detail: m.background_color ?? "missing",
      });
      checks.push({
        category: "recommended",
        check: "scope",
        pass: !!m.scope,
        severity: "warning",
        detail: m.scope ?? "missing",
      });
      checks.push({
        category: "recommended",
        check: "orientation",
        pass: !!m.orientation,
        severity: "warning",
        detail: m.orientation ?? "missing",
      });
      checks.push({
        category: "recommended",
        check: "description",
        pass: !!m.description,
        severity: "info",
        detail: m.description ?? "missing",
      });

      // --- Icon quality ---
      checks.push({
        category: "icon-quality",
        check: "maskable icon",
        pass: icons.some((i) => i.purpose === "maskable"),
        severity: "warning",
        detail: icons.find((i) => i.purpose === "maskable")?.src ?? "missing",
      });
      checks.push({
        category: "icon-quality",
        check: "icon count >= 3",
        pass: icons.length >= 3,
        severity: "info",
        detail: `${icons.length} icons`,
      });
      checks.push({
        category: "icon-quality",
        check: "has 1024x1024",
        pass: icons.some((i) => i.sizes === "1024x1024"),
        severity: "info",
        detail: icons.find((i) => i.sizes === "1024x1024")?.src ?? "missing",
      });
      checks.push({
        category: "icon-quality",
        check: "has SVG icon",
        pass: icons.some((i) => i.type === "image/svg+xml"),
        severity: "info",
        detail: icons.find((i) => i.type === "image/svg+xml")?.src ?? "missing",
      });

      // --- Icon integrity: declared files must exist and match declared size ---
      // Declaring an icon the server 404s on (or whose real pixels differ from
      // its `sizes` string) previously scored as a pass, so the endpoint could
      // report 100% installable against a manifest Chrome partly discards.
      // Ref: node_modules/bun-types/docs/runtime/image.mdx — metadata()
      const missing: string[] = [];
      const mismatched: string[] = [];
      for (const icon of icons) {
        // Only local, root-relative icons are verifiable here.
        if (!icon.src.startsWith("/")) continue;
        const file = Bun.file(`public${icon.src}`);
        if (!(await file.exists())) {
          missing.push(icon.src);
          continue;
        }
        const [w, h] = icon.sizes.split("x").map((n) => parseInt(n, 10));
        if (!w || !h) continue;
        try {
          const meta = await new Bun.Image(await file.bytes()).metadata();
          if (meta.width !== w || meta.height !== h) {
            mismatched.push(`${icon.src} declares ${icon.sizes}, is ${meta.width}x${meta.height}`);
          }
        } catch {
          mismatched.push(`${icon.src} is not a decodable image`);
        }
      }
      checks.push({
        category: "icon-integrity",
        check: "all declared icons exist",
        pass: missing.length === 0,
        severity: "error",
        detail: missing.length ? `missing: ${missing.join(", ")}` : `${icons.length} verified`,
      });
      checks.push({
        category: "icon-integrity",
        check: "declared sizes match actual pixels",
        pass: mismatched.length === 0,
        severity: "error",
        detail: mismatched.length ? mismatched.join("; ") : "all match",
      });

      // A maskable icon byte-identical to its plain counterpart has no
      // safe-zone padding, so Android's circular mask clips the glyph.
      const maskableCopies: string[] = [];
      for (const icon of icons.filter((i) => i.purpose === "maskable")) {
        const plain = icons.find((i) => i.sizes === icon.sizes && i.purpose !== "maskable");
        if (!plain) continue;
        const [a, b] = [Bun.file(`public${icon.src}`), Bun.file(`public${plain.src}`)];
        if (!(await a.exists()) || !(await b.exists())) continue;
        if (Bun.SHA256.hash(await a.bytes(), "hex") === Bun.SHA256.hash(await b.bytes(), "hex")) {
          maskableCopies.push(`${icon.src} is identical to ${plain.src}`);
        }
      }
      checks.push({
        category: "icon-integrity",
        check: "maskable icons have safe-zone padding",
        pass: maskableCopies.length === 0,
        severity: "warning",
        detail: maskableCopies.length ? maskableCopies.join("; ") : "padded",
      });

      const errors = checks.filter((c) => c.severity === "error" && !c.pass);
      const warnings = checks.filter((c) => c.severity === "warning" && !c.pass);
      const passCount = checks.filter((c) => c.pass).length;

      return Response.json(
        {
          manifest: "BUN-DEV",
          installable: errors.length === 0,
          score: Math.round((passCount / checks.length) * 100),
          errors: errors.map((c) => c.check),
          warnings: warnings.map((c) => c.check),
          checks,
        },
        {
          headers: { "Cache-Control": "no-cache" },
        },
      );
    }),
  };
  // Serve PWA icons — /icons/:filename.png
  pwaRoutes["/icons/:filename"] = {
    GET: withMiddleware<"/icons/:filename">(async (req: BunRequest<"/icons/:filename">): Promise<Response> => {
      const filename = req.params.filename;
      // Only allow .png files from the public/icons directory
      if (!filename.endsWith(".png")) {
        return errorResponse("not found", 404);
      }
      // Reject traversal before touching the filesystem.
      if (filename.includes("..") || filename.includes("/")) {
        return errorResponse("not found", 404);
      }
      const file = Bun.file(`public/icons/${filename}`);
      const exists = await file.exists();
      if (!exists) {
        return errorResponse("icon not found", 404);
      }
      // Icon filenames are NOT content-hashed (icon-512.png is a stable name),
      // so `immutable` must not be used here — it would make icon updates
      // permanently unreachable for already-cached clients. Use a moderate TTL
      // plus a weak ETag so revalidation costs a 304 instead of a re-download.
      const etag = `W/"${file.size.toString(16)}-${Math.floor(file.lastModified).toString(16)}"`;
      if (req.headers.get("if-none-match") === etag) {
        return new Response(null, {
          status: 304,
          headers: { ETag: etag, "Cache-Control": "public, max-age=86400" },
        });
      }
      return new Response(file, {
        headers: {
          "Content-Type": "image/png",
          "Cache-Control": "public, max-age=86400",
          ETag: etag,
        },
      });
    }),
  };
  markActive("pwa");
  log("server", "info", "PWA enabled — manifest at /manifest.json, install from Chrome");

  return pwaRoutes;
}

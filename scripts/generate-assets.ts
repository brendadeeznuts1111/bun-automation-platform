#!/usr/bin/env bun
/**
 * PWA asset generator — derives every manifest-declared image from the
 * largest source icon, using only Bun-native APIs (no sharp, no npm deps).
 *
 * Ref: node_modules/bun-types/docs/runtime/image.mdx — Bun.Image pipeline
 * Ref: node_modules/bun-types/docs/runtime/webview.mdx — Bun.WebView screenshot
 * Ref: https://w3c.github.io/manifest/#purpose-member — maskable safe zone
 *
 * Bun.Image has no `extend`/`composite`/`flatten` operation, so the maskable
 * variants (which need transparent-free padding so Android's circular mask
 * doesn't clip the glyph) are composited by rendering the source icon at 80%
 * on a solid background in a WebView and screenshotting it.
 *
 * Usage:
 *   bun run scripts/generate-assets.ts          # generate missing assets
 *   bun run scripts/generate-assets.ts --force  # regenerate everything
 *   bun run scripts/generate-assets.ts --check   # verify only, exit 1 if missing
 */

const ICONS_DIR = "public/icons";
const MASTER = `${ICONS_DIR}/icon-1024.png`;
/** Matches manifest background_color so the mask blends seamlessly. */
const BACKGROUND = "#1f2020";
/**
 * Fraction of the canvas the source icon occupies in a maskable variant.
 * The spec's safe zone is a circle of diameter 80% of the canvas; 80% linear
 * scaling keeps the glyph inside it for a full-bleed square source.
 */
const SAFE_ZONE_SCALE = 0.8;

/** Plain icon sizes declared in public/manifest.json. */
const ICON_SIZES = [16, 32, 48, 64, 96, 128, 192, 256, 512, 1024];
/** Maskable variants — need the safe-zone padding treatment. */
const MASKABLE_SIZES = [192, 512];
/** Apple ignores manifest icons; it reads apple-touch-icon and forces a crop. */
const APPLE_TOUCH_SIZE = 180;

const force = process.argv.includes("--force");
const checkOnly = process.argv.includes("--check");

interface Asset {
  path: string;
  kind: "icon" | "maskable" | "apple";
  size: number;
}

const assets: Asset[] = [
  ...ICON_SIZES.map((size): Asset => ({ path: `${ICONS_DIR}/icon-${size}.png`, kind: "icon", size })),
  ...MASKABLE_SIZES.map((size): Asset => ({ path: `${ICONS_DIR}/maskable-${size}.png`, kind: "maskable", size })),
  { path: `${ICONS_DIR}/apple-touch-icon.png`, kind: "apple", size: APPLE_TOUCH_SIZE },
];

/**
 * Composite the master icon at SAFE_ZONE_SCALE on a solid background.
 * Returns PNG bytes at `size`x`size`.
 */
async function renderMaskable(masterDataUrl: string, size: number): Promise<Uint8Array> {
  // Render at 512 then downscale — WebView screenshots below ~128px are unreliable.
  const canvas = Math.max(size, 512);
  const pct = SAFE_ZONE_SCALE * 100;
  const html = `<!DOCTYPE html><html><head><style>
html,body{margin:0;padding:0;width:${canvas}px;height:${canvas}px;background:${BACKGROUND};overflow:hidden}
body{display:grid;place-items:center}
img{width:${pct}%;height:${pct}%;display:block;image-rendering:auto}
</style></head><body><img src="${masterDataUrl}"></body></html>`;

  await using view = new Bun.WebView({ width: canvas, height: canvas });
  await view.navigate(`data:text/html,${encodeURIComponent(html)}`);
  // Give the renderer time to decode the embedded image and paint.
  await Bun.sleep(700);
  const shot = await view.screenshot();

  const bytes = new Uint8Array(await shot.arrayBuffer());
  if (canvas === size) return bytes;
  return await new Bun.Image(bytes).resize(size, size).png().bytes();
}

/** Verify every declared asset exists and its pixels match its declared size. */
async function verify(): Promise<{ ok: boolean; problems: string[] }> {
  const problems: string[] = [];
  for (const asset of assets) {
    const file = Bun.file(asset.path);
    if (!(await file.exists())) {
      problems.push(`missing: ${asset.path}`);
      continue;
    }
    const meta = await new Bun.Image(await file.bytes()).metadata();
    if (meta.width !== asset.size || meta.height !== asset.size) {
      problems.push(`${asset.path}: declared ${asset.size}x${asset.size}, actual ${meta.width}x${meta.height}`);
    }
  }
  // A maskable icon that is byte-identical to its plain counterpart has no
  // safe-zone padding — the mask will clip the glyph.
  for (const size of MASKABLE_SIZES) {
    const plain = Bun.file(`${ICONS_DIR}/icon-${size}.png`);
    const maskable = Bun.file(`${ICONS_DIR}/maskable-${size}.png`);
    if ((await plain.exists()) && (await maskable.exists())) {
      const a = Bun.SHA256.hash(await plain.bytes(), "hex");
      const b = Bun.SHA256.hash(await maskable.bytes(), "hex");
      if (a === b) problems.push(`maskable-${size}.png is identical to icon-${size}.png — no safe-zone padding`);
    }
  }
  return { ok: problems.length === 0, problems };
}

if (checkOnly) {
  const { ok, problems } = await verify();
  if (ok) {
    console.log(`✓ all ${assets.length} PWA assets present and correctly sized`);
    process.exit(0);
  }
  console.error("✗ PWA asset problems:");
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

const master = Bun.file(MASTER);
if (!(await master.exists())) {
  console.error(`✗ master icon not found: ${MASTER}`);
  process.exit(1);
}

const masterBytes = await master.bytes();
const masterMeta = await new Bun.Image(masterBytes).metadata();
console.log(`▶ master: ${MASTER} (${masterMeta.width}x${masterMeta.height} ${masterMeta.format})`);

// Data URL of the master, reused for every maskable render.
const masterDataUrl = await new Bun.Image(masterBytes).png().dataurl();

let generated = 0;
let skipped = 0;

for (const asset of assets) {
  const exists = await Bun.file(asset.path).exists();
  if (exists && !force) {
    // Regenerate a maskable that is just a copy of the plain icon, even
    // without --force: it's a latent defect, not a valid asset.
    const isFakeMaskable = asset.kind === "maskable" &&
      Bun.SHA256.hash(await Bun.file(asset.path).bytes(), "hex") ===
        Bun.SHA256.hash(await Bun.file(`${ICONS_DIR}/icon-${asset.size}.png`).bytes(), "hex");
    if (!isFakeMaskable) {
      skipped++;
      continue;
    }
    console.log(`  ! ${asset.path} has no safe-zone padding — regenerating`);
  }

  if (asset.kind === "maskable") {
    const bytes = await renderMaskable(masterDataUrl, asset.size);
    await Bun.write(asset.path, bytes);
  } else {
    // Plain icons and apple-touch-icon are straight downscales. The master is
    // full-bleed opaque, so apple-touch-icon needs no alpha flattening.
    await new Bun.Image(masterBytes).resize(asset.size, asset.size).png().write(asset.path);
  }
  const size = Bun.file(asset.path).size;
  console.log(`  ✓ ${asset.path} (${asset.size}x${asset.size}, ${size}B)`);
  generated++;
}

console.log(`▶ generated ${generated}, skipped ${skipped} (up to date)`);

const { ok, problems } = await verify();
if (!ok) {
  console.error("✗ verification failed after generation:");
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`✓ verified ${assets.length} assets`);

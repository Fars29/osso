/**
 * Draws the Osso icon and rasterises it. One bone in ink, a hairline of paper around it,
 * transparent ground.
 *
 * The shape is the union of a bar and four discs; the bar is thick enough that at 16 px it
 * still reads as a bar (about 3 px) rather than a hairline, and the discs overlap the bar ends
 * so no seam shows at any size. Chrome does not recolour action icons for its dark theme, so
 * the paper halo is what keeps an ink silhouette visible on a dark toolbar; on a light one it
 * vanishes into the toolbar. Margins after the halo are 4/128 a side: the toolbar crops nothing.
 *
 * Run: node scripts/icons.mjs   →  icons/icon.svg, icons/{16,32,48,128}.png
 */
import sharp from "sharp";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "icons");
const INK = "#161616";
const PAPER = "#fbfaf7";
/** Stroke width of the halo; only the half outside the fill shows, 8/128 a side (1 px at 16 px, 2 px at 32 px). */
const HALO = 16;
const SIZES = [16, 32, 48, 128];

const BONE = `    <rect x="28" y="51" width="72" height="26" rx="13"/>
    <circle cx="28" cy="47" r="16"/>
    <circle cx="28" cy="81" r="16"/>
    <circle cx="100" cy="47" r="16"/>
    <circle cx="100" cy="81" r="16"/>`;

// The halo is a stroked copy painted first; the ink union on top covers every stroke that falls
// inside the shape, so no seam shows where the discs meet the bar, and no renderer has to know
// paint-order.
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128">
  <title>Osso</title>
  <g fill="none" stroke="${PAPER}" stroke-width="${HALO}" stroke-linejoin="round">
${BONE}
  </g>
  <g fill="${INK}">
${BONE}
  </g>
</svg>
`;

mkdirSync(out, { recursive: true });
writeFileSync(join(out, "icon.svg"), svg);

for (const size of SIZES) {
  // Render the vector at the target density instead of downscaling a big bitmap: edges stay
  // crisp at 16 px, where a resample would smear the knobs into the bar.
  await sharp(Buffer.from(svg), { density: (72 * size) / 128 })
    .resize(size, size)
    .png({ compressionLevel: 9 })
    .toFile(join(out, `${size}.png`));
  console.log(`[osso] icons/${size}.png`);
}
console.log(`[osso] icons/icon.svg`);

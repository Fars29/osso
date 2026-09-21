/**
 * One version, in package.json; everything else follows it. `npm version patch|minor|major` runs
 * this through the "version" script, so the manifest and the Options page are part of the version
 * commit and of the tag that the release workflow builds from.
 *
 * With --check it changes nothing and fails if anything has drifted (the release workflow runs it,
 * with the tag, so a tag can never publish a zip that says another version).
 *
 * Run: node scripts/sync-version.mjs [--check] [--tag v1.2.3]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const check = process.argv.includes("--check");
const tagAt = process.argv.indexOf("--tag");
const tag = tagAt >= 0 ? process.argv[tagAt + 1] : null;
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

const targets = [
  { file: "src/manifest.json", pattern: /("version":\s*")[^"]+(")/, to: `$1${version}$2` },
  { file: "src/ui/options/index.html", pattern: /(Osso )\d+\.\d+\.\d+( · GPL-3.0)/, to: `$1${version}$2` },
];

const drifted = [];
for (const t of targets) {
  const path = join(root, t.file);
  const before = readFileSync(path, "utf8");
  if (!t.pattern.test(before)) throw new Error(`[osso] ${t.file}: nowhere to write the version`);
  const after = before.replace(t.pattern, t.to);
  if (after === before) continue;
  drifted.push(t.file);
  if (!check) writeFileSync(path, after);
}
if (tag && tag !== `v${version}`) drifted.push(`tag ${tag} (package.json says v${version})`);

if (check && drifted.length > 0) {
  console.error(`[osso] version ${version} is not what these say: ${drifted.join(", ")}. Run: npm version <patch|minor|major>`);
  process.exit(1);
}
console.log(check ? `[osso] version ${version} everywhere` : `[osso] version ${version}${drifted.length ? ` written to ${drifted.join(", ")}` : ", nothing to change"}`);

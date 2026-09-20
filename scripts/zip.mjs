/**
 * Packs dist/ into release/osso-<version>.zip, the file you upload to the Chrome Web Store or
 * attach to a GitHub release. No zip library: PowerShell on Windows, the zip CLI elsewhere.
 *
 * Run: npm run build && node scripts/zip.mjs
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const release = join(root, "release");

if (!existsSync(join(dist, "manifest.json"))) {
  console.error("[osso] dist/ is missing or incomplete: run npm run build first");
  process.exit(1);
}

const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const target = join(release, `osso-${version}.zip`);
mkdirSync(release, { recursive: true });
// Both tools append to an existing archive rather than replace it; start clean.
rmSync(target, { force: true });

// Entries are listed by name rather than as `.` so the archive holds manifest.json at its root
// with no `./` prefix, which is what the Web Store and `Load unpacked` expect.
const entries = readdirSync(dist);

if (process.platform === "win32") {
  // Windows 10+ ships bsdtar, which writes a standard zip with forward-slash entry names.
  // Compress-Archive (and .NET Framework's ZipFile under PowerShell 5.1) store backslashes,
  // which unzip on macOS and Linux turns into literal file names: it is the fallback only.
  const tar = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
  if (existsSync(tar)) {
    execFileSync(tar, ["-a", "-c", "-f", target, "-C", dist, ...entries], { stdio: "inherit" });
  } else {
    execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", `Compress-Archive -Path '${join(dist, "*")}' -DestinationPath '${target}' -CompressionLevel Optimal`],
      { stdio: "inherit" },
    );
  }
} else {
  execFileSync("zip", ["-r", "-q", "-X", target, ...entries], { cwd: dist, stdio: "inherit" });
}

const bytes = statSync(target).size;
console.log(`[osso] ${target} (${(bytes / 1024).toFixed(1)} KB)`);

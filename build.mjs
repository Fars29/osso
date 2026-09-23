// Bundles the extension into dist/. `node build.mjs` once, `node build.mjs --watch` to keep going.
import * as esbuild from "esbuild";
import { cpSync, mkdirSync, rmSync, existsSync } from "node:fs";

const watch = process.argv.includes("--watch");
const out = "dist";

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const common = {
  bundle: true,
  target: "chrome120",
  sourcemap: watch ? "inline" : false,
  minify: !watch,
  logLevel: "info",
  define: { "process.env.NODE_ENV": JSON.stringify(watch ? "development" : "production") },
};

const contexts = await Promise.all([
  // Content scripts cannot be ES modules: bundle as a self-contained IIFE.
  esbuild.context({ ...common, entryPoints: ["src/content/index.ts"], outfile: `${out}/content.js`, format: "iife" }),
  esbuild.context({ ...common, entryPoints: ["src/background/index.ts"], outfile: `${out}/background.js`, format: "esm" }),
  esbuild.context({ ...common, entryPoints: ["src/ui/popup/index.ts"], outfile: `${out}/popup.js`, format: "esm" }),
  esbuild.context({ ...common, entryPoints: ["src/ui/options/index.ts"], outfile: `${out}/options.js`, format: "esm" }),
  esbuild.context({ ...common, entryPoints: ["src/ui/welcome/index.ts"], outfile: `${out}/welcome.js`, format: "esm" }),
]);

function copyStatic() {
  cpSync("src/manifest.json", `${out}/manifest.json`);
  // The license travels with the program, and Options → About links to it offline.
  cpSync("LICENSE", `${out}/LICENSE.txt`);
  cpSync("src/content/osso.css", `${out}/osso.css`);
  cpSync("src/ui/tokens.css", `${out}/tokens.css`);
  cpSync("src/ui/popup/index.html", `${out}/popup.html`);
  cpSync("src/ui/popup/popup.css", `${out}/popup.css`);
  cpSync("src/ui/options/index.html", `${out}/options.html`);
  cpSync("src/ui/options/options.css", `${out}/options.css`);
  cpSync("src/ui/welcome/index.html", `${out}/welcome.html`);
  cpSync("src/ui/welcome/welcome.css", `${out}/welcome.css`);
  if (existsSync("icons")) cpSync("icons", `${out}/icons`, { recursive: true });
}

if (watch) {
  await Promise.all(contexts.map((c) => c.watch()));
  copyStatic();
  console.log("[osso] watching…");
} else {
  await Promise.all(contexts.map((c) => c.rebuild()));
  await Promise.all(contexts.map((c) => c.dispose()));
  copyStatic();
  console.log("[osso] built to dist/");
}

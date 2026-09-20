/**
 * The e2e's static server and the generated icons. The live e2e itself needs a key and a
 * browser; this covers the parts that must not be the reason it fails.
 */
/// <reference types="node" />
import { existsSync, readFileSync } from "node:fs";
import { get, type IncomingMessage } from "node:http";
import { join } from "node:path";
// @ts-expect-error the server is plain .mjs with JSDoc; its one export is typed here.
import { startServer as startServerUntyped } from "../e2e/server.mjs";

type Server = { url: string; close: () => Promise<void> };
const startServer = startServerUntyped as (dir: string) => Promise<Server>;

const root = join(__dirname, "..");
const fixtures = join(root, "e2e", "fixtures");

function fetchRaw(url: string): Promise<{ status: number; type: string | undefined; body: string }> {
  return new Promise((ok, fail) => {
    get(url, (res: IncomingMessage) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => (body += c));
      res.on("end", () => ok({ status: res.statusCode ?? 0, type: res.headers["content-type"], body }));
    }).on("error", fail);
  });
}

describe("e2e static server", () => {
  let server: Server;
  beforeAll(async () => {
    server = await startServer(fixtures);
  });
  afterAll(() => server.close());

  it("binds loopback on a free port", () => {
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it("serves each fixture as html", async () => {
    for (const name of ["recipe", "tos", "blank"]) {
      const r = await fetchRaw(`${server.url}/${name}.html`);
      expect(r.status).toBe(200);
      expect(r.type).toBe("text/html; charset=utf-8");
      expect(r.body).toContain("<!doctype html>");
    }
  });

  it("404s what is not there and refuses traversal", async () => {
    expect((await fetchRaw(`${server.url}/nope.html`)).status).toBe(404);
    // Node's URL parser collapses ../ so the encoded form is the one that reaches the handler.
    expect([403, 404]).toContain((await fetchRaw(`${server.url}/..%2f..%2fpackage.json`)).status);
  });
});

describe("fixtures", () => {
  it("recipe keeps its chrome in nav and footer and its ingredients in a list", () => {
    const html = readFileSync(join(fixtures, "recipe.html"), "utf8");
    expect(html).toContain("<nav");
    expect(html).toContain("<footer");
    expect(html).toContain('id="ingredients"');
    expect(html).toMatch(/<ol id="method">/);
  });

  it("tos carries the auto-renewal sentence the e2e looks for", () => {
    const html = readFileSync(join(fixtures, "tos.html"), "utf8");
    expect(html).toContain("automatically renew");
    expect(html).toContain('<table id="fees">');
  });

  it("blank has fewer than MIN_SENTENCES sentences", () => {
    const html = readFileSync(join(fixtures, "blank.html"), "utf8");
    const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    expect((text.match(/[.!?](\s|$)/g) ?? []).length).toBeLessThan(8);
  });
});

describe("icons", () => {
  it("exist at every size the manifest names", () => {
    const manifest = JSON.parse(readFileSync(join(root, "src", "manifest.json"), "utf8")) as { icons: Record<string, string> };
    for (const file of Object.values(manifest.icons)) expect(existsSync(join(root, file))).toBe(true);
    expect(existsSync(join(root, "icons", "icon.svg"))).toBe(true);
  });
});

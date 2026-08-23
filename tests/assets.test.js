import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";

describe("static assets", () => {
  it("serves the Polish landing page at /", async () => {
    const res = await SELF.fetch("https://example.org/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    const body = await res.text();
    expect(body).toContain('<html lang="pl">');
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });

  it("serves /en/ and /style.css", async () => {
    expect((await SELF.fetch("https://example.org/en/")).status).toBe(200);
    const css = await SELF.fetch("https://example.org/style.css");
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toMatch(/text\/css/);
  });

  it("returns 404.html with status 404 for unknown paths", async () => {
    const res = await SELF.fetch("https://example.org/nope");
    expect(res.status).toBe(404);
    expect(await res.text()).toMatch(/not found/i);
  });

  it("answers /api/* with JSON 404 until routes exist", async () => {
    const res = await SELF.fetch("https://example.org/api/nothing");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("serves the shell for /app, /app/ and any /app/* path; serves module files as JS", async () => {
    for (const p of ["/app", "/app/", "/app/admin", "/app/whatever/deeper"]) {
      const res = await SELF.fetch(`https://example.org${p}`);
      expect(res.status, p).toBe(200);
      const html = await res.text();
      expect(html).toContain('src="/app/app.js"');
      expect(res.headers.get("content-security-policy")).toContain("script-src 'self'");
    }
    const js = await SELF.fetch("https://example.org/app/app.js");
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toMatch(/javascript/);
    const missingJs = await SELF.fetch("https://example.org/app/nope.js");
    expect(missingJs.status).toBe(200); // falls back to the shell; the router shows News
  });
});

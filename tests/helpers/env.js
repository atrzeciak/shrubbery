import { env as baseEnv, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../../src/worker.js";
import * as q from "../../src/db/queries.js";

const TABLES = ["rsvps", "gatherings", "ops_status", "history", "rate_limits", "media_people", "invitations", "media", "join_requests", "avatars", "person_links", "parent_of", "partner_of", "login_codes", "sessions", "passkeys", "accounts", "people"];

export function makeEnv() {
  const sent = [];
  const env = { ...baseEnv, APP_ORIGIN: "https://example.org", MAIL_LOGIN_FROM: "login@mail.example.org", MAIL_FAMILY_FROM: "rodzina@mail.example.org", EMAIL: { async send(msg) { sent.push(msg); return { messageId: `m${sent.length}` }; } } };
  return { env, sent };
}

export async function resetDb(env) {
  await env.DB.batch(TABLES.map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  await env.DB.prepare("INSERT INTO ops_status (id, backup_at) VALUES (1, NULL)").run();
}

export async function seedAccount(env, { id, email, role = "family", lang = "pl", createdAt = 1_800_000_000, notifyEvents = 1 }) {
  await q.insertAccount(env.DB, { id, email, role, lang, createdAt, invitedBy: null, notifyEvents }).run();
}

export async function seedPerson(env, { id, first_name = null, last_name = null, display_name = null, birth_date = null, email = null, deceased = 0, unverified = 0, at = 1_800_000_000 }) {
  await env.DB.prepare("INSERT INTO people (id, first_name, last_name, display_name, birth_date, email, deceased, unverified, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(id, first_name, last_name, display_name || [first_name, last_name].filter(Boolean).join(" ") || id, birth_date, email, deceased, unverified, at, at).run();
}

export const lastCode = (sent) => sent[sent.length - 1].text.match(/\b(\d{6})\b/)[1];

export class Client {
  constructor(env) { this.env = env; this.cookies = new Map(); this.ip = "203.0.113.1"; }

  async fetch(path, { method = "GET", body, headers = {} } = {}) {
    const h = new Headers(headers);
    h.set("cf-connecting-ip", this.ip);
    h.set("user-agent", "vitest");
    if (this.cookies.size) h.set("cookie", [...this.cookies].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("; "));
    let payload;
    if (body instanceof Uint8Array || body instanceof ArrayBuffer) payload = body;
    else if (body !== undefined) { h.set("content-type", "application/json"); payload = JSON.stringify(body); }
    const req = new Request(`https://example.org${path}`, { method, headers: h, body: payload });
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, this.env, ctx);
    await waitOnExecutionContext(ctx);
    for (const sc of res.headers.getSetCookie()) {
      const [kv, ...attrs] = sc.split(";");
      const eq = kv.indexOf("=");
      const name = kv.slice(0, eq);
      const value = decodeURIComponent(kv.slice(eq + 1));
      if (attrs.some((a) => a.trim() === "Max-Age=0")) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return res;
  }

  async json(path, opts) {
    const res = await this.fetch(path, opts);
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    return { status: res.status, body, res };
  }

  async raw(path, opts) {
    return this.fetch(path, opts);
  }
}

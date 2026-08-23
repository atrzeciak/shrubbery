import { describe, it, expect, beforeEach } from "vitest";
import * as q from "../src/db/queries.js";
import { createAuthenticator } from "./helpers/authenticator.js";
import { makeEnv, resetDb, seedAccount, seedPerson, lastCode, Client } from "./helpers/env.js";
import { gatheringReminders } from "../src/events/cron.js";

let env, sent;
beforeEach(async () => { ({ env, sent } = makeEnv()); await resetDb(env); });

async function login(email) {
  const c = new Client(env);
  await c.json("/api/auth/email", { method: "POST", body: { email } });
  await c.json("/api/auth/code/request", { method: "POST", body: { email } });
  expect((await c.json("/api/auth/code", { method: "POST", body: { email, code: lastCode(sent) } })).status).toBe(200);
  return c;
}

async function admin(email = "adm@x.org") {
  await seedAccount(env, { id: "adm", email, role: "family" });
  const c = await login(email);
  const auth = await createAuthenticator();
  const ch = await c.json("/api/auth/passkey/challenge", { method: "POST", body: {} });
  await c.json("/api/me/passkeys", { method: "POST", body: { name: "key", credential: await auth.create(ch.body.challenge) } });
  await q.setRole(env.DB, "adm", "admin").run();
  return c;
}

// The family as the site knows it: some living, some dead, one of them signed in.
async function family() {
  await seedPerson(env, { id: "p_me", first_name: "Ja", last_name: "T" });
  await seedPerson(env, { id: "p_ola", first_name: "Anna", last_name: "L" });
  await seedPerson(env, { id: "p_zosia", first_name: "Zosia", last_name: "K" });   // never signs in
  await seedPerson(env, { id: "p_dead", first_name: "Władysław", last_name: "A", deceased: 1 });
  await seedAccount(env, { id: "mem", email: "me@x.org" });
  await q.linkAccountPerson(env.DB, "mem", "p_me").run();
}

const GATHERING = { on_date: "2027-06-12", place: "Ciechanowiec", note: "Zjazd rodzinny" };

async function makeGathering(c) {
  const r = await c.json("/api/admin/gatherings", { method: "POST", body: GATHERING });
  expect(r.status).toBe(201);
  return r.body.id;
}

describe("gatherings", () => {
  it("an admin creates one; everyone signed in can see it", async () => {
    await family();
    const adm = await admin();
    const id = await makeGathering(adm);
    const mem = await login("me@x.org");
    const g = (await mem.json("/api/gatherings")).body.gathering;
    expect(g).toMatchObject({ id, on_date: "2027-06-12", place: "Ciechanowiec", note: "Zjazd rodzinny" });
    expect((await new Client(env).json("/api/gatherings")).status).toBe(401);
  });

  it("only an admin may create or change one", async () => {
    await family();
    const adm = await admin();
    const id = await makeGathering(adm);
    const mem = await login("me@x.org");
    expect((await mem.json("/api/admin/gatherings", { method: "POST", body: GATHERING })).status).toBe(403);
    expect((await mem.json(`/api/admin/gatherings/${id}`, { method: "PATCH", body: { place: "Gdzie indziej" } })).status).toBe(403);
  });

  // The list is the family, not the people who happened to reply: it is a worklist for whoever is
  // making the telephone calls, and it shows how much of the family is still unaccounted for.
  it("lists every living relative, answered or not, and never the dead", async () => {
    await family();
    const adm = await admin();
    await makeGathering(adm);
    const mem = await login("me@x.org");
    const body = (await mem.json("/api/gatherings")).body;
    const ids = body.guests.map((g) => g.person_id);
    expect(ids).toContain("p_me");
    expect(ids).toContain("p_zosia");
    expect(ids).not.toContain("p_dead");
    expect(body.guests.every((g) => g.coming === null)).toBe(true);
    expect(body.totals).toEqual({ coming: 0, not_coming: 0, unanswered: ids.length });
  });

  it("a member answers for themselves, and the totals count people rather than names", async () => {
    await family();
    const adm = await admin();
    const id = await makeGathering(adm);
    const mem = await login("me@x.org");
    expect((await mem.json(`/api/gatherings/${id}/rsvp`, { method: "PUT", body: { coming: 1, headcount: 4 } })).status).toBe(200);
    const body = (await mem.json("/api/gatherings")).body;
    const mine = body.guests.find((g) => g.person_id === "p_me");
    expect(mine).toMatchObject({ coming: 1, headcount: 4, on_behalf: 0 });
    expect(body.totals.coming).toBe(4);              // four people, one name
    expect(body.totals.unanswered).toBe(body.guests.length - 1);
  });

  it("an admin answers for someone who will never sign in, and it says so", async () => {
    await family();
    const adm = await admin();
    const id = await makeGathering(adm);
    expect((await adm.json(`/api/admin/gatherings/${id}/rsvp/p_zosia`, { method: "PUT", body: { coming: 1, headcount: 2 } })).status).toBe(200);
    const zosia = (await adm.json("/api/gatherings")).body.guests.find((g) => g.person_id === "p_zosia");
    expect(zosia).toMatchObject({ coming: 1, headcount: 2, on_behalf: 1 });
  });

  it("a member cannot answer for anybody else", async () => {
    await family();
    const adm = await admin();
    const id = await makeGathering(adm);
    const mem = await login("me@x.org");
    expect((await mem.json(`/api/admin/gatherings/${id}/rsvp/p_ola`, { method: "PUT", body: { coming: 1, headcount: 1 } })).status).toBe(403);
  });

  it("a member with no linked person is told to link one rather than silently failing", async () => {
    await family();
    const adm = await admin();
    const id = await makeGathering(adm);
    await seedAccount(env, { id: "loose", email: "loose@x.org" });
    const c = await login("loose@x.org");
    const r = await c.json(`/api/gatherings/${id}/rsvp`, { method: "PUT", body: { coming: 1, headcount: 1 } });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("no_person");
  });

  it("not coming carries nobody; coming must bring at least one", async () => {
    await family();
    const adm = await admin();
    const id = await makeGathering(adm);
    const mem = await login("me@x.org");
    await mem.json(`/api/gatherings/${id}/rsvp`, { method: "PUT", body: { coming: 0, headcount: 5 } });
    const mine = () => mem.json("/api/gatherings").then((r) => r.body.guests.find((g) => g.person_id === "p_me"));
    expect(await mine()).toMatchObject({ coming: 0, headcount: 0 });
    expect((await mem.json(`/api/gatherings/${id}/rsvp`, { method: "PUT", body: { coming: 1, headcount: 0 } })).status).toBe(400);
    expect((await mem.json(`/api/gatherings/${id}/rsvp`, { method: "PUT", body: { coming: 1, headcount: -2 } })).status).toBe(400);
  });

  it("changing an answer replaces it instead of adding a second", async () => {
    await family();
    const adm = await admin();
    const id = await makeGathering(adm);
    const mem = await login("me@x.org");
    await mem.json(`/api/gatherings/${id}/rsvp`, { method: "PUT", body: { coming: 1, headcount: 3 } });
    await mem.json(`/api/gatherings/${id}/rsvp`, { method: "PUT", body: { coming: 0 } });
    const { results } = await env.DB.prepare("SELECT * FROM rsvps WHERE gathering_id = ?").bind(id).all();
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ person_id: "p_me", coming: 0, headcount: 0 });
  });

  it("a cancelled gathering still shows, marked, and takes no more answers", async () => {
    await family();
    const adm = await admin();
    const id = await makeGathering(adm);
    expect((await adm.json(`/api/admin/gatherings/${id}`, { method: "PATCH", body: { cancelled: 1 } })).status).toBe(200);
    const mem = await login("me@x.org");
    const body = (await mem.json("/api/gatherings")).body;
    expect(body.gathering.cancelled_at).toBeGreaterThan(0);
    expect((await mem.json(`/api/gatherings/${id}/rsvp`, { method: "PUT", body: { coming: 1, headcount: 1 } })).status).toBe(409);
  });

  // Cancelling is for a gathering the family was told about and that is no longer happening. Deleting
  // is for one that should never have existed — a mistake, or a trial run.
  it("an admin deletes one, and its answers go with it", async () => {
    await family();
    const adm = await admin();
    const id = await makeGathering(adm);
    await adm.json(`/api/admin/gatherings/${id}/rsvp/p_zosia`, { method: "PUT", body: { coming: 1, headcount: 2 } });
    expect((await adm.json(`/api/admin/gatherings/${id}`, { method: "DELETE" })).status).toBe(200);
    expect((await adm.json("/api/gatherings")).body.gathering).toBe(null);
    const { results } = await env.DB.prepare("SELECT * FROM rsvps WHERE gathering_id = ?").bind(id).all();
    expect(results).toHaveLength(0);
    expect(await q.gatheringById(env.DB, id).first()).toBe(null);
  });

  // The gathering goes; the record that it existed does not. Deleting a row must not quietly edit
  // the history of who did what.
  it("keeps the record that it was arranged and then deleted", async () => {
    await family();
    const adm = await admin();
    const id = await makeGathering(adm);
    await adm.json(`/api/admin/gatherings/${id}`, { method: "DELETE" });
    const { results } = await env.DB.prepare("SELECT action FROM history WHERE target_id = ? ORDER BY id").bind(id).all();
    expect(results.map((r) => r.action)).toEqual(["gathering_created", "gathering_deleted"]);
  });

  it("a member cannot delete one, and deleting nothing is a 404", async () => {
    await family();
    const adm = await admin();
    const id = await makeGathering(adm);
    const mem = await login("me@x.org");
    expect((await mem.json(`/api/admin/gatherings/${id}`, { method: "DELETE" })).status).toBe(403);
    expect((await adm.json("/api/admin/gatherings/nosuchthing", { method: "DELETE" })).status).toBe(404);
  });

  // The same rule the news feed follows: the guest list is about who is coming, never how to reach them.
  it("carries no e-mail addresses anywhere", async () => {
    await family();
    await env.DB.prepare("UPDATE people SET email = 'zosia@x.org' WHERE id = 'p_zosia'").run();
    const adm = await admin();
    await makeGathering(adm);
    const raw = JSON.stringify((await adm.json("/api/gatherings")).body);
    expect(raw).not.toContain("zosia@x.org");
    expect(raw).not.toContain("@x.org");
  });
});

describe("telling the family about it", () => {
  // The site knows an address for only a handful of relatives. Everyone else hears by telephone, so
  // the mail's job is to reach the few it can and to let them in if they have no account yet.
  async function reachable() {
    await family();
    await env.DB.prepare("UPDATE people SET email = 'me@x.org' WHERE id = 'p_me'").run();
    await env.DB.prepare("UPDATE people SET email = 'ola@x.org' WHERE id = 'p_ola'").run();
    await env.DB.prepare("UPDATE people SET email = 'dead@x.org' WHERE id = 'p_dead'").run();
    // p_zosia has no address at all: she is the reason admins can answer on somebody's behalf.
  }

  it("announces to every living relative it has an address for, and nobody else", async () => {
    await reachable();
    const adm = await admin();
    const id = await makeGathering(adm);
    sent.length = 0;
    const r = await adm.json(`/api/admin/gatherings/${id}/announce`, { method: "POST", body: {} });
    expect(r.status).toBe(200);
    const to = sent.map((m) => m.to).sort();
    expect(to).toEqual(["me@x.org", "ola@x.org"]);
    expect(sent[0].text).toContain("2027-06-12");
    expect(sent[0].text).toContain("Ciechanowiec");
  });

  // An address without an account is a relative who cannot answer. The announcement carries them in.
  it("lets in anybody it writes to who has no account yet", async () => {
    await reachable();
    const adm = await admin();
    const id = await makeGathering(adm);
    await adm.json(`/api/admin/gatherings/${id}/announce`, { method: "POST", body: {} });
    const { results } = await env.DB.prepare("SELECT email FROM invitations").all();
    expect(results.map((r) => r.email)).toEqual(["ola@x.org"]);   // me@x.org already has an account
  });

  it("announces once; a second attempt is refused rather than mailing twice", async () => {
    await reachable();
    const adm = await admin();
    const id = await makeGathering(adm);
    await adm.json(`/api/admin/gatherings/${id}/announce`, { method: "POST", body: {} });
    sent.length = 0;
    expect((await adm.json(`/api/admin/gatherings/${id}/announce`, { method: "POST", body: {} })).status).toBe(409);
    expect(sent).toHaveLength(0);
  });

  it("will not announce a cancelled gathering, and only an admin may announce", async () => {
    await reachable();
    const adm = await admin();
    const id = await makeGathering(adm);
    const mem = await login("me@x.org");
    expect((await mem.json(`/api/admin/gatherings/${id}/announce`, { method: "POST", body: {} })).status).toBe(403);
    await adm.json(`/api/admin/gatherings/${id}`, { method: "PATCH", body: { cancelled: 1 } });
    expect((await adm.json(`/api/admin/gatherings/${id}/announce`, { method: "POST", body: {} })).status).toBe(409);
  });

  // A nudge is the one mail most likely to feel like pestering, so it reaches only the silent and
  // can only be sent once.
  it("nudges only those who have not answered, and only once", async () => {
    await reachable();
    const adm = await admin();
    const id = await makeGathering(adm);
    const mem = await login("me@x.org");
    await mem.json(`/api/gatherings/${id}/rsvp`, { method: "PUT", body: { coming: 1, headcount: 2 } });
    sent.length = 0;
    expect((await adm.json(`/api/admin/gatherings/${id}/nudge`, { method: "POST", body: {} })).status).toBe(200);
    expect(sent.map((m) => m.to)).toEqual(["ola@x.org"]);          // me@x.org already answered
    sent.length = 0;
    expect((await adm.json(`/api/admin/gatherings/${id}/nudge`, { method: "POST", body: {} })).status).toBe(409);
    expect(sent).toHaveLength(0);
  });

  it("reminds the week before and on the day, and never twice for the same run", async () => {
    await reachable();
    const adm = await admin();
    await makeGathering(adm);                                       // 2027-06-12
    sent.length = 0;
    await gatheringReminders(env, new Date("2027-06-05T05:00:00Z"));  // T-7
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("me@x.org");
    await gatheringReminders(env, new Date("2027-06-05T05:00:00Z"));  // the cron fires twice
    expect(sent).toHaveLength(1);
    await gatheringReminders(env, new Date("2027-06-12T05:00:00Z"));  // the day itself
    expect(sent).toHaveLength(2);
  });

  it("says nothing on any other day, and nothing to somebody who switched reminders off", async () => {
    await reachable();
    const adm = await admin();
    await makeGathering(adm);
    sent.length = 0;
    await gatheringReminders(env, new Date("2027-06-04T05:00:00Z"));
    expect(sent).toHaveLength(0);
    await env.DB.prepare("UPDATE accounts SET notify_events = 0").run();
    await gatheringReminders(env, new Date("2027-06-12T05:00:00Z"));
    expect(sent).toHaveLength(0);
  });
});

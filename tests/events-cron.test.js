import { describe, it, expect, beforeEach } from "vitest";
import { capturingErrors } from "./helpers/logging.js";
import * as q from "../src/db/queries.js";
import { runDaily } from "../src/events/cron.js";
import { makeEnv, resetDb, seedAccount, seedPerson } from "./helpers/env.js";

let env, sent;
beforeEach(async () => { ({ env, sent } = makeEnv()); await resetDb(env); });

// 2026-06-15 05:00 UTC == 2026-06-15 in Warsaw
const NOW = new Date("2026-06-15T05:00:00Z");

async function family() {
  await seedPerson(env, { id: "me", first_name: "Ja", last_name: "T" });
  await seedPerson(env, { id: "mom", first_name: "Mama", last_name: "T", birth_date: "1960-06-22" });          // T-7 birthday
  await seedPerson(env, { id: "gm", first_name: "Babcia", last_name: "A", birth_date: "1941-01-05" });
  await env.DB.prepare("UPDATE people SET death_date = '2014-06-15', deceased = 1 WHERE id = 'gm'").run();     // T-0 anniversary
  await seedPerson(env, { id: "far", first_name: "Obcy", last_name: "X", birth_date: "1970-06-15" });          // out of scope
  await seedPerson(env, { id: "part", first_name: "Rok", last_name: "Y", birth_date: "1950" });                // partial date
  await q.insertParent(env.DB, "mom", "me").run();
  await q.insertParent(env.DB, "gm", "mom").run();
  await seedAccount(env, { id: "acc", email: "me@x.org", lang: "pl" });
  await q.linkAccountPerson(env.DB, "acc", "me").run();
}

describe("runDaily", () => {
  it("mails opted-in linked accounts at T-7 and T-0, in their language, within scope only", async () => {
    await family();
    await seedAccount(env, { id: "optout", email: "n@x.org", notifyEvents: 0 });     // switched the reminders off
    await seedAccount(env, { id: "unlinked", email: "u@x.org" });                    // on by default, no person linked
    await runDaily(env, NOW);
    expect(sent.map((m) => m.to)).toEqual(["me@x.org", "me@x.org"]);
    const subjects = sent.map((m) => m.subject).sort();
    expect(subjects.find((s) => s.includes("Babcia"))).toContain("rocznica");
    expect(subjects.find((s) => s.includes("Mama"))).toContain("urodziny");
    const hist = (await env.DB.prepare("SELECT action, target_id, details FROM history WHERE action = 'event_notice_sent' ORDER BY id").all()).results;
    expect(hist).toHaveLength(2);
    expect(JSON.parse(hist.find((r) => r.target_id === "mom").details)).toMatchObject({ type: "birthday", to_account: "acc", in_days: 7 });
  });
  // Cloudflare can run a cron trigger more than once, and a redeploy or a manual run can too. The
  // family must not get the same birthday reminder twice for it.
  it("does not send the same reminder twice on the same day", async () => {
    await family();
    await runDaily(env, NOW);
    const first = sent.length;
    expect(first).toBe(2);
    await runDaily(env, NOW);
    expect(sent).toHaveLength(first);
    const hist = (await env.DB.prepare("SELECT id FROM history WHERE action = 'event_notice_sent'").all()).results;
    expect(hist).toHaveLength(2);
  });

  // The guard is scoped to the day, not to the person: mama's birthday is T-7 today and T-0 a week
  // later, and she must be mailed about on both days.
  it("still mails the same person when their reminder comes round again", async () => {
    await family();
    await runDaily(env, NOW);
    await runDaily(env, NOW);                                            // a second run today changes nothing
    expect(sent.map((m) => m.to)).toHaveLength(2);
    const onTheDay = new Date("2026-06-22T05:00:00Z");                   // mama's birthday itself
    await runDaily(env, onTheDay);
    expect(sent.length).toBe(3);
    expect(sent[2].subject).toContain("Mama");
  });

  it("sends nothing when nobody opted in, and never about self or out-of-scope people", async () => {
    await family();
    await q.setNotifyEvents(env.DB, "acc", 0).run();
    await runDaily(env, NOW);
    expect(sent).toHaveLength(0);
    await q.setNotifyEvents(env.DB, "acc", 1).run();
    await env.DB.prepare("UPDATE people SET birth_date = '1990-06-15' WHERE id = 'me'").run();   // own birthday today
    await runDaily(env, NOW);
    expect(sent.filter((m) => /Ja|Obcy|Rok/.test(m.subject))).toHaveLength(0);
  });
  it("English account gets English text", async () => {
    await family();
    await env.DB.prepare("UPDATE accounts SET lang = 'en' WHERE id = 'acc'").run();
    await runDaily(env, NOW);
    expect(sent.find((m) => m.subject.includes("Mama")).subject).toMatch(/birthday/i);
  });
  it("keeps sending after one mail fails, and records history only for the successful ones", async () => {
    await family();
    let calls = 0;
    env.EMAIL.send = async (msg) => {
      calls++;
      if (calls === 1) throw new Error("mail provider down");
      sent.push(msg);
      return { messageId: `m${sent.length}` };
    };
    const { logged } = await capturingErrors(() => runDaily(env, NOW));
    expect(logged).toHaveLength(1);                       // the dead mailbox was reported, not hidden
    expect(logged[0].message).toBe("mail provider down");
    expect(sent).toHaveLength(1);
    const hist = (await env.DB.prepare("SELECT target_id FROM history WHERE action = 'event_notice_sent'").all()).results;
    expect(hist).toHaveLength(1);
  });
  it("uses the Polish 'lata' form for a birthday turning 22", async () => {
    await seedPerson(env, { id: "me", first_name: "Ja", last_name: "T" });
    await seedPerson(env, { id: "kid", first_name: "Dziecko", last_name: "T", birth_date: "2004-06-22" }); // T-7, turns 22
    await q.insertParent(env.DB, "me", "kid").run();
    await seedAccount(env, { id: "acc", email: "me@x.org", lang: "pl" });
    await q.linkAccountPerson(env.DB, "acc", "me").run();
    await q.setNotifyEvents(env.DB, "acc", 1).run();
    await runDaily(env, NOW);
    const msg = sent.find((m) => m.subject.includes("Dziecko"));
    expect(msg.text).toContain("22 lata");
  });
  it("uses the English singular 'year' for a first death anniversary", async () => {
    await seedPerson(env, { id: "me", first_name: "Ja", last_name: "T" });
    await seedPerson(env, { id: "mom", first_name: "Mama", last_name: "T" });
    await env.DB.prepare("UPDATE people SET death_date = '2025-06-15', deceased = 1 WHERE id = 'mom'").run(); // T-0, 1 year
    await q.insertParent(env.DB, "mom", "me").run();
    await seedAccount(env, { id: "acc", email: "me@x.org", lang: "en" });
    await q.linkAccountPerson(env.DB, "acc", "me").run();
    await q.setNotifyEvents(env.DB, "acc", 1).run();
    await runDaily(env, NOW);
    const msg = sent.find((m) => m.subject.includes("Mama"));
    expect(msg.subject + msg.text).not.toMatch(/\b1 years\b/);
    expect(msg.subject + msg.text).toMatch(/\b1 year\b/);
  });
});

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render } from "../../public/app/views/gathering.js";
import { today } from "../../public/app/events.js";
import { mockApi, lang, viewCtx, meFixture, tick, q, qa, byText } from "./helpers.js";

const TZ = "Europe/Warsaw";
const dayPlus = (n) => {
  const d = new Date(`${today(new Date(), TZ)}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

const gathering = (over = {}) => ({ id: "g1", on_date: dayPlus(10), place: "Grandma's", note: "Bring cake", cancelled_at: null, announced_at: null, nudged_at: null, ...over });
const guests = [
  { person_id: "p1", display_name: "Anna Nowak", coming: 1, headcount: 3, on_behalf: 0 },
  { person_id: "p2", display_name: "Bartek Nowak", coming: null, headcount: null, on_behalf: 0 },
  { person_id: "p3", display_name: "Celina Nowak", coming: 0, headcount: 0, on_behalf: 1 },
];
const feed = (g, gs = guests) => ({ gathering: g, guests: gs, totals: { coming: 3, not_coming: 1, unanswered: 1 } });

const family = (person_id = "p1") => viewCtx(meFixture({ account: { person_id }, tz: TZ }));
const admin = () => viewCtx(meFixture({ account: { role: "admin", person_id: "p2" }, tz: TZ }));

async function draw(ctx, routes) {
  const calls = mockApi(routes);
  const root = document.createElement("div");
  document.body.append(root);
  await render(root, ctx);
  return { calls, root, ctx };
}

beforeEach(async () => { await lang("en"); vi.stubGlobal("confirm", vi.fn(() => true)); });

describe("without a gathering", () => {
  it("tells a member there is nothing and offers no form", async () => {
    await draw(family(), { "GET /api/gatherings": feed(null, []) });
    expect(document.body.textContent).toContain("No gathering has been arranged yet.");
    expect(q("input[type=date]")).toBeNull();
  });

  it("lets an admin create one and redraws with it", async () => {
    let g = null;
    const { calls } = await draw(admin(), {
      "GET /api/gatherings": () => feed(g, g ? guests : []),
      "POST /api/admin/gatherings": (body) => { g = gathering({ on_date: body.on_date, place: body.place, note: body.note }); return { id: "g1" }; },
    });
    q("input[type=date]").value = dayPlus(0);
    q("input[type=text]").value = "Park";
    q("textarea").value = "Noon";
    byText("button", "Save").click();
    await tick();
    expect(calls.find((c) => c.method === "POST").body).toEqual({ on_date: dayPlus(0), place: "Park", note: "Noon" });
    expect(document.body.textContent).toContain("today");
    expect(document.body.textContent).toContain("Where: Park");
  });

  it("keeps the form usable when saving fails", async () => {
    const { ctx } = await draw(admin(), { "GET /api/gatherings": feed(null, []), "POST /api/admin/gatherings": { status: 400, body: { error: "bad_request" } } });
    const save = byText("button", "Save");
    save.click();
    await tick();
    expect(ctx.toast).toHaveBeenCalledWith("bad_request");
    expect(save.disabled).toBe(false);
  });
});

describe("with a gathering", () => {
  it("shows the date, countdown, place, note and totals", async () => {
    await draw(family(), { "GET /api/gatherings": feed(gathering()) });
    const text = document.body.textContent;
    expect(text).toContain("in 10 days");
    expect(text).toContain("Where: Grandma's");
    expect(text).toContain("Bring cake");
    expect(q(".totals strong").textContent).toContain("3");
    expect(text).toContain("Not coming: 1");
    expect(text).toContain("No answer yet: 1");
  });

  it("marks a cancelled gathering and hides the RSVP and past countdown", async () => {
    await draw(family(), { "GET /api/gatherings": feed(gathering({ cancelled_at: 1, on_date: dayPlus(-3), place: null, note: null })) });
    expect(document.body.textContent).toContain("Cancelled.");
    expect(document.body.textContent).not.toContain("in -3 days");
    expect(q(".rsvp")).toBeNull();
  });

  it("asks a member without a linked person to get linked first", async () => {
    await draw(family(null), { "GET /api/gatherings": feed(gathering()) });
    expect(q(".rsvp")).toBeNull();
    expect(document.body.textContent).toContain("Your account is not linked to anybody in the tree yet");
  });

  it("saves my own answer: yes with a headcount, no, and a changed count", async () => {
    let mine = guests[0];
    const { calls, ctx } = await draw(family(), {
      "GET /api/gatherings": () => feed(gathering(), [mine]),
      "PUT /api/gatherings/g1/rsvp": (body) => { mine = { ...mine, ...body }; return { ok: true }; },
    });
    const rsvp = q(".rsvp");
    expect(q("input[type=number]", rsvp).value).toBe("3");
    byText("button", "No", rsvp).click();
    await tick();
    expect(calls.at(-2).body).toEqual({ coming: 0 });
    expect(ctx.toast).toHaveBeenCalledWith("Saved.");
    const again = q(".rsvp");
    expect(q("label.field", again).hidden).toBe(true);
    byText("button", "Yes", again).click();
    await tick();
    expect(calls.find((c) => c.body?.coming === 1).body).toEqual({ coming: 1, headcount: 3 });
    const count = q(".rsvp input[type=number]");
    count.value = "5";
    count.dispatchEvent(new Event("change"));
    await tick();
    expect(calls.at(-2).body).toEqual({ coming: 1, headcount: 5 });
  });

  it("ignores a count change while the answer is no", async () => {
    const mine = [{ ...guests[0], coming: 0, headcount: 0 }];
    const { calls } = await draw(family(), { "GET /api/gatherings": feed(gathering(), mine) });
    const count = q(".rsvp input[type=number]");
    expect(count.value).toBe("1");
    count.value = "4";
    count.dispatchEvent(new Event("change"));
    await tick();
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(0);
  });

  it("reports a failed answer without redrawing", async () => {
    const { ctx } = await draw(family(), { "GET /api/gatherings": feed(gathering()), "PUT /api/gatherings/g1/rsvp": { status: 403, body: { error: "forbidden" } } });
    byText("button", "No", q(".rsvp")).click();
    await tick();
    expect(ctx.toast).toHaveBeenCalledWith("forbidden");
  });

  it("lists answered guests first for a member, with on-behalf answers marked", async () => {
    await draw(family(), { "GET /api/gatherings": feed(gathering()) });
    const rows = qa("ul.list li");
    expect(rows.map((r) => q("a", r).textContent)).toEqual(["Anna Nowak", "Celina Nowak", "Bartek Nowak"]);
    expect(rows[1].textContent).toContain("entered by somebody else");
    expect(q("a", rows[0]).getAttribute("href")).toBe("/app/tree/p1");
    expect(q("button", rows[0])).toBeNull();
  });
});

describe("as an admin", () => {
  it("lists the unanswered first and answers for a guest on the telephone", async () => {
    const { calls } = await draw(admin(), { "GET /api/gatherings": feed(gathering()), "PUT /api/admin/gatherings/g1/rsvp/p1": { ok: true } });
    const rows = qa("ul.list li");
    expect(rows.map((r) => q("a", r).textContent)).toEqual(["Bartek Nowak", "Anna Nowak", "Celina Nowak"]);
    byText("button", "Enter an answer", rows[1]).click();
    const controls = q(".rsvp", rows[1]);
    expect(controls).not.toBeNull();
    byText("button", "Yes", controls).click();
    await tick();
    expect(calls.find((c) => c.path.includes("/rsvp/p1")).body).toEqual({ coming: 1, headcount: 3 });
  });

  it("toasts when answering for a guest fails", async () => {
    const { ctx } = await draw(admin(), { "GET /api/gatherings": feed(gathering()), "PUT /api/admin/gatherings/g1/rsvp/p1": { status: 500, body: { error: "internal" } } });
    const row = qa("ul.list li")[1];
    byText("button", "Enter an answer", row).click();
    byText("button", "No", q(".rsvp", row)).click();
    await tick();
    expect(ctx.toast).toHaveBeenCalledWith("internal");
  });

  it("edits the gathering in place", async () => {
    const { calls } = await draw(admin(), { "GET /api/gatherings": feed(gathering()), "PATCH /api/admin/gatherings/g1": { ok: true } });
    const form = qa(".card").find((c) => q("input[type=date]", c));
    expect(q("input[type=date]", form).value).toBe(dayPlus(10));
    expect(q("textarea", form).value).toBe("Bring cake");
    q("input[type=text]", form).value = "Elsewhere";
    byText("button", "Save", form).click();
    await tick();
    expect(calls.find((c) => c.method === "PATCH").body).toEqual({ on_date: dayPlus(10), place: "Elsewhere", note: "Bring cake" });
  });

  it("cancels and uncancels, and re-enables the button on failure", async () => {
    let g = gathering();
    const { calls } = await draw(admin(), { "GET /api/gatherings": () => feed(g), "PATCH /api/admin/gatherings/g1": (body) => { g = gathering({ cancelled_at: body.cancelled ? 1 : null }); return { ok: true }; } });
    byText("button", "Cancel the gathering").click();
    await tick();
    expect(calls.find((c) => c.method === "PATCH").body).toEqual({ cancelled: 1 });
    expect(qa("ul.list li button")).toHaveLength(0);
    byText("button", "Reinstate the gathering").click();
    await tick();
    expect(calls.filter((c) => c.method === "PATCH").at(-1).body).toEqual({ cancelled: 0 });
    expect(q(".error")).toBeNull();

    document.body.innerHTML = "";
    const { ctx: ctx2 } = await draw(admin(), { "GET /api/gatherings": feed(gathering()), "PATCH /api/admin/gatherings/g1": { status: 500, body: { error: "internal" } } });
    const cancel = byText("button", "Cancel the gathering");
    cancel.click();
    await tick();
    expect(ctx2.toast).toHaveBeenCalledWith("internal");
    expect(cancel.disabled).toBe(false);
  });

  it("deletes only after confirmation", async () => {
    let g = gathering(), failed = false;
    const { calls, ctx } = await draw(admin(), {
      "GET /api/gatherings": () => feed(g, g ? guests : []),
      "DELETE /api/admin/gatherings/g1": () => { if (failed) { g = null; return { ok: true }; } failed = true; return { status: 500, body: { error: "internal" } }; },
    });
    confirm.mockReturnValueOnce(false);
    const del = byText("button", "Delete the gathering");
    del.click();
    await tick();
    expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(0);
    del.click();
    await tick();
    expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(1);
    expect(ctx.toast).toHaveBeenCalledWith("internal");
    expect(del.disabled).toBe(false);
    del.click();
    await tick();
    expect(document.body.textContent).toContain("No gathering has been arranged yet.");
  });

  it("offers announce, then nudge, then nothing, each behind a confirmation", async () => {
    let g = gathering();
    const { calls, ctx } = await draw(admin(), {
      "GET /api/gatherings": () => feed(g),
      "POST /api/admin/gatherings/g1/announce": () => { g = gathering({ announced_at: 1 }); return { sent: 4 }; },
      "POST /api/admin/gatherings/g1/nudge": () => { g = gathering({ announced_at: 1, nudged_at: 2 }); return { sent: 1 }; },
    });
    expect(byText("button", "Remind those who have not answered")).toBeNull();
    confirm.mockReturnValueOnce(false);
    byText("button", "Send the invitations").click();
    await tick();
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
    byText("button", "Send the invitations").click();
    await tick();
    expect(ctx.toast).toHaveBeenCalledWith("Sent: 4");
    expect(byText("button", "Send the invitations")).toBeNull();
    byText("button", "Remind those who have not answered").click();
    await tick();
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(2);
    expect(byText("button", "Remind those who have not answered")).toBeNull();
  });

  it("re-enables the mail button when sending fails", async () => {
    const { ctx } = await draw(admin(), { "GET /api/gatherings": feed(gathering()), "POST /api/admin/gatherings/g1/announce": { status: 500, body: { error: "internal" } } });
    const b = byText("button", "Send the invitations");
    b.click();
    await tick();
    expect(ctx.toast).toHaveBeenCalledWith("internal");
    expect(b.disabled).toBe(false);
  });
});

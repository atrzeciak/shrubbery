import { describe, it, expect, beforeEach } from "vitest";
import { render } from "../../public/app/views/me.js";
import { ApiError } from "../../public/app/api.js";
import { closeSheet } from "../../public/app/sheet.js";
import { mockApi, lang, viewCtx, meFixture, tick, q, qa, submit, byText, stubCanvas, pickFile } from "./helpers.js";

const root = () => q("#root");
const person = { id: "p1", display_name: "Anna Nowak", first_name: "Anna", last_name: "Nowak", birth_date: "1990-06-15", deceased: 0 };
const graph = {
  people: [person,
    { id: "p2", display_name: "Jan Nowak", first_name: "Jan", last_name: "Nowak", deceased: 0 },
    { id: "p3", display_name: "Ola Nowak", first_name: "Ola", last_name: "Nowak", deceased: 0 },
    { id: "p4", display_name: "Piotr Kowal", first_name: "Piotr", last_name: "Kowal", deceased: 0 },
    { id: "p5", display_name: "Maria Nowak", first_name: "Maria", last_name: "Nowak", deceased: 0 }],
  parents: [{ parent_id: "p2", child_id: "p1" }, { parent_id: "p5", child_id: "p1" }, { parent_id: "p2", child_id: "p3" }],
  partners: [{ a_id: "p1", b_id: "p4", kind: "married", start_year: 2015, end_year: null }],
  avatars: [{ person_id: "p1", updated_at: 77 }],
};
const media = { media: [], counts: { used: 0, cap: 6 } };
const base = () => ({ "GET /api/me/person": { person, links: [] }, "GET /api/people": graph, "GET /api/people/p1/media": media, "GET /api/people/p2/media": media });

async function start(routes = base()) {
  document.body.innerHTML = '<div id="root"></div>';
  const calls = mockApi(routes);
  const ctx = viewCtx(meFixture({ account: { person_id: "p1" } }));
  await render(root(), ctx);
  await tick();
  return { calls, ctx };
}

beforeEach(async () => { await lang("pl"); closeSheet(); });

describe("without a linked person", () => {
  it("explains that an admin has to link the login first", async () => {
    await start({ "GET /api/me/person": { status: 404, body: { error: "not_found" } } });
    expect(q("p.card").textContent).toBe("Twoje konto nie jest jeszcze połączone z osobą w drzewie. Poproś administratora.");
    expect(q("form")).toBeNull();
  });
  it("lets any other failure reach the app", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    mockApi({ "GET /api/me/person": { status: 500, body: { error: "internal" } } });
    await expect(render(root(), viewCtx())).rejects.toBeInstanceOf(ApiError);
  });
});

describe("with a linked person", () => {
  it("shows the current photo, the form filled in, and the relations as buttons or a dash", async () => {
    await start();
    expect(q("h1").textContent).toBe("Ja");
    expect(q("img.avatar").getAttribute("src")).toBe("/api/people/p1/avatar?v=77");
    expect(q("#pf-first_name").value).toBe("Anna");
    expect(q("#pf-unverified")).toBeNull();
    const kv = qa(".kv").map((el) => el.textContent);
    expect(kv).toEqual(["Rodzice: Jan Nowak, Maria Nowak", "Partnerzy: Piotr Kowal", "Dzieci: —", "Rodzeństwo: Ola Nowak"]);
    expect(q(".media-gallery")).not.toBeNull();
  });

  it("opens a relative's card in a sheet", async () => {
    await start();
    byText("button.linklike", "Jan Nowak").click();
    await tick();
    const sheet = q('[role="dialog"]');
    expect(sheet.getAttribute("aria-label")).toBe("Jan Nowak");
    expect(q("h2", sheet).textContent).toBe("Jan Nowak");
  });

  it("saves the form, says so, and redraws from the server", async () => {
    const { calls, ctx } = await start({ ...base(), "PATCH /api/me/person": {} });
    q("#pf-nickname").value = "Ania";
    submit(q("form"));
    await tick();
    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch.path).toBe("/api/me/person");
    expect(patch.body).toMatchObject({ first_name: "Anna", nickname: "Ania", deceased: 0 });
    expect(patch.body.unverified).toBeUndefined();
    expect(ctx.toast).toHaveBeenCalledWith("Zapisano.");
    expect(calls.filter((c) => c.path === "/api/me/person" && c.method === "GET").length).toBe(2);
  });

  it("uploads a chosen photo, says so, and redraws; a refusal shows in the picker", async () => {
    stubCanvas();
    const { calls, ctx } = await start({ ...base(), "PUT /api/me/person/avatar": {} });
    pickFile(q("#avatar-file"), new File(["x"], "me.jpg", { type: "image/jpeg" }));
    await tick();
    byText("button", "Zapisz zdjęcie").click();
    await tick();
    const put = calls.find((c) => c.method === "PUT");
    expect(put.path).toBe("/api/me/person/avatar");
    expect(put.body).toBeInstanceOf(Blob);
    expect(ctx.toast).toHaveBeenCalledWith("Zdjęcie zapisane.");
    expect(calls.filter((c) => c.path === "/api/me/person" && c.method === "GET").length).toBe(2);
    const failed = await start({ ...base(), "PUT /api/me/person/avatar": { status: 413, body: { error: "bad_request" } } });
    pickFile(q("#avatar-file"), new File(["x"], "me.jpg", { type: "image/jpeg" }));
    await tick();
    byText("button", "Zapisz zdjęcie").click();
    await tick();
    expect(q(".avatar-picker .error").textContent).toBe("bad_request");
    expect(failed.ctx.toast).not.toHaveBeenCalled();
  });

  it("shows a refused save inside the form", async () => {
    const { ctx } = await start({ ...base(), "PATCH /api/me/person": { status: 400, body: { error: "bad_request" } } });
    submit(q("form"));
    await tick();
    expect(q("form .error").textContent).toBe("bad_request");
    expect(ctx.toast).not.toHaveBeenCalled();
  });
});

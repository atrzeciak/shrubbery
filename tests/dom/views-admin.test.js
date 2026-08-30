import { describe, it, expect, beforeEach, vi } from "vitest";
import { render } from "../../public/app/views/admin.js";
import { mockApi, lang, viewCtx, meFixture, tick, q, qa, byText } from "./helpers.js";

const people = [
  { id: "p1", first_name: "Anna", last_name: "Nowak", display_name: "Anna Nowak", birth_date: "1950-01-01", email: "anna@x.org", account_id: null },
  { id: "p2", first_name: "Jan", last_name: "Nowak", display_name: "Jan Nowak", birth_date: "1948-05-05", death_date: "2010-01-01", account_id: null },
  { id: "p3", first_name: "Kasia", last_name: "Nowak", display_name: "Kasia Nowak", birth_date: "1980-01-01", email: "kasia@x.org", account_id: "acc2" },
  { id: "p4", first_name: "Anna", last_name: "Kowalska", display_name: "Anna Kowalska", birth_date: "1985-01-01", email: "same@x.org", account_id: null },
  { id: "p5", display_name: "Zofia Wiśniewska", birth_date: null, account_id: null },
];
const graph = { people, parents: [{ parent_id: "p1", child_id: "p3" }, { parent_id: "p2", child_id: "p3" }, { parent_id: "p1", child_id: "p4" }], partners: [], links: [], avatars: [] };

const requests = [
  { id: "r1", status: "pending", first_name: "Anna", last_name: "Kowalska", birth_date: "1985-01-01", email: "same@x.org", parent_text: "Anna Nowak", message: null, created_at: 1e9, match: "p4" },
  { id: "r2", status: "pending", first_name: "Piotr", last_name: "Lis", birth_date: "1990-02-02", email: "piotr@x.org", parent_text: "unknown", message: "Hello there", created_at: 1e9, match: null },
  { id: "r3", status: "auto", first_name: "Old", last_name: "One", birth_date: "1990-02-02", email: "old@x.org", parent_text: "x", message: null, created_at: 1e9, match: null },
];
const documents = [{ id: "d1", caption: "Deed", year: 1990, size: 2048 }, { id: "d2", caption: null, year: null, size: 100 }];
const invitations = [
  { id: "i1", email: "new@x.org", lang: "pl", expires_at: 1e9, attachment_media_id: "d1" },
  { id: "i2", email: "other@x.org", lang: "en", expires_at: 1e9, attachment_media_id: null },
];
const accounts = [
  { id: "acc1", email: "me@x.org", role: "admin", founder: 1, protected: 0, disabled_at: null, person_id: null, passkeys: 2, last_seen_at: 1e9 },
  { id: "acc2", email: "kasia@x.org", role: "family", founder: 0, protected: 0, disabled_at: null, person_id: "p3", passkeys: 1, last_seen_at: 1e9 },
  { id: "acc3", email: "same@x.org", role: "family", founder: 0, protected: 0, disabled_at: null, person_id: null, passkeys: 0, last_seen_at: null },
  { id: "acc4", email: "guard@x.org", role: "admin", founder: 0, protected: 1, disabled_at: null, person_id: null, passkeys: 1, last_seen_at: 1e9 },
  { id: "acc5", email: "off@x.org", role: "family", founder: 0, protected: 0, disabled_at: 5, person_id: "p9", passkeys: 0, last_seen_at: null },
  { id: "acc6", email: "boss@x.org", role: "admin", founder: 0, protected: 0, disabled_at: null, person_id: null, passkeys: 1, last_seen_at: 1e9 },
];

const baseRoutes = () => ({
  "GET /api/people": graph,
  "GET /api/admin/join-requests": { requests },
  "GET /api/admin/documents": { documents },
  "GET /api/admin/invitations": { invitations },
  "GET /api/admin/accounts": { accounts },
  "GET /api/admin/history": { items: [], next: null },
  "GET /api/admin/backup/check": { files: 3, media_bytes: 2_500_000, backup_at: null, backup_failed_at: null },
});

const until = async (fn) => { for (let i = 0; i < 50 && !fn(); i++) await tick(); };
const founder = () => viewCtx(meFixture({ account: { role: "admin", founder: 1 } }));

// The chosen tab is module state, so every test opens the one it wants by clicking it.
async function open(tab, routes = {}, ctx = founder()) {
  const calls = mockApi({ ...baseRoutes(), ...routes });
  const root = document.createElement("div");
  document.body.append(root);
  await render(root, ctx);
  const b = qa("[role=tab]", root).find((x) => x.textContent === tab);
  if (b.getAttribute("aria-selected") !== "true") { b.click(); await until(() => byText("[role=tab]", tab, root).getAttribute("aria-selected") === "true" && root.querySelectorAll("ul, form, .card").length); }
  // A panel appends its frame before its first page has arrived.
  for (let i = 0; i < 5; i++) await tick();
  return { calls, root, ctx };
}

const type = (input, value) => { input.value = value; input.dispatchEvent(new Event("input")); };
const picker = (li) => q(".picker-wrap input", li);
const rows = (li) => qa(".picker li", li);

beforeEach(async () => { await lang("en"); vi.stubGlobal("confirm", vi.fn(() => true)); vi.stubGlobal("prompt", vi.fn(() => "no thanks")); });

describe("invitations: join requests", () => {
  it("lists pending requests only, with the match line and the message", async () => {
    const { root } = await open("Invitations");
    const items = qa("li", qa("ul.list", root)[0]);
    expect(items.map((li) => q("strong", li).textContent)).toEqual(["Anna Kowalska", "Piotr Lis"]);
    expect(items[0].textContent).toContain("Matches: Anna Kowalska");
    expect(picker(items[0]).value).toBe("Anna Kowalska");
    expect(items[1].textContent).toContain("Hello there");
    expect(picker(items[1]).value).toBe("");
  });

  it("shows an empty line when there is nothing pending", async () => {
    const { root } = await open("Invitations", { "GET /api/admin/join-requests": { requests: [] }, "GET /api/admin/invitations": { invitations: [] } });
    expect(root.textContent).toContain("No pending requests.");
    expect(root.textContent).toContain("No pending invitations.");
  });

  it("finds by display name only, after two characters, and shows years and parents", async () => {
    const { root } = await open("Invitations");
    const li = qa("ul.list li", root)[1];
    const input = picker(li);
    type(input, "a");
    expect(q(".picker", li).hidden).toBe(true);
    type(input, "x.org");
    expect(rows(li)).toHaveLength(0);
    type(input, "anna");
    expect(rows(li).map((r) => q("span", r).textContent)).toEqual(["Anna Nowak", "Anna Kowalska"]);
    expect(rows(li)[1].textContent).toContain("1985 · parents: Anna Nowak");
    type(input, "jan");
    expect(rows(li)[0].textContent).toContain("1948–2010");
  });

  it("disables Approve while the text names nobody, and approves with the chosen person", async () => {
    const { root, calls } = await open("Invitations", { "POST /api/admin/join-requests/r2/approve": { ok: true } });
    const li = qa("ul.list li", root)[1];
    const approve = byText("button", "Approve", li);
    type(picker(li), "nobody");
    expect(approve.disabled).toBe(true);
    type(picker(li), "zofia");
    rows(li)[0].dispatchEvent(new Event("mousedown", { cancelable: true }));
    expect(picker(li).value).toBe("Zofia Wiśniewska");
    expect(q(".picker", li).hidden).toBe(true);
    expect(approve.disabled).toBe(false);
    approve.click();
    await tick();
    expect(calls.find((c) => c.path.endsWith("/approve")).body).toEqual({ person_id: "p5" });
  });

  it("drops the choice once the typed name no longer matches it", async () => {
    const { root } = await open("Invitations");
    const li = qa("ul.list li", root)[0];
    type(picker(li), "Anna Kowalsk");
    expect(byText("button", "Approve", li).disabled).toBe(true);
  });

  it("creates a new person when the field is blank", async () => {
    const { root, calls } = await open("Invitations", { "POST /api/admin/join-requests/r1/approve": { ok: true } });
    const li = qa("ul.list li", root)[0];
    type(picker(li), "");
    byText("button", "Approve", li).click();
    await tick();
    expect(calls.find((c) => c.path.endsWith("/approve")).body).toEqual({ create: true });
  });

  it("picks the only hit on Enter, hides the list on Escape and blur, refills on focus", async () => {
    const { root } = await open("Invitations");
    const li = qa("ul.list li", root)[1];
    const input = picker(li);
    type(input, "zof");
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", cancelable: true }));
    expect(input.value).toBe("Zofia Wiśniewska");
    type(input, "anna");
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", cancelable: true }));
    expect(input.value).toBe("anna");
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(q(".picker", li).hidden).toBe(true);
    input.dispatchEvent(new Event("focus"));
    expect(q(".picker", li).hidden).toBe(false);
    input.dispatchEvent(new Event("blur"));
    expect(q(".picker", li).hidden).toBe(true);
  });

  it("rejects with a note, or not at all when the prompt is dismissed", async () => {
    const { root, calls } = await open("Invitations", { "POST /api/admin/join-requests/r2/reject": { ok: true } });
    const li = qa("ul.list li", root)[1];
    prompt.mockReturnValueOnce(null);
    byText("button", "Reject", li).click();
    await tick();
    expect(calls.filter((c) => c.path.endsWith("/reject"))).toHaveLength(0);
    byText("button", "Reject", li).click();
    await tick();
    expect(calls.find((c) => c.path.endsWith("/reject")).body).toEqual({ note: "no thanks" });
  });

  it("toasts when an action fails", async () => {
    const { root, ctx } = await open("Invitations", { "POST /api/admin/join-requests/r1/approve": { status: 409, body: { error: "conflict" } } });
    byText("button", "Approve", qa("ul.list li", root)[0]).click();
    await tick();
    expect(ctx.toast).toHaveBeenCalledWith("conflict");
  });
});

describe("invitations: sending and managing", () => {
  it("sends an invitation with the chosen language and attachment", async () => {
    const { root, calls, ctx } = await open("Invitations", { "POST /api/admin/invitations": { id: "i9" } });
    expect(qa("#inv-attachment option", root).map((o) => o.textContent)).toEqual(["— no attachment —", "Deed (1990) · 2 KB", "d2 · 0 KB"]);
    q("#inv-email", root).value = "x@y.org";
    q("#inv-lang", root).value = "en";
    q("#inv-attachment", root).value = "d1";
    q("form", root).dispatchEvent(new Event("submit", { cancelable: true }));
    await tick();
    expect(calls.find((c) => c.method === "POST").body).toEqual({ email: "x@y.org", lang: "en", attachment: "d1" });
    expect(ctx.toast).toHaveBeenCalledWith("Invitation sent.");
  });

  it("sends null for no attachment", async () => {
    const { root, calls } = await open("Invitations", { "POST /api/admin/invitations": { id: "i9" } });
    q("#inv-email", root).value = "x@y.org";
    q("form", root).dispatchEvent(new Event("submit", { cancelable: true }));
    await tick();
    expect(calls.find((c) => c.method === "POST").body.attachment).toBeNull();
  });

  it("lists invitations with a paperclip for an attachment, re-sends, and revokes after confirming", async () => {
    const { root, calls } = await open("Invitations", { "POST /api/admin/invitations/i1/resend": { ok: true }, "DELETE /api/admin/invitations/i2": { ok: true } });
    const items = qa("ul.list li.row", root);
    expect(items[0].textContent).toContain("📎");
    expect(items[1].textContent).not.toContain("📎");
    byText("button", "Re-send", items[0]).click();
    await tick();
    expect(calls.some((c) => c.path === "/api/admin/invitations/i1/resend")).toBe(true);
    confirm.mockReturnValueOnce(false);
    byText("button", "Revoke", items[1]).click();
    await tick();
    expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(0);
    byText("button", "Revoke", items[1]).click();
    await tick();
    expect(calls.filter((c) => c.method === "DELETE").map((c) => c.path)).toEqual(["/api/admin/invitations/i2"]);
  });
});

describe("accounts", () => {
  const row = (root, email) => qa("ul.list li", root).find((li) => q("strong", li).textContent === email);
  const visible = (li) => qa("button", li).filter((b) => !b.hidden).map((b) => b.textContent);

  it("shows each account's state and hides what this admin cannot touch", async () => {
    const { root } = await open("Accounts");
    expect(row(root, "me@x.org").textContent).toContain("founder");
    expect(visible(row(root, "me@x.org"))).toEqual(["Sign out everywhere", "Link to person"]);
    expect(row(root, "kasia@x.org").textContent).toContain("Kasia Nowak");
    expect(visible(row(root, "kasia@x.org"))).toEqual(["Grant admin", "Disable account", "Sign out everywhere", "Unlink person"]);
    expect(row(root, "guard@x.org").textContent).toContain("protected");
    expect(visible(row(root, "guard@x.org"))).toEqual(["Revoke admin", "Remove protection", "Disable account", "Sign out everywhere", "Link to person"]);
    expect(row(root, "off@x.org").textContent).toContain("disabled · ?");
    expect(visible(row(root, "off@x.org"))).toEqual(["Enable account"]);
    expect(visible(row(root, "boss@x.org"))).toEqual(["Revoke admin", "Protect account", "Disable account", "Sign out everywhere", "Link to person"]);
  });

  it("keeps a protected admin out of reach of an admin who is not the founder", async () => {
    const { root } = await open("Accounts", {}, viewCtx(meFixture({ account: { id: "acc6", role: "admin", founder: 0 } })));
    expect(visible(row(root, "guard@x.org"))).toEqual(["Sign out everywhere", "Link to person"]);
    expect(visible(row(root, "boss@x.org"))).toEqual(["Sign out everywhere", "Link to person"]);
    expect(visible(row(root, "me@x.org"))).toEqual(["Sign out everywhere", "Link to person"]);
  });

  it("grants and revokes admin after naming the person in the confirmation", async () => {
    const { root, calls } = await open("Accounts", { "PATCH /api/admin/accounts/acc2": { ok: true }, "PATCH /api/admin/accounts/acc6": { ok: true } });
    confirm.mockReturnValueOnce(false);
    byText("button", "Grant admin", row(root, "kasia@x.org")).click();
    await tick();
    expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(0);
    byText("button", "Grant admin", row(root, "kasia@x.org")).click();
    await tick();
    expect(confirm).toHaveBeenLastCalledWith(expect.stringContaining("Give Kasia Nowak admin rights?"));
    expect(calls.find((c) => c.method === "PATCH").body).toEqual({ role: "admin" });
    byText("button", "Revoke admin", row(root, "boss@x.org")).click();
    await tick();
    expect(confirm).toHaveBeenLastCalledWith(expect.stringContaining("boss@x.org"));
    expect(calls.filter((c) => c.method === "PATCH").at(-1).body).toEqual({ role: "family" });
  });

  it("disables, enables and signs out", async () => {
    const { root, calls } = await open("Accounts", { "POST /api/admin/accounts/acc2/disable": { ok: true }, "POST /api/admin/accounts/acc5/enable": { ok: true }, "POST /api/admin/accounts/acc3/revoke-sessions": { ok: true }, "POST /api/admin/accounts/acc2/revoke-sessions": { ok: true } });
    confirm.mockReturnValueOnce(false);
    byText("button", "Disable account", row(root, "kasia@x.org")).click();
    byText("button", "Disable account", row(root, "kasia@x.org")).click();
    await tick();
    expect(calls.filter((c) => c.path.endsWith("/disable"))).toHaveLength(1);
    byText("button", "Enable account", row(root, "off@x.org")).click();
    await tick();
    expect(calls.some((c) => c.path.endsWith("/acc5/enable"))).toBe(true);
    confirm.mockReturnValueOnce(false);
    byText("button", "Sign out everywhere", row(root, "same@x.org")).click();
    byText("button", "Sign out everywhere", row(root, "same@x.org")).click();
    await tick();
    expect(confirm).toHaveBeenLastCalledWith(expect.stringContaining("same@x.org"));
    byText("button", "Sign out everywhere", row(root, "kasia@x.org")).click();
    await tick();
    expect(confirm).toHaveBeenLastCalledWith(expect.stringContaining("Kasia Nowak"));
    expect(calls.filter((c) => c.path.endsWith("/revoke-sessions"))).toHaveLength(2);
  });

  it("protects and unprotects, only after confirming", async () => {
    const { root, calls } = await open("Accounts", { "PATCH /api/admin/accounts/acc6": { ok: true }, "PATCH /api/admin/accounts/acc4": { ok: true } });
    confirm.mockReturnValueOnce(false);
    byText("button", "Protect account", row(root, "boss@x.org")).click();
    byText("button", "Protect account", row(root, "boss@x.org")).click();
    await tick();
    expect(calls.filter((c) => c.method === "PATCH").map((c) => c.body)).toEqual([{ protected: 1 }]);
    byText("button", "Remove protection", row(root, "guard@x.org")).click();
    await tick();
    expect(calls.filter((c) => c.method === "PATCH").at(-1).body).toEqual({ protected: 0 });
  });

  it("unlinks after confirming", async () => {
    const { root, calls } = await open("Accounts", { "POST /api/admin/accounts/acc2/unlink": { ok: true } });
    confirm.mockReturnValueOnce(false);
    byText("button", "Unlink person", row(root, "kasia@x.org")).click();
    byText("button", "Unlink person", row(root, "kasia@x.org")).click();
    await tick();
    expect(confirm).toHaveBeenLastCalledWith(expect.stringContaining("Kasia Nowak"));
    expect(calls.filter((c) => c.path.endsWith("/unlink"))).toHaveLength(1);
  });

  it("links through a sheet whose button waits for a chosen, unlinked person", async () => {
    const { root, calls } = await open("Accounts", { "POST /api/admin/accounts/acc1/link": { ok: true } });
    byText("button", "Link to person", row(root, "me@x.org")).click();
    const sheet = q(".sheet");
    expect(q("h2", sheet).textContent).toBe("me@x.org");
    const ok = byText("button", "Link to person", sheet);
    expect(ok.disabled).toBe(true);
    type(q("#link-person", sheet), "kasia");
    expect(qa(".picker li", sheet)).toHaveLength(0);           // already has an account
    type(q("#link-person", sheet), "nowak");
    expect(qa(".picker li", sheet).map((li) => q("span", li).textContent)).toEqual(["Anna Nowak", "Jan Nowak"]);
    qa(".picker li", sheet)[0].dispatchEvent(new Event("mousedown"));
    expect(ok.disabled).toBe(false);
    ok.click();
    await tick();
    expect(calls.find((c) => c.path.endsWith("/link")).body).toEqual({ person_id: "p1" });
    expect(q(".sheet")).toBeNull();
  });

  it("pre-fills the person whose e-mail matches the account", async () => {
    const { root } = await open("Accounts");
    byText("button", "Link to person", row(root, "same@x.org")).click();
    const sheet = q(".sheet");
    expect(q("#link-person", sheet).value).toBe("Anna Kowalska");
    expect(byText("button", "Link to person", sheet).disabled).toBe(false);
  });
});

describe("history", () => {
  const item = (id, action, at = 1e9) => ({ id, at, action, actor_email: "me@x.org", actor_name: "Me", target_id: "t", details: { name: "Anna Nowak" } });

  it("pages, filters by account, and says when it is empty", async () => {
    const pages = [{ items: [item(3, "person_created"), item(2, "made_up_action")], next: 2 }, { items: [item(1, "person_created")], next: null }, { items: [], next: null }];
    const { root, calls } = await open("History", { "GET /api/admin/history": () => pages.shift() });
    expect(qa("ul.list li", root)).toHaveLength(2);
    expect(qa("ul.list li", root)[0].textContent).toContain("person_created");
    const more = byText("button", "Show older", root);
    expect(more.hidden).toBe(false);
    more.click();
    await tick();
    expect(qa("ul.list li", root)).toHaveLength(3);
    expect(more.hidden).toBe(true);
    expect(calls.at(-1).path).toBe("/api/admin/history?before=2");
    const filter = q("select", root);
    filter.value = "acc2";
    filter.dispatchEvent(new Event("change"));
    await tick();
    expect(calls.at(-1).path).toBe("/api/admin/history?account=acc2");
    expect(root.textContent).toContain("The history is empty.");
  });

  it("toasts when a page cannot be loaded", async () => {
    const { root, ctx } = await open("History", { "GET /api/admin/history": { items: [], next: 1 } });
    mockApi({ "GET /api/admin/history": { status: 500, body: { error: "internal" } } });
    byText("button", "Show older", root).click();
    await tick();
    expect(ctx.toast).toHaveBeenCalledWith("internal");
  });
});

describe("backup", () => {
  it("describes the archive and reports the last backup, a failure, or neither", async () => {
    const { root } = await open("Backup");
    expect(root.textContent).toContain("3 files · about 3 MB");
    expect(root.textContent).toContain("No backup has been downloaded yet.");
    const { root: r2 } = await open("Backup", { "GET /api/admin/backup/check": { files: 0, media_bytes: 0, backup_at: 1e9, backup_failed_at: null } });
    expect(r2.textContent).toContain("Last backup:");
    const { root: r3 } = await open("Backup", { "GET /api/admin/backup/check": { files: 0, media_bytes: 0, backup_at: 1e9, backup_failed_at: 2e9 } });
    expect(r3.textContent).toContain("did not finish");
  });

  it("refuses to start a download the session cannot make", async () => {
    const { root, ctx } = await open("Backup");
    mockApi({ "GET /api/admin/backup/check": { status: 401, body: { error: "step_up_required" } } });
    const button = byText("button", "Download the backup", root);
    button.click();
    await tick();
    expect(ctx.toast).toHaveBeenCalledWith("step_up_required");
    expect(button.disabled).toBe(false);
  });

  it("waits for the server to record the download, riding out a transient failure", async () => {
    const { root } = await open("Backup");
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    let n = 0;
    mockApi({ "GET /api/admin/backup/check": () => (++n === 2 ? { status: 500, body: { error: "internal" } } : n < 4 ? { backup_at: null, backup_failed_at: null } : { backup_at: 3e9, backup_failed_at: null }) });
    const button = byText("button", "Download the backup", root);
    button.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(button.disabled).toBe(true);
    expect(root.textContent).toContain("Confirming the download…");
    await vi.advanceTimersByTimeAsync(15000);
    expect(root.textContent).toContain("Last backup:");
    expect(button.disabled).toBe(false);
    vi.useRealTimers();
  });

  it("gives up after two minutes without word from the server", async () => {
    const { root } = await open("Backup");
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    mockApi({ "GET /api/admin/backup/check": { backup_at: null, backup_failed_at: null } });
    const button = byText("button", "Download the backup", root);
    button.click();
    await vi.advanceTimersByTimeAsync(24 * 5000);
    expect(root.textContent).toContain("No backup has been downloaded yet.");
    expect(button.disabled).toBe(false);
    vi.useRealTimers();
  });
});

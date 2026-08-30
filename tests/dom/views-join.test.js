import { describe, it, expect, beforeEach } from "vitest";
import { render } from "../../public/app/views/join.js";
import { mockApi, lang, viewCtx, tick, q, qa, submit, byText } from "./helpers.js";

const root = () => q("#root");
const button = (text) => byText("button", text);
const FILLED = { first_name: " Anna ", last_name: "Nowak", birth_date: "1990-05-04", parent_text: "Jan Nowak", email: "Anna@Example.org" };

async function start(ctx = viewCtx(null)) {
  document.body.innerHTML = '<div id="root"></div>';
  await render(root(), ctx);
  // The view keeps its step between renders; walk back to the form if a previous test left the code step.
  const edit = button("Popraw dane") || button("Edit details");
  if (edit) edit.click();
  expect(q("#join-first_name")).not.toBeNull();
  return ctx;
}

async function fillAndSend(routes) {
  const calls = mockApi(routes);
  for (const [k, v] of Object.entries(FILLED)) q(`#join-${k}`).value = v;
  q("#join-message").value = " hello ";
  submit(q("form"));
  await tick();
  return calls;
}

beforeEach(() => lang("pl"));

describe("the request form", () => {
  it("asks for the details, with the date hint in the reader's language", async () => {
    await start();
    expect(q("h1").textContent).toBe("Dołącz do rodziny");
    expect(qa("form input:not(.hp)").map((i) => i.id)).toEqual(["join-first_name", "join-last_name", "join-birth_date", "join-parent_text", "join-email"]);
    expect(q("#join-birth_date").placeholder).toBe("RRRR-MM-DD");
    expect(q("a[data-link]").getAttribute("href")).toBe("/app/login");
    await lang("en");
    await start();
    expect(q("h1").textContent).toBe("Join the family");
    expect(q("#join-birth_date").placeholder).toBe("YYYY-MM-DD");
  });

  it("sends the trimmed details with the language and the empty honeypot, then asks for the code", async () => {
    await start();
    const calls = await fillAndSend({ "POST /api/join/request": {} });
    expect(calls).toEqual([{ method: "POST", path: "/api/join/request", body: { first_name: "Anna", last_name: "Nowak", birth_date: "1990-05-04", parent_text: "Jan Nowak", email: "Anna@Example.org", message: "hello", lang: "pl", website: "" } }]);
    expect(q("#join-code")).not.toBeNull();
    expect(q("form p").textContent).toContain("Anna@Example.org");
  });

  it("shows why the request was refused and lets the visitor resend", async () => {
    await start();
    await fillAndSend({ "POST /api/join/request": { status: 429, body: { error: "rate_limited" } } });
    expect(q(".error").textContent).toBe("rate_limited");
    expect(button("Wyślij kod").disabled).toBe(false);
    expect(q("#join-code")).toBeNull();
  });
});

describe("the code step", () => {
  it("'edit details' goes back to the form with everything still filled in", async () => {
    await start();
    await fillAndSend({ "POST /api/join/request": {} });
    button("Popraw dane").click();
    expect(q("#join-first_name").value).toBe("Anna");
    expect(q("#join-message").value).toBe("hello");
  });

  it("confirms with the code and the same details, then thanks the visitor and forgets the form", async () => {
    await start();
    await fillAndSend({ "POST /api/join/request": {} });
    const calls = mockApi({ "POST /api/join/confirm": { auto: false } });
    q("#join-code").value = " 123456 ";
    submit(q("form"));
    await tick();
    expect(calls[0].body).toMatchObject({ email: "Anna@Example.org", lang: "pl", code: "123456" });
    expect(q(".card p").textContent).toBe("Dziękujemy. Administrator sprawdzi Twoją prośbę i przyśle zaproszenie e-mailem.");
    expect(q("a[data-link]").getAttribute("href")).toBe("/app/login");
    await start();
    expect(q("#join-first_name").value).toBe("");
  });

  it("says an invitation is already on its way when the address was recognised", async () => {
    await start();
    await fillAndSend({ "POST /api/join/request": {} });
    mockApi({ "POST /api/join/confirm": { auto: true } });
    q("#join-code").value = "123456";
    submit(q("form"));
    await tick();
    expect(q(".card p").textContent).toBe("Rozpoznaliśmy Twój adres — zaproszenie jest w drodze. Możesz się już zalogować.");
    expect(q("a[data-link]").textContent).toBe("Logowanie");
  });

  it("shows a wrong code and keeps the code form", async () => {
    await start();
    await fillAndSend({ "POST /api/join/request": {} });
    mockApi({ "POST /api/join/confirm": { status: 400, body: { error: "invalid_code" } } });
    q("#join-code").value = "000000";
    submit(q("form"));
    await tick();
    expect(q(".error").textContent).toBe("invalid_code");
    expect(button("Potwierdź").disabled).toBe(false);
    button("Popraw dane").click();
  });
});

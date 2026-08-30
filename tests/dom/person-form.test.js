import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { personForm, avatarPicker } from "../../public/app/person-form.js";
import { lang, q, qa, tick, stubCanvas, pickFile } from "./helpers.js";

beforeAll(() => lang("pl"));
afterEach(() => vi.restoreAllMocks());

const person = { first_name: "Anna", last_name: "Kowal", maiden_name: "Nowak", nickname: "Ania", sex: "f", birth_date: "1950-03-04", birth_place: "Kraków", deceased: 0, unverified: 1, residence: "Gdańsk", phone: "123", email: "a@x.org", notes: "hi" };
const submit = (form) => { form.dispatchEvent(new Event("submit", { cancelable: true })); return tick(); };

describe("personForm", () => {
  it("prefills the fields, the sex, the flags, the notes and the links", () => {
    const form = personForm(person, [{ kind: "instagram", label: "ig", url: "https://i.example/a" }], { admin: true, onSubmit: vi.fn() });
    document.body.append(form);
    expect(q("#pf-first_name").value).toBe("Anna");
    expect(q("#pf-birth_date").getAttribute("placeholder")).toBe("RRRR-MM-DD");
    expect(q("#pf-birth_place").getAttribute("placeholder")).toBeNull();
    expect(q("#pf-email").type).toBe("email");
    expect(q("#pf-phone").type).toBe("tel");
    expect(q("#pf-sex").value).toBe("f");
    expect(q("#pf-deceased").checked).toBe(false);
    expect(q("#pf-unverified").checked).toBe(true);
    expect(q("#pf-notes").value).toBe("hi");
    const row = q(".link-row");
    expect(row.children[0].value).toBe("instagram");
    expect(row.children[1].value).toBe("ig");
    expect(row.children[2].value).toBe("https://i.example/a");
  });
  it("offers no unverified flag to a non-admin and copes with no person at all", () => {
    const form = personForm(null, null, { admin: false, onSubmit: vi.fn() });
    document.body.append(form);
    expect(q("#pf-unverified")).toBeNull();
    expect(q("#pf-first_name").value).toBe("");
    expect(q("#pf-sex").value).toBe("");
  });
  it("disables the death fields for the living and the phone and e-mail for the dead", () => {
    const form = personForm(person, [], { admin: true, onSubmit: vi.fn() });
    document.body.append(form);
    expect(q("#pf-death_date").disabled).toBe(true);
    expect(q("#pf-phone").disabled).toBe(false);
    q("#pf-deceased").checked = true;
    q("#pf-deceased").dispatchEvent(new Event("change"));
    expect(q("#pf-death_date").disabled).toBe(false);
    expect(q("#pf-death_place").disabled).toBe(false);
    expect(q("#pf-phone").disabled).toBe(true);
    expect(q("#pf-email").disabled).toBe(true);
  });
  it("adds and removes link rows", () => {
    const form = personForm(null, [], { admin: true, onSubmit: vi.fn() });
    document.body.append(form);
    expect(qa(".link-row").length).toBe(0);
    q(".links + .row button").click();
    q(".links + .row button").click();
    expect(qa(".link-row").length).toBe(2);
    expect(q(".link-row option[selected]").value).toBe("other");
    q(".link-row .danger").click();
    expect(qa(".link-row").length).toBe(1);
  });
  it("submits trimmed values with nulls for blanks, flags as 0/1, and the links", async () => {
    const onSubmit = vi.fn(async () => {});
    const form = personForm({ ...person, deceased: 1, unverified: 0 }, [{ kind: "facebook", label: "", url: "https://f.example/x" }], { admin: true, onSubmit });
    document.body.append(form);
    q("#pf-first_name").value = "  Anna ";
    q("#pf-nickname").value = "  ";
    q("#pf-notes").value = " n ";
    q(".link-row input[type=url]").value = " https://f.example/y ";
    await submit(form);
    const body = onSubmit.mock.calls[0][0];
    expect(body.first_name).toBe("Anna");
    expect(body.nickname).toBeNull();
    expect(body.sex).toBe("f");
    expect(body.deceased).toBe(1);
    expect(body.unverified).toBe(0);
    q("#pf-unverified").checked = true;
    await submit(form);
    expect(onSubmit.mock.calls[1][0].unverified).toBe(1);
    expect(body.notes).toBe("n");
    expect(body.links).toEqual([{ kind: "facebook", label: null, url: "https://f.example/y" }]);
  });
  it("omits unverified and sends a null sex when a member edits themselves", async () => {
    const onSubmit = vi.fn(async () => {});
    const form = personForm({}, [], { admin: false, onSubmit });
    document.body.append(form);
    await submit(form);
    const body = onSubmit.mock.calls[0][0];
    expect("unverified" in body).toBe(false);
    expect(body.sex).toBeNull();
    expect(body.deceased).toBe(0);
  });
  it("disables Save while saving, shows what went wrong, and re-enables it", async () => {
    let release;
    const onSubmit = vi.fn(() => new Promise((_, reject) => { release = reject; }));
    const form = personForm({}, [], { admin: false, onSubmit });
    document.body.append(form);
    form.showError("old");
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    expect(q("button[type=submit]").disabled).toBe(true);
    expect(q(".error").textContent).toBe("");
    release(new Error("nope"));
    await tick();
    expect(q(".error").textContent).toBe("nope");
    expect(q("button[type=submit]").disabled).toBe(false);
  });
  it("shows a thrown non-Error as text", async () => {
    const form = personForm({}, [], { admin: false, onSubmit: async () => { throw "raw"; } }); // eslint-disable-line no-throw-literal
    document.body.append(form);
    await submit(form);
    expect(q(".error").textContent).toBe("raw");
  });
});

describe("avatarPicker", () => {
  const file = () => new File(["x"], "me.jpg", { type: "image/jpeg" });
  const move = (el, type, clientX, clientY) => el.dispatchEvent(new PointerEvent(type, { clientX, clientY, pointerId: 1 }));

  it("shows the current photo when there is one and hides the crop tools until a file is picked", () => {
    document.body.append(avatarPicker("/api/people/p1/avatar?v=1", { onSave: vi.fn() }));
    expect(q("img.avatar").getAttribute("src")).toBe("/api/people/p1/avatar?v=1");
    expect(q("canvas").hidden).toBe(true);
    expect(q("input[type=range]").hidden).toBe(true);
    expect(q("button.btn").hidden).toBe(true);
    document.body.innerHTML = "";
    document.body.append(avatarPicker(null, { onSave: vi.fn() }));
    expect(q("img.avatar")).toBeNull();
  });
  it("reports an image it cannot read", async () => {
    const { bitmap } = stubCanvas();
    bitmap.mockRejectedValue(new Error("bad"));
    document.body.append(avatarPicker(null, { onSave: vi.fn() }));
    pickFile(q("#avatar-file"), file());
    await tick();
    expect(bitmap).toHaveBeenCalledTimes(2);
    expect(q(".error").textContent).toBe("Nie udało się odczytać obrazu.");
    expect(q("canvas").hidden).toBe(true);
  });
  it("ignores an empty pick", async () => {
    const { bitmap } = stubCanvas();
    document.body.append(avatarPicker(null, { onSave: vi.fn() }));
    pickFile(q("#avatar-file"), null);
    await tick();
    expect(bitmap).not.toHaveBeenCalled();
  });
  it("draws a portrait from near the top, retrying without orientation when the browser refuses it", async () => {
    const { ctx2d, bitmap } = stubCanvas({ width: 600, height: 1000 });
    bitmap.mockRejectedValueOnce(new Error("no options")).mockResolvedValueOnce({ width: 600, height: 1000 });
    document.body.append(avatarPicker(null, { onSave: vi.fn() }));
    pickFile(q("#avatar-file"), file());
    await tick();
    expect(q("canvas").hidden).toBe(false);
    expect(q("input[type=range]").min).toBe("0.6");
    expect(q("input[type=range]").value).toBe("1");
    const [, sx, sy, sw, sh] = ctx2d.drawImage.mock.calls[0];
    expect([sx, sw, sh]).toEqual([0, 600, 600]);
    expect(sy).toBeCloseTo(48);
  });
  it("zooms and pans, and never lets the crop leave the picture", async () => {
    const { ctx2d } = stubCanvas({ width: 800, height: 600 });
    document.body.append(avatarPicker(null, { onSave: vi.fn() }));
    const canvas = q("canvas");
    Object.defineProperty(canvas, "clientWidth", { value: 300 });
    pickFile(q("#avatar-file"), file());
    await tick();
    const zoom = q("input[type=range]");
    zoom.value = "2";
    zoom.dispatchEvent(new Event("input"));
    let [, sx, sy] = ctx2d.drawImage.mock.calls.at(-1);
    expect([sx, sy, ctx2d.drawImage.mock.calls.at(-1)[3]]).toEqual([250, 150, 300]);

    move(canvas, "pointerdown", 100, 100);
    move(canvas, "pointermove", 90, 100);          // 10 css px at side 300 / width 300 = 10 source px
    [, sx, sy] = ctx2d.drawImage.mock.calls.at(-1);
    expect([sx, sy]).toEqual([260, 150]);
    move(canvas, "pointermove", -5000, 5000);
    [, sx, sy] = ctx2d.drawImage.mock.calls.at(-1);
    expect([sx, sy]).toEqual([500, 0]);
    move(canvas, "pointerup", 0, 0);
    const before = ctx2d.drawImage.mock.calls.length;
    move(canvas, "pointermove", 0, 0);
    expect(ctx2d.drawImage.mock.calls.length).toBe(before);
  });
  it("does nothing on a drag or zoom before a file is chosen", () => {
    const { ctx2d } = stubCanvas();
    document.body.append(avatarPicker(null, { onSave: vi.fn() }));
    const canvas = q("canvas");
    q("input[type=range]").dispatchEvent(new Event("input"));
    expect(ctx2d.drawImage).not.toHaveBeenCalled();
    move(canvas, "pointerdown", 1, 1);
    move(canvas, "pointermove", 5, 5);
    move(canvas, "pointercancel", 5, 5);
    expect(canvas.hidden).toBe(true);
  });
  it("saves a JPEG, lowering quality until it fits, and refreshes the current photo", async () => {
    const { toBlob } = stubCanvas();
    const sizes = { 0.85: 300 * 1024, 0.7: 250 * 1024, 0.55: 100 * 1024 };
    toBlob.mockImplementation(function (cb, type, qual) { cb(new Blob(["x".repeat(sizes[qual])], { type })); });
    const onSave = vi.fn(async () => {});
    document.body.append(avatarPicker("/api/people/p1/avatar?v=1", { onSave }));
    pickFile(q("#avatar-file"), file());
    await tick();
    q("button.btn").click();
    await tick();
    expect(toBlob.mock.calls.map((c) => c[2])).toEqual([0.85, 0.7, 0.55]);
    expect(onSave.mock.calls[0][0].size).toBe(100 * 1024);
    expect(q("img.avatar").getAttribute("src")).toMatch(/\/api\/people\/p1\/avatar\?v=\d{13}$/);
    expect(q("button.btn").disabled).toBe(false);
  });
  it("saves fine with no current photo to refresh", async () => {
    stubCanvas();
    const onSave = vi.fn(async () => {});
    document.body.append(avatarPicker(null, { onSave }));
    pickFile(q("#avatar-file"), file());
    await tick();
    q("button.btn").click();
    await tick();
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(q(".error").textContent).toBe("");
  });
  it("keeps the first encoding when it is small enough, and shows a save failure", async () => {
    const { toBlob } = stubCanvas();
    document.body.append(avatarPicker(null, { onSave: async () => { throw new Error("too big"); } }));
    pickFile(q("#avatar-file"), file());
    await tick();
    q("button.btn").click();
    await tick();
    expect(toBlob).toHaveBeenCalledTimes(1);
    expect(q(".error").textContent).toBe("too big");
    expect(q("button.btn").disabled).toBe(false);
  });
  it("gives up quietly when the canvas yields no blob", async () => {
    const { toBlob } = stubCanvas();
    toBlob.mockImplementation((cb) => cb(null));
    const onSave = vi.fn(async () => { throw "x"; }); // eslint-disable-line no-throw-literal
    document.body.append(avatarPicker(null, { onSave }));
    pickFile(q("#avatar-file"), file());
    await tick();
    q("button.btn").click();
    await tick();
    expect(toBlob).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith(null);
    expect(q(".error").textContent).toBe("x");
  });
});

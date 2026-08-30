import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { uploadForm, toastApiError } from "../../public/app/media-upload.js";
import { ApiError } from "../../public/app/api.js";
import { mockApi, appCtx, lang, q, tick, stubCanvas, pickFile } from "./helpers.js";

beforeAll(() => lang("pl"));
afterEach(() => vi.restoreAllMocks());

const photo = () => new File(["x".repeat(2048)], "wedding.jpg", { type: "image/jpeg" });
const pdf = (size = 10) => new File(["x".repeat(size)], "deed.pdf", { type: "application/pdf" });

describe("toastApiError", () => {
  it("names the person whose limit is full, otherwise explains the code or the message", () => {
    const ctx = appCtx();
    const full = new ApiError(409, "conflict"); full.detail = { person: "Anna" };
    toastApiError(ctx, full);
    expect(ctx.toast).toHaveBeenLastCalledWith("Limit Anna: 6 plików — usuń coś najpierw.");
    toastApiError(ctx, new ApiError(500, "internal"));
    expect(ctx.toast).toHaveBeenLastCalledWith("internal");
    toastApiError(ctx, new Error("boom"));
    expect(ctx.toast).toHaveBeenLastCalledWith("boom");
    toastApiError(ctx, "plain");
    expect(ctx.toast).toHaveBeenLastCalledWith("plain");
  });
});

describe("uploadForm", () => {
  const mount = (ctx = appCtx(), reload = vi.fn(async () => {})) => { document.body.append(uploadForm("p1", ctx, reload)); return { ctx, reload }; };

  it("starts as a drop zone with the fields hidden", () => {
    mount();
    expect(q(".media-drop").hidden).toBe(false);
    expect(q(".media-chosen").hidden).toBe(true);
    expect(q(".media-fields").hidden).toBe(true);
  });
  it("refuses a file that is neither a picture nor a PDF, and a PDF that is too large", () => {
    const { ctx } = mount();
    pickFile(q("input[type=file]"), new File(["x"], "a.txt", { type: "text/plain" }));
    expect(ctx.toast).toHaveBeenLastCalledWith("To musi być zdjęcie lub PDF.");
    pickFile(q("input[type=file]"), pdf(10 * 1024 * 1024 + 1));
    expect(ctx.toast).toHaveBeenLastCalledWith("Plik jest za duży (limit 10 MB).");
    expect(q(".media-drop").hidden).toBe(false);
  });
  it("previews a picked photo with its name and size, and clears back to the drop zone", () => {
    const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:preview");
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    mount();
    pickFile(q("input[type=file]"), photo());
    expect(q(".media-drop").hidden).toBe(true);
    expect(q(".media-chosen").hidden).toBe(false);
    expect(q(".media-fields").hidden).toBe(false);
    expect(q(".media-name").textContent).toBe("wedding.jpg");
    expect(q(".media-meta .muted").textContent).toBe("2,0 kB");
    expect(q(".media-preview img").getAttribute("src")).toBe("blob:preview");
    expect(create).toHaveBeenCalledTimes(1);
    q('[aria-label="Wyczyść"], .media-chosen .icon-btn').click();
    expect(revoke).toHaveBeenCalledWith("blob:preview");
    expect(q(".media-drop").hidden).toBe(false);
    expect(q(".media-fields").hidden).toBe(true);
  });
  it("shows a document icon for a PDF, and ignores an empty pick", () => {
    mount();
    pickFile(q("input[type=file]"), pdf());
    expect(q(".media-preview").classList.contains("doc")).toBe(true);
    expect(q(".media-preview svg")).not.toBeNull();
    expect(q(".media-preview img")).toBeNull();
    document.body.innerHTML = "";
    mount();
    pickFile(q("input[type=file]"), null);
    expect(q(".media-drop").hidden).toBe(false);
  });
  it("highlights the zone while a file is dragged over it and takes the dropped file", () => {
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:p");
    mount();
    const zone = q(".media-drop");
    const fire = (type, files) => {
      const ev = new Event(type, { bubbles: true, cancelable: true });
      if (files) Object.defineProperty(ev, "dataTransfer", { value: { files } });
      zone.dispatchEvent(ev);
      return ev;
    };
    expect(fire("dragenter").defaultPrevented).toBe(true);
    fire("dragover");
    expect(zone.classList.contains("is-over")).toBe(true);
    fire("dragleave");
    expect(zone.classList.contains("is-over")).toBe(false);
    fire("dragover");
    fire("drop", []);
    expect(zone.classList.contains("is-over")).toBe(false);
    expect(zone.hidden).toBe(false);
    fire("drop", [photo()]);
    expect(zone.hidden).toBe(true);
    expect(q(".media-name").textContent).toBe("wedding.jpg");
  });
  // The fetch stub hands the mock only the pathname, so the query is checked on fetch itself.
  const sent = () => vi.spyOn(globalThis, "fetch");

  it("uploads a document as-is with the caption and year in the query, then reloads", async () => {
    const calls = mockApi({ "POST /api/media": { id: "m1" } });
    const fetched = sent();
    const { ctx, reload } = mount();
    pickFile(q("input[type=file]"), pdf());
    q('input[type="text"]').value = " Deed ";
    q('input[type="number"]').value = "1910";
    q(".media-fields .btn").click();
    expect(q(".media-fields .btn").disabled).toBe(true);
    expect(q(".media-fields .btn").textContent).toBe("Wysyłanie…");
    await tick();
    expect(calls.length).toBe(1);
    expect(fetched.mock.calls[0][0]).toBe("/api/media?owner=p1&kind=document&caption=Deed&year=1910");
    expect(calls[0].body).toBeInstanceOf(File);
    expect(ctx.toast).toHaveBeenCalledWith("Plik zapisany.");
    expect(reload).toHaveBeenCalledTimes(1);
  });
  it("re-encodes a photo to JPEG, then adds a thumbnail, and shrugs when the thumbnail fails", async () => {
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:p");
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const { toBlob, bitmap } = stubCanvas({ width: 4000, height: 2000 });
    bitmap.mockRejectedValueOnce(new Error("no options")).mockResolvedValue({ width: 4000, height: 2000 });
    const calls = mockApi({ "POST /api/media": { id: "m7" }, "PUT /api/media/m7/thumb": { status: 500, body: { error: "internal" } } });
    const fetched = sent();
    const { ctx, reload } = mount();
    pickFile(q("input[type=file]"), photo());
    q(".media-fields .btn").click();
    await tick();
    expect(calls.map((c) => `${c.method} ${c.path.split("?")[0]}`)).toEqual(["POST /api/media", "PUT /api/media/m7/thumb"]);
    expect(fetched.mock.calls[0][0]).toBe("/api/media?owner=p1&kind=photo");
    expect(calls[0].body.type).toBe("image/jpeg");
    expect(toBlob.mock.calls.map((c) => c[2])).toEqual([0.85, 0.8]);
    const sizes = toBlob.mock.contexts.map((c) => `${c.width}x${c.height}`);
    expect(sizes).toEqual(["2048x1024", "400x200"]);
    expect(revoke).toHaveBeenCalledWith("blob:p");
    expect(ctx.toast).toHaveBeenCalledWith("Plik zapisany.");
    expect(reload).toHaveBeenCalledTimes(1);
  });
  it("does not enlarge a small photo", async () => {
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:p");
    const { toBlob } = stubCanvas({ width: 300, height: 200 });
    mockApi({ "POST /api/media": { id: "m1" }, "PUT /api/media/m1/thumb": {} });
    mount();
    pickFile(q("input[type=file]"), photo());
    q(".media-fields .btn").click();
    await tick();
    expect(toBlob.mock.contexts.map((c) => `${c.width}x${c.height}`)).toEqual(["300x200", "300x200"]);
  });
  it("reports a photo it cannot decode and lets the user try again", async () => {
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:p");
    const { bitmap } = stubCanvas();
    bitmap.mockRejectedValue(new Error("bad"));
    const calls = mockApi({});
    const { ctx, reload } = mount();
    pickFile(q("input[type=file]"), photo());
    q(".media-fields .btn").click();
    await tick();
    expect(calls.length).toBe(0);
    expect(ctx.toast).toHaveBeenLastCalledWith("Nie udało się odczytać obrazu.");
    expect(reload).not.toHaveBeenCalled();
    expect(q(".media-fields .btn").disabled).toBe(false);
    expect(q(".media-fields .btn").textContent).toBe("Dodaj plik");
  });
  it("explains a full archive and keeps the file chosen", async () => {
    mockApi({ "POST /api/media": { status: 409, body: { error: "conflict", person: "Anna" } } });
    const { ctx, reload } = mount();
    pickFile(q("input[type=file]"), pdf());
    q(".media-fields .btn").click();
    await tick();
    expect(ctx.toast).toHaveBeenLastCalledWith("Limit Anna: 6 plików — usuń coś najpierw.");
    expect(reload).not.toHaveBeenCalled();
    expect(q(".media-chosen").hidden).toBe(false);
  });
  it("does nothing when Send is pressed with no file", async () => {
    const calls = mockApi({});
    mount();
    q(".media-fields .btn").click();
    await tick();
    expect(calls.length).toBe(0);
  });
});

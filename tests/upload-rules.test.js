import { describe, it, expect } from "vitest";
import { pickKind, formatSize } from "../public/app/upload-rules.js";

const file = (type, size) => ({ type, size });

describe("pickKind", () => {
  it("calls an image a photo whatever its size, since the browser re-encodes it before upload", () => {
    expect(pickKind(file("image/jpeg", 40 * 1024 * 1024))).toEqual({ kind: "photo" });
    expect(pickKind(file("image/png", 1))).toEqual({ kind: "photo" });
    expect(pickKind(file("image/heic", 1))).toEqual({ kind: "photo" });
  });

  it("calls a PDF a document up to 10 MB and refuses it past that", () => {
    expect(pickKind(file("application/pdf", 10 * 1024 * 1024))).toEqual({ kind: "document" });
    expect(pickKind(file("application/pdf", 10 * 1024 * 1024 + 1))).toEqual({ error: "toobig" });
  });

  it("refuses anything else, which only a drop can produce", () => {
    expect(pickKind(file("video/mp4", 1))).toEqual({ error: "badtype" });
    expect(pickKind(file("", 1))).toEqual({ error: "badtype" });
  });
});

describe("formatSize", () => {
  it("keeps bytes whole and gives one decimal only below ten of a larger unit", () => {
    expect(formatSize(0)).toBe("0 B");
    expect(formatSize(999)).toBe("999 B");
    expect(formatSize(1024)).toBe("1.0 kB");
    expect(formatSize(1024 * 512)).toBe("512 kB");
    expect(formatSize(1024 * 1024 * 2.4)).toBe("2.4 MB");
  });

  it("stops at megabytes rather than inventing a unit nobody uploads", () => {
    expect(formatSize(1024 ** 3)).toBe("1,024 MB");
  });

  it("writes the separator the reader's language uses", () => {
    expect(formatSize(1024 * 1024 * 2.4, "pl")).toBe("2,4 MB");
  });
});

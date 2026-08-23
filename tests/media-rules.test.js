import { describe, it, expect } from "vitest";
import { isPdf, checkPhoto, checkDocument, cleanCaption, cleanYear, MEDIA_CAP, PHOTO_MAX_BYTES, DOC_MAX_BYTES } from "../src/media/rules.js";
import { ApiError } from "../src/api/common.js";
import { fakeJpeg } from "./helpers/jpeg.js";

const pdf = (pad = 0) => new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, ...new Array(pad).fill(0x20)]);

describe("rules", () => {
  it("constants", () => { expect(MEDIA_CAP).toBe(6); expect(PHOTO_MAX_BYTES).toBe(2_097_152); expect(DOC_MAX_BYTES).toBe(10_485_760); });
  it("isPdf checks the magic bytes", () => {
    expect(isPdf(pdf())).toBe(true);
    expect(isPdf(fakeJpeg(10, 10))).toBe(false);
    expect(isPdf(new Uint8Array(2))).toBe(false);
  });
  it("checkPhoto: JPEG within limits → image/jpeg; rejects big/wrong", () => {
    expect(checkPhoto(fakeJpeg(2048, 1024))).toBe("image/jpeg");
    expect(() => checkPhoto(fakeJpeg(2049, 100))).toThrow(ApiError);
    expect(() => checkPhoto(pdf())).toThrow(ApiError);
    expect(() => checkPhoto(new Uint8Array(0))).toThrow(ApiError);
  });
  it("checkDocument accepts pdf and jpeg, rejects others", () => {
    expect(checkDocument(pdf(), "application/pdf")).toBe("application/pdf");
    expect(checkDocument(fakeJpeg(4000, 4000), "image/jpeg")).toBe("image/jpeg");   // scans may exceed 2048 px
    expect(() => checkDocument(new Uint8Array([1, 2, 3, 4, 5]), "application/pdf")).toThrow(ApiError);
    expect(() => checkDocument(pdf(), "text/html")).toThrow(ApiError);
  });
  it("cleanCaption trims, caps at 200, nulls empty; cleanYear bounds or null", () => {
    expect(cleanCaption("  Ślub w Zielonce  ")).toBe("Ślub w Zielonce");
    expect(cleanCaption("")).toBe(null);
    expect(cleanCaption(undefined)).toBe(null);
    expect(() => cleanCaption("x".repeat(201))).toThrow(ApiError);
    expect(cleanYear("1962")).toBe(1962);
    expect(cleanYear(undefined)).toBe(null);
    expect(cleanYear("")).toBe(null);
    for (const bad of ["999", "3000", "abc", "19.5"]) expect(() => cleanYear(bad), bad).toThrow(ApiError);
  });
});

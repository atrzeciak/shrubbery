import { describe, it, expect } from "vitest";
import { jpegSize } from "../src/people/jpeg.js";
import { fakeJpeg } from "./helpers/jpeg.js";

describe("jpegSize", () => {
  it("reads SOF dimensions", () => expect(jpegSize(fakeJpeg(512, 384))).toEqual({ width: 512, height: 384 }));
  it("returns null for non-JPEG or truncated input", () => {
    expect(jpegSize(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe(null);
    expect(jpegSize(fakeJpeg(10, 10).slice(0, 6))).toBe(null);
    expect(jpegSize(new Uint8Array(0))).toBe(null);
  });
});

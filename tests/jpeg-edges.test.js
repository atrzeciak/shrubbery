import { describe, expect, it } from "vitest";
import { jpegSize } from "../src/people/jpeg.js";

const SOF = (w, h) => [0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 0xff, w >> 8, w & 0xff, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
const jpeg = (...between) => new Uint8Array([0xff, 0xd8, ...between.flat(), ...SOF(64, 32), 0xff, 0xd9]);

describe("jpegSize walking the marker segments", () => {
  it("steps over fill bytes and the standalone markers that carry no length", () => {
    expect(jpegSize(jpeg([0xff, 0xff, 0xff]))).toEqual({ width: 64, height: 32 });          // 0xff padding
    expect(jpegSize(jpeg([0xff, 0xd0], [0xff, 0xd7]))).toEqual({ width: 64, height: 32 }); // RSTn
    expect(jpegSize(jpeg([0xff, 0x01], [0xff, 0xd8]))).toEqual({ width: 64, height: 32 }); // TEM, a second SOI
  });

  it("reads the frame header from a progressive or extended JPEG too", () => {
    for (const marker of [0xc1, 0xc2]) {
      const bytes = jpeg();
      bytes[3] = marker;
      expect(jpegSize(bytes)).toEqual({ width: 64, height: 32 });
    }
  });

  it("gives up on a byte where a marker should be", () => {
    expect(jpegSize(jpeg([0x00, 0x00, 0x00, 0x00]))).toBe(null);
  });

  it("gives up on a segment claiming a length shorter than its own length field", () => {
    expect(jpegSize(jpeg([0xff, 0xe0, 0x00, 0x01]))).toBe(null);
  });

  it("gives up when the scan or the end of image arrives before any frame header", () => {
    expect(jpegSize(jpeg([0xff, 0xda, 0x00, 0x02]))).toBe(null);
    expect(jpegSize(jpeg([0xff, 0xd9, 0x00, 0x02]))).toBe(null);
  });

  it("gives up on a stream that ends inside a segment", () => {
    expect(jpegSize(jpeg([0xff, 0xe0, 0x7f, 0xff]))).toBe(null);
    expect(jpegSize("not bytes")).toBe(null);
  });
});

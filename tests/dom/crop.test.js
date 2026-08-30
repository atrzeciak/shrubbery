import { describe, it, expect } from "vitest";
import { initialCrop, minZoom, clampCrop } from "../../public/app/crop.js";

describe("initialCrop", () => {
  it("centres the square on a landscape or square image", () => {
    expect(initialCrop(800, 600)).toEqual({ cx: 400, cy: 300, side: 600 });
    expect(initialCrop(500, 500)).toEqual({ cx: 250, cy: 250, side: 500 });
  });
  it("starts near the top of a portrait, where the head is", () => {
    const { cx, cy, side } = initialCrop(600, 1000);
    expect(side).toBe(600);
    expect(cx).toBe(300);
    expect(cy).toBeCloseTo(300 + 400 * 0.12);
  });
  it("shrinks the square with zoom", () => {
    expect(initialCrop(800, 600, 2).side).toBe(300);
  });
});

describe("minZoom", () => {
  it("is the ratio of short side to long side, so the whole photo can fit", () => {
    expect(minZoom(800, 600)).toBe(0.75);
    expect(minZoom(600, 800)).toBe(0.75);
    expect(minZoom(500, 500)).toBe(1);
  });
});

describe("clampCrop", () => {
  it("keeps the square inside the image", () => {
    expect(clampCrop(0, 0, 200, 800, 600)).toEqual({ cx: 100, cy: 100 });
    expect(clampCrop(9999, 9999, 200, 800, 600)).toEqual({ cx: 700, cy: 500 });
    expect(clampCrop(400, 300, 200, 800, 600)).toEqual({ cx: 400, cy: 300 });
  });
  it("centres an axis the square is wider than", () => {
    expect(clampCrop(50, 50, 700, 800, 600)).toEqual({ cx: 350, cy: 300 });
  });
});

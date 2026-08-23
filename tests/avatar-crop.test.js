import { describe, expect, it } from "vitest";
import { clampCrop, initialCrop, minZoom } from "../public/app/crop.js";

const inside = ({ cx, cy, side }, w, h) =>
  cx - side / 2 >= 0 && cy - side / 2 >= 0 && cx + side / 2 <= w && cy + side / 2 <= h;

describe("initialCrop", () => {
  it("starts a tall portrait near the top, where the face is", () => {
    const c = initialCrop(208, 611);
    expect(c.side).toBe(208);
    expect(c.cy - c.side / 2).toBeCloseTo(48.36, 1);   // a small margin above the hair
    expect(c.cy).toBeLessThan(611 / 2);                 // not the torso
    expect(inside(c, 208, 611)).toBe(true);
  });

  it("centres a square or landscape photo", () => {
    for (const [w, h] of [[600, 600], [1200, 800]]) {
      const c = initialCrop(w, h);
      expect([c.cx, c.cy]).toEqual([w / 2, h / 2]);
      expect(inside(c, w, h)).toBe(true);
    }
  });

  it("keeps the crop inside the image at any zoom", () => {
    for (const zoom of [1, 1.5, 3]) {
      for (const [w, h] of [[208, 611], [900, 300], [400, 400]]) {
        expect(inside(initialCrop(w, h, zoom), w, h)).toBe(true);
      }
    }
  });
});

describe("zooming out to fit", () => {
  it("lets a tall photo zoom out until the whole image fits", () => {
    const z = minZoom(208, 611);
    expect(z).toBeCloseTo(208 / 611, 5);
    const { side } = initialCrop(208, 611, z);
    expect(side).toBeCloseTo(611, 5);            // the long side: the entire photo
  });

  it("centres an axis the crop has outgrown, instead of pinning it off-image", () => {
    const c = clampCrop(104, 0, 611, 208, 611);  // crop wider than the image
    expect(c.cx).toBe(104);                       // centred horizontally, blank at the sides
    expect(c.cy).toBeCloseTo(305.5, 1);
  });

  it("still pans within the image when the crop is smaller", () => {
    expect(clampCrop(0, 0, 208, 208, 611).cy).toBe(104);        // pushed back inside the top edge
    expect(clampCrop(104, 999, 208, 208, 611).cy).toBe(507);    // and the bottom edge
  });
});

import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { personPicker } from "../../public/app/picker.js";
import { openSheet, closeSheet } from "../../public/app/sheet.js";
import { lang, q, qa } from "./helpers.js";

beforeAll(() => lang("en"));
afterEach(() => closeSheet());

// Two people share a name: typing cannot tell them apart, so the keyboard has to be able to choose.
const people = [
  { id: "a", display_name: "Jan Nowak", birth_date: "1950" },
  { id: "b", display_name: "Jan Nowak", birth_date: "1980" },
  { id: "c", display_name: "Ewa Kowal" },
];
const g = { parents: () => [], byId: new Map(people.map((p) => [p.id, p])) };
const key = (el, k) => el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));

function mount() {
  const picker = personPicker(g, people, { id: "pick", placeholder: "Who?" });
  openSheet(picker.el, "Link");
  const input = q("#pick");
  input.focus();
  input.value = "nowak";
  input.dispatchEvent(new Event("input"));
  return { picker, input };
}

describe("personPicker", () => {
  it("lets the keyboard walk the matches and choose one", () => {
    const { picker, input } = mount();
    expect(qa(".picker li").length).toBe(2);
    key(input, "ArrowDown");
    key(input, "ArrowDown");
    expect(qa('.picker li[aria-selected="true"]').length).toBe(1);
    key(input, "Enter");
    expect(picker.value()).toBe("b");
  });

  it("closes only its own list on Escape, and the card on the next one", () => {
    const { input } = mount();
    key(input, "Escape");
    expect(q(".picker").hidden).toBe(true);
    expect(q(".sheet")).not.toBeNull();
    key(input, "Escape");
    expect(q(".sheet")).toBeNull();
  });
});

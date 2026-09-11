import { s } from "./dom.js";
import { initials, lifeSpan } from "./graph.js";
import { avatarUrl } from "./people.js";

// How one person is drawn in the tree. A style owns the cell size (W, H), the gaps between cells
// (GX, GY), the node itself, and the three places a line meets it: `mid`, the y of the couple line;
// `foot`, the y a lone parent's drop starts from; `side`, the x where the couple line touches the
// node coming from direction `dir`. Layout and connectors in views/tree.js read only these.

const clip = (str, n) => (str && str.length > n ? `${str.slice(0, n - 1)}…` : str || "");

// The <g> every style shares: at the cell's centre x and top y, focusable, a button.
function group(n, p, { onTap, focus }, x, y) {
  return s("g", { class: `node ${n.role || ""}${focus === n.id ? " is-focus" : ""}`, transform: `translate(${x} ${y})`, tabindex: "0", role: "button", "aria-label": p.display_name, onclick: () => onTap(n.id), onkeydown: (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); onTap(n.id); } } });
}

// The photo clipped to a circle, or the initials where there is none. `drop` is the initials'
// baseline below the centre, which depends on the face each style uses.
function avatar(g, n, cx, cy, r, drop) {
  const url = avatarUrl(g, n.id);
  if (!url) return [s("text", { x: cx, y: cy + drop, "text-anchor": "middle", class: "initials", text: initials(g.byId.get(n.id)) })];
  const clipId = `clip-${n.id}`;
  return [s("clipPath", { id: clipId }, s("circle", { cx, cy, r: r - 2 })), s("image", { href: url, x: cx - r + 2, y: cy - r + 2, width: 2 * r - 4, height: 2 * r - 4, "clip-path": `url(#${clipId})`, preserveAspectRatio: "xMidYMid slice" })];
}

// The tall card: a ring with the portrait, the name on one or two lines, the years, the
// unverified mark. The original drawing, kept so the site can go back to it.
const R = 32;
const classic = {
  W: 120, H: 180, GX: 40, GY: 60,
  mid: (n) => n.row * (180 + 60) + R,
  foot: (n) => n.row * (180 + 60) + 2 * R + 80,
  side: (n) => n.col * (120 + 40),
  node(g, n, opts) {
    const p = g.byId.get(n.id);
    const grp = group(n, p, opts, n.col * (this.W + this.GX), n.row * (this.H + this.GY));
    grp.append(s("circle", { cx: 0, cy: R, r: R, class: "avatar-ring" }), ...avatar(g, n, 0, R, R, 6));
    const words = (p.display_name || "").split(" ");
    const [line1, line2] = p.first_name || p.last_name
      ? [p.first_name || "", p.last_name || ""]
      : [words[0] || "", words.slice(1).join(" ")];
    grp.append(s("text", { x: 0, y: 2 * R + 20, "text-anchor": "middle", class: "name", text: clip(line1, 16) }));
    if (line2) grp.append(s("text", { x: 0, y: 2 * R + 38, "text-anchor": "middle", class: "name", text: clip(line2, 16) }));
    grp.append(s("text", { x: 0, y: 2 * R + 56, "text-anchor": "middle", class: "years", text: lifeSpan(p) }));
    if (p.unverified) grp.append(s("text", { x: 0, y: 2 * R + 72, "text-anchor": "middle", class: "years", text: "?" }));
    return grp;
  },
};

export const styles = { classic };

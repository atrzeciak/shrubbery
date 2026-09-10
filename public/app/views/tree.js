import { h, s, clear } from "../dom.js";
import { t } from "../i18n.js";
import { initials, lifeSpan, yearOf } from "../graph.js";
import { focusLayout, familyLayout } from "../tree-layout.js";
import { loadGraph, avatarUrl } from "../people.js";
import { openSheet } from "../sheet.js";
import { personPicker } from "../picker.js";
import { personCard } from "../person-card.js";

const W = 120, H = 180, GX = 40, GY = 60, R = 32;
let mode = localStorage.getItem("treeMode") || "focus";

function defaultFocus(g, me) {
  if (me.person_id && g.byId.has(me.person_id)) return me.person_id;
  const roots = g.people.filter((p) => g.parents(p.id).length === 0);
  const pool = roots.length ? roots : g.people;
  return pool.slice().sort((a, b) => (yearOf(a.birth_date) ?? 99999) - (yearOf(b.birth_date) ?? 99999))[0]?.id || null;
}

function node(g, n, { onTap, focus }) {
  const p = g.byId.get(n.id);
  const x = n.col * (W + GX), y = n.row * (H + GY);
  const url = avatarUrl(g, n.id);
  const grp = s("g", { class: `node ${n.role || ""}${focus === n.id ? " is-focus" : ""}`, transform: `translate(${x} ${y})`, tabindex: "0", role: "button", "aria-label": p.display_name, onclick: () => onTap(n.id), onkeydown: (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); onTap(n.id); } } });
  grp.append(s("circle", { cx: 0, cy: R, r: R, class: "avatar-ring" }));
  if (url) {
    const clipId = `clip-${n.id}`;
    const clipRef = `url(#${clipId})`;
    grp.append(s("clipPath", { id: clipId }, s("circle", { cx: 0, cy: R, r: R - 2 })), s("image", { href: url, x: -R + 2, y: 2, width: 2 * R - 4, height: 2 * R - 4, "clip-path": clipRef, preserveAspectRatio: "xMidYMid slice" }));
  } else grp.append(s("text", { x: 0, y: R + 6, "text-anchor": "middle", class: "initials", text: initials(p) }));
  const clip = (str, n) => (str && str.length > n ? `${str.slice(0, n - 1)}…` : str || "");
  const words = (p.display_name || "").split(" ");
  const [line1, line2] = p.first_name || p.last_name
    ? [p.first_name || "", p.last_name || ""]
    : [words[0] || "", words.slice(1).join(" ")];
  grp.append(s("text", { x: 0, y: 2 * R + 20, "text-anchor": "middle", class: "name", text: clip(line1, 16) }));
  if (line2) grp.append(s("text", { x: 0, y: 2 * R + 38, "text-anchor": "middle", class: "name", text: clip(line2, 16) }));
  grp.append(s("text", { x: 0, y: 2 * R + 56, "text-anchor": "middle", class: "years", text: lifeSpan(p) }));
  if (p.unverified) grp.append(s("text", { x: 0, y: 2 * R + 72, "text-anchor": "middle", class: "years", text: "?" }));
  return grp;
}

const X = (n) => n.col * (W + GX), Y = (n) => n.row * (H + GY);
const KIND = { married: "married", partner: "unmarried", divorced: "divorced", coparents: "coparents" };

const adjacent = (a, b) => Math.abs(a.col - b.col) === 1;
const cell = (pos, row, col) => [...pos.values()].find((n) => n.row === row && n.col === col);
// Half a column inside `from`, toward `to`: between two people, never through one.
const beside = (from, to) => X(from) + Math.sign(X(to) - X(from)) * (W + GX) / 2;
// A couple with someone between them is joined by a bridge above the row; a longer span rides higher.
const bridgeTop = (a, b) => Y(a) - 16 - 14 * (Math.abs(a.col - b.col) - 2);
// The end of a couple's span where the row is not already taken by one of their other partners,
// so a strike or a drop placed there belongs unmistakably to this couple.
function clearEnd(g, pos, a, b) {
  const dir = Math.sign(b.col - a.col);
  const taken = (n, d) => { const m = cell(pos, n.row, n.col + d); return !!m && g.partners(n.id).some((q) => q.id === m.id); };
  return !taken(a, dir) ? a : !taken(b, -dir) ? b : null;
}

// The genealogist's conventions: a marriage is a solid line, a partnership a dashed one, a
// divorce a dashed line struck through.
// `bridges` collects the horizontal stretch of every bridge drawn, so a family line can hop it.
function partnerEdges(g, pos, e, bridges) {
  const a = pos.get(e.from), b = pos.get(e.to), cls = `edge partner ${KIND[e.kind] || "married"}`;
  let out, sx, sy;
  if (adjacent(a, b)) { sy = Y(a) + R; sx = (X(a) + X(b)) / 2; out = [s("line", { x1: X(a), y1: sy, x2: X(b), y2: sy, class: cls })]; }
  else {
    sy = bridgeTop(a, b);
    const end = clearEnd(g, pos, a, b) || a;
    sx = beside(end, end === a ? b : a);
    out = [s("path", { d: `M${X(a)} ${Y(a)} V${sy} H${X(b)} V${Y(b)}`, class: cls })];
    bridges.push({ y: sy, x0: Math.min(X(a), X(b)), x1: Math.max(X(a), X(b)), owner: e });
  }
  if (e.kind === "divorced") out.push(s("path", { d: `M${sx - 7} ${sy + 6} l5 -12 M${sx + 2} ${sy + 6} l5 -12`, class: "edge divorce" }));
  return out;
}

// One drop per family to a bar the children hang from, so siblings read as siblings. A couple's
// drop leaves their line halfway between them, or, when someone else sits between them, from the
// clear end of their bridge. Parents who were never partners have no line to leave from, so the
// drop starts below the row.
// The foot of a node: below the name, the years and the unverified mark.
const FOOT = 2 * R + 80;

function familyTop(g, pos, parents, children, coupled) {
  const below = Y(parents[0]) + FOOT;
  if (parents.length === 1) return { x: X(parents[0]), y: below };
  const [a, b] = parents;
  // Two parents with no line between them (one descends from the other, a data error the layout
  // tolerates) each drop from their own feet, and the children's bar is what joins them.
  if (!coupled) return { x: X(a), y: below, also: { x: X(b), y: Y(b) + FOOT } };
  if (adjacent(a, b)) return { x: (X(a) + X(b)) / 2, y: Y(a) + R };
  const cx = children.reduce((sum, c) => sum + X(c), 0) / children.length;
  const nearer = Math.abs(X(a) - cx) <= Math.abs(X(b) - cx) ? a : b;
  const end = clearEnd(g, pos, a, b) || nearer;
  return { x: beside(end, end === a ? b : a), y: bridgeTop(a, b) };
}
const drops = (top) => (top.also ? [top, top.also] : [top]);

// Bars of neighbouring families in one row sit at different heights so they cannot merge:
// `height` 0 is the topmost of four, 14px apart around the middle of the gap.
function familyGeometry({ parents, children, top }, height) {
  const y2 = Y(children[0]) - 4, ym = (Math.max(...parents.map(Y)) + FOOT + y2) / 2 + 14 * (height - 1);
  const xs = children.map(X), tx = drops(top).map((t) => t.x);
  return { top, ym, y2, xs, tx, x0: Math.min(...tx, ...xs), x1: Math.max(...tx, ...xs) };
}

// The order of the bars in one row, top to bottom, chosen so that as few lines as possible have
// to cross a bar: a bar is crossed by the children's lines of every family above it and by the
// drop of every family below it. Each family goes in where it adds the fewest crossings. Bars
// that overlap keep that order; otherwise a bar simply differs from its neighbour's, as before.
function stack(units) {
  const geom = units.map((u) => familyGeometry(u, 1));
  // The ends count too: a line at the end of another bar would run along that family's own line.
  const within = (x, m) => x >= m.x0 && x <= m.x1;
  const overlap = (a, b) => geom[a].x0 <= geom[b].x1 && geom[b].x0 <= geom[a].x1;
  const cost = (a, b) => geom[a].xs.filter((x) => within(x, geom[b])).length + geom[b].tx.filter((x) => within(x, geom[a])).length;
  const order = [];
  units.forEach((u, i) => {
    let at = 0, least = Infinity;
    for (let k = 0; k <= order.length; k++) {
      const c = order.slice(0, k).reduce((sum, j) => sum + cost(j, i), 0) + order.slice(k).reduce((sum, j) => sum + cost(i, j), 0);
      if (c < least) { least = c; at = k; }
    }
    order.splice(at, 0, i);
  });
  const height = new Map();
  for (const i of order) {
    const lo = Math.max(0, ...[...height.keys()].filter((j) => overlap(i, j)).map((j) => height.get(j) + 1));
    const taken = [height.get(i - 1), height.get(i + 1)];
    let h = lo;
    for (let c = lo; c <= 3; c++) if (!taken.includes(c)) { h = c; break; }
    height.set(i, Math.min(3, h));
  }
  return units.map((u, i) => [u, height.get(i)]);
}

// A stroke straight down from ya to yb. Where it would cut a horizontal of some other line, it
// hops over it instead, so a crossing the layout could not avoid never reads as a junction.
function vertical(x, ya, yb, mine, horizontals) {
  const cuts = [...new Set(horizontals.filter((h) => h.owner !== mine && x > h.x0 && x < h.x1 && h.y > ya && h.y < yb).map((h) => h.y))].sort((p, q) => p - q);
  return cuts.map((y) => ` V${y - 6} a6 6 0 0 1 0 12`).join("") + ` V${yb}`;
}

function familyPath(u, horizontals) {
  const { top, ym, y2, xs, x0, x1 } = u.geom;
  let d = drops(top).map((t) => `M${t.x} ${t.y}` + vertical(t.x, t.y, ym, u, horizontals)).join(" ");
  if (x0 !== x1) d += ` M${x0} ${ym} H${x1}`;
  for (const x of xs) d += ` M${x} ${ym}` + vertical(x, ym, y2, u, horizontals);
  return s("path", { d, class: "edge family" });
}

function familyShapes(g, pos, edges, bridges) {
  const coupled = new Set(edges.filter((e) => e.type === "partner").map((e) => [e.from, e.to].sort().join("|")));
  const units = [];
  for (const e of edges) {
    if (e.type !== "family") continue;
    units.push({ parents: e.parents.map((id) => pos.get(id)), children: e.children.map((id) => pos.get(id)), coupled: coupled.has(e.parents.join("|")) });
  }
  for (const u of units) u.top = familyTop(g, pos, u.parents, u.children, u.coupled);
  units.sort((a, b) => a.top.x - b.top.x);
  const rows = new Map();
  for (const u of units) { const row = Y(u.parents[0]); rows.set(row, [...(rows.get(row) || []), u]); }
  for (const group of rows.values()) for (const [u, height] of stack(group)) u.geom = familyGeometry(u, height);
  const horizontals = [...bridges, ...units.filter((u) => u.geom.x0 !== u.geom.x1).map((u) => ({ y: u.geom.ym, x0: u.geom.x0, x1: u.geom.x1, owner: u }))];
  return units.map((u) => familyPath(u, horizontals));
}

function legend() {
  const sample = (...shapes) => s("svg", { class: "tree sample", viewBox: "0 0 36 16", "aria-hidden": "true" }, ...shapes);
  const line = (cls) => s("line", { x1: 2, y1: 8, x2: 34, y2: 8, class: `edge partner ${cls}` });
  const items = [
    ["married", sample(line("married"))],
    ["unmarried", sample(line("unmarried"))],
    ["divorced", sample(line("divorced"), s("path", { d: "M11 14 l5 -12 M20 14 l5 -12", class: "edge divorce" }))],
    ["coparents", sample(line("coparents"))],
    ["children", sample(s("path", { d: "M18 1 V8 M6 8 H30 M6 8 V15 M30 8 V15", class: "edge family" }))],
  ];
  return h("ul", { class: "tree-legend" }, ...items.map(([key, svg]) => h("li", {}, svg, h("span", { text: t(`tree.legend.${key}`) }))));
}

function drawSvg(g, layout, opts) {
  const pos = new Map(layout.nodes.map((n) => [n.id, n]));
  const cols = layout.nodes.map((n) => n.col), rows = layout.nodes.map((n) => n.row);
  const minX = Math.min(...cols) * (W + GX) - W / 2 - 10, maxX = Math.max(...cols) * (W + GX) + W / 2 + 10;
  const minY = Math.min(...rows) * (H + GY) - 10, maxY = Math.max(...rows) * (H + GY) + H + 10;
  const svg = s("svg", { class: "tree", viewBox: `${minX} ${minY} ${maxX - minX} ${maxY - minY}`, role: "group", "aria-label": t("tree.title") });
  const edges = s("g", { class: "edges" });
  const bridges = [];
  const partners = layout.edges.filter((e) => e.type === "partner").flatMap((e) => partnerEdges(g, pos, e, bridges));
  edges.append(...familyShapes(g, pos, layout.edges, bridges), ...partners);
  svg.append(edges);
  for (const n of layout.nodes) svg.append(node(g, n, opts));
  svg.bounds = { minX, minY, w: maxX - minX, h: maxY - minY };
  svg.pos = pos;
  return svg;
}

// Pan (drag), pinch and wheel zoom, ± buttons — all by rewriting the viewBox.
function panZoom(svg) {
  let vb = { ...svg.bounds, x: svg.bounds.minX, y: svg.bounds.minY };
  const apply = () => svg.setAttribute("viewBox", `${vb.x} ${vb.y} ${vb.w} ${vb.h}`);
  const scale = () => vb.w / svg.clientWidth;
  const zoomAt = (f, cx, cy) => {
    const r = svg.getBoundingClientRect();
    const px = vb.x + ((cx - r.left) / r.width) * vb.w, py = vb.y + ((cy - r.top) / r.height) * vb.h;
    vb = { x: px - (px - vb.x) * f, y: py - (py - vb.y) * f, w: vb.w * f, h: vb.h * f };
    apply();
  };
  const pointers = new Map();
  let last = null, moved = false;
  // Pointer capture is grabbed only once a drag is confirmed (not on every pointerdown): Chrome
  // retargets the trailing "click" event to the capturing element, which would swallow plain taps
  // on a node before they reach its own click handler.
  const captureAll = () => { for (const id of pointers.keys()) { try { svg.setPointerCapture(id); } catch (e) { if (e.name !== "NotFoundError" && e.name !== "InvalidStateError") throw e; } } };
  svg.addEventListener("pointerdown", (ev) => { pointers.set(ev.pointerId, ev); last = null; moved = false; });
  svg.addEventListener("pointermove", (ev) => {
    if (!pointers.has(ev.pointerId)) return;
    pointers.set(ev.pointerId, ev);
    const pts = [...pointers.values()];
    if (pts.length === 1) {
      if (last) { const dx = ev.clientX - last.x, dy = ev.clientY - last.y; if (Math.abs(dx) + Math.abs(dy) > 2) { if (!moved) captureAll(); moved = true; } vb.x -= dx * scale(); vb.y -= dy * scale(); apply(); }
      last = { x: ev.clientX, y: ev.clientY };
    } else if (pts.length === 2) {
      const d = Math.hypot(pts[0].clientX - pts[1].clientX, pts[0].clientY - pts[1].clientY);
      if (last && last.d) zoomAt(last.d / d, (pts[0].clientX + pts[1].clientX) / 2, (pts[0].clientY + pts[1].clientY) / 2);
      if (!moved) captureAll();
      last = { d };
      moved = true;
    }
  });
  const up = (ev) => { pointers.delete(ev.pointerId); last = null; };
  svg.addEventListener("pointerup", up); svg.addEventListener("pointercancel", up);
  svg.addEventListener("click", (ev) => { if (moved) { ev.stopPropagation(); moved = false; } }, true);
  svg.addEventListener("wheel", (ev) => { ev.preventDefault(); zoomAt(ev.deltaY > 0 ? 1.15 : 1 / 1.15, ev.clientX, ev.clientY); }, { passive: false });
  return {
    zoom: (f) => { const r = svg.getBoundingClientRect(); zoomAt(f, r.left + r.width / 2, r.top + r.height / 2); },
    centerOn: (id) => {
      const n = svg.pos.get(id);
      if (!n) return;
      const r = svg.getBoundingClientRect();
      const w = Math.min(vb.w, 4 * (W + GX)), hgt = w * (r.height / r.width);
      vb = { x: n.col * (W + GX) - w / 2, y: n.row * (H + GY) + H / 2 - hgt / 2, w, h: hgt };
      apply();
    },
    reset: () => { vb = { ...svg.bounds, x: svg.bounds.minX, y: svg.bounds.minY }; apply(); },
  };
}

export async function render(root, ctx) {
  clear(root);
  const g = await loadGraph();
  const me = ctx.state.me.account;
  const m = location.pathname.match(/^\/app\/tree\/([A-Za-z0-9_-]+)/);
  const focus = m && g.byId.has(m[1]) ? m[1] : defaultFocus(g, me);
  const onPerson = (id) => openSheet(personCard(g, id, ctx, { onPerson }), g.byId.get(id).display_name);
  const toggle = h("div", { class: "tabs", role: "tablist" },
    ...["focus", "family"].map((k) => { const b = h("button", { type: "button", role: "tab", "aria-selected": String(mode === k), text: t(`tree.mode.${k}`) }); b.onclick = () => { mode = k; localStorage.setItem("treeMode", k); render(root, ctx); }; return b; }));
  root.append(h("h1", { text: t("tree.title") }), toggle);
  if (!g.people.length) { root.append(h("p", { class: "card muted", text: t("tree.empty") })); return; }
  if (mode === "focus") {
    const layout = focusLayout(g, focus);
    const svg = drawSvg(g, layout, { focus, onTap: (id) => (id === focus ? onPerson(id) : ctx.navigate(`/app/tree/${id}`)) });
    root.append(h("p", { class: "muted", text: t("tree.hint.focus") }), h("div", { class: "card tree-wrap focus" }, svg), legend());
    return;
  }
  const layout = familyLayout(g);
  const svg = drawSvg(g, layout, { focus, onTap: onPerson });
  const pz = panZoom(svg);
  const find = personPicker(g, g.people, { id: "tree-find", placeholder: t("tree.find") });
  find.onChange(() => { if (find.value()) pz.centerOn(find.value()); });
  const zin = h("button", { class: "btn secondary", type: "button", text: "+", "aria-label": t("tree.zoom.in") });
  const zout = h("button", { class: "btn secondary", type: "button", text: "−", "aria-label": t("tree.zoom.out") });
  const fit = h("button", { class: "btn secondary", type: "button", text: t("tree.zoom.fit") });
  zin.onclick = () => pz.zoom(1 / 1.3); zout.onclick = () => pz.zoom(1.3); fit.onclick = pz.reset;
  root.append(h("div", { class: "row tree-tools" }, find.el, zin, zout, fit), h("div", { class: "card tree-wrap family" }, svg), legend());
  requestAnimationFrame(() => pz.centerOn(focus));
}

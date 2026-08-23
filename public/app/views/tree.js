import { h, s, clear } from "../dom.js";
import { t } from "../i18n.js";
import { initials, lifeSpan, yearOf } from "../graph.js";
import { focusLayout, familyLayout } from "../tree-layout.js";
import { loadGraph, avatarUrl } from "../people.js";
import { openSheet } from "../sheet.js";
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

function edgePath(a, b, type) {
  const ax = a.col * (W + GX), ay = a.row * (H + GY), bx = b.col * (W + GX), by = b.row * (H + GY);
  if (type === "partner") return s("line", { x1: ax, y1: ay + R, x2: bx, y2: by + R, class: "edge partner" });
  const y1 = ay + 2 * R + 62, y2 = by - 4, ym = (y1 + y2) / 2;
  return s("path", { d: `M${ax} ${y1} V${ym} H${bx} V${y2}`, class: "edge parent" });
}

function drawSvg(g, layout, opts) {
  const pos = new Map(layout.nodes.map((n) => [n.id, n]));
  const cols = layout.nodes.map((n) => n.col), rows = layout.nodes.map((n) => n.row);
  const minX = Math.min(...cols) * (W + GX) - W / 2 - 10, maxX = Math.max(...cols) * (W + GX) + W / 2 + 10;
  const minY = Math.min(...rows) * (H + GY) - 10, maxY = Math.max(...rows) * (H + GY) + H + 10;
  const svg = s("svg", { class: "tree", viewBox: `${minX} ${minY} ${maxX - minX} ${maxY - minY}`, role: "group", "aria-label": t("tree.title") });
  const edges = s("g", { class: "edges" });
  for (const e of layout.edges) if (pos.has(e.from) && pos.has(e.to)) edges.append(edgePath(pos.get(e.from), pos.get(e.to), e.type));
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
    root.append(h("p", { class: "muted", text: t("tree.hint.focus") }), h("div", { class: "card tree-wrap focus" }, svg));
    return;
  }
  const layout = familyLayout(g);
  const svg = drawSvg(g, layout, { focus, onTap: onPerson });
  const pz = panZoom(svg);
  const find = h("input", { type: "search", placeholder: t("tree.find"), "aria-label": t("tree.find"), list: "tree-names" });
  const list = h("datalist", { id: "tree-names" }, ...g.people.map((p) => h("option", { value: p.display_name })));
  find.onchange = () => { const p = g.people.find((x) => x.display_name.toLowerCase() === find.value.trim().toLowerCase()); if (p) pz.centerOn(p.id); };
  const zin = h("button", { class: "btn secondary", type: "button", text: "+", "aria-label": t("tree.zoom.in") });
  const zout = h("button", { class: "btn secondary", type: "button", text: "−", "aria-label": t("tree.zoom.out") });
  const fit = h("button", { class: "btn secondary", type: "button", text: t("tree.zoom.fit") });
  zin.onclick = () => pz.zoom(1 / 1.3); zout.onclick = () => pz.zoom(1.3); fit.onclick = pz.reset;
  root.append(h("div", { class: "row tree-tools" }, find, list, zin, zout, fit), h("div", { class: "card tree-wrap family" }, svg));
  requestAnimationFrame(() => pz.centerOn(focus));
}

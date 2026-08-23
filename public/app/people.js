import { api } from "./api.js";
import { buildGraph, initials } from "./graph.js";
import { h } from "./dom.js";

export async function loadGraph() { return buildGraph(await api("/api/people")); }

export function avatarUrl(g, id) {
  const at = g.avatarAt(id);
  return at == null ? null : `/api/people/${id}/avatar?v=${at}`;
}

export function avatarEl(g, id, size = 40) {
  const p = g.byId.get(id);
  const url = avatarUrl(g, id);
  const style = `width:${size}px;height:${size}px`;
  return url ? h("img", { class: "avatar", src: url, alt: "", width: size, height: size, style })
             : h("div", { class: "avatar initials", style, "aria-hidden": "true", text: initials(p) });
}

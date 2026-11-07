// Leiden Building Finder: filter Leiden's buildings (BAG) on use, size, age and
// signals of vacancy, demolition or change of use, and keep track of follow-up.
/* global maplibregl */
import { classifyNotice, NOTICE_TYPES, PHASES } from "./notices.js";

const FUNCS = {
  woonfunctie: { en: "Residential", c: "#c9b79c" },
  kantoorfunctie: { en: "Office", c: "#2f6db5" },
  winkelfunctie: { en: "Retail", c: "#d0572f" },
  industriefunctie: { en: "Industrial", c: "#6b5a49" },
  bijeenkomstfunctie: { en: "Assembly / events", c: "#b33c86" },
  onderwijsfunctie: { en: "Education", c: "#3c9a5f" },
  gezondheidszorgfunctie: { en: "Healthcare", c: "#2aa2b3" },
  logiesfunctie: { en: "Lodging / hotel", c: "#e0a21a" },
  sportfunctie: { en: "Sport", c: "#87b03a" },
  celfunctie: { en: "Detention", c: "#555555" },
  "overige gebruiksfunctie": { en: "Other", c: "#9b9b94" },
};
const STATUS_EN = {
  "Pand in gebruik": "In use", "Pand in gebruik (niet ingemeten)": "In use (not surveyed)",
  "Pand buiten gebruik": "Out of use", "Sloopvergunning verleend": "Demolition permit granted",
  "Verbouwing pand": "Under renovation", "Bouw gestart": "Under construction",
  "Bouwvergunning verleend": "Building permit granted", "Pand gesloopt": "Demolished",
  "Niet gerealiseerd pand": "Not realised", "Pand ten onrechte opgevoerd": "Registered in error",
};
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const SIGNALS = [
  { key: "vacant", label: "Out of use (BAG)", color: "--s-vacant", weight: 3,
    help: "The building, or at least one unit in it, is registered as out of use in the BAG. Rare: the BAG mostly uses it for buildings that can't be used at all.",
    test: (b) => b.status === "Pand buiten gebruik" || b.vboOut > 0 },
  { key: "vacancy", label: "Vacancy notice", color: "--s-vacant", weight: 3,
    help: "A permit mentions vacancy, e.g. anti-squat use (anti-leegstand) or a Leegstandwet permit.",
    test: (b) => b.nsig.has("vacancy") },
  { key: "temporary", label: "Temporary use", color: "--s-vacant", weight: 2,
    help: "A permit for temporary use of a building (not an event). Often means the building is waiting for a new purpose.",
    test: (b) => b.nsig.has("temporary") },
  { key: "demolition", label: "Demolition", color: "--s-demo", weight: 3,
    help: "BAG status 'demolition permit granted', or a permit to demolish the whole building. Sheds, walls and extensions don't count.",
    test: (b) => b.status === "Sloopvergunning verleend" || b.nsig.has("demolition") },
  { key: "transformation", label: "Transformation", color: "--s-change", weight: 2,
    help: "A permit to turn the building (or part of it) into housing or a shelter, e.g. office to homes. Café terraces, shops changing trade and splitting a home don't count.",
    test: (b) => b.nsig.has("transformation") },
  { key: "renovation", label: "Renovation (BAG)", color: "--s-reno", weight: 1,
    help: "The building or a unit is registered as under renovation.",
    test: (b) => b.status === "Verbouwing pand" || b.vboReno > 0 },
];
const TRACK = ["Interesting", "Check on site", "Owner contacted", "In talks", "Not relevant"];
const YEARS = [
  { to: 1899, label: "Before 1900", c: "#7a2e1f" }, { to: 1944, label: "1900–1944", c: "#b8562f" },
  { to: 1969, label: "1945–1969", c: "#e0a043" }, { to: 1989, label: "1970–1989", c: "#9dbb6a" },
  { to: 2009, label: "1990–2009", c: "#4f9fb0" }, { to: 9999, label: "2010 and later", c: "#2f5f9e" },
];
const PRESETS = [
  { key: "all", label: "All buildings", f: {} },
  { key: "signals", label: "Any signal", f: { signals: SIGNALS.map((s) => s.key) } },
  { key: "vacant", label: "Possibly vacant", f: { signals: ["vacant", "vacancy", "temporary"] } },
  { key: "demolition", label: "Demolition", f: { signals: ["demolition"] } },
  { key: "transformation", label: "Transformation to housing", f: { signals: ["transformation"] } },
  { key: "offices", label: "Old offices ≥ 500 m²", f: { funcs: ["kantoorfunctie"], m2Min: 500, yMax: 1990 } },
  { key: "transform", label: "Transformation candidates", f: { funcs: ["kantoorfunctie", "industriefunctie", "winkelfunctie"], m2Min: 1000, yMax: 1980 } },
  { key: "monuments", label: "Monuments with a signal", f: { monument: "only", signals: SIGNALS.map((s) => s.key) } },
];

// ---------- state ----------
let B = []; // buildings
let shown = [];
let selected = null;
let colourBy = "signal";
let sortBy = "score";
const $ = (id) => document.getElementById(id);
const el = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "on") for (const [ev, fn] of Object.entries(v)) e.addEventListener(ev, fn);
    else if (k === "text") e.textContent = v;
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  kids.flat().forEach((c) => c != null && e.append(c));
  return e;
};
const nf = new Intl.NumberFormat("en-GB");
// replaceChildren() turns null into the text "null"; this skips empty parts.
const put = (node, ...kids) => node.replaceChildren(...kids.flat().filter((k) => k != null && k !== false));
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};
let track = store.get("lbf-track-v1", {});

// ---------- data ----------
async function load() {
  const r = await fetch("data/leiden.json");
  if (!r.ok) throw new Error("data/leiden.json not found");
  const d = await r.json();
  B = d.panden.map((p, i) => {
    const [id, ring, bouwjaar, status, functie, functies, m2, vbo, vboOut, vboReno, adres, postcode, monument, notices] = p;
    const coords = ring.map(([x, y]) => [x + 4, y + 52]);
    const cx = coords.slice(0, -1).reduce((a, c) => a + c[0], 0) / Math.max(1, coords.length - 1);
    const cy = coords.slice(0, -1).reduce((a, c) => a + c[1], 0) / Math.max(1, coords.length - 1);
    const b = { i, id, coords, c: [cx, cy], year: bouwjaar, status, main: functie, funcs: functies, m2, vbo, vboOut, vboReno,
      adres: adres || "(no address)", postcode: postcode || "", monument,
      notices: notices.map((n) => ({ ...n, ...classifyNotice(n.titel) })) };
    b.nsig = new Set(b.notices.flatMap((n) => n.signals));
    b.sig = SIGNALS.filter((s) => s.test(b)).map((s) => s.key);
    b.score = SIGNALS.filter((s) => b.sig.includes(s.key)).reduce((a, s) => a + s.weight, 0);
    b.search = `${b.adres} ${b.postcode} ${b.postcode.replace(/\s/g, "")} ${id}`.toLowerCase();
    return b;
  });
  $("summary").textContent = `${nf.format(B.length)} buildings in ${d.gemeente} · open data of ${d.gegenereerd} · permit notices since ${d.bekendmakingen_vanaf.slice(0, 4)}`;
  aboutData = d;
}
let aboutData = null;

// ---------- filters ----------
function buildFilters() {
  $("presets").replaceChildren(...PRESETS.map((p) => el("button", { type: "button", "data-key": p.key, "aria-pressed": "false", text: p.label, on: { click: () => applyPreset(p) } })));
  $("f-signals").replaceChildren(...SIGNALS.map((s) => el("label", { class: "check", title: s.help },
    el("input", { type: "checkbox", value: s.key, on: { change: update } }),
    el("span", { class: "sw", style: `background:var(${s.color})` }), s.label,
    el("span", { class: "n", text: nf.format(B.filter((b) => b.sig.includes(s.key)).length) }))));
  const counts = {};
  for (const b of B) counts[b.main] = (counts[b.main] || 0) + 1;
  $("f-functions").replaceChildren(...Object.entries(FUNCS).filter(([k]) => counts[k]).map(([k, v]) => el("label", { class: "check" },
    el("input", { type: "checkbox", value: k, on: { change: update } }),
    el("span", { class: "sw", style: `background:${v.c}` }), v.en)));
  $("f-track").replaceChildren(el("option", { value: "", text: "Any" }), el("option", { value: "*", text: "Anything I've marked" }),
    ...TRACK.map((t) => el("option", { value: t, text: t })));
  for (const id of ["f-q", "f-m2-min", "f-m2-max", "f-y-min", "f-y-max"]) $(id).addEventListener("input", debounce(update, 200));
  for (const id of ["f-monument", "f-track", "f-func-any"]) $(id).addEventListener("change", update);
  $("btn-reset").onclick = () => applyPreset(PRESETS[0]);
}

function readFilters() {
  const num = (id) => { const v = parseFloat($(id).value); return Number.isFinite(v) ? v : null; };
  return {
    q: $("f-q").value.trim().toLowerCase(),
    signals: [...$("f-signals").querySelectorAll("input:checked")].map((i) => i.value),
    funcs: [...$("f-functions").querySelectorAll("input:checked")].map((i) => i.value),
    funcAny: $("f-func-any").checked,
    monument: $("f-monument").value,
    m2Min: num("f-m2-min"), m2Max: num("f-m2-max"), yMin: num("f-y-min"), yMax: num("f-y-max"),
    track: $("f-track").value,
  };
}

function applyPreset(p) {
  const f = p.f;
  $("f-q").value = "";
  $("f-signals").querySelectorAll("input").forEach((i) => { i.checked = (f.signals || []).includes(i.value); });
  $("f-functions").querySelectorAll("input").forEach((i) => { i.checked = (f.funcs || []).includes(i.value); });
  $("f-func-any").checked = false;
  $("f-monument").value = f.monument || "";
  $("f-m2-min").value = f.m2Min ?? ""; $("f-m2-max").value = f.m2Max ?? "";
  $("f-y-min").value = f.yMin ?? ""; $("f-y-max").value = f.yMax ?? "";
  $("f-track").value = "";
  update(p.key);
}

function matches(b, f) {
  if (f.q && !b.search.includes(f.q)) return false;
  if (f.signals.length && !f.signals.some((s) => b.sig.includes(s))) return false;
  if (f.funcs.length && !(f.funcAny ? b.funcs.some((x) => f.funcs.includes(x)) : f.funcs.includes(b.main))) return false;
  if (f.monument === "only" && !b.monument) return false;
  if (f.monument === "exclude" && b.monument) return false;
  if (f.m2Min != null && b.m2 < f.m2Min) return false;
  if (f.m2Max != null && b.m2 > f.m2Max) return false;
  if (f.yMin != null && !(b.year >= f.yMin)) return false;
  if (f.yMax != null && !(b.year <= f.yMax)) return false;
  if (f.track === "*" && !track[b.id]?.status) return false;
  if (f.track && f.track !== "*" && track[b.id]?.status !== f.track) return false;
  return true;
}

function update(presetKey) {
  const f = readFilters();
  shown = B.filter((b) => matches(b, f));
  sortShown();
  document.querySelectorAll("#presets button").forEach((b) => b.setAttribute("aria-pressed", b.dataset.key === (typeof presetKey === "string" ? presetKey : "") ? "true" : "false"));
  renderMap();
  renderList();
}
function sortShown() {
  const by = {
    score: (a, b) => b.score - a.score || b.m2 - a.m2,
    m2: (a, b) => b.m2 - a.m2,
    old: (a, b) => (a.year || 9999) - (b.year || 9999),
    recent: (a, b) => (b.notices[0]?.datum || "").localeCompare(a.notices[0]?.datum || ""),
  }[sortBy];
  shown.sort(by);
}
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

// ---------- colours ----------
function colourOf(b) {
  if (colourBy === "function") return FUNCS[b.main]?.c || "#9b9b94";
  if (colourBy === "year") return (YEARS.find((y) => (b.year || 0) <= y.to) || YEARS.at(-1)).c;
  const top = SIGNALS.find((s) => b.sig.includes(s.key));
  return css(top ? top.color : "--s-none");
}
function renderLegend() {
  let items;
  if (colourBy === "function") items = Object.values(FUNCS).map((v) => [v.c, v.en]);
  else if (colourBy === "year") items = YEARS.map((y) => [y.c, y.label]);
  else items = [[css("--s-vacant"), "Vacancy / temporary use"], [css("--s-demo"), "Demolition"], [css("--s-change"), "Transformation"], [css("--s-reno"), "Renovation"], [css("--s-none"), "No signal"]];
  $("legend").replaceChildren(...items.map(([c, t]) => el("div", {}, el("span", { class: "sw", style: `background:${c}` }), t)));
}

// ---------- map ----------
let map;
const BASEMAPS = {
  grijs: "https://service.pdok.nl/brt/achtergrondkaart/wmts/v2_0/grijs/EPSG:3857/{z}/{x}/{y}.png",
  luchtfoto: "https://service.pdok.nl/hwh/luchtfotorgb/wmts/v1_0/Actueel_orthoHR/EPSG:3857/{z}/{x}/{y}.jpeg",
};
function initMap() {
  map = new maplibregl.Map({
    container: "map",
    style: {
      version: 8,
      sources: {
        base: { type: "raster", tiles: [BASEMAPS.grijs], tileSize: 256, maxzoom: 19, attribution: "Kaart: <a href='https://www.pdok.nl'>PDOK</a> (Kadaster) · Data: BAG, RCE, KOOP" },
        b: { type: "geojson", data: { type: "FeatureCollection", features: [] } },
        pts: { type: "geojson", data: { type: "FeatureCollection", features: [] } },
        sel: { type: "geojson", data: { type: "FeatureCollection", features: [] } },
      },
      layers: [
        { id: "base", type: "raster", source: "base" },
        { id: "b-fill", type: "fill", source: "b", minzoom: 14, paint: { "fill-color": ["get", "col"], "fill-opacity": 0.78 } },
        { id: "b-line", type: "line", source: "b", minzoom: 15, paint: { "line-color": "#222", "line-width": 0.4, "line-opacity": 0.5 } },
        { id: "pts", type: "circle", source: "pts", maxzoom: 14, paint: { "circle-color": ["get", "col"], "circle-radius": ["interpolate", ["linear"], ["zoom"], 11, ["case", ["get", "hot"], 2.6, 1.2], 14, ["case", ["get", "hot"], 4.5, 2.4]], "circle-opacity": 0.85 } },
        { id: "sel-line", type: "line", source: "sel", paint: { "line-color": "#111", "line-width": 3 } },
        { id: "sel-pt", type: "circle", source: "sel", maxzoom: 14, paint: { "circle-radius": 7, "circle-color": "rgba(0,0,0,0)", "circle-stroke-color": "#111", "circle-stroke-width": 2.5 } },
      ],
    },
    hash: true, center: [4.4935, 52.1585], zoom: 13, maxBounds: [[4.3, 52.08], [4.7, 52.24]],
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
  map.addControl(new maplibregl.ScaleControl({ unit: "metric" }));
  const pop = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 8 });
  for (const layer of ["b-fill", "pts"]) {
    map.on("mousemove", layer, (e) => {
      map.getCanvas().style.cursor = "pointer";
      const b = B[e.features[0].properties.i];
      pop.setLngLat(e.lngLat).setHTML("").setDOMContent(el("div", {}, el("b", { text: b.adres }), el("br"), `${FUNCS[b.main]?.en || "–"} · ${nf.format(b.m2)} m² · ${b.year || "?"}`)).addTo(map);
    });
    map.on("mouseleave", layer, () => { map.getCanvas().style.cursor = ""; pop.remove(); });
    map.on("click", layer, (e) => select(B[e.features[0].properties.i], false));
  }
  $("basemap").onchange = (e) => {
    const src = map.getSource("base");
    src.setTiles([BASEMAPS[e.target.value]]);
  };
  $("colour-by").onchange = (e) => { colourBy = e.target.value; renderMap(); };
  return new Promise((res) => map.on("load", res));
}
function renderMap() {
  if (!map?.getSource("b")) return;
  const feats = [], pts = [];
  for (const b of shown) {
    const col = colourOf(b);
    feats.push({ type: "Feature", properties: { i: b.i, col }, geometry: { type: "Polygon", coordinates: [b.coords] } });
    pts.push({ type: "Feature", properties: { i: b.i, col, hot: b.score > 0 }, geometry: { type: "Point", coordinates: b.c } });
  }
  map.getSource("b").setData({ type: "FeatureCollection", features: feats });
  map.getSource("pts").setData({ type: "FeatureCollection", features: pts });
  renderLegend();
}

// ---------- list ----------
function badges(b) {
  const out = SIGNALS.filter((s) => b.sig.includes(s.key)).map((s) => el("span", { class: "badge", style: `color:var(${s.color})`, text: s.label }));
  if (b.monument) out.push(el("span", { class: "badge", text: "Rijksmonument" }));
  if (track[b.id]?.status) out.push(el("span", { class: "badge", style: "color:var(--accent)", text: "★ " + track[b.id].status }));
  return out;
}
function renderList() {
  const LIMIT = 300;
  const head = el("div", { class: "res-head" },
    el("b", { text: `${nf.format(shown.length)} buildings` }),
    el("div", { class: "muted", text: `${nf.format(shown.reduce((a, b) => a + b.m2, 0))} m² in total` }),
    el("select", { "aria-label": "Sort", on: { change: (e) => { sortBy = e.target.value; sortShown(); renderList(); } } },
      ...[["score", "Most signals first"], ["m2", "Largest first"], ["old", "Oldest first"], ["recent", "Latest permit notice"]].map(([v, t]) => el("option", { value: v, selected: v === sortBy ? "" : false, text: t }))));
  const list = el("ol", { class: "list" }, shown.slice(0, LIMIT).map((b) => el("li", {}, el("button", { type: "button", on: { click: () => select(b, true) } },
    el("div", { class: "li-top" }, el("b", { text: b.adres }), el("span", { class: "m2", text: nf.format(b.m2) + " m²" })),
    el("div", { class: "li-sub", text: [b.postcode, FUNCS[b.main]?.en, b.year && "built " + b.year, b.vbo > 1 && b.vbo + " units"].filter(Boolean).join(" · ") }),
    el("div", { class: "badges" }, badges(b))))));
  put($("results"), head, list, shown.length > LIMIT ? el("p", { class: "more", text: `Showing the first ${LIMIT}. Narrow the filters or zoom the map to see the rest.` }) : null);
}

// ---------- detail ----------
function select(b, fly) {
  selected = b;
  map.getSource("sel")?.setData({ type: "FeatureCollection", features: [
    { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [b.coords] } },
    { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: b.c } }] });
  if (fly) map.flyTo({ center: b.c, zoom: Math.max(map.getZoom(), 17), speed: 1.6 });
  renderDetail();
}
function renderDetail() {
  const b = selected;
  const [lon, lat] = b.c;
  const t = track[b.id] || {};
  const saveTrack = (patch) => {
    track[b.id] = { ...t, ...patch, updated: new Date().toISOString().slice(0, 10) };
    if (!track[b.id].status && !track[b.id].note) delete track[b.id];
    store.set("lbf-track-v1", track);
    Object.assign(t, patch);
  };
  const link = (href, text) => el("a", { href, target: "_blank", rel: "noopener", text });
  const d = $("detail");
  put(d,
    el("button", { type: "button", text: "← Back to list", on: { click: closeDetail } }),
    el("h3", { text: b.adres }),
    el("div", { class: "muted", text: `${b.postcode} Leiden` }),
    el("div", { class: "badges", style: "margin-top:8px" }, badges(b)),
    el("dl", { class: "kv" },
      el("dt", { text: "Main use" }), el("dd", { text: FUNCS[b.main]?.en || "–" }),
      b.funcs.length > 1 ? [el("dt", { text: "All uses" }), el("dd", { text: b.funcs.map((x) => FUNCS[x]?.en || x).join(", ") })] : null,
      el("dt", { text: "Floor area" }), el("dd", { text: nf.format(b.m2) + " m² (usable area, all units)" }),
      el("dt", { text: "Units" }), el("dd", { text: `${b.vbo}${b.vboOut ? ` (${b.vboOut} out of use)` : ""}` }),
      el("dt", { text: "Year built" }), el("dd", { text: b.year || "–" }),
      el("dt", { text: "BAG status" }), el("dd", { text: `${STATUS_EN[b.status] || b.status}` }),
      el("dt", { text: "BAG id" }), el("dd", { text: b.id })),
    b.sig.length ? el("p", { class: "why" }, el("b", { text: "Why it's flagged: " }), whyFlagged(b)) : null,
    el("div", { class: "row" },
      el("a", { class: "button primary", href: streetView(lat, lon), target: "_blank", rel: "noopener", text: "Walk around in Street View ↗" }),
      el("button", { type: "button", text: "Aerial view", on: { click: () => aerialView(b) } }),
      el("button", { type: "button", text: "Copy summary", on: { click: (e) => copySummary(b, e.target) } })),
    noticesBlock(b, link),
    el("h4", { text: "Units in this building" }), el("div", { id: "units" }, el("p", { class: "muted", text: "Loading from the BAG…" })),
    el("h4", { text: "Owner" }), el("div", { id: "owner" }, el("p", { class: "muted", text: "Looking up the cadastral parcel…" })),
    el("h4", { text: "Look further" }),
    el("div", { class: "links" },
      link(`https://bagviewer.kadaster.nl/lvbag/bag-viewer/?objectId=${b.id}`, "BAG viewer (all units and history)"),
      b.monument ? link(b.monument, "Rijksmonument register") : null,
      link("https://www.ep-online.nl/Energylabel/Search", "Energy label (EP-online, search the address)"),
      link(`https://www.google.com/search?q=${encodeURIComponent(`"${b.adres}" Leiden`)}`, "Who's there? (Google the address)"),
      link(`https://www.google.com/maps/search/?api=1&query=${lat},${lon}`, "Google Maps"),
      link("https://omgevingswet.overheid.nl/regels-op-de-kaart", "Zoning rules (Omgevingsloket, search the address)")),
    el("h4", { text: "My follow-up" }),
    el("label", { class: "field" }, el("span", { text: "Status" }),
      el("select", { on: { change: (e) => { saveTrack({ status: e.target.value }); renderList(); renderDetail(); } } },
        el("option", { value: "", text: "Not marked" }), ...TRACK.map((s) => el("option", { value: s, selected: t.status === s ? "" : false, text: s })))),
    el("label", { class: "field" }, el("span", { text: "Notes (only saved in this browser)" }),
      Object.assign(el("textarea", { placeholder: "e.g. windows boarded up, letter sent 12 Nov…", on: { input: debounce((e) => saveTrack({ note: e.target.value }), 400) } }), { value: t.note || "" })),
    t.updated ? el("p", { class: "note", text: "Last updated " + t.updated }) : null,
  );
  d.hidden = false; $("results").hidden = true;
  $("side").scrollTop = 0;
  loadMore(b);
}

// ---------- "more info" helpers ----------
const streetView = (lat, lon) => `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${lat},${lon}`;
function whyFlagged(b) {
  const parts = [];
  if (b.sig.includes("vacant")) parts.push(b.status === "Pand buiten gebruik" ? "BAG: building out of use" : `BAG: ${b.vboOut} unit(s) out of use`);
  if (b.status === "Sloopvergunning verleend") parts.push("BAG: demolition permit granted");
  if (b.sig.includes("renovation")) parts.push("BAG: under renovation");
  const seen = new Set();
  for (const n of b.notices) for (const s of n.signals) {
    if (seen.has(s)) continue; seen.add(s);
    parts.push(`${NOTICE_TYPES[s].en.toLowerCase()} (${PHASES[n.phase].toLowerCase()} ${n.datum.slice(0, 7)})`);
  }
  if (b.year && b.year < 1980 && ["kantoorfunctie", "industriefunctie", "winkelfunctie"].includes(b.main) && b.m2 >= 1000) parts.push(`large ${FUNCS[b.main].en.toLowerCase()} building from ${b.year}`);
  return parts.join(" · ");
}
function noticesBlock(b, link) {
  const one = (n) => el("div", { class: "notice" + (n.signals.length ? " strong" : "") }, link(n.url, n.titel.replace(/^[^,]*,\s*/, "")),
    el("div", { class: "muted" }, el("span", { class: "phase " + n.phase, text: PHASES[n.phase] }), ` ${n.datum} · ${n.types.map((x) => NOTICE_TYPES[x].en).join(", ")}`));
  const main = b.notices.filter((n) => n.signals.length), minor = b.notices.filter((n) => !n.signals.length);
  return el("div", {},
    el("h4", { text: `Permit notices (${b.notices.length})` }),
    !b.notices.length ? el("p", { class: "muted", text: "No demolition, vacancy, temporary-use or change-of-use permits found for this building since the start of the data." }) : null,
    main.map(one),
    minor.length ? (main.length ? el("details", {}, el("summary", { text: `${minor.length} minor notice(s): terraces, sheds, events…` }), minor.map(one)) : minor.map(one)) : null);
}
function aerialView(b) {
  $("basemap").value = "luchtfoto"; map.getSource("base").setTiles([BASEMAPS.luchtfoto]);
  map.flyTo({ center: b.c, zoom: 18.5, speed: 1.4 });
}
async function copySummary(b, btn) {
  const [lon, lat] = b.c;
  const lines = [
    `${b.adres}, ${b.postcode} Leiden`,
    `${FUNCS[b.main]?.en || "–"} · ${nf.format(b.m2)} m² · built ${b.year || "?"} · ${b.vbo} unit(s)${b.monument ? " · rijksmonument" : ""}`,
    b.sig.length ? `Flagged: ${whyFlagged(b)}` : null,
    ...b.notices.filter((n) => n.signals.length).map((n) => `- ${PHASES[n.phase]} ${n.datum}: ${n.titel.replace(/^[^,]*,\s*/, "")} ${n.url}`),
    owner[b.id]?.text ? `Cadastral parcel: ${owner[b.id].text}` : null,
    `Street View: ${streetView(lat, lon)}`,
    `Map: ${location.origin}${location.pathname}#18/${lat.toFixed(5)}/${lon.toFixed(5)}`,
  ].filter(Boolean).join("\n");
  try { await navigator.clipboard.writeText(lines); btn.textContent = "Copied ✓"; }
  catch { prompt("Copy this summary:", lines); }
  setTimeout(() => { btn.textContent = "Copy summary"; }, 1800);
}

// Live lookups (PDOK, open, no key): all units in the building, and the cadastral parcel.
const owner = {};
async function loadMore(b) {
  const units = $("units"), own = $("owner");
  const wfs = (base, params) => fetch(base + "?" + new URLSearchParams({ service: "WFS", version: "2.0.0", request: "GetFeature", outputFormat: "application/json", srsName: "EPSG:4326", ...params })).then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); });
  const filter = `<fes:Filter xmlns:fes="http://www.opengis.net/fes/2.0"><fes:PropertyIsEqualTo><fes:ValueReference>pandidentificatie</fes:ValueReference><fes:Literal>${b.id}</fes:Literal></fes:PropertyIsEqualTo></fes:Filter>`;
  wfs("https://service.pdok.nl/lv/bag/wfs/v2_0", { typeName: "bag:verblijfsobject", filter, count: 200 }).then((d) => {
    if (selected !== b) return;
    const rows = d.features.map((f) => f.properties).sort((x, y) => (x.huisnummer - y.huisnummer) || String(x.huisletter + x.toevoeging).localeCompare(y.huisletter + y.toevoeging));
    units.replaceChildren(rows.length ? el("table", { class: "units" },
      el("thead", {}, el("tr", {}, ["Address", "Use", "m²", "Status"].map((h) => el("th", { text: h })))),
      el("tbody", {}, rows.map((u) => el("tr", { class: /buiten gebruik|Verbouwing/.test(u.status) ? "flag" : "" },
        el("td", { text: `${u.openbare_ruimte} ${u.huisnummer}${u.huisletter || ""}${u.toevoeging ? "-" + u.toevoeging : ""}` }),
        el("td", { text: String(u.gebruiksdoel).split(",").map((x) => FUNCS[x]?.en || x).join(", ") }),
        el("td", { class: "num", text: nf.format(u.oppervlakte) }),
        el("td", { text: u.status.replace("Verblijfsobject ", "") })))))
      : el("p", { class: "muted", text: "No units found." }));
  }).catch(() => { if (selected === b) units.replaceChildren(el("p", { class: "muted", text: "Couldn't reach the BAG right now. Try the BAG viewer link below." })); });

  const [lon, lat] = b.c, dd = 0.0004;
  wfs("https://service.pdok.nl/kadaster/kadastralekaart/wfs/v5_0", { typeName: "kadastralekaart:Perceel", bbox: `${lat - dd},${lon - dd},${lat + dd},${lon + dd},urn:ogc:def:crs:EPSG::4326`, count: 50 }).then((d) => {
    if (selected !== b) return;
    const inPoly = (pt, ring) => { let hit = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const [xi, yi] = ring[i], [xj, yj] = ring[j]; if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) hit = !hit; } return hit; };
    const rings = (g) => g.type === "Polygon" ? [g.coordinates[0]] : g.type === "MultiPolygon" ? g.coordinates.map((p) => p[0]) : [];
    const f = d.features.find((x) => rings(x.geometry).some((r) => inPoly(b.c, r))) || d.features[0];
    if (!f) throw new Error("none");
    const p = f.properties;
    const text = `${p.kadastraleGemeenteWaarde} ${p.sectie} ${p.perceelnummer} (${nf.format(p.kadastraleGrootteWaarde)} m² plot)`;
    owner[b.id] = { text };
    own.replaceChildren(
      el("p", {}, "Cadastral parcel: ", el("b", { text })),
      el("p", { class: "note", text: "The parcel under the middle of the building. Large buildings can span several parcels." }),
      el("p", { class: "muted", text: "Who owns it isn't public for free. Order the owner's name (and for companies their KvK number) from the Kadaster, using this parcel or the address. It costs a few euros per lookup." }),
      el("div", { class: "row" },
        el("a", { class: "button", href: "https://www.kadaster.nl/producten/woning/eigendomsinformatie", target: "_blank", rel: "noopener", text: "Look up owner at Kadaster ↗" }),
        el("button", { type: "button", text: "Copy parcel", on: { click: async (e) => { try { await navigator.clipboard.writeText(`${p.kadastraleGemeenteWaarde} ${p.sectie} ${p.perceelnummer}`); e.target.textContent = "Copied ✓"; } catch { /* clipboard blocked */ } } } })),
      el("p", { class: "note", text: "Private owner? You may write to them about their building, but don't keep their personal data longer than needed (AVG/GDPR)." }));
  }).catch(() => { if (selected === b) own.replaceChildren(el("p", { class: "muted" }, "Couldn't find the parcel right now. ", el("a", { href: "https://www.kadaster.nl/producten/woning/eigendomsinformatie", target: "_blank", rel: "noopener", text: "Kadaster ownership information ↗" }))); });
}
function closeDetail() {
  selected = null; $("detail").hidden = true; $("results").hidden = false;
  map.getSource("sel")?.setData({ type: "FeatureCollection", features: [] });
}
addEventListener("keydown", (e) => { if (e.key === "Escape" && selected && !$("about").open) closeDetail(); });

// ---------- export ----------
$("btn-export").onclick = () => {
  const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const head = ["bag_id", "address", "postcode", "main_use", "all_uses", "floor_area_m2", "units", "units_out_of_use", "year_built", "bag_status", "signals", "rijksmonument", "permit_notices", "latest_notice", "my_status", "my_note", "lat", "lon"];
  const rows = shown.map((b) => [b.id, b.adres, b.postcode, FUNCS[b.main]?.en, b.funcs.map((x) => FUNCS[x]?.en || x).join("; "), b.m2, b.vbo, b.vboOut, b.year,
    STATUS_EN[b.status] || b.status, b.sig.join("; "), b.monument ? "yes" : "", b.notices.filter((n) => n.signals.length).length, b.notices.find((n) => n.signals.length)?.titel || "", track[b.id]?.status || "", track[b.id]?.note || "", b.c[1].toFixed(6), b.c[0].toFixed(6)]);
  const csv = [head, ...rows].map((r) => r.map(q).join(",")).join("\n");
  const a = el("a", { href: URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv" })), download: `leiden-buildings-${new Date().toISOString().slice(0, 10)}.csv` });
  document.body.append(a); a.click(); a.remove();
};

// ---------- about ----------
$("btn-about").onclick = () => {
  const d = aboutData;
  put($("about-body"),
    el("p", { text: "This map combines open government data for every building in Leiden that has at least one registered unit, so you can find buildings that may be vacant, old or underused, and keep track of which ones you've looked into." }),
    el("h3", { text: "Data" }),
    el("ul", {},
      el("li", {}, el("b", { text: "BAG" }), " (Kadaster, via PDOK): year built, use, floor area, number of units and status for every building and unit."),
      el("li", {}, el("b", { text: "Rijksmonumentenregister" }), " (RCE, via PDOK): national monuments."),
      el("li", {}, el("b", { text: "Official notices" }), ` (Gemeenteblad Leiden, since ${d?.bekendmakingen_vanaf || "2023"}): permits that mention demolition, vacancy or change of use, linked to the building by their map location.`)),
    el("p", { class: "muted", text: `Data downloaded on ${d?.gegenereerd || "?"}. The GitHub repository can refresh it automatically every month.` }),
    el("p", { text: "Each permit is sorted by its title: whole-building demolition, transformation to housing, temporary use and vacancy count as signals; sheds and walls, café terraces, shops changing trade, events and splitting a home are shown but don't count. Refused or withdrawn permits never count." }),
    el("h3", { text: "What the signals mean, and what they don't" }),
    el("ul", {}, SIGNALS.map((s) => el("li", {}, el("b", { text: s.label + ": " }), s.help))),
    el("p", { text: "There is no public register of vacant buildings in the Netherlands, so this is a shortlist, not proof. 'Out of use' in the BAG often means unusable (e.g. during works) rather than simply empty. Always check on site (or in Street View) before contacting an owner." }),
    el("h3", { text: "How to use it" }),
    el("ol", {},
      el("li", { text: "Pick a quick view, or set filters on signals, use, floor area and year built." }),
      el("li", { text: "Click a building on the map or in the list to see its details and permit notices." }),
      el("li", { text: "See why it's flagged, all units in the building (live from the BAG) and its cadastral parcel. Walk around in Street View or switch to the aerial view." }),
      el("li", { text: "Interesting? Order the owner's name from the Kadaster with the parcel number, and use Copy summary to send the building to someone." }),
      el("li", { text: "Mark its status and add notes. These stay in this browser only; use Export CSV to share or back them up." })),
  );
  $("about").showModal();
};

// ---------- start ----------
(async () => {
  // The list and filters don't wait for the map: map tiles can be slow.
  const mapReady = initMap();
  try {
    await load();
  } catch (e) {
    $("summary").textContent = "Could not load the data: " + e.message;
    return;
  }
  buildFilters();
  applyPreset(PRESETS[1]); // start on 'Any signal'
  await mapReady;
  renderMap();
})();

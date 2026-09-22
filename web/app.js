/* Parking Intelligence — front end (vanilla JS, Leaflet, hand-rolled SVG charts) */

const C = {
  yellow: "#ffd84d", magenta: "#e53aa3", blue: "#1e93ff", blueLight: "#4fe3f0",
  red: "#f93c31", orange: "#ff8a1f", maroon: "#921231", gray: "#555",
  grayLight: "#999", off: "#e3e1df", border: "#222",
};
// discrete ARC-style heat ramp (empty -> hottest)
const RAMP = ["#1a1818", "#3a1020", C.maroon, C.red, C.orange, C.yellow];
const TIER = { P1: C.red, P2: C.orange, P3: C.yellow, Watch: C.gray };
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const DAYS_LONG = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

const $ = (s, el = document) => el.querySelector(s);
const fmt = (n, d = 0) => Number(n).toLocaleString("en-IN", { maximumFractionDigits: d, minimumFractionDigits: d });
const pct = (x, d = 0) => `${(x * 100).toFixed(d)}%`;
const hh = (h) => `${String(h % 24).padStart(2, "0")}:00`;
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const title = (s) => String(s ?? "").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

let META, HOT, FC, REC;
const state = { stations: [], vgroups: [], offences: [], days: [], h0: 0, h1: 23, heatMode: "impact" };

/* ---------------- tooltip ---------------- */
const tip = $("#tip");
function showTip(e, html) {
  tip.innerHTML = html; tip.style.opacity = 1;
  const x = Math.min(e.clientX + 14, innerWidth - tip.offsetWidth - 8);
  const y = Math.min(e.clientY + 14, innerHeight - tip.offsetHeight - 8);
  tip.style.left = x + "px"; tip.style.top = y + "px";
}
const hideTip = () => (tip.style.opacity = 0);
function bindTips(root) {
  root.querySelectorAll("[data-tip]").forEach((el) => {
    el.addEventListener("mousemove", (e) => showTip(e, el.dataset.tip));
    el.addEventListener("mouseleave", hideTip);
  });
}

/* ---------------- routing / pill ---------------- */
const PAGES = ["overview", "hotspots", "forecast", "method"];
let current = "overview";
function go(page) {
  if (!PAGES.includes(page)) page = "overview";
  current = page;
  PAGES.forEach((p) => ($(`#page-${p}`).hidden = p !== page));
  const i = PAGES.indexOf(page);
  const opts = [...document.querySelectorAll(".pill-option")];
  opts.forEach((o, j) => o.classList.toggle("active", j === i));
  const w = opts[0].getBoundingClientRect().width;
  $(".pill-slider").style.width = w + "px";
  $(".pill-slider").style.transform = `translateX(${i * w}px)`;
  if (location.hash.slice(1) !== page) history.replaceState(null, "", "#" + page);
  onShow[page]?.();
  setTimeout(() => Object.values(maps).forEach((m) => m.invalidateSize()), 30);
}
document.addEventListener("click", (e) => {
  const a = e.target.closest("[data-go]");
  if (a) { e.preventDefault(); go(a.dataset.go); scrollTo({ top: 0 }); }
});
addEventListener("resize", () => go(current));
// in-page "page contents" links scroll without touching the page router
document.addEventListener("click", (e) => {
  const a = e.target.closest(".menu a");
  if (!a) return;
  e.preventDefault();
  document.querySelector(a.getAttribute("href"))?.scrollIntoView({ behavior: "smooth" });
});

/* ---------------- SVG helpers ---------------- */
const NS = "http://www.w3.org/2000/svg";
function svg(w, h) {
  const s = document.createElementNS(NS, "svg");
  s.setAttribute("viewBox", `0 0 ${w} ${h}`);
  return s;
}
function el(parent, tag, attrs = {}, text) {
  const n = document.createElementNS(NS, tag);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  if (text != null) n.textContent = text;
  parent.appendChild(n);
  return n;
}
const niceMax = (v) => {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v)), f = v / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
};

/* hourly: enforcement share (bars) vs demand (stepped line) */
function chartHourly(node, hourly) {
  const W = 560, H = 250, L = 34, R = 10, T = 16, B = 28;
  const s = svg(W, H), iw = W - L - R, ih = H - T - B, bw = iw / 24;
  const total = hourly.c.reduce((a, b) => a + b, 0) || 1;
  const share = hourly.c.map((c) => c / total);
  const dem = META.assumptions.demand_profile;
  const dsum = dem.reduce((a, b) => a + b, 0);
  const dshare = dem.map((d) => d / dsum);
  const ymax = niceMax(Math.max(...share, ...dshare));
  const y = (v) => T + ih - (v / ymax) * ih;
  [0, 0.5, 1].forEach((f) => {
    el(s, "line", { x1: L, x2: W - R, y1: y(ymax * f), y2: y(ymax * f), class: "grid" });
    el(s, "text", { x: L - 6, y: y(ymax * f) + 3, "text-anchor": "end" }, pct(ymax * f));
  });
  // evening peak band
  el(s, "rect", { x: L + 17 * bw, y: T, width: 5 * bw, height: ih, fill: "rgba(229,58,163,.08)" });
  el(s, "text", { x: L + 19.5 * bw, y: T + 10, "text-anchor": "middle", fill: C.magenta, style: "fill:" + C.magenta }, "EVENING PEAK");
  share.forEach((v, h) => {
    const r = el(s, "rect", { x: L + h * bw + 2, y: y(v), width: bw - 4, height: T + ih - y(v), fill: C.blue });
    r.dataset.tip = `<b>${hh(h)}</b><br>${fmt(hourly.c[h])} tickets (${pct(v, 1)})<br>demand share ${pct(dshare[h], 1)}`;
  });
  let d = "";
  dshare.forEach((v, h) => { d += `${h ? "L" : "M"}${L + h * bw},${y(v)} L${L + (h + 1) * bw},${y(v)} `; });
  el(s, "path", { d, fill: "none", stroke: C.yellow, "stroke-width": 2 });
  for (let h = 0; h < 24; h += 3) el(s, "text", { x: L + h * bw + bw / 2, y: H - 10, "text-anchor": "middle" }, String(h).padStart(2, "0"));
  el(s, "line", { x1: L, x2: W - R, y1: T + ih, y2: T + ih, class: "axis" });
  node.replaceChildren(s);
  node.insertAdjacentHTML("beforeend", `<div class="legend"><span><span class="tier-dot" style="background:${C.blue}"></span>share of tickets</span><span><span class="tier-dot" style="background:${C.yellow};height:2px"></span>share of traffic demand</span></div>`);
  bindTips(node);
}

/* ARC-style pixel grid: weekday x hour */
function chartWeek(node, week) {
  const W = 560, L = 34, T = 4, gap = 2;
  const cw = (W - L) / 24, chh = cw;
  const H = T + 7 * chh + 24;
  const s = svg(W, H);
  const max = Math.max(1, ...week.flat());
  week.forEach((row, d) => {
    el(s, "text", { x: L - 6, y: T + d * chh + chh / 2 + 3, "text-anchor": "end" }, DAYS[d].toUpperCase());
    row.forEach((v, h) => {
      const k = v === 0 ? 0 : 1 + Math.min(4, Math.floor(Math.sqrt(v / max) * 5));
      const r = el(s, "rect", { x: L + h * cw + gap / 2, y: T + d * chh + gap / 2, width: cw - gap, height: chh - gap, fill: RAMP[k] });
      r.dataset.tip = `<b>${DAYS_LONG[d].toUpperCase()} ${hh(h)}</b><br>${fmt(v)} tickets`;
    });
  });
  for (let h = 0; h < 24; h += 3) el(s, "text", { x: L + h * cw + cw / 2, y: H - 6, "text-anchor": "middle" }, String(h).padStart(2, "0"));
  node.replaceChildren(s);
  node.insertAdjacentHTML("beforeend", `<div class="legend">fewer<span class="ramp">${RAMP.map((c) => `<i style="background:${c}"></i>`).join("")}</span>more</div>`);
  bindTips(node);
}

/* horizontal bars */
function chartBars(node, rows, { key = "k", val = "i", color = C.magenta, fmtV = (v) => fmt(v), tipF, onClick } = {}) {
  const W = 560, rh = 26, L = 150, R = 60, H = rows.length * rh + 6;
  const s = svg(W, H);
  const max = Math.max(...rows.map((r) => r[val])) || 1;
  rows.forEach((r, i) => {
    const y = i * rh + 4, w = ((W - L - R) * r[val]) / max;
    const g = el(s, "g", { style: onClick ? "cursor:pointer" : "" });
    el(g, "text", { x: L - 10, y: y + 13, "text-anchor": "end", class: "lbl" }, r[key].length > 20 ? r[key].slice(0, 19) + "…" : r[key]);
    el(g, "rect", { x: L, y: y + 3, width: W - L - R, height: rh - 10, fill: "rgba(255,255,255,.03)" });
    el(g, "rect", { x: L, y: y + 3, width: Math.max(1, w), height: rh - 10, fill: color });
    el(g, "text", { x: L + w + 6, y: y + 13 }, fmtV(r[val]));
    if (tipF) g.dataset.tip = tipF(r);
    if (onClick) g.addEventListener("click", () => onClick(r));
  });
  node.replaceChildren(s);
  bindTips(node);
}

/* paired bars: share of tickets vs share of impact */
function chartShares(node, rows) {
  const tc = rows.reduce((a, r) => a + r.c, 0), ti = rows.reduce((a, r) => a + r.i, 0);
  rows = rows.slice(0, 8).map((r) => ({ ...r, sc: r.c / tc, si: r.i / ti }));
  const W = 560, rh = 34, L = 170, R = 50, H = rows.length * rh + 4;
  const s = svg(W, H), iw = W - L - R;
  const max = Math.max(...rows.flatMap((r) => [r.sc, r.si]));
  rows.forEach((r, i) => {
    const y = i * rh + 4;
    const g = el(s, "g");
    const name = title(r.k).replace("Bustop/School/Hospital Etc", "bus stop/school");
    el(g, "text", { x: L - 10, y: y + 17, "text-anchor": "end", class: "lbl" }, name.length > 24 ? name.slice(0, 23) + "…" : name);
    el(g, "rect", { x: L, y: y + 3, width: Math.max(1, (iw * r.sc) / max), height: 10, fill: C.blue });
    el(g, "rect", { x: L, y: y + 15, width: Math.max(1, (iw * r.si) / max), height: 10, fill: C.magenta });
    el(g, "text", { x: L + (iw * Math.max(r.sc, r.si)) / max + 6, y: y + 18 }, (r.si / r.sc).toFixed(1) + "×");
    g.dataset.tip = `<b>${esc(r.k)}</b><br>${pct(r.sc, 1)} of tickets<br>${pct(r.si, 1)} of traffic impact<br>${(r.si / r.sc).toFixed(1)}× the average harm per ticket`;
  });
  node.replaceChildren(s);
  node.insertAdjacentHTML("beforeend", `<div class="legend"><span><span class="tier-dot" style="background:${C.blue}"></span>tickets</span><span><span class="tier-dot" style="background:${C.magenta}"></span>impact</span><span>2.0× = each ticket does twice the average traffic harm</span></div>`);
  bindTips(node);
}

/* scatter: volume (log) vs impact per ticket */
function chartScatter(node, pts) {
  pts = pts.filter((p) => p.c >= 30);
  const W = 560, H = 300, L = 40, R = 14, T = 12, B = 30;
  const s = svg(W, H), iw = W - L - R, ih = H - T - B;
  const lx = pts.map((p) => Math.log10(p.c));
  const x0 = Math.floor(Math.min(...lx)), x1 = Math.ceil(Math.max(...lx));
  const ymax = niceMax(Math.max(...pts.map((p) => p.ipv)));
  const x = (c) => L + ((Math.log10(c) - x0) / (x1 - x0)) * iw;
  const y = (v) => T + ih - (v / ymax) * ih;
  const med = (a) => { const b = [...a].sort((p, q) => p - q); return b[Math.floor(b.length / 2)]; };
  const mx = med(pts.map((p) => p.c)), my = med(pts.map((p) => p.ipv));
  el(s, "rect", { x: x(mx), y: T, width: W - R - x(mx), height: y(my) - T, fill: "rgba(249,60,49,.07)" });
  el(s, "text", { x: W - R - 4, y: T + 10, "text-anchor": "end", style: `fill:${C.red}` }, "ENFORCE FIRST");
  el(s, "line", { x1: x(mx), x2: x(mx), y1: T, y2: T + ih, class: "axis", "stroke-dasharray": "3 3" });
  el(s, "line", { x1: L, x2: W - R, y1: y(my), y2: y(my), class: "axis", "stroke-dasharray": "3 3" });
  for (let e = x0; e <= x1; e++) el(s, "text", { x: L + ((e - x0) / (x1 - x0)) * iw, y: H - 12, "text-anchor": "middle" }, fmt(10 ** e));
  el(s, "text", { x: L + iw / 2, y: H, "text-anchor": "middle" }, "NUMBER OF TICKETS (LOG SCALE)");
  [0, 0.5, 1].forEach((f) => el(s, "text", { x: L - 6, y: y(ymax * f) + 3, "text-anchor": "end" }, (ymax * f).toFixed(2)));
  el(s, "text", { x: 0, y: 0, transform: `translate(10 ${T + ih / 2}) rotate(-90)`, "text-anchor": "middle" }, "HARM PER TICKET");
  const labelled = new Set([...pts].sort((a, b) => b.c * b.ipv - a.c * a.ipv).slice(0, 4).map((p) => p.k));
  pts.forEach((p) => {
    const hot = p.c >= mx && p.ipv >= my;
    const r = el(s, "rect", { x: x(p.c) - 4, y: y(p.ipv) - 4, width: 8, height: 8, fill: hot ? C.red : C.grayLight, opacity: hot ? 1 : 0.6 });
    r.dataset.tip = `<b>${esc(p.k.toUpperCase())}</b><br>${fmt(p.c)} tickets<br>${p.ipv.toFixed(3)} impact points per ticket`;
    if (labelled.has(p.k)) el(s, "text", { x: x(p.c) + 7, y: y(p.ipv) + 3, class: "lbl", style: "font-size:11px" }, p.k);
  });
  node.replaceChildren(s);
  bindTips(node);
}

/* forecast 24h bars */
function chartForecast(node, count, impact) {
  const W = 560, H = 230, L = 36, R = 8, T = 10, B = 26;
  const s = svg(W, H), iw = W - L - R, ih = H - T - B, bw = iw / 24;
  const ymax = niceMax(Math.max(...impact));
  const y = (v) => T + ih - (v / ymax) * ih;
  [0, 0.5, 1].forEach((f) => {
    el(s, "line", { x1: L, x2: W - R, y1: y(ymax * f), y2: y(ymax * f), class: "grid" });
    el(s, "text", { x: L - 6, y: y(ymax * f) + 3, "text-anchor": "end" }, (ymax * f).toFixed(1));
  });
  const win = impact.map((_, h) => impact[h] + impact[(h + 1) % 24] + impact[(h + 2) % 24]);
  const ws = win.indexOf(Math.max(...win));
  el(s, "rect", { x: L + ws * bw, y: T, width: 3 * bw, height: ih, fill: "rgba(255,216,77,.08)", stroke: C.yellow, "stroke-dasharray": "3 3" });
  impact.forEach((v, h) => {
    const inW = h >= ws && h < ws + 3;
    const r = el(s, "rect", { x: L + h * bw + 2, y: y(v), width: bw - 4, height: T + ih - y(v), fill: inW ? C.yellow : C.magenta });
    r.dataset.tip = `<b>${hh(h)}</b><br>${count[h].toFixed(1)} expected tickets<br>${v.toFixed(2)} impact points`;
  });
  for (let h = 0; h < 24; h += 3) el(s, "text", { x: L + h * bw + bw / 2, y: H - 8, "text-anchor": "middle" }, String(h).padStart(2, "0"));
  el(s, "line", { x1: L, x2: W - R, y1: T + ih, y2: T + ih, class: "axis" });
  node.replaceChildren(s);
  node.insertAdjacentHTML("beforeend", `<div class="legend"><span><span class="tier-dot" style="background:${C.magenta}"></span>expected impact</span><span><span class="tier-dot" style="background:${C.yellow}"></span>recommended patrol window ${hh(ws)}–${hh(ws + 3)}</span></div>`);
  bindTips(node);
}

/* ---------------- maps ---------------- */
// leaflet.heat throws if it redraws while its map is 0x0 (hidden tab/pane); skip those frames
if (L.HeatLayer) {
  const redraw = L.HeatLayer.prototype._redraw;
  L.HeatLayer.prototype._redraw = function () {
    if (this._map && this._map.getSize().x > 0 && this._map.getSize().y > 0) redraw.call(this);
    this._frame = null;
  };
}
const maps = {};
function makeMap(id) {
  const m = L.map(id, { zoomControl: true, preferCanvas: true }).setView([12.975, 77.595], 12);
  const esri = "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/";
  L.tileLayer(esri + "World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}", {
    attribution: "Tiles &copy; Esri, HERE, Garmin, &copy; OpenStreetMap", maxZoom: 16, className: "base-tiles",
  }).addTo(m);
  // street labels on their own pane so they sit above the heat layer
  m.createPane("labels");
  m.getPane("labels").style.zIndex = 650;
  m.getPane("labels").style.pointerEvents = "none";
  L.tileLayer(esri + "World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}", {
    pane: "labels", maxZoom: 16, opacity: 0.8,
  }).addTo(m);
  maps[id] = m;
  return m;
}
const HALF = 0.001; // half of a 0.002° grid cell
function cellRect(h, opts = {}) {
  // cell centroid is the mean of its points; draw the fixed 220 m square it belongs to
  const gy = Math.floor(h.lat / 0.002) * 0.002, gx = Math.floor(h.lon / 0.002) * 0.002;
  return L.rectangle([[gy, gx], [gy + 2 * HALF, gx + 2 * HALF]], {
    color: TIER[h.tier], weight: 1.5, fillColor: TIER[h.tier], fillOpacity: 0.25, ...opts,
  });
}
// Gi* z-score in words: 2.58 = 99% sure, 1.96 = 95% sure this is a real cluster
const confidence = (z) => (z > 2.58 ? "Very high (99%)" : z > 1.96 ? "High (95%)" : "Low (not a clear hotspot)");
function hotPopup(h) {
  const road = h.road || "—";
  return `<div class="pop-rank">#${h.rank} · ${h.tier} · EPI ${h.epi}</div>
    <div class="pop-title">${esc(road)}</div>
    <div class="pop-grid">
      <span>Station</span><span>${esc(h.station)}</span>
      <span>Junction</span><span>${esc(h.junction ? h.junction.replace(/^BTP\d+ - /, "") : "none")}</span>
      <span>Tickets</span><span>${fmt(h.n)} over ${h.days} days</span>
      <span>Impact points / day</span><span>${h.impact_per_day.toFixed(1)}</span>
      <span>Road blocked / day</span><span>${fmt(h.blocked_m_day, 0)} m</span>
      <span>Main vehicle</span><span>${esc(h.vgroup)}</span>
      <span>Main offence</span><span>${esc(title(h.offence))}</span>
      <span>Patrol window</span><span>${hh(h.peak_start)}–${hh(h.peak_start + 3)}</span>
      <span>Hotspot confidence</span><span>${confidence(h.gi_z)}</span>
    </div>`;
}

/* ---------------- filters ---------------- */
function multiFilter(host, label, key, options, fmtOpt = (o) => o) {
  const wrap = document.createElement("div");
  wrap.className = "filter";
  wrap.innerHTML = `<span class="filter-label">${label}</span><button type="button"></button><div class="dropdown"><div class="dd-actions"><button data-a="none">Clear</button></div></div>`;
  const btn = wrap.querySelector("button"), dd = wrap.querySelector(".dropdown");
  options.forEach((o) => {
    const l = document.createElement("label");
    l.innerHTML = `<input type="checkbox" value="${esc(o)}"> ${esc(fmtOpt(o))}`;
    dd.appendChild(l);
  });
  const paint = () => {
    const n = state[key].length;
    btn.textContent = n === 0 ? "All" : n === 1 ? fmtOpt(state[key][0]) : `${n} selected`;
    btn.classList.toggle("has", n > 0);
    dd.querySelectorAll("input").forEach((i) => (i.checked = state[key].includes(i.value)));
  };
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    document.querySelectorAll(".dropdown.open").forEach((d) => d !== dd && d.classList.remove("open"));
    dd.classList.toggle("open");
  });
  dd.addEventListener("click", (e) => e.stopPropagation());
  dd.addEventListener("change", () => {
    state[key] = [...dd.querySelectorAll("input:checked")].map((i) => i.value);
    paint(); refresh();
  });
  dd.querySelector('[data-a="none"]').addEventListener("click", () => { state[key] = []; paint(); refresh(); });
  wrap.paint = paint;
  paint();
  host.appendChild(wrap);
  return wrap;
}
document.addEventListener("click", () => document.querySelectorAll(".dropdown.open").forEach((d) => d.classList.remove("open")));

function buildFilters() {
  const host = $("#filters");
  const widgets = [
    multiFilter(host, "POLICE STATION", "stations", META.options.stations),
    multiFilter(host, "VEHICLE", "vgroups", META.options.vgroups),
    multiFilter(host, "OFFENCE", "offences", META.options.offences, title),
    multiFilter(host, "DAY", "days", ["0", "1", "2", "3", "4", "5", "6"], (d) => DAYS_LONG[+d]),
  ];
  const hw = document.createElement("div");
  hw.innerHTML = `<span class="filter-label">HOURS</span><div class="hours"><input type="range" min="0" max="23" value="0" id="h0"><output id="hout"></output><input type="range" min="0" max="23" value="23" id="h1"></div>`;
  host.appendChild(hw);
  const h0 = $("#h0", hw), h1 = $("#h1", hw), out = $("#hout", hw);
  const paintH = () => (out.textContent = `${hh(state.h0)}–${hh(state.h1)}`);
  let t;
  const onH = () => {
    let a = +h0.value, b = +h1.value;
    if (a > b) [a, b] = [b, a];
    state.h0 = a; state.h1 = b; paintH();
    clearTimeout(t); t = setTimeout(refresh, 200);
  };
  h0.addEventListener("input", onH); h1.addEventListener("input", onH);
  paintH();
  const reset = document.createElement("button");
  reset.className = "reset"; reset.textContent = "Reset";
  reset.addEventListener("click", () => {
    Object.assign(state, { stations: [], vgroups: [], offences: [], days: [], h0: 0, h1: 23 });
    h0.value = 0; h1.value = 23; paintH();
    widgets.forEach((w) => w.paint()); refresh();
  });
  host.appendChild(reset);
}

/* ---------------- overview ---------------- */
let heatLayer, overviewCells, lastOverview;
/* records.bin: grouped tickets as typed-array columns (layout in meta.records) */
function loadRecords(buf) {
  const R = META.records, T = { float32: Float32Array, uint16: Uint16Array, uint8: Uint8Array };
  const cols = {};
  R.columns.forEach((c) => (cols[c.name] = new T[c.type](buf, c.offset, R.rows)));
  return cols;
}

// Everything the overview needs, for the current filters, in one pass over the rows.
function computeOverview() {
  const R = REC, O = META.options, rows = META.records.rows;
  const want = (list, names) => {
    if (!list.length) return null;
    const m = new Uint8Array(names.length);
    list.forEach((v) => (m[names.indexOf(v)] = 1));
    return m;
  };
  const fs = want(state.stations, O.stations), fv = want(state.vgroups, O.vgroups), fo = want(state.offences, O.offences);
  const fd = state.days.length ? new Set(state.days.map(Number)) : null;
  const nS = O.stations.length, nV = O.vgroups.length, nO = O.offences.length;
  const hc = new Float64Array(24), hi = new Float64Array(24), week = Array.from({ length: 7 }, () => new Array(24).fill(0));
  const sc = new Float64Array(nS), si = new Float64Array(nS), vc = new Float64Array(nV), vi = new Float64Array(nV), oc = new Float64Array(nO), oi = new Float64Array(nO);
  const heat = new Map(), p1i = META.records.tiers.indexOf("P1");
  let n = 0, imp = 0, blk = 0, jn = 0, p1 = 0;
  for (let r = 0; r < rows; r++) {
    const h = R.hour[r];
    if (h < state.h0 || h > state.h1) continue;
    const st = R.stn[r], ve = R.veh[r], of = R.off[r], dw = R.dow[r];
    if ((fs && !fs[st]) || (fv && !fv[ve]) || (fo && !fo[of]) || (fd && !fd.has(dw))) continue;
    const c = R.n[r], i = R.impact[r];
    n += c; imp += i; blk += R.blocked[r]; if (R.jn[r]) jn += c; if (R.tier[r] === p1i) p1 += i;
    hc[h] += c; hi[h] += i; week[dw][h] += c;
    sc[st] += c; si[st] += i; vc[ve] += c; vi[ve] += i; oc[of] += c; oi[of] += i;
    const key = R.by[r] * 65536 + R.bx[r], cell = heat.get(key);
    if (cell) { cell[0] += c; cell[1] += i; } else heat.set(key, [c, i]);
  }
  if (!n) return { n: 0 };
  const days = META.dataset.days, deg = META.records.bin_deg, by0 = META.records.by0, bx0 = META.records.bx0;
  const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;
  const stations = O.stations.map((k, j) => ({ k, c: sc[j], i: round(si[j], 1), ipv: si[j] / (sc[j] || 1) })).filter((x) => x.c > 0);
  const mix = (names, cc, ii) => names.map((k, j) => ({ k, c: cc[j], i: round(ii[j], 1) })).filter((x) => x.c > 0).sort((a, b) => b.i - a.i);
  const byImpact = [...stations].sort((a, b) => b.i - a.i);
  return {
    n,
    impact: round(imp, 1),
    impact_per_day: round(imp / days, 1),
    blocked_km_day: round(blk / days / 1000, 2),
    junction_share: jn / n,
    stations: stations.length,
    peak_hour: hi.indexOf(Math.max(...hi)),
    top_station: byImpact[0].k,
    p1_share: p1 / imp,
    heat: [...heat].map(([key, [c, i]]) => [round((Math.floor(key / 65536) + by0) * deg, 4), round(((key % 65536) + bx0) * deg, 4), c, i]),
    hourly: { c: [...hc], i: [...hi].map((v) => round(v, 1)) },
    week,
    top_stations: byImpact.slice(0, 12),
    scatter: stations,
    vgroups: mix(O.vgroups, vc, vi),
    offences: mix(O.offences, oc, oi),
  };
}

function drawHeat() {
  const d = lastOverview, m = maps["map-overview"];
  if (heatLayer) m.removeLayer(heatLayer);
  heatLayer = null;
  if (!d || !d.n) return;
  m.invalidateSize();
  const sz = m.getSize();
  if (!sz.x || !sz.y) { setTimeout(drawHeat, 300); return; } // map not laid out yet
  const k = state.heatMode === "impact" ? 3 : 2;
  const vals = d.heat.map((p) => p[k]).sort((a, b) => a - b);
  const cap = vals[Math.floor(vals.length * 0.995)] || 1;
  // sqrt keeps mid-intensity blocks visible without flooding the whole city
  heatLayer = L.heatLayer(d.heat.map((p) => [p[0], p[1], Math.sqrt(Math.min(1, p[k] / cap))]), {
    radius: 11, blur: 13, maxZoom: 16, minOpacity: 0.12, max: 0.9,
    gradient: { 0.2: C.maroon, 0.45: C.red, 0.7: C.orange, 0.9: C.yellow, 1: "#fff6c8" },
  }).addTo(m);
}

async function refresh() {
  const d = computeOverview();
  lastOverview = d;
  if (!d.n) {
    $("#filter-status").textContent = "No tickets match these filters. Loosen them.";
    $("#kpis").innerHTML = "";
    drawHeat();
    return;
  }
  const ds = META.dataset;
  $("#filter-status").textContent = `Showing ${fmt(d.n)} of ${fmt(ds.parking_violations)} validated parking tickets · ${ds.start} → ${ds.end}`;

  const kpi = (label, value, sub = "", cls = "", help = "") =>
    `<div class="kpi"><div class="kpi-label">${label}${help ? ` <span class="info" data-tip="${esc(help)}">?</span>` : ""}</div><div class="kpi-value ${cls}" title="${esc(value)}">${value}</div><div class="kpi-sub">${sub}</div></div>`;
  $("#kpis").innerHTML =
    kpi("Tickets", fmt(d.n), `${fmt(d.n / ds.days, 0)} per day`, "", "Parking e-challans issued by traffic police, after removing ones that validators rejected or marked duplicate.") +
    kpi("Impact per day", fmt(d.impact_per_day, 0), "impact points", "", "How much illegal parking slows traffic each day. 1 point = one car parked at the kerb during rush hour. Bigger vehicles, busier roads, junctions and peak hours score more.") +
    kpi("Road blocked", `${d.blocked_km_day} km`, "of lane lost per day", "", "Total length of road lane taken up by illegally parked vehicles per day, added end to end.") +
    kpi("At junctions", pct(d.junction_share), "of tickets at a junction", "", "Share of tickets at a named traffic junction. Parking there hurts more because junctions are where traffic already bunches up.") +
    kpi("Worst hour", hh(d.peak_hour), "most traffic harm", "", "The hour of day when illegal parking does the most damage to traffic flow.") +
    kpi("Top station", esc(d.top_station), `${d.stations} stations in view`, "sm", "The police station area where illegal parking causes the most traffic harm.");

  bindTips($("#kpis"));
  chartHourly($("#chart-hourly"), d.hourly);
  const tot = d.hourly.c.reduce((a, b) => a + b, 0) || 1;
  const dem = META.assumptions.demand_profile, dsum = dem.reduce((a, b) => a + b, 0);
  const eve = d.hourly.c.slice(18, 22).reduce((a, b) => a + b, 0) / tot;
  const eveDem = dem.slice(18, 22).reduce((a, b) => a + b, 0) / dsum;
  $("#gap-note").innerHTML = `18:00–22:00 carries about <strong>${pct(eveDem)}</strong> of daily traffic demand but only <strong>${pct(eve, 1)}</strong> of tickets. Enforcement tails off after 18:00, just as the evening peak builds.`;
  chartWeek($("#chart-week"), d.week);
  chartBars($("#chart-stations"), d.top_stations, {
    fmtV: (v) => fmt(v / META.dataset.days, 1) + "/d",
    tipF: (r) => `<b>${esc(r.k.toUpperCase())}</b><br>${fmt(r.c)} tickets<br>${fmt(r.i / META.dataset.days, 1)} impact / day<br>${r.ipv.toFixed(3)} impact / ticket<br><span class="muted">click to filter</span>`,
    onClick: (r) => { state.stations = [r.k]; document.querySelectorAll("#filters .filter").forEach((w) => w.paint()); refresh(); },
  });
  chartScatter($("#chart-scatter"), d.scatter);
  chartShares($("#chart-veh"), d.vgroups);
  chartShares($("#chart-off"), d.offences);
  drawHeat();
}

function buildOverviewStatic() {
  const ds = META.dataset, f = META.findings;
  $("#lede").innerHTML = `Bengaluru Traffic Police issued <strong>${fmt(ds.raw_records)}</strong> parking fines (e-challans) between ${ds.start} and ${ds.end}. We removed ${fmt(ds.dropped_invalid)} that were rejected or duplicates, leaving <strong>${fmt(ds.parking_violations)}</strong> real tickets. Counting tickets alone treats a scooter on a quiet lane the same as a bus blocking a junction at rush hour. So every ticket is scored for <em>how much it slows traffic</em>, and that score decides where police should go first.`;
  $("#callout").textContent = `${f.p1_cells} blocks · ${f.p1_area_km2} km² · ${pct(f.p1_impact_share)} of the city's parking congestion`;
  $("#callout-sub").innerHTML = `Just ${f.p1_cells} city blocks, about ${f.p1_area_km2} km² in total, cause ${pct(f.p1_impact_share)} of all the traffic slowdown from illegal parking in Bengaluru. ${pct(f.junction_record_share)} of tickets are at traffic junctions, and they cause ${pct(f.junction_impact_share)} of the slowdown. A short, fixed patrol list at the right hours beats sweeping the whole city.`;

  const m = makeMap("map-overview");
  overviewCells = L.layerGroup(HOT.filter((h) => h.tier === "P1" || h.tier === "P2").map((h) =>
    cellRect(h, { fillOpacity: 0.08 }).bindPopup(hotPopup(h)))).addTo(m);
  $("#legend-overview").innerHTML = `<span>heat<span class="ramp">${[C.maroon, C.red, C.orange, C.yellow].map((c) => `<i style="background:${c}"></i>`).join("")}</span>high</span><span><span class="tier-dot t-P1"></span>P1 block</span><span><span class="tier-dot t-P2"></span>P2 block</span>`;
  $("#heat-mode").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    state.heatMode = b.dataset.v;
    $("#heat-mode").querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
    drawHeat();
  });
}

/* ---------------- hotspots page ---------------- */
let hotBuilt = false;
const hotState = { tier: ["P1", "P2", "P3"], station: "" };
function buildHotspots() {
  if (hotBuilt) return;
  hotBuilt = true;
  const m = makeMap("map-hot");
  const layer = L.layerGroup().addTo(m);
  const rects = new Map();

  const host = $("#hot-filters");
  host.innerHTML = `
    <div class="seg" id="tier-seg">
      ${["P1", "P2", "P3", "Watch"].map((t) => `<button data-v="${t}" class="${hotState.tier.includes(t) ? "on" : ""}"><span class="tier-dot t-${t}"></span>${t}</button>`).join("")}
    </div>
    <label class="field" style="flex:1"><select id="hot-station"><option value="">All stations</option>${META.options.stations.map((s) => `<option>${esc(s)}</option>`).join("")}</select></label>`;
  $("#hot-station").style.minWidth = "0"; $("#hot-station").style.width = "100%";

  function render() {
    const rows = HOT.filter((h) => hotState.tier.includes(h.tier) && (!hotState.station || h.station === hotState.station));
    layer.clearLayers(); rects.clear();
    rows.forEach((h) => {
      const r = cellRect(h).bindPopup(hotPopup(h));
      r.on("click", () => select(h.rank, false));
      rects.set(h.rank, r); layer.addLayer(r);
    });
    $("#hot-list").innerHTML = rows.slice(0, 300).map((h) => `
      <div class="hot-row" data-rank="${h.rank}">
        <div class="hot-rank">${h.rank}</div>
        <div>
          <div class="hot-name">${esc(h.road || "Unnamed road")}</div>
          <div class="hot-meta">${esc(h.station)}${h.junction ? " · " + esc(h.junction.replace(/^BTP\d+ - /, "")) : ""}</div>
          <div class="hot-meta">${fmt(h.n)} tickets · ${h.impact_per_day.toFixed(1)} impact pts/day · patrol ${hh(h.peak_start)}–${hh(h.peak_start + 3)}</div>
        </div>
        <div class="hot-epi"><b>${h.epi.toFixed(0)}</b><span class="badge ${h.tier}">${h.tier}</span></div>
      </div>`).join("") || `<p class="muted" style="padding:16px">No cells match.</p>`;
    if (rows.length) m.fitBounds(L.featureGroup([...rects.values()]).getBounds(), { padding: [30, 30], maxZoom: 15 });
  }
  function select(rank, fly = true) {
    document.querySelectorAll(".hot-row").forEach((r) => r.classList.toggle("sel", +r.dataset.rank === rank));
    const row = document.querySelector(`.hot-row[data-rank="${rank}"]`);
    if (row && !fly) row.scrollIntoView({ block: "nearest" });
    const r = rects.get(rank);
    if (r && fly) { m.flyTo(r.getBounds().getCenter(), 16, { duration: 0.6 }); setTimeout(() => r.openPopup(), 650); }
  }
  $("#hot-list").addEventListener("click", (e) => {
    const row = e.target.closest(".hot-row"); if (row) select(+row.dataset.rank);
  });
  $("#tier-seg").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    b.classList.toggle("on");
    hotState.tier = [...$("#tier-seg").querySelectorAll("button.on")].map((x) => x.dataset.v);
    render();
  });
  $("#hot-station").addEventListener("change", (e) => { hotState.station = e.target.value; render(); });
  setTimeout(render, 40);
}

/* ---------------- forecast page ---------------- */
// Plan for a date: every station ranked by expected impact, with its best 3-hour window.
function computeForecast(date, station) {
  const dt = new Date(date + "T00:00:00");
  const dow = (dt.getDay() + 6) % 7; // Monday = 0, like pandas
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  const plan = Object.entries(FC).map(([s, v]) => {
    const imp = v.impact[dow];
    const win = imp.map((_, h) => imp[h] + imp[(h + 1) % 24] + imp[(h + 2) % 24]);
    return { station: s, count: sum(v.count[dow]), impact: sum(imp), window: win.indexOf(Math.max(...win)) };
  }).sort((a, b) => b.impact - a.impact);
  plan.forEach((r, i) => (r.rank = i + 1));
  const res = { date, dow, plan };
  if (FC[station]) res.station = {
    name: station, count: FC[station].count[dow], impact: FC[station].impact[dow],
    hotspots: HOT.filter((h) => h.station === station).slice(0, 8),
  };
  return res;
}
let fcBuilt = false;
function buildForecast() {
  if (fcBuilt) return;
  fcBuilt = true;
  const sel = $("#fc-station");
  sel.innerHTML = META.options.stations.map((s) => `<option>${esc(s)}</option>`).join("");
  const mt = META.metrics;
  $("#fc-metric").innerHTML = `<strong>How reliable is this?</strong> We hid the last 3 weeks of data and asked the model to predict them. It named <strong>${Math.round(mt.top10_station_hit_rate * 10)} of each day's 10 busiest stations</strong> correctly, and its hourly guesses were off by about ${mt.mae_model.toFixed(1)} tickets on average (a plain average is off by ${mt.mae_global_mean.toFixed(1)}).`;
  let firstLoad = true;
  function load() {
    const d = computeForecast($("#fc-date").value, sel.value);
    if (firstLoad) { sel.value = d.plan[0].station; firstLoad = false; return load(); }
    const dayName = DAYS_LONG[d.dow];
    $("#fc-plan-label").textContent = `DEPLOYMENT PLAN · ${dayName.toUpperCase()} ${d.date}`;
    const max = d.plan[0].impact || 1;
    $("#fc-plan").innerHTML = `<table class="tbl"><thead><tr><th>#</th><th>Station</th><th class="num">Tickets</th><th>Impact</th><th>Patrol window</th></tr></thead><tbody>${
      d.plan.slice(0, 15).map((r) => `<tr class="click ${r.station === sel.value ? "sel" : ""}" data-s="${esc(r.station)}">
        <td class="muted">${r.rank}</td><td>${esc(r.station)}</td><td class="num">${fmt(r.count, 0)}</td>
        <td class="bar-cell" style="width:120px"><i style="width:${(100 * r.impact) / max}%"></i><span style="position:relative">${fmt(r.impact, 1)}</span></td>
        <td class="window">${hh(r.window)}–${hh(r.window + 3)}</td></tr>`).join("")
    }</tbody></table><p class="note">Ranked by expected congestion impact, not raw tickets. Click a station for its hourly profile.</p>`;
    $("#fc-plan").querySelectorAll("tr.click").forEach((tr) => tr.addEventListener("click", () => { sel.value = tr.dataset.s; load(); }));
    if (d.station) {
      const tc = d.station.count.reduce((a, b) => a + b, 0);
      $("#fc-station-label").textContent = `${d.station.name.toUpperCase()} · ${fmt(tc, 0)} EXPECTED TICKETS`;
      chartForecast($("#chart-fc"), d.station.count, d.station.impact);
      $("#fc-cells").innerHTML = d.station.hotspots.length
        ? `<table class="tbl"><thead><tr><th>#</th><th>Road</th><th>Tier</th><th>Window</th></tr></thead><tbody>${d.station.hotspots.map((h) =>
            `<tr><td class="muted">${h.rank}</td><td>${esc(h.road || "—")}</td><td><span class="badge ${h.tier}">${h.tier}</span></td><td class="window">${hh(h.peak_start)}–${hh(h.peak_start + 3)}</td></tr>`).join("")}</tbody></table>`
        : `<p class="muted">No ranked cells in this station.</p>`;
    }
  }
  $("#fc-date").addEventListener("change", load);
  sel.addEventListener("change", load);
  load();
}

/* ---------------- method page ---------------- */
let methodBuilt = false;
function buildMethod() {
  if (methodBuilt) return;
  methodBuilt = true;
  const ds = META.dataset, mt = META.metrics, a = META.assumptions, f = META.findings;
  $("#m-clean-body").innerHTML = `<p><strong>${fmt(ds.raw_records)}</strong> raw records → dropped <strong>${fmt(ds.dropped_invalid)}</strong> marked <em>rejected</em> or <em>duplicate</em> by validators (they are not real violations, and would have inflated hotspots by ~17%) → <strong>${fmt(ds.parking_violations)}</strong> parking tickets across ${ds.stations} stations and ${ds.days} days. Timestamps were double-offset in the export: converting UTC → IST alone put 51% of human validator activity between midnight and 6 AM, so a further +5.5 h correction is applied. That puts 64% of validation in office hours (10:00–18:00) and tickets in a normal 06:00–20:00 enforcement day. Where a validator corrected the vehicle type, the corrected type is used. Non-parking offences (e.g. defective plate) are not counted towards obstruction.</p>`;
  $("#m-obs").innerHTML = `<thead><tr><th>Offence</th><th class="num">Weight</th></tr></thead><tbody>${Object.entries(a.obstruction).map(([k, v]) => `<tr><td>${esc(title(k))}</td><td class="num">${v.toFixed(1)}</td></tr>`).join("")}<tr><td>Junction multiplier</td><td class="num">${a.junction_factor}</td></tr></tbody>`;
  const dnode = $("#chart-demand");
  const s = svg(360, 120), bw = 360 / 24;
  a.demand_profile.forEach((v, h) => {
    const r = el(s, "rect", { x: h * bw + 1, y: 100 - v * 90, width: bw - 2, height: v * 90, fill: v >= 0.95 ? C.yellow : C.gray });
    r.dataset.tip = `<b>${hh(h)}</b><br>demand weight ${v}`;
  });
  for (let h = 0; h < 24; h += 6) el(s, "text", { x: h * bw + bw / 2, y: 116, "text-anchor": "middle" }, String(h).padStart(2, "0"));
  dnode.replaceChildren(s); bindTips(dnode);

  $("#m-fc-body").innerHTML = `<p>Target: tickets per station per hour. The original model computed each station's average over the whole dataset, including the test weeks (target leakage), and used <em>month</em>, which the test window (April) never saw in training. The rebuilt model uses only history before the cut-off: station × hour and station × weekday profiles, the last-28-day level, and a Poisson loss suited to sparse counts. It is evaluated on the last 21 days (${mt.test_window}) against honest baselines:</p>`;
  $("#m-metrics").innerHTML = `<thead><tr><th>Approach</th><th class="num">MAE / station-hour</th><th class="num">Top-10 hit rate</th></tr></thead><tbody>
    <tr><td>Global average (naive)</td><td class="num">${mt.mae_global_mean}</td><td class="num">—</td></tr>
    <tr><td>Station × hour history</td><td class="num">${mt.mae_station_hour}</td><td class="num">${pct(mt.top10_hit_rate_station_hour, 1)}</td></tr>
    <tr><td>Station × weekday × hour history</td><td class="num">${mt.mae_station_dow_hour}</td><td class="num">—</td></tr>
    <tr><td><strong>${mt.model}</strong></td><td class="num"><strong>${mt.mae_model}</strong></td><td class="num"><strong>${pct(mt.top10_station_hit_rate, 1)}</strong></td></tr></tbody>`;
  $("#m-limits-body").innerHTML = [
    "Tickets record <em>when enforcement happened</em>, not when parking occurred. Late-evening impact is under-counted because patrols thin out after 18:00.",
    "The time correction (+5.5 h beyond UTC → IST) is inferred from validator desk hours, not confirmed by the data owner. It should be verified with BTP before deployment.",
    "Impact is a physically motivated proxy (PCU × lane obstruction × junction × demand), not measured speed loss. With a traffic-speed feed (e.g. BTP ATCS or map-provider speeds per segment), the weights could be calibrated by regressing speed drop on nearby ticket density.",
    `Hourly counts are noisy (patrol-driven). The model gains over the station-hour profile are modest, and its value is in ranking where to go: it picks ~${pct(mt.top10_station_hit_rate)} of each day's top-10 stations.`,
    `${f.significant_cells} of ${f.ranked_cells} ranked cells are statistically significant hotspots; the rest are shown as a watch list.`,
  ].map((x) => `<li>${x}</li>`).join("");
}

const onShow = { hotspots: buildHotspots, forecast: buildForecast, method: buildMethod };

/* ---------------- boot ---------------- */
(async function boot() {
  const get = (f) => fetch("data/" + f).then((r) => { if (!r.ok) throw new Error(f + " " + r.status); return r; });
  let buf;
  [META, HOT, FC, buf] = await Promise.all([
    get("meta.json").then((r) => r.json()), get("hotspots.json").then((r) => r.json()),
    get("forecast.json").then((r) => r.json()), get("records.bin").then((r) => r.arrayBuffer()),
  ]);
  REC = loadRecords(buf);
  buildOverviewStatic();
  buildFilters();
  go(location.hash.slice(1) || "overview");
  refresh();
})();

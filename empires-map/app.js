import * as d3 from "https://cdn.jsdelivr.net/npm/d3@7/+esm";

const GEOJSON_BASE =
  "https://raw.githubusercontent.com/aourednik/historical-basemaps/master/geojson/";
const CSHAPES_URL = "https://icr.ethz.ch/data/cshapes/CShapes-2.0.geojson";
const COW_ENTITIES_URL = new URL("data/cow/tc_entities_tabula.csv", document.baseURI).href;

const state = {
  snapshots: [],
  currentIdx: 0,
  cache: new Map(),
  cshapes: null,
  cowEntityRows: null,
  playTimer: null,
  timeWheelAccum: 0,
  width: 600,
  height: 400,
  /** SVG fill-rule for land paths. nonzero avoids parity holes in historical multipolygons. */
  landFillRule: "nonzero",
  currentYear: null,
};

const TIME_WHEEL_THRESH = 90;

let projection;
let path;
let svg;
let gRoot;
let pathSphereFill;
let pathSphereOutline;
let gLand;

function formatYear(y) {
  if (y < 0) return `${Math.abs(y).toLocaleString("en-US")} BCE`;
  return `${y.toLocaleString("en-US")} CE`;
}

function hashString(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}

function baseHueForKey(k) {
  return ((hashString(String(k).toLowerCase()) % 360) + 360) % 360;
}

function eachRing(geometry, visit) {
  if (!geometry) return;
  if (geometry.type === "Polygon") {
    for (const ring of geometry.coordinates) visit(ring);
  } else if (geometry.type === "MultiPolygon") {
    for (const poly of geometry.coordinates) {
      for (const ring of poly) visit(ring);
    }
  }
}

function geomBounds(geometry) {
  let minLon = Infinity;
  let maxLon = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;
  eachRing(geometry, (ring) => {
    for (const pt of ring) {
      const lon = pt[0];
      const lat = pt[1];
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
  });
  if (!Number.isFinite(minLon)) return null;
  return { minLon, maxLon, minLat, maxLat };
}

function fillForKey(key) {
  const k = String(key ?? "").trim();
  if (!k) return "rgba(110, 118, 129, 0.75)";
  const hue = baseHueForKey(k);
  return `hsla(${hue}, 50%, 42%, 0.9)`;
}

function usingCShapesYear(year) {
  return year >= 1886 && year <= 2019;
}

function regionName(d) {
  const p = d.properties ?? {};
  return String(p.NAME ?? p.name ?? p.cntry_name ?? "").trim();
}

function parseOwnerCode(status) {
  const s = String(status ?? "").trim();
  if (!s) return NaN;
  const m = s.match(/(\d+)\s*$/);
  return m ? Number(m[1]) : NaN;
}

function labelFromStatus(status) {
  const s = String(status ?? "").trim().toLowerCase();
  if (s.includes("occupied by")) return "Occupied by";
  if (s.includes("leased to")) return "Leased to";
  if (s.includes("claimed by")) return "Claimed by";
  if (s.includes("colony of")) return "Colony of";
  if (s.includes("possession of")) return "Possession of";
  if (s.includes("protectorate")) return "Protectorate of";
  if (s.includes("part of")) return "Part of";
  return "Controlled by";
}

function normalizeCsvRowKeys(row) {
  const out = {};
  for (const [k, v] of Object.entries(row)) out[String(k).replace(/\r/g, "").trim()] = v;
  return out;
}

async function loadCowEntities() {
  if (state.cowEntityRows) return state.cowEntityRows;
  const text = await (await fetch(COW_ENTITIES_URL, { cache: "default" })).text();
  const rows = d3
    .csvParse(text)
    .map(normalizeCsvRowKeys)
    .map((row) => {
      const code = Number(row["Entity Number"]);
      const begin = Number(row["Begin Year"]);
      const end = Number(row["End Year"]);
      const name = String(row["Name"] ?? "").trim();
      const status = String(row["Ending Political Status"] ?? "").trim();
      const ownerCode = parseOwnerCode(status);
      return { code, begin, end, name, status, ownerCode, relLabel: labelFromStatus(status) };
    })
    .filter((row) => Number.isFinite(row.code) && Number.isFinite(row.begin) && Number.isFinite(row.end));
  state.cowEntityRows = rows;
  return rows;
}

function ownerFromCowEntities(code, year) {
  if (!Number.isFinite(code) || !Number.isFinite(year) || !state.cowEntityRows) return null;
  const row = state.cowEntityRows.find((r) => r.code === code && r.begin <= year && year <= r.end);
  if (!row || !Number.isFinite(row.ownerCode) || row.ownerCode === code) return null;
  const owner = state.cowEntityRows.find((r) => r.code === row.ownerCode && r.begin <= year && year <= r.end);
  const ownerName = owner?.name ?? "";
  return { ownerCode: row.ownerCode, ownerName, relLabel: row.relLabel };
}

function powerKey(d) {
  const p = d.properties ?? {};
  const sub = String(p.SUBJECTO ?? p.subjecto ?? "").trim();
  const year = Number(state.currentYear);
  const code = Number(p.gwcode);
  const owner = ownerFromCowEntities(code, year);
  const cshapesOwner = String(owner?.ownerName ?? "").trim();
  const cshapesName = String(p.cntry_name ?? "").trim();
  const name = regionName(d);
  return sub || cshapesOwner || cshapesName || name || "";
}

function isGlobalBackdropFeature(feature) {
  if (!feature.geometry) return true;
  let area;
  try {
    area = d3.geoArea(feature);
  } catch {
    return true;
  }
  if (!Number.isFinite(area)) return true;
  // Named polities are never the synthetic global backdrop. CShapes (and some
  // other sources) can yield very large d3.geoArea values for valid polygons
  // (e.g. non-RFC7946 ring winding), so we must not drop them here.
  const pk = powerKey(feature);
  if (pk) return false;

  if (area > 10) return true;

  const b = geomBounds(feature.geometry);
  const lonSpan = b ? b.maxLon - b.minLon : 0;
  const latSpan = b ? b.maxLat - b.minLat : 0;
  if (area > 2) return true;
  if (lonSpan > 300) return true;
  if (lonSpan > 200 && latSpan > 16) return true;
  if (latSpan > 68 && lonSpan > 80) return true;
  return false;
}

function borderStyle(d) {
  const p = d.properties ?? {};
  if (p.gwsyear != null || p.gweyear != null) {
    return { dash: null, strokeOp: 0.85, fillOp: 0.92 };
  }
  const raw = p.BORDERPRECISION ?? p.borderprecision;
  const n = typeof raw === "number" ? raw : parseInt(String(raw), 10);
  if (n === 1) return { dash: "5 4", strokeOp: 0.45, fillOp: 0.72 };
  if (n === 2) return { dash: null, strokeOp: 0.65, fillOp: 0.85 };
  return { dash: null, strokeOp: 0.85, fillOp: 0.92 };
}

function reverseGeometryRings(geometry) {
  if (!geometry) return geometry;
  if (geometry.type === "Polygon") {
    return { ...geometry, coordinates: geometry.coordinates.map((ring) => [...ring].reverse()) };
  }
  if (geometry.type === "MultiPolygon") {
    return {
      ...geometry,
      coordinates: geometry.coordinates.map((poly) => poly.map((ring) => [...ring].reverse())),
    };
  }
  return geometry;
}

function normalizeFeatureGeometry(feature) {
  const geometry = feature?.geometry;
  if (!geometry) return feature;
  if (geometry.type !== "Polygon" && geometry.type !== "MultiPolygon") return feature;

  let areaOriginal = NaN;
  try {
    areaOriginal = d3.geoArea(feature);
  } catch {
    return feature;
  }
  if (!Number.isFinite(areaOriginal)) return feature;

  const reversed = reverseGeometryRings(geometry);
  let areaReversed = NaN;
  try {
    areaReversed = d3.geoArea({ ...feature, geometry: reversed });
  } catch {
    return feature;
  }
  if (Number.isFinite(areaReversed) && areaReversed < areaOriginal) {
    return { ...feature, geometry: reversed };
  }
  return feature;
}

function measure() {
  const wrap = document.getElementById("map-wrap");
  const r = wrap.getBoundingClientRect();
  state.width = Math.max(320, Math.floor(r.width));
  state.height = Math.max(280, Math.floor(r.height));
}

function configureProjection() {
  const { width, height } = state;
  const r = Math.min(width, height) * 0.42;
  projection.scale(r).translate([width / 2, height / 2]).clipAngle(90);
  path.projection(projection);
}

function redrawSphere() {
  pathSphereFill.datum({ type: "Sphere" }).attr("d", path);
  pathSphereOutline.datum({ type: "Sphere" }).attr("d", path);
}

function redrawLand() {
  gLand.selectAll("path.land").attr("d", path);
}

function updateAllPaths() {
  redrawSphere();
  redrawLand();
}

function clearPeerHighlight() {
  if (!gLand) return;
  gLand.selectAll("path.land").classed("land--peers", false).classed("land--muted", false);
  if (gRoot) gRoot.classed("globe-root--land-focus", false);
}

function setPeerHighlight(key) {
  if (!gLand) return;
  const k = String(key ?? "").trim();
  if (!k) {
    clearPeerHighlight();
    return;
  }
  gLand.selectAll("path.land").each(function (d) {
    const on = powerKey(d) === k;
    d3.select(this).classed("land--peers", on).classed("land--muted", !on);
  });
  if (gRoot) gRoot.classed("globe-root--land-focus", true);
}

function styleLandPath(selection) {
  return selection
    .attr("class", "land")
    .attr("fill-rule", state.landFillRule)
    .attr("vector-effect", "non-scaling-stroke")
    .each(function (d) {
      const key = powerKey(d);
      d3.select(this).attr("fill", fillForKey(key));
      const { dash, strokeOp, fillOp } = borderStyle(d);
      d3.select(this).attr("stroke-opacity", strokeOp).attr("fill-opacity", fillOp);
      if (dash) d3.select(this).attr("stroke-dasharray", dash);
      else d3.select(this).attr("stroke-dasharray", null);
    })
    .on("pointerenter.landtip", onLandPointerEnter)
    .on("pointermove.landtip", onLandPointerMove)
    .on("pointerleave.landtip", onLandPointerLeave);
}

function renderLand(fc) {
  const features = (fc.features ?? []).filter((f) => !isGlobalBackdropFeature(f));
  const merged = gLand
    .selectAll("path.land")
    .data(features, (_d, i) => i)
    .join((enter) => styleLandPath(enter.append("path")), (update) => styleLandPath(update));
  merged.attr("d", path);
}

function tooltipTitle(d) {
  const props = d.properties ?? {};
  const rawName = regionName(d);
  const sub = String(props.SUBJECTO ?? props.subjecto ?? "").trim();
  const owner = ownerFromCowEntities(Number(props.gwcode), Number(state.currentYear));
  const ownerName = String(owner?.ownerName ?? "").trim();
  if (!sub && ownerName && rawName && ownerName !== rawName) return `${ownerName} (${rawName})`;
  if (sub && rawName) return sub !== rawName ? `${sub} (${rawName})` : rawName;
  if (sub) return sub;
  if (rawName) return rawName;
  return "Unknown";
}

function onLandPointerEnter(event, d) {
  setPeerHighlight(powerKey(d));
  const el = document.getElementById("tooltip");
  el.innerHTML = `<div class="t-name">${escapeHtml(tooltipTitle(d))}</div>`;
  el.hidden = false;
  positionTooltip(event.clientX, event.clientY);
}

function onLandPointerMove(event) {
  const el = document.getElementById("tooltip");
  if (!el.hidden) positionTooltip(event.clientX, event.clientY);
}

function onLandPointerLeave(event, d) {
  const key = powerKey(d);
  const rt = event.relatedTarget;
  let stayOnSamePower = false;
  if (key && rt instanceof Element && gLand?.node()?.contains(rt)) {
    const toPath = rt.closest?.("path.land");
    if (toPath && gLand.selectAll("path.land").nodes().includes(toPath)) {
      const d2 = d3.select(toPath).datum();
      if (powerKey(d2) === key) stayOnSamePower = true;
    }
  }
  if (!stayOnSamePower) {
    clearPeerHighlight();
    hideTooltip();
  }
}

function hideTooltip() {
  clearPeerHighlight();
  const el = document.getElementById("tooltip");
  el.hidden = true;
}

function positionTooltip(x, y) {
  const el = document.getElementById("tooltip");
  const pad = 12;
  const rect = el.getBoundingClientRect();
  let left = x + pad;
  let top = y + pad;
  if (left + rect.width > window.innerWidth - 8) left = x - rect.width - pad;
  if (top + rect.height > window.innerHeight - 8) top = y - rect.height - pad;
  el.style.left = `${Math.max(8, left)}px`;
  el.style.top = `${Math.max(8, top)}px`;
}

function escapeHtml(s) {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

async function fetchGeojson(filename) {
  const url = `${GEOJSON_BASE}${filename}`;
  const res = await fetch(url, { cache: "default" });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

async function loadCShapes() {
  if (state.cshapes) return state.cshapes;
  const res = await fetch(CSHAPES_URL, { cache: "default" });
  if (!res.ok) throw new Error(`CShapes load failed: ${res.status}`);
  const raw = await res.json();
  const features = (raw.features ?? []).map((feature) => normalizeFeatureGeometry(feature));
  state.cshapes = { ...raw, features };
  return state.cshapes;
}

function cshapeActiveInYear(feature, year) {
  const p = feature.properties ?? {};
  const start = Number(p.gwsyear);
  const end = Number(p.gweyear);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
  return start <= year && year < end;
}

function cshapesSnapshotForYear(year) {
  const all = state.cshapes?.features ?? [];
  const features = all.filter((f) => cshapeActiveInYear(f, year));
  return { type: "FeatureCollection", features };
}

function prefetch(idx) {
  if (idx < 0 || idx >= state.snapshots.length) return;
  const snap = state.snapshots[idx];
  if (!snap || usingCShapesYear(snap.year)) return;
  const { filename } = snap;
  if (state.cache.has(filename)) return;
  fetchGeojson(filename)
    .then((fc) => state.cache.set(filename, fc))
    .catch(() => {});
}

async function loadSnapshot(idx) {
  const snap = state.snapshots[idx];
  if (!snap) return;
  const { filename, year } = snap;
  const useCShapes = usingCShapesYear(year);
  setStatus(useCShapes ? `Loading CShapes ${year}...` : `Loading ${filename}...`);
  let fc;
  if (useCShapes) {
    await loadCShapes();
    try {
      await loadCowEntities();
    } catch {
      state.cowEntityRows = [];
    }
    fc = cshapesSnapshotForYear(year);
  } else {
    fc = state.cache.get(filename);
    if (!fc) {
      fc = await fetchGeojson(filename);
      state.cache.set(filename, fc);
    }
  }
  state.currentIdx = idx;
  state.currentYear = year;
  state.landFillRule = "nonzero";
  renderLand(fc);
  updateAllPaths();
  prefetch(idx - 1);
  prefetch(idx + 1);
  syncUi(year, useCShapes ? `CShapes-2.0 (${year})` : filename);
  hideStatus();
}

function setStatus(msg, isError = false) {
  const el = document.getElementById("status");
  el.textContent = msg;
  el.hidden = false;
  el.classList.toggle("error", isError);
}

function hideStatus() {
  const el = document.getElementById("status");
  el.hidden = true;
  el.classList.remove("error");
}

function syncUi(year, filename) {
  const slider = document.getElementById("year-slider");
  slider.value = String(state.currentIdx);
  slider.setAttribute("aria-valuetext", formatYear(year));
  document.getElementById("year-label").textContent = formatYear(year);
  document.getElementById("file-hint").textContent = filename;
  const n = state.snapshots.length;
  document.getElementById("btn-prev").disabled = state.currentIdx <= 0;
  document.getElementById("btn-next").disabled = state.currentIdx >= n - 1;
}

function goTo(idx) {
  const clamped = Math.max(0, Math.min(state.snapshots.length - 1, idx));
  loadSnapshot(clamped).catch((e) => {
    setStatus(String(e.message || e), true);
  });
}

function stepTimeFromWheel(deltaY) {
  state.timeWheelAccum += deltaY;
  if (Math.abs(state.timeWheelAccum) < TIME_WHEEL_THRESH) return;
  const dir = state.timeWheelAccum > 0 ? -1 : 1;
  state.timeWheelAccum = 0;
  goTo(state.currentIdx + dir);
}

function zoomFromWheel(event) {
  event.preventDefault();
  const delta = -event.deltaY * 0.0015;
  const next = projection.scale() * (1 + delta);
  projection.scale(Math.max(120, Math.min(900, next)));
  updateAllPaths();
}

function setupSvg() {
  svg = d3.select("#globe-svg");
  svg.selectAll("*").remove();
  projection = d3.geoOrthographic().rotate([0, -18, 0]);
  path = d3.geoPath(projection);

  const defs = svg.append("defs");
  const grad = defs.append("radialGradient").attr("id", "ocean-gradient").attr("cx", "32%").attr("cy", "30%").attr("r", "78%");
  grad.append("stop").attr("offset", "0%").attr("stop-color", "#2b5a8c");
  grad.append("stop").attr("offset", "55%").attr("stop-color", "#153a5c");
  grad.append("stop").attr("offset", "100%").attr("stop-color", "#0a1628");

  gRoot = svg.append("g").attr("class", "globe-root");
  pathSphereFill = gRoot.append("path").attr("class", "sphere-fill");
  gLand = gRoot.append("g").attr("class", "land-layer");
  pathSphereOutline = gRoot.append("path").attr("class", "sphere-outline");

  svg.call(
    d3
      .drag()
      .on("start", hideTooltip)
      .on("drag", (event) => {
        const rotate = projection.rotate();
        const k = 75 / projection.scale();
        projection.rotate([rotate[0] + event.dx * k, rotate[1] - event.dy * k, rotate[2] ?? 0]);
        updateAllPaths();
      }),
  );

  svg.on("wheel", (event) => {
    const zoomChord = event.ctrlKey || event.metaKey;
    if (zoomChord) {
      zoomFromWheel(event);
      return;
    }
    event.preventDefault();
    stepTimeFromWheel(event.deltaY);
  });

  svg.on("pointermove", (event) => {
    const tip = document.getElementById("tooltip");
    if (!tip.hidden) positionTooltip(event.clientX, event.clientY);
  });
}

function resize() {
  measure();
  svg.attr("width", state.width).attr("height", state.height);
  configureProjection();
  updateAllPaths();
}

async function init() {
  const res = await fetch(new URL("data/index.json", document.baseURI).href);
  if (!res.ok) throw new Error(`Could not load index: ${res.status}`);
  const data = await res.json();
  state.snapshots = data.years.slice().sort((a, b) => a.year - b.year);
  const n = state.snapshots.length;
  if (n === 0) throw new Error("No snapshots in index");

  const slider = document.getElementById("year-slider");
  slider.min = "0";
  slider.max = String(n - 1);
  let startIdx = state.snapshots.findIndex((s) => s.year === 1900);
  if (startIdx < 0) startIdx = Math.floor(n / 2);
  slider.value = String(startIdx);

  setupSvg();
  resize();
  window.addEventListener("resize", resize);

  slider.addEventListener("input", () => {
    goTo(Number.parseInt(slider.value, 10));
  });
  document.getElementById("btn-prev").addEventListener("click", () => goTo(state.currentIdx - 1));
  document.getElementById("btn-next").addEventListener("click", () => goTo(state.currentIdx + 1));

  const playBtn = document.getElementById("btn-play");
  playBtn.addEventListener("click", () => {
    if (state.playTimer) {
      window.clearInterval(state.playTimer);
      state.playTimer = null;
      playBtn.textContent = "Play";
      playBtn.setAttribute("aria-pressed", "false");
      return;
    }
    if (state.currentIdx >= n - 1) goTo(0);
    playBtn.textContent = "Pause";
    playBtn.setAttribute("aria-pressed", "true");
    state.playTimer = window.setInterval(() => {
      if (state.currentIdx >= n - 1) {
        window.clearInterval(state.playTimer);
        state.playTimer = null;
        playBtn.textContent = "Play";
        playBtn.setAttribute("aria-pressed", "false");
        return;
      }
      goTo(state.currentIdx + 1);
    }, 1600);
  });

  const globeEl = document.getElementById("globe-svg");
  globeEl.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      goTo(state.currentIdx - 1);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      goTo(state.currentIdx + 1);
    } else if (e.key === " " || e.code === "Space") {
      e.preventDefault();
      playBtn.click();
    } else if (e.key === "+" || e.key === "=") {
      e.preventDefault();
      projection.scale(Math.min(900, projection.scale() * 1.12));
      updateAllPaths();
    } else if (e.key === "-" || e.key === "_") {
      e.preventDefault();
      projection.scale(Math.max(120, projection.scale() / 1.12));
      updateAllPaths();
    }
  });

  document.getElementById("timeline").addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      stepTimeFromWheel(event.deltaY);
    },
    { passive: false },
  );

  await loadSnapshot(startIdx);
}

init().catch((err) => {
  console.error(err);
  setStatus(err?.message || String(err), true);
});

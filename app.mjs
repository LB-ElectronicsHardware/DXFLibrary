// main.mjs — DXF Library + Board Outline Generator (front-end only, GitHub Pages friendly)
//
// Fixes included:
// ✅ SVG renders reliably (proper SVG namespace)
// ✅ Previews are correctly oriented (DXF Y-up -> SVG Y-down) and centered with margin
// ✅ Board outline fillets are ROUND in preview (bulge -> SVG arc rendering)
// ✅ Board outline DXF uses true fillets (bulge arcs in LWPOLYLINE)
// ✅ Typing no longer de-focuses inputs (focus + caret preserved across full re-renders)
//
// Expected folders:
//   /index.html  (script type=module src="./main.mjs")
//   /styles.css
//   /data/library.json
//   /dxf/*.dxf

const LIBRARY_JSON_PATH = "./data/library.json";
const DXF_DIR = "./dxf/";

// -------------------------
// Namespace-aware element creator (CRITICAL for SVG rendering)
// -------------------------
const SVG_NS = "http://www.w3.org/2000/svg";
const SVG_TAGS = new Set([
  "svg", "g", "path", "rect", "circle", "ellipse", "line",
  "polyline", "polygon", "text", "defs", "clipPath"
]);

function el(tag, attrs = {}, children = []) {
  const isSvg = SVG_TAGS.has(tag);
  const node = isSvg ? document.createElementNS(SVG_NS, tag) : document.createElement(tag);

  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.setAttribute("class", v);
    else if (k === "style") node.setAttribute("style", v);
    else if (k === "onclick") node.onclick = v;
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else if (v === null || v === undefined || v === false) {
      // skip
    } else if (v === true) {
      node.setAttribute(k, "");
    } else {
      node.setAttribute(k, String(v));
    }
  }

  for (const c of Array.isArray(children) ? children : [children]) {
    if (c === null || c === undefined) continue;
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

// -------------------------
// Utilities
// -------------------------
const appEl = document.querySelector("#app");

function debounce(fn, ms = 150) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

async function fetchText(path) {
  const res = await fetch(path, { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to fetch ${path}: ${res.status}`);
  return await res.text();
}

function downloadText(filename, text) {
  const blob = new Blob([text], { type: "application/dxf;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function clampMm(v) {
  if (!Number.isFinite(v)) return NaN;
  return Math.min(1e6, Math.max(0.01, v));
}
function clampScale(v) {
  if (!Number.isFinite(v)) return 1;
  return Math.min(1e6, Math.max(0.000001, v));
}
function fmtMm(v) {
  if (!Number.isFinite(v)) return "0";
  return (Math.round(v * 100) / 100).toString();
}
function fmtScale(v) {
  if (!Number.isFinite(v)) return "1";
  return (Math.round(v * 100000) / 100000).toString();
}
function roundNice(v) {
  if (!Number.isFinite(v)) return 10;
  return Math.round(v * 100) / 100;
}

// -------------------------
// Focus preservation across full re-renders (fixes "input deselects each keystroke")
// Use data-focus keys on inputs/selects.
// -------------------------
function renderWithFocusPreserved(doRender) {
  const active = document.activeElement;

  const focusKey =
    active?.getAttribute?.("data-focus") ||
    (active?.id ? `#${active.id}` : null);

  const isTextLike =
    active &&
    (active.tagName === "INPUT" || active.tagName === "TEXTAREA") &&
    active.type !== "checkbox" &&
    active.type !== "radio";

  // Only capture caret if the browser provides it (number inputs often don't)
  const start = isTextLike ? active.selectionStart : null;
  const end = isTextLike ? active.selectionEnd : null;

  const canRestoreCaret =
    Number.isInteger(start) &&
    Number.isInteger(end) &&
    start >= 0 &&
    end >= 0;

  doRender();

  requestAnimationFrame(() => {
    if (!focusKey) return;

    const next =
      document.querySelector(`[data-focus="${CSS.escape(focusKey)}"]`) ||
      (focusKey.startsWith("#") ? document.querySelector(focusKey) : null);

    if (!next) return;

    next.focus({ preventScroll: true });

    if (canRestoreCaret && typeof next.setSelectionRange === "function") {
      try {
        next.setSelectionRange(start, end);
      } catch {
        // ignore
      }
    }
  });
}

function render() {
  renderWithFocusPreserved(() => {
    appEl.innerHTML = "";
    appEl.appendChild(renderShell());
    if (state.view === "library" && state.selected) {
      appEl.appendChild(renderFullscreen());
    }
  });
}

// -------------------------
// DXF pair reader
// -------------------------
function dxfToPairs(dxfText) {
  const lines = dxfText.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const pairs = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = parseInt(lines[i].trim(), 10);
    const value = lines[i + 1] ?? "";
    pairs.push({ code, value });
  }
  return pairs;
}

function getEntitiesSectionPairs(dxfText) {
  const pairs = dxfToPairs(dxfText);
  let start = -1;
  let end = -1;

  for (let i = 0; i < pairs.length - 2; i++) {
    if (pairs[i].code === 0 && pairs[i].value.trim() === "SECTION") {
      if (pairs[i + 1]?.code === 2 && pairs[i + 1].value.trim() === "ENTITIES") {
        start = i + 2;
        break;
      }
    }
  }
  if (start < 0) return [];

  for (let i = start; i < pairs.length; i++) {
    if (pairs[i].code === 0 && pairs[i].value.trim() === "ENDSEC") {
      end = i;
      break;
    }
  }
  if (end < 0) end = pairs.length;
  return pairs.slice(start, end);
}

function groupEntities(entityPairs) {
  const entities = [];
  let current = null;

  function push() {
    if (current) entities.push(current);
    current = null;
  }

  for (const { code, value } of entityPairs) {
    if (code === 0) {
      push();
      current = { type: value.trim(), pairs: [] };
    } else if (current) {
      current.pairs.push({ code, value });
    }
  }
  push();
  return entities;
}

function readPointsFromPairs(pairs, xCode, yCode) {
  const pts = [];
  let pendingX = null;

  for (const p of pairs) {
    const n = parseFloat(String(p.value).trim());
    if (!Number.isFinite(n)) continue;
    if (p.code === xCode) pendingX = n;
    if (p.code === yCode && pendingX !== null) {
      pts.push({ x: pendingX, y: n });
      pendingX = null;
    }
  }
  return pts;
}

function findNumber(pairs, code) {
  for (const p of pairs) {
    if (p.code === code) {
      const n = parseFloat(String(p.value).trim());
      if (Number.isFinite(n)) return n;
    }
  }
  return NaN;
}

// -------------------------
// DXF scaling (Approach 1): rewrite numeric group codes
// -------------------------
const X_CODES = new Set([10, 11, 12, 13, 14, 15, 16, 17, 18]);
const Y_CODES = new Set([20, 21, 22, 23, 24, 25, 26, 27, 28]);
const Z_CODES = new Set([30, 31, 32, 33, 34, 35, 36, 37, 38]);
// Include bulge (42) and common widths/radii
const UNIFORM_LINEAR_CODES = new Set([40, 41, 42, 43, 44]);

function isNumericText(s) {
  return /^[\s+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?\s*$/.test(String(s));
}

function scaleDxfText(dxfText, sx, sy) {
  const pairs = dxfToPairs(dxfText);
  const out = [];
  const sAvg = (sx + sy) / 2;

  for (const { code, value } of pairs) {
    let newValue = value;

    if (isNumericText(value)) {
      const n = parseFloat(String(value).trim());
      if (Number.isFinite(n)) {
        if (X_CODES.has(code)) newValue = String(n * sx);
        else if (Y_CODES.has(code)) newValue = String(n * sy);
        else if (Z_CODES.has(code)) newValue = String(n * sAvg);
        else if (UNIFORM_LINEAR_CODES.has(code)) {
          // NOTE: bulge (42) should NOT be scaled (dimensionless). We handle it below.
          if (code === 42) newValue = value; // keep bulge unchanged
          else newValue = String(n * sAvg);
        }
      }
    }

    out.push(String(code));
    out.push(newValue);
  }

  return out.join("\n") + "\n";
}

// -------------------------
// Preview: LWPOLYLINE bulge -> SVG arcs (for rounded fillets)
// -------------------------
function bulgeToArc(p0, p1, bulge) {
  const x0 = p0.x, y0 = p0.y;
  const x1 = p1.x, y1 = p1.y;

  const dx = x1 - x0;
  const dy = y1 - y0;
  const c = Math.hypot(dx, dy);
  if (c < 1e-12) return null;

  const b = bulge;
  const theta = 4 * Math.atan(Math.abs(b)); // radians
  const R = c / (2 * Math.sin(theta / 2));

  const mx = (x0 + x1) / 2;
  const my = (y0 + y1) / 2;

  const h = Math.sqrt(Math.max(0, R * R - (c / 2) * (c / 2)));

  const ux = -dy / c; // left normal
  const uy = dx / c;

  const sign = b >= 0 ? 1 : -1;
  const cx = mx + sign * h * ux;
  const cy = my + sign * h * uy;

  const sweepFlag = b >= 0 ? 1 : 0;
  const largeArcFlag = theta > Math.PI ? 1 : 0;

  return { R, cx, cy, sweepFlag, largeArcFlag };
}

function lwpolylineToSvgPath(vertices, closed) {
  if (!vertices || vertices.length < 2) return "";
  const n = vertices.length;

  let d = `M ${vertices[0].x} ${vertices[0].y}`;
  const segCount = closed ? n : (n - 1);

  for (let i = 0; i < segCount; i++) {
    const p0 = vertices[i];
    const p1 = vertices[(i + 1) % n];
    const b = p0.bulge ?? 0;

    if (Math.abs(b) < 1e-12) {
      d += ` L ${p1.x} ${p1.y}`;
    } else {
      const arc = bulgeToArc(p0, p1, b);
      if (!arc) d += ` L ${p1.x} ${p1.y}`;
      else d += ` A ${arc.R} ${arc.R} 0 ${arc.largeArcFlag} ${arc.sweepFlag} ${p1.x} ${p1.y}`;
    }
  }

  if (closed) d += " Z";
  return d;
}

// -------------------------
// DXF -> preview geometry (SVG path)
// Supports: LINE, LWPOLYLINE (with bulge!), POLYLINE+VERTEX+SEQEND, CIRCLE, ARC, SPLINE (polyline approx)
// -------------------------
function extractGeometryForPreview(dxfText) {
  const entityPairs = getEntitiesSectionPairs(dxfText);
  const raw = groupEntities(entityPairs);

  // Stitch POLYLINE with VERTEX records
  const entities = [];
  for (let i = 0; i < raw.length; i++) {
    const e = raw[i];
    if (e.type === "POLYLINE") {
      const pts = [];
      let j = i + 1;
      while (j < raw.length && raw[j].type !== "SEQEND") {
        if (raw[j].type === "VERTEX") {
          const vpts = readPointsFromPairs(raw[j].pairs, 10, 20);
          if (vpts.length) pts.push(...vpts);
        }
        j++;
      }
      entities.push({ type: "POLYLINE_STITCHED", pts });
      i = j;
      continue;
    }
    entities.push(e);
  }

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const paths = [];

  function addPoint(x, y) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }

  function polyPath(points, closed = false) {
    if (!points || points.length < 2) return "";
    let d = `M ${points[0].x} ${points[0].y}`;
    for (let i = 1; i < points.length; i++) d += ` L ${points[i].x} ${points[i].y}`;
    if (closed) d += " Z";
    return d;
  }

  function polar(c, r, deg) {
    const rad = (deg * Math.PI) / 180;
    return { x: c.x + r * Math.cos(rad), y: c.y + r * Math.sin(rad) };
  }

  function arcLargeFlag(a0, a1) {
    const s = ((a0 % 360) + 360) % 360;
    const e = ((a1 % 360) + 360) % 360;
    let delta = e - s;
    if (delta < 0) delta += 360;
    return delta > 180;
  }

  for (const e of entities) {
    if (e.type === "LINE") {
      const p0 = readPointsFromPairs(e.pairs, 10, 20)[0];
      const p1 = readPointsFromPairs(e.pairs, 11, 21)[0];
      if (p0 && p1) {
        addPoint(p0.x, p0.y);
        addPoint(p1.x, p1.y);
        paths.push(`M ${p0.x} ${p0.y} L ${p1.x} ${p1.y}`);
      }
      continue;
    }

    if (e.type === "LWPOLYLINE") {
      const pts = readPointsFromPairs(e.pairs, 10, 20);

      // Attach bulges to vertices (bulge 42 appears per vertex, in order)
      const bulges = [];
      for (const p of e.pairs) {
        if (p.code === 42) {
          const n = parseFloat(String(p.value).trim());
          bulges.push(Number.isFinite(n) ? n : 0);
        }
      }

      const vertices = pts.map((p, i) => ({
        x: p.x,
        y: p.y,
        bulge: bulges[i] ?? 0,
      }));

      for (const p of vertices) addPoint(p.x, p.y);

      // Closed flag (70 bit 1) if present
      const flags = findNumber(e.pairs, 70);
      const closed = Number.isFinite(flags) ? ((flags | 0) & 1) === 1 : false;

      const d = lwpolylineToSvgPath(vertices, closed);
      if (d) paths.push(d);
      continue;
    }

    if (e.type === "POLYLINE_STITCHED") {
      for (const p of e.pts) addPoint(p.x, p.y);
      const d = polyPath(e.pts, false);
      if (d) paths.push(d);
      continue;
    }

    if (e.type === "CIRCLE") {
      const c = readPointsFromPairs(e.pairs, 10, 20)[0];
      const r = findNumber(e.pairs, 40);
      if (c && Number.isFinite(r)) {
        addPoint(c.x - r, c.y - r);
        addPoint(c.x + r, c.y + r);
        paths.push(
          `M ${c.x + r} ${c.y} A ${r} ${r} 0 1 0 ${c.x - r} ${c.y} A ${r} ${r} 0 1 0 ${c.x + r} ${c.y}`
        );
      }
      continue;
    }

    if (e.type === "ARC") {
      const c = readPointsFromPairs(e.pairs, 10, 20)[0];
      const r = findNumber(e.pairs, 40);
      const a0 = findNumber(e.pairs, 50);
      const a1 = findNumber(e.pairs, 51);
      if (c && Number.isFinite(r) && Number.isFinite(a0) && Number.isFinite(a1)) {
        addPoint(c.x - r, c.y - r);
        addPoint(c.x + r, c.y + r);

        const p0 = polar(c, r, a0);
        const p1 = polar(c, r, a1);
        const largeArc = arcLargeFlag(a0, a1) ? 1 : 0;
        const sweep = 1;
        paths.push(`M ${p0.x} ${p0.y} A ${r} ${r} 0 ${largeArc} ${sweep} ${p1.x} ${p1.y}`);
      }
      continue;
    }

    if (e.type === "SPLINE") {
      const fit = readPointsFromPairs(e.pairs, 11, 21);
      const ctrl = readPointsFromPairs(e.pairs, 10, 20);
      const pts = fit.length >= 2 ? fit : ctrl.length >= 2 ? ctrl : [];
      for (const p of pts) addPoint(p.x, p.y);
      const d = polyPath(pts, false);
      if (d) paths.push(d);
      continue;
    }
  }

  if (!Number.isFinite(minX)) {
    minX = 0; minY = 0; maxX = 1; maxY = 1;
  }
  if (maxX - minX < 1e-9) maxX = minX + 1;
  if (maxY - minY < 1e-9) maxY = minY + 1;

  return { bbox: { minX, minY, maxX, maxY }, pathD: paths.filter(Boolean).join(" ") };
}

// Centered + padded SVG preview (correct orientation)
function makeSvgPreview({ bbox, pathD }, { marginFrac = 0.18, view = 100 } = {}) {
  const W = view;
  const H = view;

  const rawW = bbox.maxX - bbox.minX;
  const rawH = bbox.maxY - bbox.minY;

  const safeW = Math.max(rawW, 1e-9);
  const safeH = Math.max(rawH, 1e-9);

  const mx = safeW * marginFrac;
  const my = safeH * marginFrac;

  const minX = bbox.minX - mx;
  const maxX = bbox.maxX + mx;
  const minY = bbox.minY - my;
  const maxY = bbox.maxY + my;

  const w = Math.max(maxX - minX, 1e-9);
  const h = Math.max(maxY - minY, 1e-9);

  const scale = Math.min(W / w, H / h);

  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;

  const svg = el("svg", {
    viewBox: `0 0 ${W} ${H}`,
    style: "width:100%;height:100%;display:block;background:rgba(255,255,255,0.02);",
  });

  const g = el("g", {
    transform: `
      translate(${W / 2} ${H / 2})
      scale(${scale} ${-scale})
      translate(${-cx} ${-cy})
    `.trim().replace(/\s+/g, " "),
  });

  g.appendChild(
    el("path", {
      d: pathD || "",
      fill: "none",
      stroke: "#5eead4",
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
      "vector-effect": "non-scaling-stroke",
      "stroke-width": String(Math.max(safeW, safeH) / 700),
    })
  );

  svg.appendChild(g);
  return svg;
}

// -------------------------
// Board outline generator (DXF)
// Uses closed LWPOLYLINE with bulge arcs for fillets.
// -------------------------
function bulgeFor90deg() {
  return 0.41421356237309503; // tan(22.5°)
}

function generateBoardOutlineVertices(w, h, r) {
  const rr = Math.max(0, Math.min(r, Math.min(w, h) / 2));

  if (rr <= 1e-9) {
    const vertices = [
      { x: 0, y: 0, bulge: 0 },
      { x: w, y: 0, bulge: 0 },
      { x: w, y: h, bulge: 0 },
      { x: 0, y: h, bulge: 0 },
    ];
    return {
      vertices,
      closed: true,
      bbox: { minX: 0, minY: 0, maxX: w, maxY: h },
      pathD: lwpolylineToSvgPath(vertices, true),
    };
  }

  const b = bulgeFor90deg(); // CCW convex corners => positive bulge

  // CCW with tangency points; bulge is on the vertex where the arc segment starts.
  const vertices = [
    { x: rr, y: 0, bulge: 0 },
    { x: w - rr, y: 0, bulge: b }, // arc to (w, rr)
    { x: w, y: rr, bulge: 0 },
    { x: w, y: h - rr, bulge: b }, // arc to (w-rr, h)
    { x: w - rr, y: h, bulge: 0 },
    { x: rr, y: h, bulge: b }, // arc to (0, h-rr)
    { x: 0, y: h - rr, bulge: 0 },
    { x: 0, y: rr, bulge: b }, // arc to (rr, 0)
  ];

  return {
    vertices,
    closed: true,
    bbox: { minX: 0, minY: 0, maxX: w, maxY: h },
    pathD: lwpolylineToSvgPath(vertices, true),
  };
}

function boardOutlineToDxf({ vertices, closed }) {
  const lines = [];

  lines.push("0", "SECTION");
  lines.push("2", "HEADER");
  lines.push("0", "ENDSEC");

  lines.push("0", "SECTION");
  lines.push("2", "TABLES");
  lines.push("0", "ENDSEC");

  lines.push("0", "SECTION");
  lines.push("2", "ENTITIES");

  lines.push("0", "LWPOLYLINE");
  lines.push("8", "0"); // layer
  lines.push("90", String(vertices.length)); // count
  lines.push("70", closed ? "1" : "0"); // closed flag

  for (const p of vertices) {
    lines.push("10", String(p.x));
    lines.push("20", String(p.y));
    if (p.bulge && Math.abs(p.bulge) > 1e-12) {
      lines.push("42", String(p.bulge));
    }
  }

  lines.push("0", "ENDSEC");
  lines.push("0", "EOF");

  return lines.join("\n") + "\n";
}

// -------------------------
// App state
// -------------------------
const state = {
  view: "library", // "library" | "board"
  items: [],
  categories: [],
  activeCategory: "All",
  search: "",

  selected: null, // { item, dxfText, geom }
  lockAspect: true,
  sizeMode: "longest", // "longest" | "widthHeight"
  targetLongestMm: 10,
  targetWmm: 10,
  targetHmm: 10,

  board: { w: 80, h: 30, r: 5 },
};

async function loadLibrary() {
  const res = await fetch(LIBRARY_JSON_PATH, { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to load ${LIBRARY_JSON_PATH}: ${res.status}`);
  const items = await res.json();

  const cats = new Set(items.map((i) => i.category).filter(Boolean));
  state.items = items;
  state.categories = ["All", ...Array.from(cats).sort((a, b) => a.localeCompare(b))];
}

function filteredItems() {
  const q = state.search.trim().toLowerCase();
  return state.items.filter((it) => {
    const inCat = state.activeCategory === "All" || it.category === state.activeCategory;
    if (!inCat) return false;
    if (!q) return true;
    const hay = `${it.name ?? ""} ${it.file ?? ""} ${(it.tags ?? []).join(" ")} ${it.category ?? ""}`.toLowerCase();
    return hay.includes(q);
  });
}

// -------------------------
// Sidebar
// -------------------------
function renderSidebar() {
  const libActive = state.view === "library";
  const boardActive = state.view === "board";

  const top = el("div", { class: "catlist" }, [
    el("button", {
      class: `catbtn ${libActive ? "active" : ""}`,
      onclick: () => { state.view = "library"; state.selected = null; render(); }
    }, "DXF Library"),
    el("button", {
      class: `catbtn ${boardActive ? "active" : ""}`,
      onclick: () => { state.view = "board"; state.selected = null; render(); }
    }, "Board Outline Generator"),
  ]);

  const controls = libActive
    ? [
        el("input", {
          class: "search",
          type: "search",
          placeholder: "Search…",
          value: state.search,
          "data-focus": "search",
          oninput: debounce((e) => { state.search = e.target.value; render(); }, 0),
        }),
        el("div", { class: "catlist" },
          state.categories.map((cat) =>
            el("button", {
              class: `catbtn ${cat === state.activeCategory ? "active" : ""}`,
              onclick: () => { state.activeCategory = cat; render(); },
            }, cat)
          )
        ),
      ]
    : [
        el("div", { class: "mini" }, "Generate a rectangular board outline DXF (mm) with optional round corner fillets.")
      ];

  return el("div", { class: "sidebar" }, [
    el("h1", {}, "Electronics PCB Symbol Library"),
    top,
    el("div", { class: "hline" }),
    ...controls,
    el("div", { class: "hline" }),
    el("div", { class: "mini" }, [
      "V0.2",
    ]),
  ]);
}

// -------------------------
// Library view
// -------------------------
function renderLibraryMain() {
  const items = filteredItems();

  return el("div", { class: "main" }, [
    el("div", { class: "topbar" }, [
      el("h2", {}, state.activeCategory === "All" ? "All symbols" : state.activeCategory),
      el("div", { class: "meta" }, `${items.length} item(s)`),
    ]),
    el("div", { class: "grid" }, items.map(renderCard)),
  ]);
}

function renderCard(item) {
  const card = el("div", { class: "card" }, [
    el("div", { class: "thumb" }, [el("div", { class: "notice" }, "Loading preview…")]),
    el("div", { class: "name" }, item.name ?? item.file),
    el("div", { class: "sub" }, item.file),
    el("div", { class: "badgeRow" },
      [el("span", { class: "badge" }, item.category ?? "Uncategorized")].concat(
        (item.tags ?? []).slice(0, 4).map((t) => el("span", { class: "badge" }, t))
      )
    ),
  ]);

  (async () => {
    try {
      const dxfText = await fetchText(DXF_DIR + item.file);
      const geom = extractGeometryForPreview(dxfText);
      const svg = makeSvgPreview(geom, { marginFrac: 0.28, view: 100 });
      const thumb = card.querySelector(".thumb");
      thumb.innerHTML = "";
      thumb.appendChild(svg);
    } catch (err) {
      const thumb = card.querySelector(".thumb");
      thumb.innerHTML = "";
      thumb.appendChild(el("div", { class: "notice" }, "Preview failed"));
      console.warn("Preview failed:", item.file, err);
    }
  })();

  card.onclick = async () => {
    try {
      const dxfText = await fetchText(DXF_DIR + item.file);
      const geom = extractGeometryForPreview(dxfText);

      const curW = geom.bbox.maxX - geom.bbox.minX;
      const curH = geom.bbox.maxY - geom.bbox.minY;
      const longest = Math.max(curW, curH);

      state.selected = { item, dxfText, geom };
      state.lockAspect = true;
      state.sizeMode = "longest";
      state.targetLongestMm = roundNice(longest);
      state.targetWmm = roundNice(curW);
      state.targetHmm = roundNice(curH);

      render();
    } catch (err) {
      alert(`Failed to open ${item.file}\n\n${String(err)}`);
    }
  };

  return card;
}

// -------------------------
// Fullscreen settings (symbols)
// -------------------------
function computeScaleFromMm({ curW, curH, curLongest, mode, lockAspect, targetWmm, targetHmm, targetLongestMm }) {
  curW = Math.max(curW, 1e-9);
  curH = Math.max(curH, 1e-9);
  curLongest = Math.max(curLongest, 1e-9);

  let sx = 1, sy = 1;

  if (mode === "longest") {
    const s = clampScale(targetLongestMm / curLongest);
    sx = s; sy = s;
  } else {
    sx = clampScale(targetWmm / curW);
    sy = clampScale(targetHmm / curH);
    if (lockAspect) sy = sx;
  }

  return { sx, sy, outW: curW * sx, outH: curH * sy };
}

function renderFullscreen() {
  const { item, dxfText, geom } = state.selected;

  const curW = geom.bbox.maxX - geom.bbox.minX;
  const curH = geom.bbox.maxY - geom.bbox.minY;
  const curLongest = Math.max(curW, curH);

  const { sx, sy, outW, outH } = computeScaleFromMm({
    curW,
    curH,
    curLongest,
    mode: state.sizeMode,
    lockAspect: state.lockAspect,
    targetWmm: state.targetWmm,
    targetHmm: state.targetHmm,
    targetLongestMm: state.targetLongestMm,
  });

  const svg = makeSvgPreview(geom, { marginFrac: 0.15, view: 600 });

  const modeSelect = el(
    "select",
    {
      "data-focus": "size-mode",
      onchange: (e) => { state.sizeMode = e.target.value; render(); },
      style:
        "width:100%; padding:10px 12px; border-radius:10px; border:1px solid var(--border); background: rgba(255,255,255,0.03); color: var(--text);",
    },
    [
      el("option", { value: "longest", selected: state.sizeMode === "longest" }, "Set longest side (mm)"),
      el("option", { value: "widthHeight", selected: state.sizeMode === "widthHeight" }, "Set width/height (mm)"),
    ]
  );

  const viewer = el("div", { class: "viewer" }, [
    el("div", { class: "title" }, [
      el("h3", {}, item.name ?? item.file),
      el("button", { class: "btn", onclick: () => { state.selected = null; render(); } }, "Back"),
    ]),
    el("div", { class: "stage" }, [svg]),
  ]);

  const panelChildren = [
    el("div", { class: "row" }, [el("label", {}, "Sizing mode"), modeSelect]),
    el("label", { class: "checkbox" }, [
      el("input", {
        type: "checkbox",
        checked: state.lockAspect ? "checked" : null,
        "data-focus": "lock-aspect",
        onchange: (e) => {
          state.lockAspect = !!e.target.checked;
          if (state.lockAspect && state.sizeMode === "widthHeight") {
            const aspect = curH / Math.max(curW, 1e-9);
            state.targetHmm = roundNice(state.targetWmm * aspect);
          }
          render();
        },
      }),
      el("span", {}, "Lock aspect ratio"),
    ]),
    el("div", { class: "hline" }),
  ];

  if (state.sizeMode === "longest") {
    panelChildren.push(
      el("div", { class: "row" }, [
        el("label", {}, `Target longest side (mm) (current ≈ ${fmtMm(curLongest)} mm)`),
        el("input", {
          type: "text",
          inputMode: "decimal",
          autocomplete: "off",
          spellcheck: "false",
          pattern: "[0-9]*[.,]?[0-9]*",
          value: String(state.targetLongestMm),
          "data-focus": "target-longest",
          oninput: (e) => {
            // store as string while typing to avoid clobbering "1." etc
            const raw = e.target.value;
            state.targetLongestMm = raw;
            // compute and clamp only for download/preview; render anyway
            render();
          },
        }),
      ])
    );
  } else {
    panelChildren.push(
      el("div", { class: "split" }, [
        el("div", { class: "row" }, [
          el("label", {}, `Target width (mm) (current ≈ ${fmtMm(curW)} mm)`),
          el("input", {
            type: "text",
            inputMode: "decimal",
            autocomplete: "off",
            spellcheck: "false",
            pattern: "[0-9]*[.,]?[0-9]*",
            value: String(state.targetWmm),
            "data-focus": "target-w",
            oninput: (e) => {
              state.targetWmm = e.target.value;
              if (state.lockAspect) {
                const v = clampMm(parseFloat(state.targetWmm));
                if (Number.isFinite(v)) {
                  const aspect = curH / Math.max(curW, 1e-9);
                  state.targetHmm = roundNice(v * aspect).toString();
                }
              }
              render();
            },
          }),
        ]),
        el("div", { class: "row" }, [
          el("label", {}, `Target height (mm) (current ≈ ${fmtMm(curH)} mm)`),
          el("input", {
            type: "text",
            inputMode: "decimal",
            autocomplete: "off",
            spellcheck: "false",
            pattern: "[0-9]*[.,]?[0-9]*",
            value: String(state.targetHmm),
            "data-focus": "target-h",
            oninput: (e) => {
              state.targetHmm = e.target.value;
              if (state.lockAspect) {
                const v = clampMm(parseFloat(state.targetHmm));
                if (Number.isFinite(v)) {
                  const aspect = curW / Math.max(curH, 1e-9);
                  state.targetWmm = roundNice(v * aspect).toString();
                }
              }
              render();
            },
          }),
        ]),
      ])
    );
  }

  // Parse numeric targets safely (allow strings while typing)
  const targetLongestNum = clampMm(parseFloat(state.targetLongestMm));
  const targetWNum = clampMm(parseFloat(state.targetWmm));
  const targetHNum = clampMm(parseFloat(state.targetHmm));

  const computed = computeScaleFromMm({
    curW,
    curH,
    curLongest,
    mode: state.sizeMode,
    lockAspect: state.lockAspect,
    targetWmm: Number.isFinite(targetWNum) ? targetWNum : curW,
    targetHmm: Number.isFinite(targetHNum) ? targetHNum : curH,
    targetLongestMm: Number.isFinite(targetLongestNum) ? targetLongestNum : curLongest,
  });

  panelChildren.push(
    el("div", { class: "hline" }),
    el("div", { class: "mini" }, [
      `Output size: ${fmtMm(computed.outW)} mm × ${fmtMm(computed.outH)} mm\n`,
      `Scale: sx=${fmtScale(computed.sx)}, sy=${fmtScale(computed.sy)}\n`,
      "Assumes 1 DXF unit = 1 mm."
    ]),
    el("button", {
      class: "btn primary",
      onclick: () => {
        const scaled = scaleDxfText(dxfText, computed.sx, computed.sy);
        const base = (item.file || "output.dxf").replace(/\.dxf$/i, "");
        const outName = `${base}_${fmtMm(computed.outW)}x${fmtMm(computed.outH)}mm.dxf`;
        downloadText(outName, scaled);
      }
    }, "Download scaled DXF")
  );

  const panel = el("div", { class: "panel" }, panelChildren);
  return el("div", { class: "fullscreen" }, [viewer, panel]);
}

// -------------------------
// Board outline page
// -------------------------
function renderBoardMain() {
  const wNum = clampMm(parseFloat(state.board.w));
  const hNum = clampMm(parseFloat(state.board.h));
  const rNumRaw = parseFloat(state.board.r);
  let rNum = Number.isFinite(rNumRaw) ? rNumRaw : 0;

  const rMax = Math.min(wNum, hNum) / 2;
  rNum = Math.max(0, Math.min(rNum, rMax));

  const outline = generateBoardOutlineVertices(wNum, hNum, rNum);
  const preview = makeSvgPreview(
    { bbox: outline.bbox, pathD: outline.pathD },
    { marginFrac: 0.28, view: 900 }
  );

  return el("div", { class: "main" }, [
    el("div", { class: "topbar" }, [
      el("h2", {}, "Board outline"),
      el("div", { class: "meta" }, "Generate a rectangular DXF (mm)")
    ]),

    el("div", { class: "card", style: "cursor:default;" }, [
      el("div", { class: "thumb", style: "height:520px;" }, [preview]),
      el("div", { class: "name" }, "Live preview"),
      el("div", { class: "sub" }, "Outline is a closed LWPOLYLINE. Fillets are true arcs (bulge)."),
    ]),

    el("div", { class: "card", style: "cursor:default;" }, [
      el("div", { class: "name" }, "Parameters (mm)"),
      el("div", { class: "split" }, [
        el("div", { class: "row" }, [
          el("label", {}, "Width (mm)"),
          el("input", {
            type: "text",
            inputMode: "decimal",
            autocomplete: "off",
            spellcheck: "false",
            pattern: "[0-9]*[.,]?[0-9]*",
            value: String(state.board.w),
            "data-focus": "board-w",
            oninput: (e) => { state.board.w = e.target.value; render(); }
          })
        ]),
        el("div", { class: "row" }, [
          el("label", {}, "Height (mm)"),
          el("input", {
            type: "text",
            inputMode: "decimal",
            autocomplete: "off",
            spellcheck: "false",
            pattern: "[0-9]*[.,]?[0-9]*",
            value: String(state.board.h),
            "data-focus": "board-h",
            oninput: (e) => { state.board.h = e.target.value; render(); }
          })
        ]),
      ]),
      el("div", { class: "row" }, [
        el("label", {}, `Corner fillet radius (mm) (max ${fmtMm(rMax)} mm)`),
        el("input", {
          type: "text",
          inputMode: "decimal",
          autocomplete: "off",
          spellcheck: "false",
          pattern: "[0-9]*[.,]?[0-9]*",
          value: String(state.board.r),
          "data-focus": "board-r",
          oninput: (e) => { state.board.r = e.target.value; render(); }
        })
      ]),
      el("div", { class: "hline" }),
      el("div", { class: "mini" }, [
        `Generated size: ${fmtMm(wNum)} mm × ${fmtMm(hNum)} mm\n`,
        `Fillet radius: ${fmtMm(rNum)} mm`
      ]),
      el("button", {
        class: "btn primary",
        onclick: () => {
          const dxf = boardOutlineToDxf(outline);
          const outName = `board_outline_${fmtMm(wNum)}x${fmtMm(hNum)}mm_r${fmtMm(rNum)}.dxf`;
          downloadText(outName, dxf);
        }
      }, "Download board outline DXF")
    ])
  ]);
}

// -------------------------
// Shell / routing
// -------------------------
function renderShell() {
  const sidebar = renderSidebar();
  const main = state.view === "board" ? renderBoardMain() : renderLibraryMain();
  return el("div", { class: "shell" }, [sidebar, main]);
}



// -------------------------
// Boot
// -------------------------
(async function boot() {
  try {
    await loadLibrary();

    // Ensure numeric fields are strings (better typing UX)
    state.targetLongestMm = String(state.targetLongestMm);
    state.targetWmm = String(state.targetWmm);
    state.targetHmm = String(state.targetHmm);
    state.board.w = String(state.board.w);
    state.board.h = String(state.board.h);
    state.board.r = String(state.board.r);

    render();
  } catch (err) {
    console.error(err);
    appEl.innerHTML = "";
    appEl.appendChild(el("div", { style: "padding:16px" }, `Failed to start app: ${String(err)}`));
  }
})();
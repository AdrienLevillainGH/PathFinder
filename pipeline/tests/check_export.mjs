// Loads an export (pipeline/out/<region>/data, or public/data) the way the
// app does — by area when it is tiled — and runs the presets from each hub.
//   node pipeline/tests/check_export.mjs pipeline/out/bruche/data [--all-routes]
// --all-routes: fail if a shown result has no walking route drawn (made-up
// world; in real data a few stops have no path along the network)
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { runQuery, PRESETS, DEFAULT_QUERY, focusClimb, tkey } from "../../src/engine.js";
import { openData, ensureFor, ensureTiles, ensureHub, loadDetail, tilesFor } from "../../src/data.js";

const dir = process.argv[2];
if (!dir) { console.error("usage: node check_export.mjs <data folder>"); process.exit(2); }
const fail = (m) => { console.error("FAILED:", m); process.exit(1); };
const get = async (p) => {
  const f = join(dir, p);
  if (!existsSync(f)) throw new Error(`${p} missing`);
  return JSON.parse(readFileSync(f, "utf8"));
};

const db = await openData(get);
const hubs = db.stations.filter((s) => s.hub !== false);
// transport choices in this export: train + coach, and train only / coach only when routed
const modes = db.meta.modes || ["all"];

// a search by area must give exactly what a search over everything gives
const full = await openData(get);
if (db.tiled) {
  await ensureTiles(full, db.meta.tiles.map((t) => t.id));
  for (const h of hubs) for (const m of modes) await ensureHub(full, h.id, m);
  if (full.climbs.length !== db.meta.counts.climbs) fail(`tiles hold ${full.climbs.length} climbs, meta says ${db.meta.counts.climbs}`);
}

// contract
for (const c of full.climbs) {
  if (c.coords.length !== c.z.length) fail(`${c.id}: ${c.coords.length} coords for ${c.z.length} heights`);
  if (c.wayE.some((v) => v === undefined) || c.surfE.some((v) => v === undefined)) fail(`${c.id}: way/surface runs do not cover every step`);
  for (const [sid] of c.access) if (!full.byId[sid]) fail(`${c.id}: access to unknown station ${sid}`);
}
for (const m of modes) for (const w of full.meta.windows) {
  const k = tkey({ window: w.id, transit: m });
  if (db.tiled && Object.keys(full.ttm.by[k] || {}).length !== hubs.length) fail(`ttm ${k}: not every hub has times`);
  for (const [o, row] of Object.entries(full.ttm.by[k] || {})) {
    if (!full.byId[o]) fail(`ttm origin ${o} is not a station`);
    if (row.length !== full.order.length) fail(`ttm ${k}/${o}: ${row.length} cells for ${full.order.length} stations`);
  }
}
console.log(`${full.climbs.length} climbs · ${full.stations.length} stations (${hubs.length} hubs) · windows ${full.meta.windows.map((w) => w.id).join(", ")} · ${modes.join(", ")}${db.tiled ? ` · ${db.meta.tiles.length} tiles` : ""}`);

const ids = (r) => r.results.map((x) => `${x.id}/${x.i}/${x.j}`).sort().join();
// every preset for train + coach; two for the other choices (same code path)
const shown = new Map();                        // mode -> results to check the walking routes of
for (const m of modes) for (const h of hubs) for (const d of ["up", "down"]) {
  const line = [];
  for (const p of m === "all" ? PRESETS : PRESETS.filter((x) => x.id === "p300" || x.id === "g10")) {
    const q = { ...DEFAULT_QUERY, origin: h.id, window: db.meta.windows[0].id, transit: m, dir: d, preset: p.id, ...p.terrain };
    await ensureFor(db, q);
    const r = runQuery(db, q, 6);
    for (const x of r.results) {
      if (x.train[0] > q.maxTrain || x.approach > q.maxApproach) fail(`${p.id}: result over the access limits`);
      if (q.mode === "gain" ? (x.up < q.gain - 1e-6 || x.len > q.len + 1e-6) : (x.len < q.len - 1e-6 || x.grade < q.grade - 1e-9)) fail(`${p.id}: result outside the terrain filter`);
      if (x.dn > q.cap * x.up + 1e-6) fail(`${p.id}: result over the descent cap`);
      if (p.id === "p300") { if (!shown.has(m)) shown.set(m, []); shown.get(m).push({ ...x, side: d === "up" ? "b" : "t" }); }
    }
    if (db.tiled) {
      const rf = runQuery(full, q, 6);
      if (ids(r) !== ids(rf)) fail(`${h.name} ${m} ${p.id} ${d}: by area ${r.results.length} results, over everything ${rf.results.length}`);
    }
    line.push(`${p.id} ${r.results.length}/${r.near.length}`);
  }
  console.log(`${h.name.padEnd(22)} ${m.padEnd(5)} ${d.padEnd(4)} ${line.join(" · ")}${db.tiled ? ` · ${db.loaded.tiles.size}/${db.meta.tiles.length} tiles loaded` : ""}`);
}

// exact lines and walking routes: start at the stop, end at the bottom/top of the climb
let checked = 0, lines = 0;
const R = (a, b) => Math.hypot((a[0] - b[0]) * 73000, (a[1] - b[1]) * 111000);
for (const c of full.climbs.slice(0, 300)) {
  const rough = c.coords.map((p) => [...p]);
  const rt = await loadDetail(full, c.id);
  if (!rt) continue;
  if (db.tiled) {
    if (c.rough) fail(`${c.id}: exact line not loaded`);
    const off = Math.max(...c.coords.map((p, k) => R(p, rough[k])));
    if (off > 120) fail(`${c.id}: rough line ${Math.round(off)} m off the exact one`);
    lines++;
  }
  for (const side of ["b", "t"]) for (const [sid, pts] of Object.entries(rt[side] || {})) {
    const st = full.byId[sid];
    if (!st) fail(`${c.id}: route from unknown stop ${sid}`);
    if (R(pts[0], [st.lon, st.lat]) > 30) fail(`${c.id}/${sid}: route does not start at the stop`);
    const end = side === "b" ? c.coords[0] : c.coords[c.coords.length - 1];
    if (R(pts[pts.length - 1], end) > 60) fail(`${c.id}/${sid}: route does not reach the climb (${Math.round(R(pts[pts.length - 1], end))} m off)`);
    checked++;
  }
}
console.log(`${lines} exact lines, ${checked} walking routes checked`);
// the stop a result uses should have its walking route drawn (else the app draws a straight dashed line)
for (const [m, list] of shown) {
  let has = 0;
  for (const x of list) { const rt = await loadDetail(full, x.climb.id); if (rt?.[x.side]?.[x.station]) has++; }
  console.log(`walking route drawn for ${has} of ${list.length} shown results (${m})`);
  if (process.argv.includes("--all-routes") && db.tiled && has < list.length) fail(`${list.length - has} shown results (${m}) have no walking route`);
}
const one = focusClimb(full, full.climbs[0].id, { ...DEFAULT_QUERY, origin: hubs[0].id, window: full.meta.windows[0].id }, 6);
if (!one) fail("focusClimb");
console.log("export loads in the app engine: ok");

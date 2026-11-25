// Loads an export (pipeline/out/<region>/data, or any folder with the five
// files) with the app's own engine and runs the presets from each hub.
//   node pipeline/tests/check_export.mjs pipeline/out/bruche/data
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { prepare, runQuery, PRESETS, DEFAULT_QUERY, focusClimb } from "../../src/engine.js";

const dir = process.argv[2];
if (!dir) { console.error("usage: node check_export.mjs <folder with the 5 json files>"); process.exit(2); }
const read = (n) => JSON.parse(readFileSync(join(dir, n + ".json"), "utf8"));
const raw = Object.fromEntries(["meta", "stations", "ttm", "climbs", "access"].map((n) => [n, read(n)]));
const db = prepare(raw);
const fail = (m) => { console.error("FAILED:", m); process.exit(1); };

// contract
for (const c of db.climbs) {
  if (c.coords.length !== c.z.length) fail(`${c.id}: ${c.coords.length} coords for ${c.z.length} heights`);
  if (c.wayE.some((v) => v === undefined) || c.surfE.some((v) => v === undefined)) fail(`${c.id}: way/surface runs do not cover every step`);
  for (const [sid] of c.access) if (!db.byId[sid]) fail(`${c.id}: access to unknown station ${sid}`);
}
for (const w of db.meta.windows) for (const [o, row] of Object.entries(db.ttm.by[w.id] || {})) {
  if (!db.byId[o]) fail(`ttm origin ${o} is not a station`);
  if (row.length !== db.order.length) fail(`ttm ${w.id}/${o}: ${row.length} cells for ${db.order.length} stations`);
}
const hubs = db.stations.filter((s) => s.hub);
console.log(`${db.climbs.length} climbs · ${db.stations.length} stations (${hubs.length} hubs) · windows ${db.meta.windows.map((w) => w.id).join(", ")}`);

// every preset, from every hub, first window, both directions
for (const h of hubs) for (const dir of ["up", "down"]) {
  const line = [];
  for (const p of PRESETS) {
    const q = { ...DEFAULT_QUERY, origin: h.id, window: db.meta.windows[0].id, dir, preset: p.id, ...p.terrain };
    const r = runQuery(db, q, 6);
    for (const x of r.results) {
      if (x.train[0] > q.maxTrain || x.approach > q.maxApproach) fail(`${p.id}: result over the access limits`);
      if (q.mode === "gain" ? (x.up < q.gain - 1e-6 || x.len > q.len + 1e-6) : (x.len < q.len - 1e-6 || x.grade < q.grade - 1e-9)) fail(`${p.id}: result outside the terrain filter`);
      if (x.dn > q.cap * x.up + 1e-6) fail(`${p.id}: result over the descent cap`);
    }
    line.push(`${p.id} ${r.results.length}/${r.near.length}`);
  }
  console.log(`${h.name.padEnd(22)} ${dir.padEnd(4)} ${line.join(" · ")}`);
}
const one = focusClimb(db, db.climbs[0].id, { ...DEFAULT_QUERY, origin: hubs[0].id, window: db.meta.windows[0].id }, 6);
if (!one) fail("focusClimb");
console.log("export loads in the app engine: ok");

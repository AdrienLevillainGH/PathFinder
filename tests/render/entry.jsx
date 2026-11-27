// Renders the segment page (details, and the full-screen map with its
// profile panel) to HTML with the demo data: catches errors a build does
// not, such as a value used before it is defined.
import React from "react";
import { renderToString } from "react-dom/server";
import { readFileSync } from "node:fs";
import Segment from "../../src/Segment.jsx";
import { prepare, runQuery, focusClimb, DEFAULT_QUERY } from "../../src/engine.js";
import { THEMES } from "../../src/theme.js";
import { DEFAULT_LAYERS } from "../../src/basemap.js";

const dir = process.argv[2];
const load = (f) => JSON.parse(readFileSync(`${dir}/${f}`, "utf8"));
const db = prepare({ meta: load("meta.json"), stations: load("stations.json"), ttm: load("ttm.json"), climbs: load("climbs.json"), access: load("access.json") });
const q = { ...DEFAULT_QUERY };
const r = runQuery(db, q, 6).results[0];
const whole = focusClimb(db, r.id, q, 6, { dir: r.dir, whole: true });
const theme = Object.values(THEMES)[0];
let fails = 0;
for (const [name, rr, startFull, basemap] of [["segment page", r, false, false], ["whole climb", whole, false, false],
                                              ["full-screen map", r, true, true]]) {
  try {
    const html = renderToString(<Segment r={{ ...rr, base: { dir: r.dir, i: r.i, j: r.j } }} db={db} q={q} pace={6} theme={theme} basemap={basemap}
      layers={DEFAULT_LAYERS} setLayers={() => {}} fav={false} doneDates={[]} onFav={() => {}} onDone={() => {}} onClose={() => {}}
      onView={() => {}} startFull={startFull} />);
    const want = startFull ? "Elevation profile" : "Getting there";
    if (!html.includes(want)) throw new Error(`"${want}" not on the page`);
    console.log(`  ok  ${name} renders`);
  } catch (e) { fails++; console.log(`FAIL  ${name}: ${e.message}`); }
}
console.log(fails ? `${fails} failures` : "all render checks pass");
if (fails) process.exit(1);

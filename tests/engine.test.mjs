// Engine checks: run with `npm test`. Brute force is the referee.
import { readFileSync } from "node:fs";
import { prepare, runQuery, searchClimb, implied, DEFAULT_QUERY, PRESETS, footprint, overlap, tkey } from "../src/engine.js";

const load = (f) => JSON.parse(readFileSync(new URL(`./fixtures/demo/${f}`, import.meta.url)));
const db = prepare({ meta: load("meta.json"), stations: load("stations.json"), ttm: load("ttm.json"),
                     climbs: load("climbs.json"), access: load("access.json") });

let fails = 0;
const check = (ok, msg) => { if (!ok) { fails++; console.log("FAIL", msg); } };
const open = [{ sid: "s", entry: 0 }];

// 0. the third number follows from the other two
check(Math.abs(implied({ mode: "gain", gain: 300, len: 2000 }).grade - 0.15) < 1e-12, "300 m in 2 km is 15 %");
check(Math.abs(implied({ mode: "grade", grade: 0.1, len: 1000 }).gain - 100) < 1e-9, "10 % over 1 km is 100 m");

// 1. synthetic profile: 1 km at 10 %, a 20 m dip over 40 m, then 1 km at 20 %
{
  const z = [100];
  for (let k = 0; k < 50; k++) z.push(z.at(-1) + 2);
  for (let k = 0; k < 2; k++) z.push(z.at(-1) - 10);
  for (let k = 0; k < 50; k++) z.push(z.at(-1) + 4);
  const fake = prepare({ meta: { profile_step_m: 20 }, stations: { stations: [], lines: {} }, ttm: { order: [], by: {} },
                         climbs: [{ id: "x", z, coords: [] }], access: {} }).climbs[0];
  const base = { ...DEFAULT_QUERY, maxApproach: 1e9, mode: "gain", gain: 250, len: 2200, cap: 0.1 };
  const a = searchClimb(null, fake, base, open).best;
  check(a && Math.round(a.up) === 300 && a.dn === 20, `D+ mode, cap 10 %: whole climb (300 up, 20 down), got ${a && a.up}`);
  check(!searchClimb(null, fake, { ...base, cap: 0 }, open).best, "D+ mode, cap 0 %: nothing reaches 250 m without a dip");
  check(!searchClimb(null, fake, { ...base, cap: 0.05 }, open).best, "D+ mode, cap 5 %: a 20 m dip needs 400 m of D+");

  const g = { ...base, mode: "grade", grade: 0.15, len: 1000 };
  const b = searchClimb(null, fake, { ...g, cap: 0 }, open).best;
  check(b && b.len === 1000 && Math.abs(b.grade - 0.2) < 1e-9, `grade mode, cap 0 %: only the 20 % km, got ${b && [b.len, b.grade]}`);
  const c = searchClimb(null, fake, g, open).best;
  check(c && c.len > 1000 && c.grade >= 0.15 - 1e-12, `grade mode, cap 10 %: longer than 1 km at ≥ 15 %, got ${c && [c.len, c.grade]}`);
  check(!searchClimb(null, fake, { ...g, len: 2100 }, open).best, "grade mode: nothing is 2.1 km long");
}

// 2. brute force agrees with the engine on every climb, both modes, both directions, trail filters on and off
function brute(c, q) {
  const s = q.dir === "down" ? c.down : c.up;
  const span = Math.round(q.len / c.step);
  let best = null;
  for (let i = 0; i < c.n; i++) for (let j = i + 1; j < c.n; j++) {
    const e = j - i, len = e * c.step;
    if (q.mode === "gain" && e > span) break;
    let up = 0, dn = 0, tr = 0, pv = 0;
    for (let k = i + 1; k <= j; k++) {
      const d = s.z[k] - s.z[k - 1];
      if (s.sign * d > 0) up += Math.abs(d); else dn += Math.abs(d);
      if (s.wayE[k - 1] === "t") tr++;
      if (s.surfE[k - 1] === "a") pv++;
    }
    if (!q.tracks && tr > 0.3 * e) continue;
    if (q.noPaved && pv > 0.05 * e) continue;
    if (up <= 0 || dn > q.cap * up + 1e-9) continue;
    const grade = (s.sign * (s.z[j] - s.z[i])) / len;
    if (q.mode === "gain") { if (up >= q.gain && (!best || up > best + 1e-9)) best = up; }
    else if (e >= span && grade >= q.grade && (!best || len > best)) best = len;
  }
  return best;
}
for (const t of [PRESETS[0].terrain, PRESETS[1].terrain]) for (const dir of ["up", "down"]) for (const [tracks, noPaved] of [[true, false], [false, true]]) {
  const q = { ...DEFAULT_QUERY, ...t, dir, tracks, noPaved, maxApproach: 1e9 };
  for (const c of db.climbs) {
    const { best } = searchClimb(db, c, q, open);
    const got = best ? (q.mode === "gain" ? best.up : best.len) : null;
    const want = brute(c, q);
    check(got === want || Math.abs((got || 0) - (want || 0)) < 1e-6, `${t.mode}/${dir}/${tracks}/${noPaved} ${c.id}: engine ${got} vs brute ${want}`);
  }
}

// 3. every result respects every limit it was asked for
for (const p of PRESETS) for (const w of ["wd", "sat", "sun"]) for (const dir of ["up", "down"]) {
  const q = { ...DEFAULT_QUERY, ...p.terrain, window: w, dir };
  const { results, near } = runQuery(db, q);
  for (const r of results) {
    const tag = `${p.id}/${w}/${dir} ${r.id}`;
    check(r.train[0] <= q.maxTrain, `${tag}: train ${r.train[0]}`);
    check(r.approach <= q.maxApproach, `${tag}: approach ${r.approach}`);
    check(r.dn <= q.cap * r.up + 1e-9, `${tag}: descent cap`);
    if (q.mode === "gain") check(r.up >= q.gain && r.len <= q.len, `${tag}: D+ ${r.up} in ${r.len}`);
    else check(r.len >= q.len && r.grade >= q.grade - 1e-12, `${tag}: ${r.grade} over ${r.len}`);
    const wsum = Object.values(r.ways).reduce((a, b) => a + b, 0);
    check(Math.abs(wsum - r.len) < 1e-6, `${tag}: way types add up to the length`);
  }
  for (const r of near) check(r.why && r.why.length > 0, `${p.id} near ${r.id} has a reason`);
  const prints = results.map(footprint);
  for (let a = 0; a < prints.length; a++) for (let b = a + 1; b < prints.length; b++)
    check(overlap(prints[a], prints[b]) < 0.5, `${p.id}/${w}/${dir}: ${results[a].id} and ${results[b].id} are the same stretch`);
  if (dir === "up" && w === "sat") console.log(`${p.label.padEnd(30)} ${String(results.length).padStart(3)} results  ${near.length} near misses`);
}

// 4. the origin changes the answer
{
  const a = runQuery(db, { ...DEFAULT_QUERY, origin: "stg" }).results.length;
  const b = runQuery(db, { ...DEFAULT_QUERY, origin: "kru" }).results.length;
  check(a !== b, `origin changes the answer (stg ${a}, kru ${b})`);
}

// without a car: a stop with no train or coach back that evening is not used
{
  const raw2 = { meta: load("meta.json"), stations: load("stations.json"), ttm: load("ttm.json"),
                 climbs: load("climbs.json"), access: load("access.json") };
  const q = { ...DEFAULT_QUERY, preset: "g10", ...PRESETS.find((p) => p.id === "g10").terrain };
  const before = runQuery(prepare(raw2), q, 6);
  const used = before.results[0]?.station;
  check(!!used, "g10 has a result to test the way back with");
  if (used) {
    const k = raw2.ttm.order.indexOf(used);
    raw2.ttm.by[q.window][q.origin][k][3] = null;
    const after = runQuery(prepare(raw2), q, 6);
    check(after.results.every((r) => r.station !== used), "a stop with no way back is not used");
    check(after.trace.noBack === 1, "…and counted");
  }
}

// transport choice: "train only" reads its own times ("<window>@rail")
{
  const raw3 = { meta: load("meta.json"), stations: load("stations.json"), ttm: load("ttm.json"),
                 climbs: load("climbs.json"), access: load("access.json") };
  const q = { ...DEFAULT_QUERY, preset: "g10", ...PRESETS.find((p) => p.id === "g10").terrain };
  const all = runQuery(prepare(raw3), q, 6);
  const used = all.results[0]?.station;
  // a made-up train-only table: same times, minus the stop the best result uses
  const row = raw3.ttm.by[q.window][q.origin].slice();
  row[raw3.ttm.order.indexOf(used)] = null;
  raw3.ttm.by[`${q.window}@rail`] = { [q.origin]: row };
  const db3 = prepare(raw3);
  check(tkey(q) === q.window && tkey({ ...q, transit: "rail" }) === `${q.window}@rail`, "times key: window, or window@mode");
  const rail = runQuery(db3, { ...q, transit: "rail" }, 6);
  check(rail.results.length > 0 && rail.results.every((r) => r.station !== used), "train only: stops it cannot reach are not used");
  check(runQuery(db3, { ...q, transit: "all" }, 6).results.length === all.results.length, "train + coach: unchanged");
  check(runQuery(db3, { ...q, transit: "coach" }, 6).results.length === 0, "a choice the data does not have finds nothing (the app falls back)");
}

console.log(fails ? `${fails} failures` : "all engine checks pass");
process.exit(fails ? 1 : 0);

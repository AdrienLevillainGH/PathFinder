/* ==================================================================
   engine

   Everything PathFinder decides lives here, and nothing here knows
   about React. Two filters, in this order:

   1. access  — origin station → stations reachable by train within
                T max (precomputed matrix) → climbs whose start is within
                D max of one of those stations (precomputed distances)
   2. terrain — inside each remaining climb, the best stretch for the
                terrain filter, in one of two modes:

      D+ mode    "300 m D+ within 2 km": any stretch up to the length
                 counts (shorter = steeper). Best = most D+.
                 Implied average grade = D+ / length.
      grade mode "10 % held over 1 km": the stretch must be at least
                 that long and average at least that grade.
                 Best = longest. Implied D+ = grade × length.

      In both, the descent cap keeps it a real climb: what the stretch
      loses on the way may not exceed cap × its D+.

   Then ranking, and near misses for whatever just failed.
   ================================================================== */

export const PRESETS = [
  { id: "p300", label: "300 m D+ in 2 km", terrain: { mode: "gain", gain: 300, len: 2000, cap: 0.1 } },
  { id: "g10", label: "10 % over 1 km", terrain: { mode: "grade", grade: 0.1, len: 1000, cap: 0.1 } },
  { id: "reps", label: "Hill reps · 100 m in 500 m", terrain: { mode: "gain", gain: 100, len: 500, cap: 0.05 } },
  { id: "wall", label: "Wall · 20 % over 300 m", terrain: { mode: "grade", grade: 0.2, len: 300, cap: 0.05 } },
  { id: "long", label: "Long climb · 450 m in 4.5 km", terrain: { mode: "gain", gain: 450, len: 4500, cap: 0.15 } },
];

export const DEFAULT_QUERY = {
  origin: "stg",
  window: "sat",
  maxTrain: 60,          // minutes, station to station
  maxApproach: 5000,     // metres, station to the start of the stretch
  dir: "up",             // "up" climbs, "down" descents
  tracks: true,          // forest tracks allowed
  noPaved: false,        // leave out stretches with tarmac
  sort: "total",
  preset: "p300",
  mode: "gain",
  gain: 300,             // D+ mode: metres
  grade: 0.15,           // grade mode: fraction
  len: 2000,             // D+ mode: at most · grade mode: at least
  cap: 0.1,
};

// the number the user did not type, worked out from the two they did
export function implied(q) {
  return q.mode === "gain" ? { grade: q.gain / q.len } : { gain: q.grade * q.len };
}

export const WAYS = {
  m: { label: "Mountain path", color: "#CBC3B4" },
  p: { label: "Hiking path", color: "#AD9066" },
  t: { label: "Forest track", color: "#C9D0D8" },
  r: { label: "Road", color: "#8E98A4" },
};
export const SURFACES = {
  k: { label: "Rocky", color: "#B3B99D" },
  n: { label: "Natural", color: "#BB925E" },
  u: { label: "Unpaved", color: "#A99071" },
  a: { label: "Paved", color: "#8B95A3" },
  x: { label: "Unknown", color: "#3A3833" },
};

/* ---------- load ---------- */

export function prepare({ meta, stations, ttm, climbs, access }) {
  const step = meta.profile_step_m || 20;
  const order = ttm.order;
  const pos = Object.fromEntries(order.map((id, i) => [id, i]));
  const byId = Object.fromEntries(stations.stations.map((s) => [s.id, s]));
  const prepped = climbs.map((c0) => {
    const c = c0.z10 ? unpack(c0) : c0;
    const n = c.z.length;
    const wayE = expand(c.way || [[0, "p"]], n - 1);
    const surfE = expand(c.surf || [[0, "n"]], n - 1);
    return {
      ...c, step, n, access: access[c.id] || [], wayE, surfE,
      up: series(c.z, 1, wayE, surfE),
      down: series([...c.z].reverse(), -1, [...wayE].reverse(), [...surfE].reverse()),
    };
  });
  return { meta, step, order, pos, stations: stations.stations, lines: stations.lines, byId, ttm, climbs: prepped,
           climbById: Object.fromEntries(prepped.map((c) => [c.id, c])) };
}

// compact climbs (pipeline): heights in decimetres and coordinates in
// 1e-5 degrees, each as differences from the previous point
function undelta(d, scale) {
  const out = new Array(d.length);
  let v = 0;
  for (let i = 0; i < d.length; i++) { v += d[i]; out[i] = v / scale; }
  return out;
}
function unpack(c) {
  const { z10, lon, lat, ...rest } = c;
  const x = undelta(lon, 1e5), y = undelta(lat, 1e5);
  return { ...rest, z: undelta(z10, 10), coords: x.map((v, i) => [v, y[i]]) };
}

// runs [[first edge, code], ...] → one code per edge
function expand(runs, edges) {
  const out = new Array(edges);
  for (let a = 0; a < runs.length; a++) {
    const k1 = a + 1 < runs.length ? runs[a + 1][0] : edges;
    for (let k = runs[a][0]; k < Math.min(k1, edges); k++) out[k] = runs[a][1];
  }
  return out;
}

// prefix sums, so any stretch's D+, D−, track and tarmac cost O(1)
function series(z, sign, wayE, surfE) {
  const n = z.length;
  const pu = new Float64Array(n), pd = new Float64Array(n), pt = new Int32Array(n), pa = new Int32Array(n);
  for (let k = 1; k < n; k++) {
    const d = z[k] - z[k - 1];
    pu[k] = pu[k - 1] + (d > 0 ? d : 0);
    pd[k] = pd[k - 1] + (d < 0 ? -d : 0);
    pt[k] = pt[k - 1] + (wayE[k - 1] === "t" ? 1 : 0);
    pa[k] = pa[k - 1] + (surfE[k - 1] === "a" ? 1 : 0);
  }
  // going down, the "gain" we look for is the drop: swap the two sums
  return sign > 0 ? { z, pu, pd, pt, pa, sign, wayE, surfE } : { z, pu: pd, pd: pu, pt, pa, sign, wayE, surfE };
}

/* ---------- access ---------- */

export function trainRow(db, origin, window) {
  return db.ttm.by[window]?.[origin] || [];
}

export function train(db, origin, window, station) {
  if (station === origin) return [0, 0, 99, 24 * 60, 0];
  return trainRow(db, origin, window)[db.pos[station]] || null;
}

/* ---------- terrain ---------- */

// best stretch of one climb, in one direction, for one query
export function searchClimb(db, c, q, entries) {
  const s = q.dir === "down" ? c.down : c.up;
  const { z, pu, pd, pt, pa } = s;
  const step = c.step, n = c.n;
  const span = Math.round(q.len / step);
  const nearestEntry = entries.length ? Math.min(...entries.map((e) => e.entry)) : Infinity;
  const slack = q._approachSlack || 1;
  const gainMode = q.mode !== "grade";

  let best = null, near = null;
  for (let i = 0; i < n - 1; i++) {
    // reaching the stretch means running the climb up to its start
    if (nearestEntry + i * step > q.maxApproach * slack) break;
    const jMax = gainMode ? Math.min(n - 1, i + span) : n - 1;
    const jMin = gainMode ? i + 1 : i + Math.max(1, Math.floor(span / 2));
    for (let j = jMin; j <= jMax; j++) {
      const edges = j - i, len = edges * step;
      if (!q.tracks && pt[j] - pt[i] > 0.3 * edges) continue;
      if (q.noPaved && pa[j] - pa[i] > 0.05 * edges) continue;
      const up = pu[j] - pu[i], dn = pd[j] - pd[i];
      if (up <= 0) continue;
      const net = s.sign * (z[j] - z[i]);
      const grade = net / len;
      const capOver = Math.max(0, dn - q.cap * up);
      let ok, short;
      if (gainMode) {
        ok = up >= q.gain && capOver === 0;
        short = Math.max(0, (q.gain - up) / q.gain) + capOver / up;
      } else {
        ok = j - i >= span && grade >= q.grade && capOver === 0;
        short = Math.max(0, (span - edges) / span) + Math.max(0, (q.grade - grade) / q.grade) + capOver / up;
      }
      const w = { i, j, up, dn, net, len, grade };
      if (ok) {
        if (!best || better(w, best, gainMode)) best = w;
      } else if (!near || short < near.short) {
        near = { ...w, short };
      }
    }
  }
  return { best, near };
}

// D+ mode: most D+, then shorter. grade mode: longest, then steeper.
function better(a, b, gainMode) {
  if (gainMode) return a.up > b.up + 1e-9 || (Math.abs(a.up - b.up) < 1e-9 && a.len < b.len);
  return a.len > b.len || (a.len === b.len && a.grade > b.grade + 1e-12);
}

/* ---------- one search ---------- */

export function runQuery(db, q, pace = 6) {
  const t0 = typeof performance !== "undefined" ? performance.now() : 0;
  const reach = new Map();               // station → train entry, within T max
  const reachLoose = new Map();          // within T max + 20 %, for near misses
  for (const s of db.stations) {
    const t = train(db, q.origin, q.window, s.id);
    if (!t) continue;
    if (t[0] <= q.maxTrain) reach.set(s.id, t);
    if (t[0] <= q.maxTrain * 1.2) reachLoose.set(s.id, t);
  }

  const trace = { stations: db.stations.length, reach: reach.size, climbs: db.climbs.length,
                  nearStation: 0, matched: 0, dupes: 0, near: 0, ms: 0 };
  const results = [], near = [];

  for (const c of db.climbs) {
    // which end you arrive at depends on the direction
    const entriesAll = c.access.map(([sid, d0, d1]) => ({ sid, entry: q.dir === "down" ? d1 : d0 }));
    const entries = entriesAll.filter((e) => reach.has(e.sid) && e.entry <= q.maxApproach);
    if (entries.length) {
      trace.nearStation++;
      const { best, near: nr } = searchClimb(db, c, q, entries);
      const pick = best && bestAccess(best, entries, reach, c.step, q, pace);
      if (pick) {
        trace.matched++;
        results.push(describe(db, c, q, best, pick));
        continue;
      }
      if (nr && nr.short <= 0.2) {
        const acc = bestAccess(nr, entries, reach, c.step, { ...q, maxApproach: Infinity }, pace);
        if (acc) near.push({ ...describe(db, c, q, nr, acc), why: whyTerrain(q, nr), score: nr.short });
      }
      continue;
    }

    // failed on access: does it pass terrain if we stretch access a little?
    const loose = entriesAll.filter((e) => reachLoose.has(e.sid) && e.entry <= q.maxApproach * 1.25);
    if (!loose.length) continue;
    const { best } = searchClimb(db, c, { ...q, _approachSlack: 1.25 }, loose);
    if (!best) continue;
    const acc = bestAccess(best, loose, reachLoose, c.step, { ...q, maxApproach: q.maxApproach * 1.25 }, pace);
    if (!acc) continue;
    const overT = Math.max(0, acc.train[0] - q.maxTrain) / q.maxTrain;
    const overD = Math.max(0, acc.approach - q.maxApproach) / q.maxApproach;
    if (overT + overD === 0) continue;
    near.push({ ...describe(db, c, q, best, acc), why: whyAccess(q, acc), score: overT + overD });
  }

  // climbs that share their upper part give the same stretch twice:
  // keep the one you reach soonest, drop the copies
  results.sort((a, b) => a.total - b.total);
  const kept = dedupe(results);
  trace.dupes = results.length - kept.length;
  results.length = 0;
  results.push(...kept);
  sortResults(results, q.sort);
  near.sort((a, b) => a.score - b.score);
  const nearKept = dedupe(near, results.map(footprint));
  near.length = 0;
  near.push(...nearKept);
  trace.near = Math.min(near.length, 8);
  trace.ms = typeof performance !== "undefined" ? performance.now() - t0 : 0;
  return { results, near: near.slice(0, 8), reach, trace };
}

// the ground a stretch covers, as ~45 m cells
export function footprint(r) {
  const c = r.climb.coords, n = c.length;
  const cells = new Set();
  for (let k = r.i; k <= r.j; k++) {
    const [lon, lat] = r.dir === "down" ? c[n - 1 - k] : c[k];
    cells.add(`${Math.floor(lon / 0.0006)},${Math.floor(lat / 0.0004)}`);
  }
  return cells;
}

// two stretches are the same if half the smaller one is on the other
export function overlap(a, b) {
  let shared = 0;
  for (const x of a) if (b.has(x)) shared++;
  return shared / Math.max(1, Math.min(a.size, b.size));
}

export function dedupe(list, taken = []) {
  const keep = [], prints = [...taken];
  for (const r of list) {
    const f = footprint(r);
    if (prints.some((g) => overlap(f, g) >= 0.5)) continue;
    keep.push(r);
    prints.push(f);
  }
  return keep;
}

// the station that gets you to this stretch soonest, train + approach
function bestAccess(w, entries, reach, step, q, pace) {
  let pick = null;
  for (const e of entries) {
    const t = reach.get(e.sid);
    if (!t) continue;
    const approach = e.entry + w.i * step;
    if (approach > q.maxApproach) continue;
    const approachMin = (approach / 1000) * pace;
    const total = t[0] + approachMin;
    if (!pick || total < pick.total) pick = { station: e.sid, train: t, approach, approachMin, total };
  }
  return pick;
}

function describe(db, c, q, w, acc) {
  const s = q.dir === "down" ? c.down : c.up;
  // steepest and flattest 100 m inside the stretch
  const k100 = Math.max(1, Math.round(100 / c.step));
  let steep = -Infinity, flat = Infinity;
  for (let k = w.i; k + k100 <= w.j; k++) {
    const g = (s.sign * (s.z[k + k100] - s.z[k])) / (k100 * c.step);
    if (g > steep) steep = g;
    if (g < flat) flat = g;
  }
  if (w.j - w.i < k100) steep = flat = w.grade;
  let hi = -Infinity, lo = Infinity;
  for (let k = w.i; k <= w.j; k++) { hi = Math.max(hi, s.z[k]); lo = Math.min(lo, s.z[k]); }
  return { id: c.id, climb: c, dir: q.dir, mode: q.mode, ...w, steep, flat, hi, lo,
           ways: breakdown(s.wayE, w.i, w.j, c.step), surfaces: breakdown(s.surfE, w.i, w.j, c.step),
           ...acc, stationName: db.byId[acc.station]?.name };
}

// metres of each code between two points
export function breakdown(codes, i, j, step) {
  const out = {};
  for (let k = i; k < j; k++) out[codes[k]] = (out[codes[k]] || 0) + step;
  return out;
}

// one climb opened on its own (from Saved): best stretch for the
// current terrain filter, reached from whichever station is soonest,
// with no access limits. Falls back to the whole climb.
export function focusClimb(db, id, q, pace = 6) {
  const c = db.climbById[id];
  if (!c) return null;
  const reach = new Map();
  for (const s of db.stations) {
    const t = train(db, q.origin, q.window, s.id);
    if (t) reach.set(s.id, t);
  }
  const entries = c.access.map(([sid, d0, d1]) => ({ sid, entry: q.dir === "down" ? d1 : d0 })).filter((e) => reach.has(e.sid));
  const open = { ...q, maxApproach: Infinity, maxTrain: Infinity };
  let { best } = searchClimb(db, c, open, entries.length ? entries : [{ sid: null, entry: 0 }]);
  if (!best) {
    const s = q.dir === "down" ? c.down : c.up;
    const j = c.n - 1, len = j * c.step, net = s.sign * (s.z[j] - s.z[0]);
    best = { i: 0, j, up: s.pu[j], dn: s.pd[j], net, len, grade: net / len, whole: true };
  }
  const acc = bestAccess(best, entries, reach, c.step, open, pace) ||
    { station: null, train: null, approach: null, approachMin: 0, total: Infinity };
  return describe(db, c, q, best, acc);
}

export function sortResults(list, by) {
  const f = {
    total: (a, b) => a.total - b.total,
    gain: (a, b) => b.up - a.up,
    grade: (a, b) => b.grade - a.grade,
    long: (a, b) => b.len - a.len,
  }[by] || ((a, b) => a.total - b.total);
  list.sort(f);
}

function whyTerrain(q, w) {
  const out = [];
  const d = q.dir === "down" ? "D−" : "D+";
  if (q.mode !== "grade") {
    if (w.up < q.gain) out.push(`${Math.round(q.gain - w.up)} m short of ${q.gain} m ${d} within ${fmtKm(q.len)}`);
  } else {
    if (w.len < q.len) out.push(`holds ${fmtPct(w.grade)} for ${fmtKm(w.len)}, not ${fmtKm(q.len)}`);
    else if (w.grade < q.grade) out.push(`${fmtPct(w.grade)} over ${fmtKm(w.len)}, under ${fmtPct(q.grade)}`);
  }
  if (w.dn > q.cap * w.up) out.push(`${q.dir === "down" ? "rises" : "dips"} ${Math.round(w.dn)} m on the way, over the ${Math.round(q.cap * 100)} % cap`);
  return out.join(" · ") || "just outside the limits";
}

function whyAccess(q, a) {
  const out = [];
  if (a.train[0] > q.maxTrain) out.push(`train ${a.train[0]} min, over ${q.maxTrain}`);
  if (a.approach > q.maxApproach) out.push(`${fmtKm(a.approach)} from the station, over ${fmtKm(q.maxApproach)}`);
  return out.join(" · ");
}

/* ---------- labels shared with the UI ---------- */

export function difficulty(grade) {
  if (grade < 0.08) return "Easy";
  if (grade < 0.14) return "Moderate";
  if (grade < 0.2) return "Hard";
  return "Very hard";
}

export const fmtPct = (x) => `${(x * 100).toFixed(Math.abs(x * 100) >= 10 ? 0 : 1)} %`;
export const fmtKm = (m) => (m < 1000 ? `${Math.round(m)} m` : m >= 10000 ? `${Math.round(m / 1000)} km` : `${(m / 1000).toFixed(1)} km`);
export const fmtMin = (m) => (m < 60 ? `${Math.round(m)} min` : `${Math.floor(m / 60)} h ${String(Math.round(m % 60)).padStart(2, "0")}`);
export const fmtClock = (mins) => `${String(Math.floor(mins / 60) % 24).padStart(2, "0")}:${String(Math.round(mins % 60)).padStart(2, "0")}`;
export const fmtPace = (p) => `${Math.floor(p)}:${String(Math.round((p % 1) * 60)).padStart(2, "0")} /km`;

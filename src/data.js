import { prepare, addClimbs, exactLine, train, tkey } from "./engine.js";

/* Loading the data. Two layouts:
   - all at once (the demo world): meta, stations, ttm, climbs, access
   - by area ("tiles1", the pipeline): meta + stations first; the times of
     the starting station; then only the tiles near the stops you can
     reach; the exact line and walking routes of a climb when it is shown.
   `get(path)` returns the parsed JSON of a file (fetch in the browser,
   the disk in tests). */

export async function openData(get) {
  const [meta, stations] = await Promise.all([get("meta.json"), get("stations.json")]);
  if (meta.climb_format !== "tiles1") {
    const [ttm, climbs, access] = await Promise.all([get("ttm.json"), get("climbs.json"), get("access.json")]);
    const db = prepare({ meta, stations, ttm, climbs, access });
    return Object.assign(db, { tiled: false, get });
  }
  const order = stations.stations.map((s) => s.id);
  const db = prepare({ meta, stations, ttm: { windows: meta.windows, order, by: {} }, climbs: [], access: {} });
  return Object.assign(db, { tiled: true, get, loaded: { hubs: new Map(), tiles: new Map(), details: new Map(), index: null } });
}

// one load per file, however many times it is asked for
function once(map, key, load) {
  if (!map.has(key)) map.set(key, load().catch((e) => { map.delete(key); throw e; }));
  return map.get(key);
}

// train/coach times from one starting station, for one transport choice
// ("all" = train + coach; "rail", "coach" when the data has them)
export function ensureHub(db, hub, transit = "all") {
  if (!db.tiled || !hub) return Promise.resolve();
  const mode = transit && transit !== "all" && (db.meta.modes || []).includes(transit) ? transit : "all";
  return once(db.loaded.hubs, `${hub}|${mode}`, async () => {
    const t = await db.get(`ttm/${hub}${mode === "all" ? "" : "." + mode}.json`);
    // rows follow stations.json; older files carry their own order
    const remap = !t.order || t.order.join() === db.order.join() ? null : t.order.map((id) => db.pos[id]);
    for (const [win, row] of Object.entries(t.by)) {
      const w = tkey({ window: win, transit: mode });
      db.ttm.by[w] = db.ttm.by[w] || {};
      if (!remap) { db.ttm.by[w][hub] = row; continue; }
      const out = new Array(db.order.length).fill(null);
      row.forEach((v, k) => { if (remap[k] != null) out[remap[k]] = v; });
      db.ttm.by[w][hub] = out;
    }
  });
}

// the tiles a search needs: those with a stop you can reach (with the same
// slack as the near misses) within walking distance of one of their climbs
export function tilesFor(db, q) {
  if (!db.tiled) return [];
  const reach = new Set([q.origin]);
  for (const s of db.stations) {
    const t = train(db, q.origin, tkey(q), s.id);
    if (!t || t[0] > q.maxTrain * 1.2) continue;
    if (q.roundTrip !== false && t[3] == null) continue;
    reach.add(s.id);
  }
  const lim = q.maxApproach * 1.25;
  return (db.meta.tiles || [])
    .filter((tile) => Object.entries(tile.near).some(([sid, d]) => reach.has(sid) && d <= lim))
    .map((tile) => tile.id);
}

export function ensureTiles(db, ids) {
  if (!db.tiled) return Promise.resolve();
  return Promise.all(ids.map((id) => once(db.loaded.tiles, id, async () => {
    const t = await db.get(`tiles/${id}.json`);
    addClimbs(db, t.climbs, t.access);
  })));
}

// everything a search needs, before it runs
export async function ensureFor(db, q) {
  if (!db.tiled) return;
  await ensureHub(db, q.origin, q.transit);
  await ensureTiles(db, tilesFor(db, q));
}

// saved climbs may be in tiles not loaded yet
export async function ensureClimbs(db, ids) {
  if (!db.tiled) return;
  const missing = ids.filter((id) => !db.climbById[id]);
  if (!missing.length) return;
  if (!db.loaded.index) db.loaded.index = db.get("index.json");
  const index = await db.loaded.index;
  await ensureTiles(db, [...new Set(missing.map((id) => index[id]).filter(Boolean))]);
}

// exact line + walking routes of one climb: { b: {stop: [[lon, lat], ...]}, t: {...} }
export function loadDetail(db, climbId) {
  if (!db || !climbId) return Promise.resolve(null);
  const cache = db.loaded?.details || (db._details = db._details || new Map());
  return once(cache, climbId, async () => {
    let j;
    try { j = await db.get(db.tiled ? `climbs/${climbId}.json` : `routes/${climbId}.json`); } catch { return null; }
    if (!j) return null;
    const c = db.climbById[climbId];
    if (c && j.lon) exactLine(c, j.lon, j.lat);
    const out = { b: {}, t: {} };
    for (const side of ["b", "t"]) {
      for (const [sid, d] of Object.entries(j[side] || {})) {
        const pts = [];
        let x = 0, y = 0;
        for (let k = 0; k + 1 < d.length; k += 2) { x += d[k]; y += d[k + 1]; pts.push([x / 1e5, y / 1e5]); }
        out[side][sid] = pts;
      }
    }
    return out;
  });
}

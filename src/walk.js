import { useEffect, useState } from "react";
import { along } from "./geo.js";

/* Walking routes from a stop to the bottom (b) or top (t) of a climb,
   along paths and roads: the same routes as the distances used by the
   filters. One small file per climb (data/routes/<id>.json), fetched
   when the climb is shown, in 1e-5 degrees as differences. */

const cache = new Map();

function decode(j) {
  if (!j) return null;
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
}

export function loadWalk(climbId) {
  if (!climbId) return Promise.resolve(null);
  if (!cache.has(climbId)) {
    cache.set(climbId, fetch(`./data/routes/${climbId}.json`)
      .then((r) => (r.ok ? r.json() : null))
      .then(decode)
      .catch(() => null));
  }
  return cache.get(climbId);
}

// the routes of one climb, once loaded (null until then, or if there are none)
export function useWalk(climbId) {
  const [walk, setWalk] = useState({ id: null, data: null });
  useEffect(() => {
    let live = true;
    loadWalk(climbId).then((data) => live && setWalk({ id: climbId, data }));
    return () => { live = false; };
  }, [climbId]);
  return walk.id === climbId ? walk.data : null;
}

/* the way from the stop to the start of the stretch: the walking route to
   the bottom (or top, for a descent) of the climb, then the climb itself up
   to where the stretch begins. `real` is false when the route of this stop
   is not in the file: the line is then straight and says so. */
export function approachLine(r, walk, db) {
  if (!r || !r.station) return null;
  const { coords } = along(r.climb, r.dir);
  const s = db.byId[r.station];
  if (!s) return null;
  const route = walk?.[r.dir === "down" ? "t" : "b"]?.[r.station];
  if (route && route.length > 1) return { coords: [...route, ...coords.slice(0, r.i + 1)], real: true };
  if (r.approach === 0) return null;
  return { coords: [[s.lon, s.lat], coords[r.i]], real: false };
}

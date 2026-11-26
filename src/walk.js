import { useEffect, useState } from "react";
import { along } from "./geo.js";

import { loadDetail } from "./data.js";

/* Walking routes from a stop to the bottom (b) or top (t) of a climb,
   along paths and roads: the same routes as the distances used by the
   filters. They come with the climb's exact line, in one small file per
   climb, fetched when the climb is shown (data.js, loadDetail). */

// the routes of one climb, once loaded (null until then, or if there are none);
// loading also swaps the climb's rough line for the exact one
export function useWalk(db, climbId) {
  const [walk, setWalk] = useState({ id: null, data: null });
  useEffect(() => {
    let live = true;
    loadDetail(db, climbId).then((data) => live && setWalk({ id: climbId, data }));
    return () => { live = false; };
  }, [db, climbId]);
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

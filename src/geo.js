/* Map helpers. The map is drawn by hand in SVG: no tiles, no library,
   so it runs inside the Claude artifact (which blocks remote images).
   The real app swaps this for MapLibre over a Plan IGN / OSM basemap. */

export const UNITS = 1000; // SVG units per degree of latitude

export function projection(bbox) {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  const kx = Math.cos((((minLat + maxLat) / 2) * Math.PI) / 180);
  return {
    x: (lon) => (lon - minLon) * kx * UNITS,
    y: (lat) => (maxLat - lat) * UNITS,
    w: (maxLon - minLon) * kx * UNITS,
    h: (maxLat - minLat) * UNITS,
    metres: (m) => (m / 111200) * UNITS,
    lon: (x) => minLon + x / (kx * UNITS),
    lat: (y) => maxLat - y / UNITS,
  };
}

export function bboxOf(points, pad = 0) {
  let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
  for (const [lon, lat] of points) {
    if (lon < a) a = lon;
    if (lat < b) b = lat;
    if (lon > c) c = lon;
    if (lat > d) d = lat;
  }
  return [a - pad, b - pad, c + pad, d + pad];
}

export const path = (P, coords) =>
  coords.map(([lon, lat], k) => `${k ? "L" : "M"}${P.x(lon).toFixed(1)} ${P.y(lat).toFixed(1)}`).join("");

// Rhine, schematic — only there to orient the eye
export const RHINE = [
  [7.56, 47.62], [7.55, 47.85], [7.58, 48.0], [7.62, 48.15], [7.7, 48.3], [7.78, 48.45],
  [7.8, 48.57], [7.88, 48.68], [7.98, 48.78], [8.1, 48.9], [8.2, 48.97],
];

// coordinates and elevations in the direction of travel
export function along(c, dir) {
  return dir === "down"
    ? { coords: [...c.coords].reverse(), z: [...c.z].reverse() }
    : { coords: c.coords, z: c.z };
}

export function gpx(r, whole) {
  const { coords, z } = along(r.climb, r.dir);
  const a = whole ? 0 : r.i, b = whole ? z.length - 1 : r.j;
  const pts = [];
  for (let k = a; k <= b; k++) {
    const [lon, lat] = coords[k] || coords[coords.length - 1];
    pts.push(`      <trkpt lat="${lat.toFixed(5)}" lon="${lon.toFixed(5)}"><ele>${z[k].toFixed(1)}</ele></trkpt>`);
  }
  const name = r.climb.name.replace(/[<&>"]/g, "");
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="PathFinder (demo)" xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>${name}${whole ? "" : " — matched stretch"}</name>
    <trkseg>
${pts.join("\n")}
    </trkseg>
  </trk>
</gpx>
`;
}

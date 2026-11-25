/* Background maps.

   IGN's Géoplateforme serves its maps openly: no key, no sign-up, and no
   rate limit on the tiled services (WMTS). Checked from Adrien's browser
   on 2026-11-25: Plan IGN, aerial photos, relief shading and contour lines
   all answer from any website. SCAN 25 (the paper-map look) is the one IGN
   map that still needs a licence, so it is not here.

   OpenStreetMap's own tiles are fine for light personal use. Komoot's and
   OpenRunner's maps are their own products and offer no public access. */

const wmts = (layer, style, set, format) =>
  `https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=${layer}&STYLE=${style}` +
  `&TILEMATRIXSET=${set}&FORMAT=${format}&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}`;

export const BASES = {
  plan: { label: "Plan IGN", tiles: wmts("GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2", "normal", "PM_0_19", "image/png"), maxzoom: 19, credit: "© IGN" },
  ortho: { label: "Aerial", tiles: wmts("ORTHOIMAGERY.ORTHOPHOTOS", "normal", "PM_0_19", "image/jpeg"), maxzoom: 19, credit: "© IGN" },
  osm: { label: "OpenStreetMap", tiles: "https://tile.openstreetmap.org/{z}/{x}/{y}.png", maxzoom: 19, credit: "© OpenStreetMap contributors" },
};

export const OVERLAYS = {
  relief: { label: "Relief shading", tiles: wmts("ELEVATION.ELEVATIONGRIDCOVERAGE.SHADOW", "estompage_grayscale", "PM_0_15", "image/png"), maxzoom: 15, opacity: 0.45 },
  contours: { label: "Contour lines", tiles: wmts("ELEVATION.CONTOUR.LINE", "normal", "PM_6_18", "image/png"), minzoom: 6, maxzoom: 18, opacity: 0.8, from: 12 },
};

export const DEFAULT_LAYERS = { base: "plan", relief: true, contours: true };

// can this page load map tiles? Inside a Claude artifact it cannot (the page
// may not reach other sites), so the app falls back to its hand-drawn map.
export async function probeBasemap() {
  try {
    if (typeof location !== "undefined" && /[?&]basemap=force/.test(location.search)) return true;
    if (typeof location !== "undefined" && /[?&]basemap=off/.test(location.search)) return false;
    const url = BASES.plan.tiles.replace("{z}", "8").replace("{y}", "88").replace("{x}", "133");
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch(url, { signal: ctrl.signal, mode: "cors" });
    clearTimeout(t);
    return res.ok;
  } catch (e) {
    return false;
  }
}

// the raster sources and layers every PathFinder map starts with
export function baseStyle(layers) {
  const sources = {}, out = [{ id: "paper", type: "background", paint: { "background-color": "#EBEDDA" } }];
  for (const [k, b] of Object.entries(BASES)) {
    sources[`base-${k}`] = { type: "raster", tiles: [b.tiles], tileSize: 256, maxzoom: b.maxzoom };
    out.push({ id: `base-${k}`, type: "raster", source: `base-${k}`, layout: { visibility: layers.base === k ? "visible" : "none" } });
  }
  for (const [k, o] of Object.entries(OVERLAYS)) {
    sources[`ov-${k}`] = { type: "raster", tiles: [o.tiles], tileSize: 256, minzoom: o.minzoom || 0, maxzoom: o.maxzoom };
    out.push({ id: `ov-${k}`, type: "raster", source: `ov-${k}`, minzoom: o.from || 0,
               paint: { "raster-opacity": o.opacity }, layout: { visibility: layers[k] ? "visible" : "none" } });
  }
  return { version: 8, sources, layers: out };
}

export function applyLayers(map, layers) {
  for (const k of Object.keys(BASES)) map.setLayoutProperty(`base-${k}`, "visibility", layers.base === k ? "visible" : "none");
  for (const k of Object.keys(OVERLAYS)) map.setLayoutProperty(`ov-${k}`, "visibility", layers[k] ? "visible" : "none");
}

export function credits(layers) {
  const c = new Set([BASES[layers.base].credit]);
  if (layers.relief || layers.contours) c.add("© IGN");
  return [...c].join(" · ");
}

// a circle as a GeoJSON ring, for "this far from the station"
export function circle(lon, lat, metres, n = 48) {
  const ring = [];
  const dLat = metres / 111200, dLon = metres / (111200 * Math.cos((lat * Math.PI) / 180));
  for (let k = 0; k <= n; k++) {
    const a = (k / n) * 2 * Math.PI;
    ring.push([lon + dLon * Math.cos(a), lat + dLat * Math.sin(a)]);
  }
  return ring;
}

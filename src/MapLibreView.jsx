import React, { useEffect, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { Layers, Check } from "lucide-react";
import { along } from "./geo.js";
import { fmtKm } from "./engine.js";
import { BASES, OVERLAYS, baseStyle, applyLayers, credits, circle } from "./basemap.js";
import { useWalk, approachLine } from "./walk.js";
import { loadDetail } from "./data.js";

/* The explore map on a real background (IGN or OSM tiles), drawn by
   MapLibre. Same props and behaviour as the hand-drawn MapView, which the
   app still uses wherever tiles cannot load (inside Claude).
   Kept quiet on purpose: by default only the selected match, its walk from
   the stop and the start station are drawn. All the matches, the stops and
   the reachable area are layers you switch on (layers.all/stops/reach). */

// what else can go on the map (off by default)
export const EXTRAS = {
  all: "All the matches",
  trains: "Train stations",
  coaches: "Coach stops",
  reach: "Reachable area",
};

const NAV_SVG = `<svg viewBox="0 0 24 24" width="12" height="12"><path d="M3 11 22 2 13 21 11 13 3 11Z" fill="#fff"/></svg>`;
const TRAIN_SVG = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><rect x="5" y="3" width="14" height="13" rx="3"/><path d="M5 10h14M9 20l-2 2M15 20l2 2M9 16v4M15 16v4"/></svg>`;

const fc = (features) => ({ type: "FeatureCollection", features });
const line = (coords, props = {}) => ({ type: "Feature", properties: props, geometry: { type: "LineString", coordinates: coords } });

export default function MapLibreView({ db, run, q, theme, selected, onSelect, pad, onMoved, layers, setLayers }) {
  const box = useRef(null);
  const mapRef = useRef(null);
  const markers = useRef([]);
  const userMoved = useRef(false);
  const [ready, setReady] = useState(false);
  const [scale, setScale] = useState(null);
  const [picker, setPicker] = useState(false);

  const showAll = Boolean(layers.all);
  const sel = run.results.find((r) => r.id === selected) || run.near.find((r) => r.id === selected);
  const walk = useWalk(db, sel?.id);
  const appr = approachLine(sel, walk, db);
  // with all the matches on the map, fetch their exact lines (rough until then)
  const [exact, setExact] = useState(0);
  useEffect(() => {
    if (!showAll) return;
    let live = true;
    Promise.all(run.results.map((r) => loadDetail(db, r.id))).then(() => live && setExact((x) => x + 1));
    return () => { live = false; };
  }, [showAll, run]);

  // frame what is drawn: the selected match and its walk (or all the matches)
  const fitResults = (map, animate = true) => {
    const b = new maplibregl.LngLatBounds();
    const shown = showAll ? run.results : sel ? [sel] : [];
    for (const r of shown) {
      const { coords } = along(r.climb, r.dir);
      for (let k = r.i; k <= r.j; k += 5) b.extend(coords[k]);
      b.extend(coords[r.j]);
      const s = db.byId[r.station];
      if (s && (showAll || !appr)) b.extend([s.lon, s.lat]);
    }
    if (!showAll && appr) appr.coords.forEach((c) => b.extend(c));
    if (b.isEmpty()) { const o = db.byId[q.origin]; if (o) b.extend([o.lon, o.lat]); }
    if (b.isEmpty()) return;
    map.fitBounds(b, { padding: { top: pad.top + 16, bottom: pad.bottom + 16, left: pad.left + 16, right: pad.right + 16 }, maxZoom: 14.5, duration: animate ? 600 : 0 });
  };

  // create the map once
  useEffect(() => {
    const map = new maplibregl.Map({
      container: box.current, style: baseStyle(layers), center: [7.45, 48.5], zoom: 8.5,
      attributionControl: false, dragRotate: false, pitchWithRotate: false, touchPitch: false, maxZoom: 18,
    });
    map.touchZoomRotate.disableRotation();
    // overlays go on as soon as the style is ready, without waiting for the background
    // tiles (if those fail to load, the routes must still show)
    const init = () => {
      if (map.getSource("reach")) return;
      const empty = fc([]);
      for (const id of ["reach", "near", "results", "approach", "stations"]) map.addSource(id, { type: "geojson", data: empty });
      map.addLayer({ id: "reach", type: "fill", source: "reach", paint: { "fill-color": theme.accentBg, "fill-opacity": 0.08 } });
      map.addLayer({ id: "near", type: "line", source: "near", paint: { "line-color": theme.route, "line-width": 2.5, "line-opacity": 0.8, "line-dasharray": [1, 1.6] } });
      map.addLayer({ id: "results-casing", type: "line", source: "results", layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#FFFFFF", "line-width": ["case", ["==", ["get", "sel"], 1], 11, 8] } });
      map.addLayer({ id: "results-line", type: "line", source: "results", layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": ["case", ["==", ["get", "sel"], 1], theme.sel, theme.route], "line-width": ["case", ["==", ["get", "sel"], 1], 7, 5] } });
      map.addLayer({ id: "results-dash", type: "line", source: "results", filter: ["==", ["get", "sel"], 1],
        paint: { "line-color": "#FFFFFF", "line-width": 2, "line-dasharray": [2.5, 2.5] } });
      map.addLayer({ id: "results-hit", type: "line", source: "results", paint: { "line-color": "#000", "line-opacity": 0, "line-width": 24 } });
      // the walk from the stop: dots along the real route; dashes when the route is not drawn (straight line)
      map.addLayer({ id: "approach-casing", type: "line", source: "approach", layout: { "line-cap": "round", "line-join": "round" },
        filter: ["==", ["get", "real"], 1], paint: { "line-color": "#FFFFFF", "line-width": 6, "line-opacity": 0.85 } });
      map.addLayer({ id: "approach", type: "line", source: "approach", layout: { "line-cap": "round", "line-join": "round" },
        filter: ["==", ["get", "real"], 1], paint: { "line-color": theme.sel, "line-width": 3, "line-dasharray": [0.1, 1.8] } });
      map.addLayer({ id: "approach-straight", type: "line", source: "approach", filter: ["==", ["get", "real"], 0],
        paint: { "line-color": theme.sel, "line-width": 1.5, "line-opacity": 0.6, "line-dasharray": [2, 3] } });
      // stops you switch on: coaches small, trains larger; the ones you can reach (out and back) solid
      map.addLayer({ id: "stops-coach", type: "circle", source: "stations", minzoom: 9, filter: ["==", ["get", "kind"], "coach"],
        paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 9, 2.5, 14, 5],
                 "circle-color": ["case", ["==", ["get", "reach"], 1], "#2F6DB5", "#A9BEDA"],
                 "circle-stroke-color": "#FFFFFF", "circle-stroke-width": 1.2 } });
      map.addLayer({ id: "stops-rail", type: "circle", source: "stations", filter: ["==", ["get", "kind"], "rail"],
        paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 8, 3.5, 14, 6.5],
                 "circle-color": ["case", ["==", ["get", "reach"], 1], theme.accentBg, "#FFFFFF"],
                 "circle-stroke-color": ["case", ["==", ["get", "reach"], 1], "#FFFFFF", theme.accentBg], "circle-stroke-width": 2 } });
      map.on("click", "results-hit", (e) => { const id = e.features?.[0]?.properties?.id; if (id) onSelectRef.current?.(id); });
      map.on("mouseenter", "results-hit", () => (map.getCanvas().style.cursor = "pointer"));
      map.on("mouseleave", "results-hit", () => (map.getCanvas().style.cursor = ""));
      setReady(true);
    };
    map.on("style.load", init);
    map.on("load", init);
    const report = () => {
      const c = map.getCenter();
      const mpp = (40075016.686 * Math.cos((c.lat * Math.PI) / 180)) / (512 * 2 ** map.getZoom());
      setScale(mpp);
    };
    map.on("move", report);
    map.on("moveend", (e) => {
      report();
      if (!e.originalEvent && !userMoved.current) return;
      userMoved.current = false;
      const W = box.current.clientWidth, H = box.current.clientHeight;
      const ll = map.unproject([pad.left + (W - pad.left - pad.right) / 2, pad.top + (H - pad.top - pad.bottom) / 2]);
      onMovedRef.current?.({ lon: ll.lng, lat: ll.lat });
    });
    mapRef.current = map;
    return () => { markers.current.forEach((m) => m.remove()); map.remove(); };
  }, []);

  // keep the latest callbacks without re-creating the map
  const onSelectRef = useRef(onSelect), onMovedRef = useRef(onMoved);
  onSelectRef.current = onSelect; onMovedRef.current = onMoved;

  useEffect(() => { if (ready) applyLayers(mapRef.current, layers); }, [ready, layers]);

  // the data on the map
  useEffect(() => {
    const map = mapRef.current;
    if (!ready) return;
    const R = q.maxApproach;
    map.getSource("reach").setData(fc(!layers.reach ? [] : db.stations.filter((s) => run.reach.has(s.id) || s.id === q.origin)
      .map((s) => ({ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [circle(s.lon, s.lat, R)] } }))));
    map.getSource("near").setData(fc(!showAll || !q.showNear ? [] : run.near.map((r) => line(along(r.climb, r.dir).coords.slice(r.i, r.j + 1)))));
    const shown = showAll ? [...run.results.filter((r) => r.id !== selected), ...(sel ? [sel] : [])] : sel ? [sel] : [];
    map.getSource("results").setData(fc(shown.map((r) => line(along(r.climb, r.dir).coords.slice(r.i, r.j + 1), { id: r.id, sel: r.id === selected ? 1 : 0 }))));
    map.getSource("approach").setData(fc(appr ? [line(appr.coords, { real: appr.real ? 1 : 0 })] : []));
    const kinds = new Set([layers.trains && "rail", layers.coaches && "coach"].filter(Boolean));
    map.getSource("stations").setData(fc(db.stations.filter((st) => kinds.has(st.kind || "rail")).map((st) => ({ type: "Feature",
      properties: { kind: st.kind || "rail", reach: run.reach.has(st.id) ? 1 : 0 }, geometry: { type: "Point", coordinates: [st.lon, st.lat] } }))));

    // HTML markers: the start station, and a pin at the start of each match
    markers.current.forEach((m) => m.remove());
    markers.current = [];
    const o = db.byId[q.origin];
    if (o) {
      const el = document.createElement("div");
      el.innerHTML = `<div style="display:flex;align-items:center;gap:6px"><span style="width:26px;height:26px;border-radius:50%;background:${theme.accentBg};color:${theme.accentText};border:2.5px solid #fff;display:flex;align-items:center;justify-content:center;box-shadow:0 1px 4px rgba(0,0,0,.3)">${TRAIN_SVG}</span><b style="font:600 13px system-ui;color:#1B1A16;text-shadow:0 0 3px #fff,0 0 3px #fff,0 0 3px #fff">${o.name}</b></div>`;
      markers.current.push(new maplibregl.Marker({ element: el, anchor: "left", offset: [-13, 0] }).setLngLat([o.lon, o.lat]).addTo(map));
    }
    // the stop you get off at, for the selected match
    const st = sel && db.byId[sel.station];
    if (st && st.id !== q.origin) {
      const el = document.createElement("div");
      el.innerHTML = `<div style="display:flex;align-items:center;gap:5px"><span style="width:22px;height:22px;border-radius:50%;background:#fff;color:${theme.accentBg};border:2px solid ${theme.accentBg};display:flex;align-items:center;justify-content:center;box-shadow:0 1px 3px rgba(0,0,0,.3)">${TRAIN_SVG}</span><b style="font:600 12px system-ui;color:#1B1A16;text-shadow:0 0 3px #fff,0 0 3px #fff,0 0 3px #fff">${st.name}</b></div>`;
      markers.current.push(new maplibregl.Marker({ element: el, anchor: "left", offset: [-11, 0] }).setLngLat([st.lon, st.lat]).addTo(map));
    }
    for (const r of shown) {
      const on = r.id === selected;
      const el = document.createElement("button");
      el.setAttribute("aria-label", r.climb.name);
      el.style.cssText = `width:${on ? 26 : 20}px;height:${on ? 26 : 20}px;border-radius:50%;border:2px solid #fff;background:${on ? theme.sel : theme.route};display:flex;align-items:center;justify-content:center;box-shadow:0 1px 4px rgba(0,0,0,.3);cursor:pointer;padding:0`;
      el.innerHTML = NAV_SVG;
      el.addEventListener("click", (e) => { e.stopPropagation(); onSelectRef.current?.(r.id); });
      markers.current.push(new maplibregl.Marker({ element: el }).setLngLat(along(r.climb, r.dir).coords[r.i]).addTo(map));
    }
  }, [ready, run, selected, q.origin, q.maxApproach, q.showNear, theme, showAll, layers.trains, layers.coaches, layers.reach, walk, exact, appr?.coords.length, appr?.real]);

  // a new search, a new selection or a route that arrives reframes the map
  // (with all the matches shown, only a new search does)
  const frameKey = showAll ? `all|${run.results.length}` : `${selected}|${appr?.real ? 1 : 0}`;
  useEffect(() => { if (ready) fitResults(mapRef.current, true); }, [ready, run, frameKey]);

  const map = mapRef.current;
  const nice = scale ? ([200, 500, 1000, 2000, 5000, 10000, 20000, 50000].find((m) => m / scale > 70) || 50000) : null;
  const btn = (Icon, label, act) => (
    <button key={label} onClick={act} aria-label={label} title={label} className="dl-text flex h-9 w-9 items-center justify-center border-t dl-line first:border-t-0">
      <Icon size={16} />
    </button>
  );

  return (
    <div className="absolute inset-0">
      {/* MapLibre's stylesheet makes its container position:relative, so the size is set inline */}
      <div ref={box} style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, background: "#EBEDDA" }} />

      {nice && (
        <div className="pointer-events-none absolute left-3 text-[11px] font-medium" style={{ top: pad.top + 4, color: "#1B1A16", textShadow: "0 0 3px #fff" }}>
          <div className="flex justify-between" style={{ width: nice / scale }}><span>0</span><span>{fmtKm(nice)}</span></div>
          <div className="mt-0.5 h-1.5 rounded-full border-2" style={{ width: nice / scale, borderColor: "#1B1A16", background: "linear-gradient(90deg,#1B1A16 50%,#fff 50%)" }} />
        </div>
      )}

      <div className="pointer-events-none absolute left-3 text-[10px]" style={{ bottom: pad.bottom + 6, color: "#1B1A16", textShadow: "0 0 3px #fff,0 0 3px #fff" }}>
        {credits(layers)} · MapLibre
      </div>

      <div className="absolute right-3" style={{ bottom: pad.bottom + 12 }}>
        {picker && (
          <div className="dl-float absolute bottom-0 right-[46px] w-56 rounded-2xl p-2 text-[14px]">
            <div className="px-2 pb-1 pt-1 text-xs dl-faint">Map</div>
            {Object.entries(BASES).map(([k, b]) => (
              <button key={k} onClick={() => setLayers({ ...layers, base: k })} className="flex w-full items-center justify-between rounded-xl px-2 py-2 text-left">
                {b.label}{layers.base === k && <Check size={18} style={{ color: "var(--abg)" }} />}
              </button>
            ))}
            <div className="px-2 pb-1 pt-2 text-xs dl-faint">On top</div>
            {Object.entries(OVERLAYS).map(([k, o]) => (
              <button key={k} onClick={() => setLayers({ ...layers, [k]: !layers[k] })} className="flex w-full items-center justify-between rounded-xl px-2 py-2 text-left">
                {o.label}{layers[k] && <Check size={18} style={{ color: "var(--abg)" }} />}
              </button>
            ))}
            <p className="px-2 pt-1 text-[11px] dl-faint">Contour lines show from zoom 12.</p>
            <div className="px-2 pb-1 pt-2 text-xs dl-faint">Also show</div>
            {Object.entries(EXTRAS).map(([k, label]) => (
              <button key={k} onClick={() => setLayers({ ...layers, [k]: !layers[k] })} className="flex w-full items-center justify-between rounded-xl px-2 py-2 text-left">
                <span className="flex items-center gap-2">
                  {k === "trains" && <span className="inline-block h-3 w-3 rounded-full border-2 border-white" style={{ background: theme.accentBg, boxShadow: "0 0 0 1px #0002" }} />}
                  {k === "coaches" && <span className="inline-block h-2.5 w-2.5 rounded-full border border-white" style={{ background: "#2F6DB5", boxShadow: "0 0 0 1px #0002" }} />}
                  {label}
                </span>
                {layers[k] && <Check size={18} style={{ color: "var(--abg)" }} />}
              </button>
            ))}
          </div>
        )}
        <div className="dl-float flex flex-col overflow-hidden rounded-xl">
          {btn(Layers, "Map layers", () => setPicker(!picker))}
        </div>
      </div>
    </div>
  );
}

/* the small map on the segment page: the stretch coloured by grade, its station */
// 3D relief: Mapterhorn's open terrain tiles (terrarium encoding, 512 px),
// read from its PMTiles archives: zoom <= 12 from the planet file, deeper
// zooms from one regional file per zoom-6 tile. Loaded on first use only.
const MAPTERHORN = "https://s3.us-west-2.amazonaws.com/us-west-2.opendata.source.coop/mapterhorn/mapterhorn/";
let demReady = null;
function demProtocol() {
  if (!demReady) demReady = import("pmtiles").then(({ Protocol }) => {
    const protocol = new Protocol();
    maplibregl.addProtocol("mapterhorn", async (params, abort) => {
      const [z, x, y] = params.url.replace("mapterhorn://", "").split("/").map(Number);
      const name = z <= 12 ? "planet" : `6-${x >> (z - 6)}-${y >> (z - 6)}`;
      const res = await protocol.tile({ ...params, url: `pmtiles://${MAPTERHORN}${name}.pmtiles/${z}/${x}/${y}.webp` }, abort);
      if (res.data == null) throw new Error(`no terrain tile ${z}/${x}/${y}`);
      return res;
    });
  });
  return demReady;
}

// compass direction from a to b ([lon, lat]), degrees
function bearingOf(a, b) {
  const k = Math.PI / 180;
  const y = Math.sin((b[0] - a[0]) * k) * Math.cos(b[1] * k);
  const x = Math.cos(a[1] * k) * Math.sin(b[1] * k) - Math.sin(a[1] * k) * Math.cos(b[1] * k) * Math.cos((b[0] - a[0]) * k);
  return (Math.atan2(y, x) / k + 360) % 360;
}

export function DetailMapGL({ r, db, layers, theme, gradeColor, approach, height = 300, full = false, threeD = false, onTap = null, cursor = null }) {
  const box = useRef(null);
  const mapRef = useRef(null);
  const pins = useRef([]);
  const apprRef = useRef(approach);
  apprRef.current = approach;
  const tapRef = useRef(null);
  tapRef.current = full ? null : onTap;
  const fullRef = useRef(full);
  fullRef.current = full;
  const threeRef = useRef(threeD);
  threeRef.current = threeD;
  const walkData = (a) => fc(a ? [line(a.coords, { real: a.real ? 1 : 0 })] : []);
  useEffect(() => {
    const { coords, z } = along(r.climb, r.dir);
    // tilt up to 85° in 3D (MapLibre's limit; its default is 60°), to look along the ground
    const map = new maplibregl.Map({ container: box.current, style: baseStyle(layers), center: coords[r.i], zoom: 13, interactive: true,
      attributionControl: false, dragRotate: false, touchPitch: false, maxPitch: 85 });   // turning and tilting: 3D only
    map.touchZoomRotate.disableRotation();
    const init = () => {
      if (map.getSource("seg")) return;
      const seg = coords.slice(r.i, r.j + 1);
      // colour by grade along the stretch: a step per 20 m
      const steps = [];
      const n = seg.length - 1, sign = r.dir === "down" ? -1 : 1;
      for (let k = 0; k < n; k++) {
        const a = Math.max(0, r.i + k - 2), b = Math.min(z.length - 1, r.i + k + 3);
        const col = gradeColor((sign * (z[b] - z[a])) / ((b - a) * r.climb.step));
        if (k === 0) steps.push(col); else steps.push(k / n, col);
      }
      map.addSource("whole", { type: "geojson", data: line(coords) });
      map.addSource("seg", { type: "geojson", data: line(seg), lineMetrics: true });
      const s = db.byId[r.station];
      map.addSource("approach", { type: "geojson", data: walkData(apprRef.current) });
      map.addLayer({ id: "whole", type: "line", source: "whole", paint: { "line-color": "#55524A", "line-opacity": 0.55, "line-width": 3 } });
      map.addLayer({ id: "approach-casing", type: "line", source: "approach", layout: { "line-cap": "round", "line-join": "round" },
        filter: ["==", ["get", "real"], 1], paint: { "line-color": "#FFFFFF", "line-width": 6, "line-opacity": 0.85 } });
      map.addLayer({ id: "approach", type: "line", source: "approach", layout: { "line-cap": "round", "line-join": "round" },
        filter: ["==", ["get", "real"], 1], paint: { "line-color": theme.sel, "line-width": 3, "line-dasharray": [0.1, 1.8] } });
      map.addLayer({ id: "approach-straight", type: "line", source: "approach", filter: ["==", ["get", "real"], 0],
        paint: { "line-color": theme.sel, "line-width": 1.5, "line-opacity": 0.6, "line-dasharray": [2, 3] } });
      map.addLayer({ id: "seg-casing", type: "line", source: "seg", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#FFFFFF", "line-width": 11 } });
      map.addLayer({ id: "seg", type: "line", source: "seg", layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-width": 7, "line-gradient": steps.length > 1 ? ["step", ["line-progress"], ...steps] : steps[0] } });
      const pin = (lngLat, bg, svg) => {
        const el = document.createElement("div");
        el.style.cssText = `width:24px;height:24px;border-radius:50%;border:2.5px solid #fff;background:${bg};display:flex;align-items:center;justify-content:center;box-shadow:0 1px 4px rgba(0,0,0,.3)`;
        el.innerHTML = svg;
        return new maplibregl.Marker({ element: el }).setLngLat(lngLat).addTo(map);
      };
      pins.current = [
        pin(seg[0], theme.sel, `<svg viewBox="0 0 24 24" width="11" height="11"><path d="M7 4l12 8-12 8z" fill="#fff"/></svg>`),
        pin(seg[seg.length - 1], "#1B1A16", `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="#fff" stroke-width="2.6"><path d="M5 21V4h11l-2 4 2 4H5"/></svg>`),
      ];
      if (s) pin([s.lon, s.lat], theme.accentBg, TRAIN_SVG.replace('stroke="currentColor"', `stroke="${theme.accentText}"`));
      frame(map, false);
    };
    map.on("style.load", init);
    map.on("load", init);
    // a tap (not a drag) on the small map opens it full screen
    map.on("click", () => tapRef.current?.());
    mapRef.current = map;
    return () => { mapRef.current = null; curRef.current = null; map.remove(); };
  }, [r.id, r.i, r.j, r.dir]);

  // where the finger is on the elevation profile
  const curRef = useRef(null);
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!cursor) { curRef.current?.remove(); curRef.current = null; return; }
    if (!curRef.current) {
      const el = document.createElement("div");
      el.style.cssText = `width:20px;height:20px;border-radius:50%;background:#fff;border:5px solid ${theme.accentBg};box-shadow:0 1px 5px rgba(0,0,0,.45)`;
      curRef.current = new maplibregl.Marker({ element: el }).setLngLat(cursor).addTo(map);
    } else curRef.current.setLngLat(cursor);
  }, [cursor?.[0], cursor?.[1]]);

  // background map and overlays chosen in the layers menu
  useEffect(() => {
    const map = mapRef.current;
    if (map && map.getLayer("paper")) applyLayers(map, layers);
  }, [layers.base, layers.relief, layers.contours]);

  // follow the box when it grows to the whole screen and back
  useEffect(() => {
    const ro = new ResizeObserver(() => mapRef.current?.resize());
    if (box.current) ro.observe(box.current);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.getSource("seg")) return;
    map.resize();
    if (!threeRef.current) frame(map, true);
  }, [full]);

  // relief in 3D: terrain on, tilted, looking along the segment (uphill for a climb)
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    let gone = false;
    const handlers = [map.dragRotate, map.touchPitch];
    if (threeD) {
      demProtocol().then(() => {
        if (gone || mapRef.current !== map) return;
        const go = () => {
          if (!map.getSource("dem")) map.addSource("dem", { type: "raster-dem", tiles: ["mapterhorn://{z}/{x}/{y}"], encoding: "terrarium", tileSize: 512, maxzoom: 14 });
          map.setTerrain({ source: "dem", exaggeration: 1 });            // true scale
          // above the horizon: let the sky behind the map show through
          if (map.getLayer("paper")) map.setPaintProperty("paper", "background-opacity", 0);
          handlers.forEach((h) => h.enable());
          map.touchZoomRotate.enableRotation();
          frame(map, true);
        };
        if (map.isStyleLoaded()) go(); else map.once("load", go);
      }).catch(() => {});
    } else if (map.getTerrain?.()) {
      map.setTerrain(null);
      if (map.getLayer("paper")) map.setPaintProperty("paper", "background-opacity", 1);
      handlers.forEach((h) => h.disable());
      map.touchZoomRotate.disableRotation();
      map.easeTo({ pitch: 0, bearing: 0, duration: 400 });
      setTimeout(() => mapRef.current === map && frame(map, true), 420);
    }
    return () => { gone = true; };
  }, [threeD]);

  // the stretch, its stop and the walk between them
  const frame = (map, animate) => {
    const { coords } = along(r.climb, r.dir);
    const b = new maplibregl.LngLatBounds();
    coords.slice(r.i, r.j + 1).forEach((c) => b.extend(c));
    const s = db.byId[r.station];
    if (s) b.extend([s.lon, s.lat]);
    apprRef.current?.coords.forEach((c) => b.extend(c));
    const padding = fullRef.current ? { top: 90, bottom: 50, left: 40, right: 40 } : { top: 80, bottom: 50, left: 40, right: 40 };
    if (threeRef.current) {
      const bearing = bearingOf(coords[r.i], coords[r.j]);
      const cam = map.cameraForBounds(b, { padding, bearing, maxZoom: 15 });
      if (cam) map.easeTo({ ...cam, zoom: cam.zoom - 0.3, bearing, pitch: 65, duration: animate ? 900 : 0 });
      return;
    }
    map.fitBounds(b, { padding, maxZoom: 15.5, duration: animate ? 500 : 0 });
  };

  // the walking route and the exact line arrive after the page opens
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.getSource("approach")) return;
    const { coords } = along(r.climb, r.dir);
    const seg = coords.slice(r.i, r.j + 1);
    map.getSource("whole").setData(line(coords));
    map.getSource("seg").setData(line(seg));
    pins.current[0]?.setLngLat(seg[0]);
    pins.current[1]?.setLngLat(seg[seg.length - 1]);
    map.getSource("approach").setData(walkData(approach));
    frame(map, true);
  }, [approach?.coords.length, approach?.real, r.climb.rough]);
  return (
    <div style={{ position: "absolute", top: 0, left: 0, right: 0, height }}>
      <div ref={box} className="absolute inset-0"
        style={{ background: threeD ? "linear-gradient(180deg, #8FB8DE 0%, #C9DDEE 45%, #E8EEF2 100%)" : "#EBEDDA" }} />
      <div className="pointer-events-none absolute left-3 text-[10px]" style={{ bottom: full ? 28 : 32, color: "#1B1A16", textShadow: "0 0 3px #fff,0 0 3px #fff" }}>{credits(layers)}{threeD ? " · relief © Mapterhorn" : ""}</div>
    </div>
  );
}

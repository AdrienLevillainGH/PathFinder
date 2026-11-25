import React, { useEffect, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { Plus, Minus, LocateFixed, Maximize2, Layers, Check } from "lucide-react";
import { along } from "./geo.js";
import { fmtKm } from "./engine.js";
import { BASES, OVERLAYS, baseStyle, applyLayers, credits, circle } from "./basemap.js";

/* The explore map on a real background (IGN or OSM tiles), drawn by
   MapLibre. Same props and behaviour as the hand-drawn MapView, which the
   app still uses wherever tiles cannot load (inside Claude). */

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

  // where the visible part of the map is (between the floating search and the sheet)
  const fitResults = (map, animate = true) => {
    const b = new maplibregl.LngLatBounds();
    const o = db.byId[q.origin];
    if (o) b.extend([o.lon, o.lat]);
    for (const r of run.results) {
      const { coords } = along(r.climb, r.dir);
      b.extend(coords[r.i]); b.extend(coords[r.j]);
      const s = db.byId[r.station];
      if (s) b.extend([s.lon, s.lat]);
    }
    if (b.isEmpty()) return;
    map.fitBounds(b, { padding: { top: pad.top + 10, bottom: pad.bottom + 10, left: pad.left + 10, right: pad.right + 10 }, maxZoom: 13.5, duration: animate ? 700 : 0 });
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
      for (const id of ["reach", "climbs", "near", "results", "approach", "stations"]) map.addSource(id, { type: "geojson", data: empty });
      map.addLayer({ id: "reach", type: "fill", source: "reach", paint: { "fill-color": theme.accentBg, "fill-opacity": 0.1 } });
      map.addLayer({ id: "climbs", type: "line", source: "climbs", paint: { "line-color": "#55524A", "line-opacity": 0.45, "line-width": 1.4 } });
      map.addLayer({ id: "near", type: "line", source: "near", paint: { "line-color": theme.route, "line-width": 3, "line-dasharray": [1, 1.6] } });
      map.addLayer({ id: "results-casing", type: "line", source: "results", layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#FFFFFF", "line-width": ["case", ["==", ["get", "sel"], 1], 11, 8] } });
      map.addLayer({ id: "results-line", type: "line", source: "results", layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": ["case", ["==", ["get", "sel"], 1], theme.sel, theme.route], "line-width": ["case", ["==", ["get", "sel"], 1], 7, 5] } });
      map.addLayer({ id: "results-dash", type: "line", source: "results", filter: ["==", ["get", "sel"], 1],
        paint: { "line-color": "#FFFFFF", "line-width": 2, "line-dasharray": [2.5, 2.5] } });
      map.addLayer({ id: "results-hit", type: "line", source: "results", paint: { "line-color": "#000", "line-opacity": 0, "line-width": 24 } });
      map.addLayer({ id: "approach", type: "line", source: "approach", layout: { "line-cap": "round" },
        paint: { "line-color": theme.sel, "line-width": 2, "line-dasharray": [0.2, 2.2] } });
      map.addLayer({ id: "stations", type: "circle", source: "stations",
        paint: { "circle-radius": ["case", ["==", ["get", "reach"], 1], 5, 3.5], "circle-color": ["case", ["==", ["get", "reach"], 1], "#FFFFFF", "#D8D4C8"],
                 "circle-stroke-color": "#1B1A16", "circle-stroke-width": ["case", ["==", ["get", "reach"], 1], 2, 1] } });
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
    map.getSource("reach").setData(fc(db.stations.filter((s) => run.reach.has(s.id) || s.id === q.origin)
      .map((s) => ({ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [circle(s.lon, s.lat, R)] } }))));
    map.getSource("climbs").setData(fc(db.climbs.map((c) => line(c.coords))));
    map.getSource("near").setData(fc(run.near.map((r) => line(along(r.climb, r.dir).coords.slice(r.i, r.j + 1)))));
    const sel = run.results.find((r) => r.id === selected);
    const ordered = sel ? [...run.results.filter((r) => r.id !== selected), sel] : run.results;
    map.getSource("results").setData(fc(ordered.map((r) => line(along(r.climb, r.dir).coords.slice(r.i, r.j + 1), { id: r.id, sel: r.id === selected ? 1 : 0 }))));
    const s = sel && db.byId[sel.station];
    map.getSource("approach").setData(fc(s ? [line([[s.lon, s.lat], along(sel.climb, sel.dir).coords[sel.i]])] : []));
    map.getSource("stations").setData(fc(db.stations.map((st) => ({ type: "Feature", properties: { reach: run.reach.has(st.id) ? 1 : 0 },
      geometry: { type: "Point", coordinates: [st.lon, st.lat] } }))));

    // HTML markers: the start station, and a pin at the start of each match
    markers.current.forEach((m) => m.remove());
    markers.current = [];
    const o = db.byId[q.origin];
    if (o) {
      const el = document.createElement("div");
      el.innerHTML = `<div style="display:flex;align-items:center;gap:6px"><span style="width:26px;height:26px;border-radius:50%;background:${theme.accentBg};color:${theme.accentText};border:2.5px solid #fff;display:flex;align-items:center;justify-content:center;box-shadow:0 1px 4px rgba(0,0,0,.3)">${TRAIN_SVG}</span><b style="font:600 13px system-ui;color:#1B1A16;text-shadow:0 0 3px #fff,0 0 3px #fff,0 0 3px #fff">${o.name}</b></div>`;
      markers.current.push(new maplibregl.Marker({ element: el, anchor: "left", offset: [-13, 0] }).setLngLat([o.lon, o.lat]).addTo(map));
    }
    for (const r of ordered) {
      const on = r.id === selected;
      const el = document.createElement("button");
      el.setAttribute("aria-label", r.climb.name);
      el.style.cssText = `width:${on ? 30 : 24}px;height:${on ? 30 : 24}px;border-radius:50%;border:2.5px solid #fff;background:${on ? theme.sel : theme.route};display:flex;align-items:center;justify-content:center;box-shadow:0 1px 4px rgba(0,0,0,.3);cursor:pointer;padding:0`;
      el.innerHTML = NAV_SVG;
      el.addEventListener("click", (e) => { e.stopPropagation(); onSelectRef.current?.(r.id); });
      markers.current.push(new maplibregl.Marker({ element: el }).setLngLat(along(r.climb, r.dir).coords[r.i]).addTo(map));
    }
  }, [ready, run, selected, q.origin, q.maxApproach, theme]);

  // a new search reframes the map on its results
  useEffect(() => { if (ready) fitResults(mapRef.current, true); }, [ready, run]);

  const map = mapRef.current;
  const nice = scale ? ([200, 500, 1000, 2000, 5000, 10000, 20000, 50000].find((m) => m / scale > 70) || 50000) : null;
  const btn = (Icon, label, act) => (
    <button key={label} onClick={act} aria-label={label} title={label} className="dl-text flex h-11 w-11 items-center justify-center border-t dl-line first:border-t-0">
      <Icon size={18} />
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
          <div className="dl-float absolute bottom-0 right-[56px] w-56 rounded-2xl p-2 text-[15px]">
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
          </div>
        )}
        <div className="dl-float flex flex-col overflow-hidden rounded-2xl">
          {btn(Layers, "Map layers", () => setPicker(!picker))}
          {btn(Plus, "Zoom in", () => { userMoved.current = true; map?.zoomIn(); })}
          {btn(Minus, "Zoom out", () => { userMoved.current = true; map?.zoomOut(); })}
          {btn(LocateFixed, "Back to the results", () => { map && fitResults(map, true); onMoved?.(null); })}
          {btn(Maximize2, "Whole region", () => { userMoved.current = true; map?.fitBounds([[6.85, 47.7], [8.1, 49.1]], { padding: { top: pad.top, bottom: pad.bottom, left: 20, right: 60 } }); })}
        </div>
      </div>
    </div>
  );
}

/* the small map on the segment page: the stretch coloured by grade, its station */
export function DetailMapGL({ r, db, layers, theme, gradeColor, height = 300 }) {
  const box = useRef(null);
  useEffect(() => {
    const { coords, z } = along(r.climb, r.dir);
    const map = new maplibregl.Map({ container: box.current, style: baseStyle(layers), center: coords[r.i], zoom: 13, interactive: true,
      attributionControl: false, dragRotate: false, pitchWithRotate: false, touchPitch: false });
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
      map.addSource("approach", { type: "geojson", data: fc(s ? [line([[s.lon, s.lat], seg[0]])] : []) });
      map.addLayer({ id: "whole", type: "line", source: "whole", paint: { "line-color": "#55524A", "line-opacity": 0.55, "line-width": 3 } });
      map.addLayer({ id: "approach", type: "line", source: "approach", layout: { "line-cap": "round" }, paint: { "line-color": theme.sel, "line-width": 2.2, "line-dasharray": [0.2, 2.2] } });
      map.addLayer({ id: "seg-casing", type: "line", source: "seg", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#FFFFFF", "line-width": 11 } });
      map.addLayer({ id: "seg", type: "line", source: "seg", layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-width": 7, "line-gradient": steps.length > 1 ? ["step", ["line-progress"], ...steps] : steps[0] } });
      const pin = (lngLat, bg, svg) => {
        const el = document.createElement("div");
        el.style.cssText = `width:24px;height:24px;border-radius:50%;border:2.5px solid #fff;background:${bg};display:flex;align-items:center;justify-content:center;box-shadow:0 1px 4px rgba(0,0,0,.3)`;
        el.innerHTML = svg;
        new maplibregl.Marker({ element: el }).setLngLat(lngLat).addTo(map);
      };
      pin(seg[0], theme.sel, `<svg viewBox="0 0 24 24" width="11" height="11"><path d="M7 4l12 8-12 8z" fill="#fff"/></svg>`);
      pin(seg[seg.length - 1], "#1B1A16", `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="#fff" stroke-width="2.6"><path d="M5 21V4h11l-2 4 2 4H5"/></svg>`);
      if (s) pin([s.lon, s.lat], theme.accentBg, TRAIN_SVG.replace('stroke="currentColor"', `stroke="${theme.accentText}"`));
      const b = new maplibregl.LngLatBounds();
      seg.forEach((c) => b.extend(c));
      if (s) b.extend([s.lon, s.lat]);
      map.fitBounds(b, { padding: { top: 80, bottom: 50, left: 40, right: 40 }, maxZoom: 15.5, duration: 0 });
    };
    map.on("style.load", init);
    map.on("load", init);
    return () => map.remove();
  }, [r.id, r.i, r.j, r.dir]);
  return (
    <div className="absolute inset-0">
      <div ref={box} style={{ position: "absolute", top: 0, left: 0, right: 0, height, background: "#EBEDDA" }} />
      <div className="pointer-events-none absolute bottom-8 left-3 text-[10px]" style={{ color: "#1B1A16", textShadow: "0 0 3px #fff,0 0 3px #fff" }}>{credits(layers)}</div>
    </div>
  );
}

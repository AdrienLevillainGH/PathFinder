import React, { useEffect, useMemo, useRef, useState } from "react";
import { Plus, Minus, LocateFixed, Maximize2 } from "lucide-react";
import { projection, bboxOf, path, RHINE, along } from "./geo.js";
import { fmtKm } from "./engine.js";

/* The explore map, drawn by hand in SVG (the Claude artifact blocks map
   tiles; the real app puts MapLibre over Plan IGN / OSM here).
   Layout after Komoot: the map is the page, controls float on it, the
   matches are routes with a start pin, the selected one is the dark
   dashed line. Pan with a finger or the mouse; pinch or wheel to zoom. */

const NAV = "M3 11 22 2 13 21 11 13 3 11Z"; // navigation arrow, 24-unit box

export default function MapView({ db, run, q, selected, onSelect, pad = { top: 16, right: 16, bottom: 16, left: 16 }, onMoved }) {
  const P = useMemo(() => {
    const pts = db.stations.map((s) => [s.lon, s.lat]).concat(db.climbs.flatMap((c) => [c.coords[0], c.coords[c.coords.length - 1]]));
    return projection(bboxOf(pts, 0.03));
  }, [db]);

  const boxRef = useRef(null);
  const [size, setSize] = useState(null);
  const [view, setView] = useState(null);           // { cx, cy, u }, u = SVG units per CSS pixel
  const pointers = useRef(new Map());
  const dragged = useRef(false);
  const touched = useRef(false);

  const fitBox = ([x0, y0, x1, y1], W, H) => {
    const u = Math.max(Math.max((x1 - x0) / Math.max(80, W - pad.left - pad.right), (y1 - y0) / Math.max(80, H - pad.top - pad.bottom)) * 1.08, 0.02);
    return { cx: (x0 + x1) / 2 + ((pad.right - pad.left) / 2) * u, cy: (y0 + y1) / 2 + ((pad.bottom - pad.top) / 2) * u, u };
  };
  const wholeView = (W, H) => fitBox([0, 0, P.w, P.h], W, H);
  const resultsView = (W, H) => {
    const pts = [];
    const o = db.byId[q.origin];
    if (o) pts.push([P.x(o.lon), P.y(o.lat)]);
    for (const r of run.results) {
      const { coords } = along(r.climb, r.dir);
      for (const k of [r.i, r.j]) pts.push([P.x(coords[k][0]), P.y(coords[k][1])]);
      const s = db.byId[r.station];
      if (s) pts.push([P.x(s.lon), P.y(s.lat)]);
    }
    if (pts.length < 3) return wholeView(W, H);
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    return fitBox([Math.min(...xs) - 3, Math.min(...ys) - 3, Math.max(...xs) + 3, Math.max(...ys) + 3], W, H);
  };

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const W = el.clientWidth || 360, H = el.clientHeight || 500;
      setSize({ W, H });
      setView((v) => v || resultsView(W, H));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [P]);

  // a new search reframes the map on its results
  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) { firstRun.current = false; return; }
    touched.current = false;
    if (size) setView(resultsView(size.W, size.H));
  }, [run]);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const onWheel = (e) => {
      e.preventDefault();
      if (!view) return;
      const rect = el.getBoundingClientRect();
      zoomAt(Math.exp(e.deltaY * 0.0015), e.clientX - rect.left, e.clientY - rect.top);
      moved();
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  });

  // once the user has moved the map, report where its visible part is centred
  useEffect(() => {
    if (!touched.current || !view || !size) return;
    const t = setTimeout(() => {
      const mx = pad.left + (size.W - pad.left - pad.right) / 2, my = pad.top + (size.H - pad.top - pad.bottom) / 2;
      const x = view.cx - (size.W / 2) * view.u + mx * view.u, y = view.cy - (size.H / 2) * view.u + my * view.u;
      onMoved?.({ lon: P.lon(x), lat: P.lat(y) });
    }, 250);
    return () => clearTimeout(t);
  }, [view]);

  const ready = view && size;
  const W = size?.W || 360, H = size?.H || 500;
  const { cx, cy, u } = view || { cx: 0, cy: 0, u: 1 };
  const fitU = wholeView(W, H).u;

  function zoomAt(f, mx, my) {
    setView((v) => {
      const nu = Math.min(fitU * 1.5, Math.max(fitU / 80, v.u * f));
      const ux = v.cx - (W / 2) * v.u + mx * v.u, uy = v.cy - (H / 2) * v.u + my * v.u;
      return { u: nu, cx: ux - (mx - W / 2) * nu, cy: uy - (my - H / 2) * nu };
    });
  }
  function moved() {
    touched.current = true;
  }

  const onPointerDown = (e) => {
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    dragged.current = false;
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e) => {
    const ps = pointers.current;
    if (!ps.has(e.pointerId)) return;
    const prev = ps.get(e.pointerId);
    if (ps.size === 1) {
      const dx = e.clientX - prev.x, dy = e.clientY - prev.y;
      if (Math.abs(dx) + Math.abs(dy) > 2) { dragged.current = true; touched.current = true; }
      setView((v) => ({ ...v, cx: v.cx - dx * v.u, cy: v.cy - dy * v.u }));
      ps.set(e.pointerId, { x: e.clientX, y: e.clientY });
    } else if (ps.size === 2) {
      const [a, b] = [...ps.entries()];
      const other = a[0] === e.pointerId ? b[1] : a[1];
      const d0 = Math.hypot(prev.x - other.x, prev.y - other.y);
      const d1 = Math.hypot(e.clientX - other.x, e.clientY - other.y);
      ps.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (d0 > 0 && d1 > 0) {
        dragged.current = true;
        touched.current = true;
        const rect = boxRef.current.getBoundingClientRect();
        zoomAt(d0 / d1, (e.clientX + other.x) / 2 - rect.left, (e.clientY + other.y) / 2 - rect.top);
      }
    }
  };
  const onPointerUp = (e) => pointers.current.delete(e.pointerId);

  const px = (n) => n * u;
  const zoomedIn = u < fitU / 3;
  const origin = db.byId[q.origin];
  const usedStations = new Set(run.results.map((r) => r.station));
  const sel = run.results.find((r) => r.id === selected);
  const ordered = sel ? [...run.results.filter((r) => r.id !== selected), sel] : run.results;

  // station labels that do not collide: origin, then stations serving matches, then the rest
  const labels = [];
  if (ready) {
    const placed = [];
    const want = db.stations
      .filter((s) => s.id === q.origin || usedStations.has(s.id) || (zoomedIn && run.reach.has(s.id)))
      .sort((a, b) => (b.id === q.origin) - (a.id === q.origin) || usedStations.has(b.id) - usedStations.has(a.id));
    for (const s of want) {
      const w = s.name.length * 6.3 * u, h = 13 * u;
      const sx = P.x(s.lon), sy = P.y(s.lat);
      for (const [x, anchor, x0] of [[sx + px(9), "start", sx + px(9)], [sx - px(9), "end", sx - px(9) - w]]) {
        const box = [x0, sy - h * 0.75, x0 + w, sy + h * 0.45];
        if (!placed.some((b) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1])) {
          placed.push(box);
          labels.push({ id: s.id, name: s.name, x, y: sy + px(4), anchor });
          break;
        }
      }
    }
  }

  // a round scale bar, about a fifth of the width
  const metresPerPx = (u / 1000) * 111200;
  const nice = [200, 500, 1000, 2000, 5000, 10000, 20000].find((m) => m / metresPerPx > W / 7) || 20000;

  return (
    <div ref={boxRef} className="absolute inset-0 select-none overflow-hidden" style={{ background: "var(--land)", touchAction: "none" }}>
      {ready && (
        <svg width={W} height={H} viewBox={[cx - (W / 2) * u, cy - (H / 2) * u, W * u, H * u].join(" ")} className="block"
          onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
          onClick={() => { if (!dragged.current) onSelect?.(null); }}
          role="img" aria-label={`Map: ${run.results.length} matching segments around ${origin?.name}`}>
          {/* how far you may run from each station you can reach */}
          <g fill="var(--abg)" opacity="0.08">
            {db.stations.filter((s) => run.reach.has(s.id) || s.id === q.origin).map((s) => (
              <circle key={s.id} cx={P.x(s.lon)} cy={P.y(s.lat)} r={P.metres(q.maxApproach)} />
            ))}
          </g>

          <path d={path(P, RHINE)} fill="none" stroke="var(--water)" strokeWidth="5" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
          <text x={P.x(7.735)} y={P.y(48.25)} fontSize={px(12)} fill="var(--water)" fontStyle="italic" className="map-label" strokeWidth={px(3)}>Rhine</text>
          <text x={P.x(6.98)} y={P.y(48.2)} fontSize={px(13)} fill="var(--faint)" fontStyle="italic" letterSpacing={px(3)}>VOSGES</text>

          {/* railways: grey line with white dashes */}
          <g fill="none" vectorEffect="non-scaling-stroke">
            {Object.entries(db.lines).map(([id, L]) => {
              const d = path(P, L.stops.map((sid) => [db.byId[sid].lon, db.byId[sid].lat]));
              return (
                <g key={id}>
                  <path d={d} stroke="var(--faint)" strokeWidth="3" vectorEffect="non-scaling-stroke" />
                  <path d={d} stroke="var(--land)" strokeWidth="1.4" strokeDasharray="5 5" vectorEffect="non-scaling-stroke" />
                </g>
              );
            })}
          </g>

          {/* every climb in the catalogue, faint */}
          <g fill="none" stroke="var(--muted)" strokeOpacity="0.28" strokeWidth="1" vectorEffect="non-scaling-stroke">
            {db.climbs.map((c) => <path key={c.id} d={path(P, c.coords)} vectorEffect="non-scaling-stroke" />)}
          </g>

          {/* near misses, dashed */}
          {run.near.map((r) => {
            const { coords } = along(r.climb, r.dir);
            return <path key={"n" + r.id} d={path(P, coords.slice(r.i, r.j + 1))} fill="none" stroke="var(--route)"
              strokeWidth="2.2" strokeDasharray="3 4" strokeOpacity="0.9" vectorEffect="non-scaling-stroke" />;
          })}

          {/* matches; the selected one drawn last, dark with white dashes */}
          {ordered.map((r) => {
            const { coords } = along(r.climb, r.dir);
            const d = path(P, coords.slice(r.i, r.j + 1));
            const on = r.id === selected;
            const pick = (e) => { e.stopPropagation(); if (!dragged.current) onSelect?.(r.id); };
            return (
              <g key={r.id} style={{ cursor: "pointer" }} onClick={pick}>
                <path d={d} fill="none" stroke="#FFFFFF" strokeWidth={on ? 10 : 7} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
                <path d={d} fill="none" stroke={on ? "var(--sel)" : "var(--route)"} strokeWidth={on ? 7 : 4.5} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
                {on && <path d={d} fill="none" stroke="#FFFFFF" strokeWidth="2" strokeDasharray="5 5" vectorEffect="non-scaling-stroke" />}
                <path d={d} fill="none" stroke="transparent" strokeWidth="20" vectorEffect="non-scaling-stroke" />
              </g>
            );
          })}

          {/* the approach to the selected stretch, straight and dashed */}
          {sel && db.byId[sel.station] && (() => {
            const s = db.byId[sel.station];
            const [lon, lat] = along(sel.climb, sel.dir).coords[sel.i];
            return <line x1={P.x(s.lon)} y1={P.y(s.lat)} x2={P.x(lon)} y2={P.y(lat)} stroke="var(--sel)" strokeWidth="1.6" strokeDasharray="2 4" strokeLinecap="round" vectorEffect="non-scaling-stroke" />;
          })()}

          {/* stations */}
          {db.stations.map((s) => {
            const reach = run.reach.has(s.id);
            return <circle key={s.id} cx={P.x(s.lon)} cy={P.y(s.lat)} r={px(reach ? 4 : 3)}
              fill={reach ? "#FFFFFF" : "var(--land)"} stroke={reach ? "var(--text)" : "var(--faint)"} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />;
          })}
          {origin && (
            <g transform={`translate(${P.x(origin.lon)} ${P.y(origin.lat)}) scale(${u})`}>
              <circle r="11" fill="var(--abg)" stroke="#FFFFFF" strokeWidth="2.5" />
              <rect x="-4.5" y="-5" width="9" height="8.5" rx="2" fill="var(--atext)" />
              <circle cx="-2.2" cy="5.5" r="1.2" fill="var(--atext)" /><circle cx="2.2" cy="5.5" r="1.2" fill="var(--atext)" />
            </g>
          )}

          {/* start pins */}
          {ordered.map((r) => {
            const [lon, lat] = along(r.climb, r.dir).coords[r.i];
            const on = r.id === selected;
            return (
              <g key={"pin" + r.id} transform={`translate(${P.x(lon)} ${P.y(lat)}) scale(${u * (on ? 1.25 : 1)})`} style={{ cursor: "pointer" }}
                onClick={(e) => { e.stopPropagation(); if (!dragged.current) onSelect?.(r.id); }}>
                <circle r="11" fill={on ? "var(--sel)" : "var(--route)"} stroke="#FFFFFF" strokeWidth="2.5" />
                <path d={NAV} transform="translate(-6.2 -6) scale(0.5)" fill="#FFFFFF" />
              </g>
            );
          })}

          <g fontSize={px(11.5)} fill="var(--text)">
            {labels.map((l) => (
              <text key={l.id} x={l.x} y={l.y} textAnchor={l.anchor} className="map-label" strokeWidth={px(3.5)}
                fontWeight={l.id === q.origin ? 700 : 500}>{l.name}</text>
            ))}
          </g>
        </svg>
      )}

      {/* scale bar, under the floating search */}
      {ready && (
        <div className="pointer-events-none absolute left-3 text-[11px] font-medium" style={{ top: pad.top + 4, color: "var(--text)" }}>
          <div className="flex justify-between" style={{ width: nice / metresPerPx }}>
            <span>0</span><span>{fmtKm(nice)}</span>
          </div>
          <div className="mt-0.5 h-1.5 rounded-full border-2" style={{ width: nice / metresPerPx, borderColor: "var(--text)", background: "linear-gradient(90deg,var(--text) 50%,#fff 50%)" }} />
        </div>
      )}

      {/* map buttons, above the sheet */}
      <div className="dl-float absolute right-3 flex flex-col overflow-hidden rounded-2xl" style={{ bottom: pad.bottom + 12 }}>
        {[
          { icon: Plus, label: "Zoom in", act: () => { zoomAt(1 / 1.6, W / 2, H / 2); moved(); } },
          { icon: Minus, label: "Zoom out", act: () => { zoomAt(1.6, W / 2, H / 2); moved(); } },
          { icon: LocateFixed, label: "Back to the results", act: () => { touched.current = false; setView(resultsView(W, H)); onMoved?.(null); } },
          { icon: Maximize2, label: "Whole region", act: () => { setView(wholeView(W, H)); moved(); } },
        ].map(({ icon: Icon, label, act }, k) => (
          <button key={label} onClick={act} aria-label={label} title={label}
            className={`dl-text flex h-11 w-11 items-center justify-center ${k ? "border-t dl-line" : ""}`}>
            <Icon size={18} />
          </button>
        ))}
      </div>
    </div>
  );
}

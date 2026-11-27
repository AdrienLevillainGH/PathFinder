import React, { Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Star, TrainFront, Footprints, Clock, CircleCheck, Share2, Copy, Check, ArrowRight, Bookmark, Maximize2, Mountain, Layers, ChevronDown, ChevronUp } from "lucide-react";
import { AreaChart, Area, XAxis, YAxis, Tooltip, ReferenceLine, ReferenceDot, ResponsiveContainer } from "recharts";
import { fmtKm, fmtPct, fmtMin, fmtClock, fmtPace, difficulty, WAYS, SURFACES } from "./engine.js";
import { gradeColor, GRADE_COLORS, GRADE_LABELS } from "./theme.js";
import { projection, bboxOf, path, along, gpx } from "./geo.js";
import { useWalk, approachLine } from "./walk.js";
import { BASES, OVERLAYS } from "./basemap.js";
const DetailMapGL = lazy(() => import("./MapLibreView.jsx").then((m) => ({ default: m.DetailMapGL })));

/* The segment page, after Komoot's route page: map on top, the card
   slides over it, tabs jump to sections, actions stay at the bottom. */

const TABS = [["access", "Getting there"], ["elevation", "Elevation"], ["ways", "Way types"], ["surfaces", "Surfaces"]];
const PANEL = 236;          // height of the profile panel under the full-screen map

export default function Segment({ r, db, q, pace, theme, basemap, layers, setLayers, fav, doneDates, onFav, onDone, onClose, onView }) {
  const [gpxOpen, setGpxOpen] = useState(false);
  // the map can take the whole screen (tap it), and show the relief in 3D
  const [full, setFull] = useState(false);
  const [threeD, setThreeD] = useState(false);
  const [picker, setPicker] = useState(false);
  const [profileOpen, setProfileOpen] = useState(true);
  const closeFull = () => { setThreeD(false); setPicker(false); setFull(false); };
  // where the finger is on the elevation profile: a point along the climb,
  // shown on the map (profile and map are linked, both ways of the page)
  const [cursor, setCursor] = useState(null);
  const line = useMemo(() => along(c, r.dir), [c, c.rough, r.dir]);
  const cursorLL = cursor != null ? line.coords[Math.min(cursor, line.coords.length - 1)] : null;
  const [tab, setTab] = useState("access");
  const scroller = useRef(null);
  const refs = useRef({});
  const c = r.climb;
  const down = r.dir === "down";
  const d = down ? "D−" : "D+";
  const origin = db.byId[q.origin];
  const station = db.byId[r.station];
  const win = db.meta.windows.find((w) => w.id === q.window);
  const walk = useWalk(db, c.id);
  const appr = approachLine(r, walk, db);

  // the tab follows the section in view
  useEffect(() => {
    const root = scroller.current;
    if (!root) return;
    const io = new IntersectionObserver((entries) => {
      const seen = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
      if (seen[0]) setTab(seen[0].target.dataset.tab);
    }, { root, rootMargin: "-120px 0px -55% 0px" });
    Object.values(refs.current).forEach((el) => el && io.observe(el));
    return () => io.disconnect();
  }, []);
  const go = (k) => refs.current[k]?.scrollIntoView({ behavior: "smooth", block: "start" });

  const stats = [
    [down ? "Descent" : "Climb", `${Math.round(r.up)} m`],
    [down ? "Rises inside" : "Dips inside", `${Math.round(r.dn)} m`],
    ["Length", fmtKm(r.len)],
    ["Average grade", fmtPct(r.grade)],
    ["Steepest 100 m", fmtPct(r.steep)],
    ["Flattest 100 m", fmtPct(r.flat)],
    ["Highest point", `${Math.round(r.hi)} m`],
    ["Lowest point", `${Math.round(r.lo)} m`],
  ];

  return (
    <div ref={scroller} className="dl-root dl-bg dl-text fixed inset-0 z-50 overflow-y-auto" role="dialog" aria-modal="true" aria-label={c.name}>
      {/* map: a header, or the whole screen */}
      <div className={full ? "fixed inset-0 z-[55]" : "relative"} style={{ height: full ? "100%" : 300, background: "var(--land)" }}>
        {basemap
          ? <Suspense fallback={null}><DetailMapGL r={r} db={db} layers={layers} theme={theme} gradeColor={gradeColor} approach={appr}
              height={full ? (profileOpen ? `calc(100% - ${PANEL}px)` : "100%") : 300} full={full} threeD={full && threeD}
              onTap={basemap ? () => setFull(true) : null} cursor={cursorLL} /></Suspense>
          : <DetailMap r={r} db={db} approach={appr} />}
        <div className="absolute inset-x-0 top-0 flex justify-between p-4" style={{ paddingTop: "calc(env(safe-area-inset-top) + 1rem)" }}>
          {full ? (
            <>
              <Round onClick={closeFull} label="Close the map"><ArrowLeft size={22} /></Round>
              <div className="relative flex gap-2">
                {setLayers && <Round onClick={() => setPicker(!picker)} label="Map layers"><Layers size={20} /></Round>}
                <button onClick={() => setThreeD(!threeD)} aria-pressed={threeD} title="Relief in 3D"
                  className={`flex h-12 items-center gap-1.5 rounded-full px-4 text-[15px] font-semibold ${threeD ? "dl-accent" : "dl-float dl-text"}`}>
                  <Mountain size={18} /> 3D
                </button>
                {picker && (
                  <div className="dl-float dl-text absolute right-0 top-14 w-56 rounded-2xl p-2 text-[14px]">
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
                    <p className="px-2 pt-1 text-[11px] dl-faint">The same choice as on the Explore map. In 3D, two fingers up or down tilt the view.</p>
                  </div>
                )}
              </div>
            </>
          ) : (
            <>
              <Round onClick={onClose} label="Back"><ArrowLeft size={22} /></Round>
              <div className="flex gap-2">
                <Round onClick={() => setGpxOpen(true)} label="GPX"><Share2 size={20} /></Round>
                <Round onClick={() => onFav()} label={fav ? "Remove from saved" : "Save"}><Star size={20} fill={fav ? "currentColor" : "none"} /></Round>
              </div>
            </>
          )}
        </div>
        {basemap && !full && (
          <div className="absolute right-4" style={{ bottom: 36 }}>
            <Round onClick={() => setFull(true)} label="Open the map"><Maximize2 size={19} /></Round>
          </div>
        )}
        {full && profileOpen && (
          <div className="dl-bg dl-text absolute inset-x-0 bottom-0 rounded-t-3xl px-4 pt-3 shadow-[0_-4px_16px_rgba(0,0,0,0.12)]"
            style={{ height: PANEL, paddingBottom: "env(safe-area-inset-bottom)" }}>
            <div className="mx-auto max-w-2xl">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-[17px] font-semibold">Elevation profile</span>
                <button onClick={closeFull} className="rounded-full px-3 py-1.5 text-sm font-medium dl-muted">Details</button>
                <button onClick={() => setProfileOpen(false)} aria-label="Hide the profile" className="flex h-9 w-9 items-center justify-center rounded-full dl-muted"><ChevronDown size={22} /></button>
              </div>
              <ProfileLine r={r} line={line} cursor={cursor} />
              <Profile r={r} height={PANEL - 96} cursor={cursor} onScrub={setCursor} lockScroll />
            </div>
          </div>
        )}
        {full && !profileOpen && (
          <div className="absolute inset-x-0 bottom-0 px-3" style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 0.75rem)" }}>
            <button onClick={() => setProfileOpen(true)} className="dl-float dl-text mx-auto flex w-full max-w-md items-center gap-3 rounded-2xl px-4 py-3 text-left">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[15px] font-semibold">{c.name}</span>
                <span className="block text-[13px] tabular-nums dl-muted">{down ? "↘" : "↗"} {Math.round(r.up)} m · {fmtKm(r.len)} · {fmtPct(r.grade)}{r.whole ? " · whole climb" : ""}</span>
              </span>
              <span className="flex items-center gap-1 text-sm font-medium dl-muted">Profile <ChevronUp size={18} /></span>
            </button>
          </div>
        )}
      </div>

      {/* the card */}
      <div className="dl-bg relative -mt-6 rounded-t-3xl pb-32">
        <div className="mx-auto max-w-2xl px-5 pt-5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="dl-accent rounded-lg px-2 py-0.5 text-xs font-semibold">{difficulty(r.grade)}</span>
            <span className="text-xs dl-faint">{down ? "Descent" : "Climb"} towards {c.towards}{db.meta.demo ? " · demo climb, generated" : ""}</span>
          </div>
          <h2 className="mt-2 text-[26px] font-semibold leading-tight" style={{ textWrap: "balance" }}>{c.name}</h2>
          {onView && (
            <div className="dl-soft mt-2 inline-flex rounded-full p-0.5 text-sm" role="group" aria-label="Show">
              {[["segment", "Segment"], ["whole", "Whole climb"]].map(([v, l]) => {
                const on = (r.whole ? "whole" : "segment") === v;
                return (
                  <button key={v} onClick={() => !on && onView(v)} aria-pressed={on}
                    className={`rounded-full px-3.5 py-1.5 ${on ? "dl-surface font-semibold shadow-sm" : "dl-muted"}`}>{l}</button>
                );
              })}
            </div>
          )}
          {r.nomatch && <p className="mt-1 text-sm dl-muted">No stretch of this climb meets the current terrain filter, so the whole climb is shown.</p>}
          <div className="mt-2 flex flex-wrap items-center gap-x-2 text-[15px] tabular-nums dl-muted">
            {r.train && <><span>{fmtMin(r.total)} to the start</span><span>·</span></>}
            <span>{fmtKm(r.len)}</span><span>·</span>
            <span>{down ? "↘" : "↗"} {Math.round(r.up)} m</span><span>·</span>
            <span>{fmtPct(r.grade)}</span>
          </div>
        </div>

        <div className="dl-bg sticky top-0 z-10 mt-4 border-b dl-line" style={{ paddingTop: "env(safe-area-inset-top)" }}>
          <div className="no-scrollbar mx-auto flex max-w-2xl gap-6 overflow-x-auto px-5">
            {TABS.map(([k, l]) => (
              <button key={k} onClick={() => go(k)} aria-current={tab === k}
                className={`-mb-px whitespace-nowrap border-b-[3px] py-3 text-[17px] ${tab === k ? "font-medium dl-text" : "dl-faint"}`}
                style={{ borderColor: tab === k ? "var(--text)" : "transparent" }}>{l}</button>
            ))}
          </div>
        </div>

        <div className="mx-auto max-w-2xl space-y-9 px-5 pt-6">
          <Sec id="access" title="Getting there" note={win?.label} refs={refs}>
            {r.train ? (
              <div className="space-y-4">
                <Row icon={TrainFront} main={r.train[0] === 0 ? `${station.name} · you start here` : `${station.name} · ${r.train[0]} min from ${origin.name}`}
                  sub={r.train[0] === 0 ? null : `${r.train[4] ? `${r.train[4]} change` : "direct"} · ${r.train[2]} trains in the window · slower connections up to ${r.train[1]} min`} />
                <Row icon={Footprints} main={`${fmtKm(r.approach)} on foot to the start · ≈ ${fmtMin(r.approachMin)}`}
                  sub={`along paths and roads (dotted on the map), at ${fmtPace(pace)}${r.i > 0 ? ` · the last ${fmtKm(r.i * c.step)} are the lower part of this climb` : ""}${appr && !appr.real ? " · route not drawn for this stop: the dashed line is only the direction" : ""}`} />
                <Row icon={Clock} main={`≈ ${fmtMin(r.total)} from ${origin.name} to the start`}
                  sub={r.train[0] === 0 ? null : r.train[3] == null ? `no connection back from ${station.name} in the evening window` : `last connection back from ${station.name} ≈ ${fmtClock(r.train[3])}`} />
                <a href="https://www.sncf-connect.com/" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm underline dl-muted">
                  Check the real timetable on SNCF Connect <ArrowRight size={14} />
                </a>
              </div>
            ) : <p className="text-sm dl-muted">No station within 8 km of this climb.</p>}
          </Sec>

          <Sec id="elevation" title="Elevation" note={r.whole ? `whole climb · ${fmtKm((c.n - 1) * c.step)}` : `segment ${(r.i * c.step / 1000).toFixed(2)}–${(r.j * c.step / 1000).toFixed(2)} km of a ${fmtKm((c.n - 1) * c.step)} climb`} refs={refs}>
            <ProfileLine r={r} line={line} cursor={cursor} />
            <Profile r={r} cursor={cursor} onScrub={setCursor} />
            <div className="mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs dl-muted">
              {GRADE_COLORS.map((col, k) => (
                <span key={col} className="flex items-center gap-1"><span className="inline-block h-2 w-3.5 rounded-sm" style={{ background: col }} />{GRADE_LABELS[k]}</span>
              ))}
              <span className="dl-faint">% grade</span>
            </div>
            <div className="mt-5 grid grid-cols-2 gap-x-4 gap-y-4 sm:grid-cols-4">
              {stats.map(([k, v]) => (
                <div key={k}>
                  <div className="text-[15px] dl-muted">{k}</div>
                  <div className="text-[26px] font-semibold leading-tight tabular-nums">{v}</div>
                </div>
              ))}
            </div>
          </Sec>

          <Sec id="ways" title="Way types" note={r.whole ? "whole climb" : "this segment"} refs={refs}>
            <Breakdown parts={r.ways} legend={WAYS} />
            <p className="mt-3 text-sm dl-muted">{c.marked ? "On a marked route" : "Not on a marked route"} · OSM difficulty: {c.sac === "mountain_hiking" ? "mountain path" : "hiking path"}</p>
          </Sec>

          <Sec id="surfaces" title="Surfaces" note={r.whole ? "whole climb" : "this segment"} refs={refs}>
            <Breakdown parts={r.surfaces} legend={SURFACES} />
          </Sec>
        </div>
      </div>

      {/* actions */}
      <div className="dl-bg fixed inset-x-0 bottom-0 z-20" style={{ paddingBottom: "env(safe-area-inset-bottom)" }}>
        <div className="mx-auto flex max-w-2xl gap-3 px-4 py-3">
          <button onClick={() => onFav()} className="dl-accent flex min-h-[56px] flex-1 items-center justify-center gap-2 rounded-2xl text-[17px] font-semibold">
            {fav ? "Saved" : "Save"} <Bookmark size={20} fill={fav ? "currentColor" : "none"} />
          </button>
          <button onClick={() => setGpxOpen(true)} className="dl-soft flex min-h-[56px] flex-1 items-center justify-center gap-2 rounded-2xl text-[17px] font-semibold">
            GPX <Share2 size={18} />
          </button>
          <button onClick={onDone} aria-label="Mark as done" title={doneDates.length ? `Done on ${doneDates.join(", ")}` : "Mark as done"}
            className="dl-soft flex min-h-[56px] w-16 items-center justify-center rounded-2xl">
            <CircleCheck size={22} fill={doneDates.length ? "currentColor" : "none"} stroke={doneDates.length ? "var(--soft)" : "currentColor"} />
          </button>
        </div>
        {doneDates.length > 0 && <p className="-mt-1 pb-2 text-center text-xs dl-faint">Done on {doneDates.join(", ")}</p>}
      </div>

      {gpxOpen && <GpxSheet r={r} onClose={() => setGpxOpen(false)} />}
    </div>
  );
}

function Round({ onClick, label, children }) {
  return (
    <button onClick={onClick} aria-label={label} title={label} className="dl-float dl-text flex h-12 w-12 items-center justify-center rounded-full">
      {children}
    </button>
  );
}

function Sec({ id, title, note, refs, children }) {
  return (
    <section ref={(el) => (refs.current[id] = el)} data-tab={id} style={{ scrollMarginTop: 64 }}>
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-3">
        <h3 className="text-[24px] font-semibold">{title}</h3>
        {note && <span className="text-xs dl-faint">{note}</span>}
      </div>
      {children}
    </section>
  );
}

function Row({ icon: Icon, main, sub }) {
  return (
    <div className="flex gap-3">
      <Icon size={20} className="mt-0.5 shrink-0 dl-muted" />
      <div className="min-w-0">
        <div className="text-[15px]">{main}</div>
        {sub && <div className="text-xs dl-faint">{sub}</div>}
      </div>
    </div>
  );
}

/* stacked bar + legend with distances, biggest first */
function Breakdown({ parts, legend }) {
  const rows = Object.entries(parts).filter(([, m]) => m > 0).sort((a, b) => b[1] - a[1]);
  const total = rows.reduce((a, [, m]) => a + m, 0) || 1;
  const order = Object.keys(legend).filter((k) => parts[k] > 0);
  return (
    <div>
      <div className="flex h-12 gap-[3px] overflow-hidden rounded-md">
        {order.map((k) => <span key={k} title={legend[k].label} style={{ width: `${(parts[k] / total) * 100}%`, background: legend[k].color, minWidth: 4 }} />)}
      </div>
      <div className="mt-4 space-y-3">
        {rows.map(([k, m]) => (
          <div key={k} className="flex items-center gap-3">
            <span className="inline-block h-6 w-6 shrink-0 rounded-md" style={{ background: legend[k].color }} />
            <span className="flex-1 text-[17px]">{legend[k].label}</span>
            <span className="text-[15px] tabular-nums dl-muted">{m < 100 ? "< 100 m" : fmtKm(m)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---------- profile: dark area, line coloured by grade, the stretch lit ---------- */

// the line above the profile: the segment's numbers, or where the finger is
function ProfileLine({ r, line, cursor }) {
  const down = r.dir === "down";
  if (cursor == null)
    return <p className="mb-1 mt-1 text-[15px] tabular-nums dl-muted">{down ? "↘" : "↗"} {Math.round(r.up)} m · {fmtKm(r.len)} · {fmtPct(r.grade)}{r.whole ? " · whole climb" : ""}</p>;
  const { z } = line;
  const k = Math.min(cursor, z.length - 1);
  const a = Math.max(0, k - 2), b = Math.min(z.length - 1, k + 3);
  const g = ((down ? -1 : 1) * (z[b] - z[a])) / ((b - a) * r.climb.step);
  const into = k >= r.i && k <= r.j ? ` · ${fmtKm((k - r.i) * r.climb.step)} into the ${r.whole ? "climb" : "segment"}` : "";
  return (
    <p className="mb-1 mt-1 flex items-center gap-1.5 text-[15px] tabular-nums">
      <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: gradeColor(g) }} />
      <span className="truncate">{fmtKm(k * r.climb.step)} · {Math.round(z[k])} m · {fmtPct(g)} here<span className="dl-muted">{into}</span></span>
    </p>
  );
}

function Profile({ r, height = 230, cursor = null, onScrub = null, lockScroll = false }) {
  const { z } = along(r.climb, r.dir);
  const step = r.climb.step;
  const total = ((z.length - 1) * step) / 1000;
  const a = (r.i * step) / 1000, b = (r.j * step) / 1000;
  const data = useMemo(() => z.map((v, k) => {
    const lo2 = Math.max(0, k - 2), hi2 = Math.min(z.length - 1, k + 3);
    const g = ((r.dir === "down" ? -1 : 1) * (z[hi2] - z[lo2])) / ((hi2 - lo2) * step);
    return { d: (k * step) / 1000, z: v, s: k >= r.i && k <= r.j ? v : null, g };
  }), [r]);
  // the lit line's gradient spans the stretch only, so offsets are measured from its start
  const stops = useMemo(() => {
    const out = [];
    for (let k = r.i; k <= r.j; k += 2) out.push({ o: (data[k].d - a) / ((b - a) || 1), c: gradeColor(data[k].g) });
    return out;
  }, [data]);
  const lo = Math.floor((Math.min(...z) - 10) / 10) * 10, hi = Math.ceil((Math.max(...z) + 10) / 10) * 10;
  const gid = `g-${r.id}-${r.dir}-${r.i}-${r.j}`;
  // the plot sits between the height axis (50 px) and a 4 px margin
  const scrub = (e) => {
    const box = e.currentTarget.getBoundingClientRect();
    const f = (e.clientX - box.left - 50) / (box.width - 54);
    onScrub?.(Math.round(Math.max(0, Math.min(1, f)) * (z.length - 1)));
  };
  const ck = cursor != null ? Math.min(cursor, z.length - 1) : null;
  return (
    <div className="relative" style={{ height }}>
      {onScrub && (
        <div className="absolute inset-0 z-10" style={{ touchAction: lockScroll ? "none" : "pan-y", cursor: "crosshair" }}
          onPointerDown={(e) => { if (lockScroll) e.currentTarget.setPointerCapture(e.pointerId); scrub(e); }}
          onPointerMove={(e) => (e.pointerType === "mouse" || e.buttons || lockScroll) && scrub(e)} />
      )}
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 6, right: 4, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id={gid} x1="0" y1="0" x2="1" y2="0">
              {stops.map((s, k) => <stop key={k} offset={Math.min(1, Math.max(0, s.o))} stopColor={s.c} />)}
            </linearGradient>
          </defs>
          <XAxis dataKey="d" type="number" domain={[0, total]} tickCount={4} tickFormatter={(v) => (v === 0 ? "Start" : `${v.toFixed(1)} km`)}
            tick={{ fontSize: 12, fill: "var(--muted)" }} stroke="var(--line)" tickLine={false} />
          <YAxis domain={[lo, hi]} ticks={[lo, hi]} width={50} tickFormatter={(v) => `${v} m`} tick={{ fontSize: 12, fill: "var(--muted)" }} axisLine={false} tickLine={false} />
          {!onScrub && <Tooltip content={<Tip />} cursor={{ stroke: "var(--faint)", strokeWidth: 1 }} />}
          <Area dataKey="z" type="monotone" stroke="var(--faint)" strokeWidth={2} fill="var(--slate)" fillOpacity={0.28}
            baseValue={lo} isAnimationActive={false} dot={false} activeDot={false} />
          <Area dataKey="s" type="monotone" stroke={`url(#${gid})`} strokeWidth={3.5} fill="var(--slate)" fillOpacity={1}
            baseValue={lo} connectNulls={false} isAnimationActive={false} dot={false} activeDot={{ r: 4, fill: "#fff", stroke: "var(--slate)" }} />
          {a > 0 && <ReferenceLine x={a} stroke="var(--text)" strokeDasharray="3 3" />}
          {b < total && <ReferenceLine x={b} stroke="var(--text)" strokeDasharray="3 3" />}
          {ck != null && <ReferenceLine x={(ck * step) / 1000} stroke="var(--abg)" strokeWidth={2.5} />}
          {ck != null && <ReferenceDot x={(ck * step) / 1000} y={z[ck]} r={5} fill="#fff" stroke="var(--abg)" strokeWidth={2.5} />}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

function Tip({ active, payload }) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  return (
    <div className="dl-float rounded-lg px-2 py-1 text-xs tabular-nums">
      <div>{p.d.toFixed(2)} km · {Math.round(p.z)} m</div>
      <div className="flex items-center gap-1 dl-muted"><span className="inline-block h-2 w-2 rounded-full" style={{ background: gradeColor(p.g) }} />{fmtPct(p.g)} here</div>
    </div>
  );
}

/* ---------- map header ---------- */

function DetailMap({ r, db, approach }) {
  const { coords, z } = along(r.climb, r.dir);
  const s = db.byId[r.station];
  const pts = [...coords, ...(s ? [[s.lon, s.lat]] : []), ...(approach?.coords || [])];
  const P = projection(bboxOf(pts, 0.004));
  const box = useRef(null);
  const [W, setW] = useState(390);
  useEffect(() => {
    const ro = new ResizeObserver(() => setW(box.current?.clientWidth || 390));
    if (box.current) ro.observe(box.current);
    return () => ro.disconnect();
  }, []);
  const H = 300, padTop = 74, padBottom = 44;
  // the station's name is written to its right: leave room for it when the station is on the east side
  const east = s && P.x(s.lon) > P.w / 2;
  const padL = 28, padR = 28 + (east ? s.name.length * 7.8 + 24 : 0);
  const u = Math.max(P.w / (W - padL - padR), P.h / (H - padTop - padBottom));
  const vb = [P.w / 2 - (padL + (W - padL - padR) / 2) * u, P.h / 2 - ((H + padTop - padBottom) / 2) * u, W * u, H * u];
  const start = coords[r.i], end = coords[r.j];
  const segs = [];
  for (let k = r.i; k < r.j; k++) {
    const a2 = Math.max(0, k - 2), b2 = Math.min(z.length - 1, k + 3);
    const g = ((r.dir === "down" ? -1 : 1) * (z[b2] - z[a2])) / ((b2 - a2) * r.climb.step);
    segs.push([coords[k], coords[k + 1], gradeColor(g)]);
  }
  return (
    <div ref={box} className="absolute inset-0">
      <svg width="100%" height={H} viewBox={vb.join(" ")} role="img" aria-label={`Map of ${r.climb.name}`}>
        <path d={path(P, coords)} fill="none" stroke="var(--muted)" strokeOpacity="0.45" strokeWidth="2.5" vectorEffect="non-scaling-stroke" />
        {approach?.real
          ? <path d={path(P, approach.coords)} fill="none" stroke="var(--sel)" strokeWidth="2.4" strokeDasharray="0.5 4" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
          : s && <line x1={P.x(s.lon)} y1={P.y(s.lat)} x2={P.x(start[0])} y2={P.y(start[1])} stroke="var(--sel)" strokeWidth="1.5" strokeOpacity="0.6" strokeDasharray="5 6" vectorEffect="non-scaling-stroke" />}
        <path d={path(P, coords.slice(r.i, r.j + 1))} fill="none" stroke="#FFFFFF" strokeWidth="10" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        {segs.map(([p1, p2, col], k) => (
          <line key={k} x1={P.x(p1[0])} y1={P.y(p1[1])} x2={P.x(p2[0])} y2={P.y(p2[1])} stroke={col} strokeWidth="6" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        ))}
        <g transform={`translate(${P.x(start[0])} ${P.y(start[1])}) scale(${u})`}>
          <circle r="11" fill="var(--sel)" stroke="#fff" strokeWidth="2.5" />
          <path d="M-3 -5 L5 0 L-3 5 Z" fill="#fff" />
        </g>
        <g transform={`translate(${P.x(end[0])} ${P.y(end[1])}) scale(${u})`}>
          <circle r="11" fill="var(--text)" stroke="#fff" strokeWidth="2.5" />
          <path d="M-4 -5 V5 M-4 -5 H4 L2 -2.5 L4 0 H-4" stroke="#fff" strokeWidth="1.6" fill="none" />
        </g>
        {s && (
          <g transform={`translate(${P.x(s.lon)} ${P.y(s.lat)}) scale(${u})`}>
            <circle r="11" fill="var(--abg)" stroke="#fff" strokeWidth="2.5" />
            <rect x="-4.5" y="-5" width="9" height="8.5" rx="2" fill="var(--atext)" />
            <text x="16" y="5" fontSize="13" fontWeight="600" fill="var(--text)" className="map-label" strokeWidth="3.5">{s.name}</text>
          </g>
        )}
      </svg>
    </div>
  );
}

/* ---------- GPX ---------- */

function GpxSheet({ r, onClose }) {
  const [whole, setWhole] = useState(false);
  const [copied, setCopied] = useState(false);
  const text = useMemo(() => gpx(r, whole), [r, whole]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch (e) {
      setCopied(false);
    }
  };
  return (
    <div className="dl-root dl-bg dl-text fixed inset-0 z-[60] flex flex-col" role="dialog" aria-modal="true" aria-label="GPX">
      <div className="mx-auto flex w-full max-w-2xl items-center justify-between px-4 py-3" style={{ paddingTop: "calc(env(safe-area-inset-top) + 0.75rem)" }}>
        <Round onClick={onClose} label="Back"><ArrowLeft size={22} /></Round>
        <span className="text-[17px] font-semibold">GPX</span>
        <span className="w-12" />
      </div>
      <div className="mx-auto w-full max-w-2xl space-y-3 px-4">
        <div className="flex gap-2">
          {[[false, "Matched stretch"], [true, "Whole climb"]].map(([v, l]) => (
            <button key={l} onClick={() => setWhole(v)} aria-pressed={whole === v}
              className={`rounded-full px-4 py-2 text-sm font-medium ${whole === v ? "dl-accent" : "dl-surface border dl-line dl-muted"}`}>{l}</button>
          ))}
        </div>
        <button onClick={copy} className="dl-accent flex min-h-[56px] w-full items-center justify-center gap-2 rounded-2xl text-[17px] font-semibold">
          {copied ? <><Check size={18} /> Copied</> : <><Copy size={18} /> Copy GPX</>}
        </button>
        <p className="text-xs dl-faint">Downloads are blocked inside Claude, so the file is copied instead. The real app saves it, and can send the route to COROS the way DayLoad talks to COROS.</p>
      </div>
      <div className="mx-auto mt-3 w-full max-w-2xl flex-1 overflow-hidden px-4 pb-4">
        <textarea readOnly value={text} className="dl-surface h-full w-full rounded-2xl border dl-line p-3 font-mono text-xs" style={{ minHeight: 240 }} />
      </div>
    </div>
  );
}

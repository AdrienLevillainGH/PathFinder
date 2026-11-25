import React, { Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";
import { Search, Map as MapIcon, Bookmark, Workflow, Settings2, SlidersHorizontal, TrainFront, Mountain, Radius, Clock,
         ChevronUp, ChevronDown, ArrowRight, Trash2, Check, X, Plus, Minus, RotateCcw, Car, Bike, CircleCheck, ArrowLeft } from "lucide-react";
import { prepare, runQuery, focusClimb, implied, PRESETS, DEFAULT_QUERY, fmtKm, fmtPct, fmtMin, fmtPace, difficulty } from "./engine.js";
import { pickTheme, themeCss, THEMES, gradeColor } from "./theme.js";
import { along } from "./geo.js";
import { loadLocal, saveLocal, resetLocal, nowISO, uid } from "./storage.js";
import MapView from "./MapView.jsx";
// MapLibre is big: load it only where map tiles can be shown
const MapLibreView = lazy(() => import("./MapLibreView.jsx"));
import { probeBasemap, DEFAULT_LAYERS } from "./basemap.js";
import Segment from "./Segment.jsx";

/* ================================================================== */
/* PathFinder — trail-running segments by terrain and by train.       */
/* Built like DayLoad (one React app, Tailwind, dl-* themes, static   */
/* data, one personal store); laid out like Komoot (map first,        */
/* floating controls, cards at the bottom, a full route page).        */
/* ================================================================== */

const FILES = ["meta", "stations", "ttm", "climbs", "access"];

async function loadData() {
  const raw = {}, sizes = {};
  await Promise.all(FILES.map(async (f) => {
    const res = await fetch(`./data/${f}.json`);
    if (!res.ok) throw new Error(`${f}.json (${res.status})`);
    const text = await res.text();
    sizes[f] = text.length;
    raw[f] = JSON.parse(text);
  }));
  return { db: prepare(raw), sizes };
}

const TERRAIN_KEYS = ["mode", "gain", "grade", "len", "cap"];
const today = () => new Date().toISOString().slice(0, 10);
const SHEET_PEEK = 238;

function kmBetween(a, b) {
  const dy = (b.lat - a.lat) * 111.2;
  const dx = (b.lon - a.lon) * 111.2 * Math.cos(((a.lat + b.lat) / 2) * Math.PI / 180);
  return Math.hypot(dx, dy);
}

export default function PathFinder() {
  const [state, setState] = useState({ status: "loading" });
  const [store, setStore] = useState(loadLocal);
  const [q, setQ] = useState(() => ({ ...DEFAULT_QUERY, ...(store.lastQuery || {}) }));
  const [page, setPage] = useState("explore");
  const [open, setOpen] = useState(null);
  const [sheet, setSheet] = useState(null);          // "filters" | "origin" | "settings"
  const [selected, setSelected] = useState(null);
  const [basemap, setBasemap] = useState(null);     // can this page load map tiles?

  const theme = pickTheme(store.settings.theme);
  const pace = store.settings.pace || 6;

  useEffect(() => {
    loadData().then((d) => setState({ status: "ready", ...d })).catch((e) => setState({ status: "error", error: e.message }));
    probeBasemap().then(setBasemap);
  }, []);
  const layers = { ...DEFAULT_LAYERS, ...(store.settings.map || {}) };
  useEffect(() => { saveLocal({ ...store, lastQuery: q }); }, [store, q]);

  const run = useMemo(() => (state.status === "ready" ? runQuery(state.db, q, pace) : null), [state, q, pace]);
  useEffect(() => { setSelected(run?.results[0]?.id || null); }, [run]);

  const set = (patch) => setQ((prev) => {
    const next = { ...prev, ...patch };
    if (TERRAIN_KEYS.some((k) => k in patch) && !("preset" in patch)) next.preset = "custom";
    if (next.mode === "grade" && next.sort === "gain") next.sort = "long";
    if (next.mode === "gain" && next.sort === "long") next.sort = "gain";
    return next;
  });
  // switching mode carries the third number over, so nothing jumps
  const setMode = (mode) => {
    if (mode === q.mode) return;
    if (mode === "grade") set({ mode, grade: Math.max(0.03, Math.round(implied(q).grade * 100) / 100) });
    else set({ mode, gain: Math.max(25, Math.round(implied(q).gain / 10) * 10) });
  };

  // personal data, stamped like DayLoad's so the GitHub sync can take it later
  const toggleFav = (id) => setStore((s) => {
    const favourites = { ...s.favourites };
    if (favourites[id]) {
      delete favourites[id];
      return { ...s, favourites, graveyard: [...s.graveyard, { id: `fav:${id}`, deletedAt: nowISO() }] };
    }
    favourites[id] = { updatedAt: nowISO() };
    return { ...s, favourites };
  });
  const markDone = (id) => setStore((s) => ({ ...s, done: [...s.done, { id: uid(), climbId: id, date: today(), updatedAt: nowISO() }] }));
  const removeDone = (doneId) => setStore((s) => ({ ...s, done: s.done.filter((d) => d.id !== doneId),
    graveyard: [...s.graveyard, { id: `done:${doneId}`, deletedAt: nowISO() }] }));
  const savePreset = (name) => setStore((s) => ({ ...s, presets: [...s.presets, { id: uid(), name, query: q, updatedAt: nowISO() }] }));
  const deletePreset = (pid) => setStore((s) => ({ ...s, presets: s.presets.filter((p) => p.id !== pid),
    graveyard: [...s.graveyard, { id: `preset:${pid}`, deletedAt: nowISO() }] }));
  const setSetting = (k, v) => setStore((s) => ({ ...s, settings: { ...s.settings, [k]: v } }));
  const setLayers = (v) => setSetting("map", v);
  const openClimb = (id) => { const r = focusClimb(state.db, id, q, pace); if (r) setOpen(r); };

  const db = state.db;
  const pages = [
    { id: "explore", label: "Explore", icon: MapIcon },
    { id: "saved", label: "Saved", icon: Bookmark },
    { id: "how", label: "How it works", icon: Workflow },
  ];

  return (
    <div className="dl-root dl-bg dl-text fixed inset-0 flex flex-col">
      <style>{themeCss(theme)}</style>
      <div className="dl-soft shrink-0 text-xs" style={{ paddingTop: "env(safe-area-inset-top)" }}>
        <div className="mx-auto flex max-w-2xl items-center justify-between gap-3 px-4 py-1.5">
          <span><b>Preview</b> · demo data · nothing is sent to GitHub</span>
          <button onClick={() => setPage("how")} className="underline">What is real?</button>
        </div>
      </div>

      <main className="relative min-h-0 flex-1">
        {state.status === "loading" && <p className="py-16 text-center dl-faint">Loading the climbs and the timetable…</p>}
        {state.status === "error" && (
          <div className="m-4 rounded-2xl border dl-line p-4 text-sm">
            <p className="font-medium">The data files did not load.</p>
            <p className="mt-1 dl-muted">{state.error}. The page needs its data/ folder next to it.</p>
          </div>
        )}
        {state.status === "ready" && page === "explore" && (
          <Explore db={db} q={q} set={set} run={run} store={store} selected={selected} setSelected={setSelected}
            onOpen={setOpen} openSheet={setSheet} goHow={() => setPage("how")} theme={theme} basemap={basemap} layers={layers} setLayers={setLayers} />
        )}
        {state.status === "ready" && page === "saved" && (
          <div className="absolute inset-0 overflow-y-auto">
            <Saved db={db} q={q} pace={pace} store={store} onOpenClimb={openClimb} onRemoveDone={removeDone} onUnfav={toggleFav}
              onApply={(p) => { setQ({ ...DEFAULT_QUERY, ...p.query }); setPage("explore"); }} onDeletePreset={deletePreset}
              onSettings={() => setSheet("settings")} />
          </div>
        )}
        {state.status === "ready" && page === "how" && (
          <div className="absolute inset-0 overflow-y-auto"><How db={db} q={q} run={run} sizes={state.sizes} basemap={basemap} /></div>
        )}
      </main>

      <nav className="dl-bg shrink-0 border-t dl-line" style={{ paddingBottom: "env(safe-area-inset-bottom)" }}>
        <div className="mx-auto flex max-w-2xl">
          {pages.map((p) => {
            const Icon = p.icon, on = page === p.id;
            return (
              <button key={p.id} onClick={() => setPage(p.id)} aria-current={on ? "page" : undefined}
                className="flex flex-1 flex-col items-center gap-1 py-2.5" style={{ color: on ? "var(--abg)" : "var(--text)" }}>
                <Icon size={24} strokeWidth={on ? 2.2 : 1.7} />
                <span className={`text-[13px] ${on ? "font-semibold" : ""}`}>{p.label}</span>
              </button>
            );
          })}
        </div>
      </nav>

      {open && (
        <Segment r={open} db={db} q={q} pace={pace} theme={theme} basemap={basemap} layers={layers}
          fav={Boolean(store.favourites[open.id])}
          doneDates={store.done.filter((d) => d.climbId === open.id).map((d) => d.date)}
          onFav={() => toggleFav(open.id)} onDone={() => markDone(open.id)} onClose={() => setOpen(null)} />
      )}
      {sheet === "filters" && <Filters db={db} q={q} set={set} setMode={setMode} run={run} onSavePreset={savePreset} onClose={() => setSheet(null)}
        onOrigin={() => setSheet("origin")} onReset={() => setQ({ ...DEFAULT_QUERY, origin: q.origin, window: q.window })} />}
      {sheet === "origin" && <OriginPicker db={db} q={q} onPick={(id) => { set({ origin: id }); setSheet(null); }} onClose={() => setSheet(null)} />}
      {sheet === "settings" && (
        <SettingsSheet store={store} pace={pace} setSetting={setSetting} onClose={() => setSheet(null)}
          onReset={() => { setStore(resetLocal()); setQ(DEFAULT_QUERY); setSheet(null); }} />
      )}
    </div>
  );
}

/* ================================================================== */
/* Explore — the map is the page                                      */
/* ================================================================== */

function Explore({ db, q, set, run, store, selected, setSelected, onOpen, openSheet, goHow, theme, basemap, layers, setLayers }) {
  const [full, setFull] = useState(false);
  const [centre, setCentre] = useState(null);
  const origin = db.byId[q.origin];
  const preset = PRESETS.find((p) => p.id === q.preset);
  const win = db.meta.windows.find((w) => w.id === q.window);

  // "start from here": the station nearest the middle of the map, once it is moved away
  const here = useMemo(() => {
    if (!centre) return null;
    let best = null;
    for (const s of db.stations) {
      const d = kmBetween(centre, s);
      if (!best || d < best.d) best = { s, d };
    }
    return best && best.d < 15 && best.s.id !== q.origin ? best.s : null;
  }, [centre, db, q.origin]);

  return (
    <div className="absolute inset-0">
      {basemap === true && (
        <Suspense fallback={<div className="absolute inset-0" style={{ background: "var(--land)" }} />}>
          <MapLibreView db={db} run={run} q={q} theme={theme} selected={selected} onSelect={setSelected} onMoved={setCentre}
            pad={{ top: 136, right: 64, bottom: SHEET_PEEK + 8, left: 20 }} layers={layers} setLayers={setLayers} />
        </Suspense>
      )}
      {basemap === false && (
        <MapView db={db} run={run} q={q} selected={selected} onSelect={setSelected} onMoved={setCentre}
          pad={{ top: 136, right: 64, bottom: SHEET_PEEK + 8, left: 20 }} />
      )}
      {basemap === null && <div className="absolute inset-0" style={{ background: "var(--land)" }} />}

      {/* floating search and chips */}
      <div className="pointer-events-none absolute inset-x-0 top-0 mx-auto max-w-2xl px-3 pt-3">
        <div className="dl-float pointer-events-auto flex h-14 items-center rounded-full pl-5 pr-2">
          <button onClick={() => openSheet("origin")} className="flex min-w-0 flex-1 items-center gap-3 text-left">
            <Search size={22} className="shrink-0" />
            <span className="truncate text-[17px]">From {origin.name}</span>
          </button>
          <span className="mx-2 h-7 w-px" style={{ background: "var(--line)" }} />
          <button onClick={() => openSheet("filters")} className="flex items-center gap-2 rounded-full px-3 py-2 font-semibold" style={{ color: "var(--abg)" }}>
            <SlidersHorizontal size={20} /> Filters
          </button>
        </div>
        <div className="no-scrollbar pointer-events-auto mt-2.5 flex gap-2 overflow-x-auto pb-1">
          <FloatChip icon={TrainFront} onClick={() => openSheet("filters")}>≤ {q.maxTrain} min</FloatChip>
          <FloatChip icon={Radius} onClick={() => openSheet("filters")}>{fmtKm(q.maxApproach)} from the station</FloatChip>
          <FloatChip icon={Mountain} onClick={() => openSheet("filters")}>{preset ? preset.label : terrainLine(q)}</FloatChip>
          <FloatChip icon={Clock} onClick={() => openSheet("filters")}>{win.label.replace(":00", "").replace(":00", "")}</FloatChip>
        </div>
      </div>

      {here && !full && (
        <button onClick={() => { set({ origin: here.id }); setCentre(null); }}
          className="absolute left-1/2 flex -translate-x-1/2 items-center gap-2 whitespace-nowrap rounded-full px-5 py-3 text-[15px] font-semibold text-white shadow-lg"
          style={{ bottom: SHEET_PEEK + 16, background: "var(--cta)" }}>
          <RotateCcw size={18} /> Start from {here.name}
        </button>
      )}

      <ResultsSheet run={run} q={q} set={set} store={store} full={full} setFull={setFull}
        selected={selected} setSelected={setSelected} onOpen={onOpen} goHow={goHow} />
    </div>
  );
}

function FloatChip({ icon: Icon, children, onClick }) {
  return (
    <button onClick={onClick} className="dl-float flex h-11 shrink-0 items-center gap-2 rounded-2xl px-3.5 text-[15px]">
      <Icon size={18} style={{ color: "var(--abg)" }} />
      <span className="whitespace-nowrap">{children}</span>
    </button>
  );
}

function terrainLine(q) {
  const d = q.dir === "down" ? "D−" : "D+";
  return q.mode === "grade" ? `${fmtPct(q.grade)} over ${fmtKm(q.len)}` : `${q.gain} m ${d} in ${fmtKm(q.len)}`;
}

/* ---------- the sheet with the results ---------- */

function ResultsSheet({ run, q, set, store, full, setFull, selected, setSelected, onOpen, goHow }) {
  const strip = useRef(null);
  const programmatic = useRef(false);
  const drag = useRef(null);
  const word = q.dir === "down" ? "descent" : "segment";
  const n = run.results.length;

  // map → strip: bring the selected card into view
  useEffect(() => {
    if (full || !selected || !strip.current) return;
    const el = strip.current.querySelector(`[data-id="${selected}"]`);
    if (!el) return;
    programmatic.current = true;
    strip.current.scrollTo({ left: el.offsetLeft - 12, behavior: "smooth" });
    const t = setTimeout(() => (programmatic.current = false), 500);
    return () => clearTimeout(t);
  }, [selected, full]);

  // strip → map: the card that settles at the left is the selected one
  const onScroll = () => {
    if (programmatic.current) return;
    clearTimeout(onScroll.t);
    onScroll.t = setTimeout(() => {
      const box = strip.current;
      if (!box) return;
      const cards = [...box.querySelectorAll("[data-id]")];
      let best = null;
      for (const c of cards) {
        const d = Math.abs(c.offsetLeft - 12 - box.scrollLeft);
        if (!best || d < best.d) best = { d, id: c.dataset.id };
      }
      if (best && best.id !== selected) setSelected(best.id);
    }, 120);
  };

  const sorts = [["total", "Soonest"], ["grade", "Steepest"], q.mode === "grade" ? ["long", "Longest"] : ["gain", q.dir === "down" ? "Most D−" : "Most D+"]];

  return (
    <div className="dl-bg absolute inset-x-0 bottom-0 z-10 flex flex-col rounded-t-3xl shadow-[0_-4px_18px_rgba(0,0,0,0.12)]"
      style={{ height: full ? "86%" : SHEET_PEEK, transition: "height .25s ease" }}>
      <div className="mx-auto w-full max-w-2xl cursor-grab touch-none select-none px-4 pt-2"
        onPointerDown={(e) => (drag.current = e.clientY)}
        onPointerUp={(e) => {
          const dy = drag.current == null ? 0 : e.clientY - drag.current;
          drag.current = null;
          if (dy < -25) setFull(true); else if (dy > 25) setFull(false); else setFull(!full);
        }}>
        <div className="mx-auto h-1.5 w-12 rounded-full" style={{ background: "var(--line)" }} />
        <div className="mt-2 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[19px] font-semibold">{n} {word}{n === 1 ? "" : "s"}{run.near.length ? <span className="font-normal dl-muted"> · {run.near.length} near misses</span> : null}</div>
            <div className="truncate text-xs dl-faint">Shaded: ≤ {fmtKm(q.maxApproach)} from a station ≤ {q.maxTrain} min away</div>
          </div>
          {full ? <ChevronDown size={22} className="shrink-0 dl-muted" /> : <ChevronUp size={22} className="shrink-0 dl-muted" />}
        </div>
      </div>

      {!full && (
        <div ref={strip} onScroll={onScroll} className="no-scrollbar mt-2 flex gap-3 overflow-x-auto px-3 pb-3"
          style={{ scrollSnapType: "x mandatory", scrollPaddingLeft: 12 }}>
          {run.results.map((r) => (
            <div key={r.id} data-id={r.id} style={{ scrollSnapAlign: "start" }} className="shrink-0">
              <Card r={r} on={r.id === selected} fav={Boolean(store.favourites[r.id])} done={store.done.some((d) => d.climbId === r.id)}
                onClick={() => (r.id === selected ? onOpen(r) : setSelected(r.id))} width={318} />
            </div>
          ))}
          {!n && <Empty>Nothing meets every filter. Pull up for the near misses and what each one is missing.</Empty>}
        </div>
      )}

      {full && (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-2xl px-3 pb-6">
            <div className="no-scrollbar mt-2 flex gap-2 overflow-x-auto">
              {sorts.map(([k, l]) => <Chip key={k} on={q.sort === k} onClick={() => set({ sort: k })}>{l}</Chip>)}
            </div>
            <div className="mt-3 space-y-3">
              {run.results.map((r) => (
                <Card key={r.id} r={r} on={r.id === selected} fav={Boolean(store.favourites[r.id])} done={store.done.some((d) => d.climbId === r.id)}
                  onClick={() => onOpen(r)} />
              ))}
            </div>
            {run.near.length > 0 && (
              <>
                <h3 className="mt-6 text-[19px] font-semibold">Almost</h3>
                <div className="mt-2 space-y-2">
                  {run.near.map((r) => (
                    <button key={"n" + r.id} onClick={() => onOpen(r)} className="flex w-full items-center gap-3 rounded-2xl border-2 border-dashed dl-line p-3 text-left">
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">{r.climb.name}</span>
                        <span className="block text-sm dl-muted">{r.why}</span>
                      </span>
                      <span className="text-right text-xs tabular-nums dl-faint">{Math.round(r.up)} m · {fmtKm(r.len)}<br />{fmtMin(r.total)}</span>
                    </button>
                  ))}
                </div>
              </>
            )}
            <Funnel run={run} q={q} onMore={goHow} />
          </div>
        </div>
      )}
    </div>
  );
}

/* a result, as a Komoot card: picture on the left (here: the profile), facts on the right */
function Card({ r, on, fav, done, onClick, width }) {
  const d = r.dir === "down" ? "↘" : "↗";
  return (
    <button onClick={onClick} className="dl-surface flex gap-3 rounded-3xl p-2.5 text-left"
      style={{ width: width || "100%", boxShadow: on ? "0 0 0 2.5px var(--sel)" : "0 1px 6px rgba(0,0,0,0.10)" }}>
      <div className="relative h-[118px] w-[104px] shrink-0 overflow-hidden rounded-2xl" style={{ background: "var(--slate)" }}>
        <Thumb r={r} />
        <span className="dl-accent absolute left-1.5 top-1.5 rounded-lg px-1.5 py-0.5 text-[11px] font-semibold">{difficulty(r.grade)}</span>
        <span className="absolute bottom-1.5 right-2 text-[17px] font-semibold tabular-nums text-white" style={{ textShadow: "0 1px 3px rgba(0,0,0,.6)" }}>{fmtPct(r.grade)}</span>
      </div>
      <div className="min-w-0 flex-1 py-1 pr-1">
        <div className="flex items-center gap-1.5 text-[13px] tabular-nums dl-muted">
          <TrainFront size={15} style={{ color: "var(--abg)" }} />
          <span className="truncate">{r.train ? `${r.stationName} · ${r.train[0]} min` : "no station near"}</span>
          {fav && <Bookmark size={13} className="ml-auto shrink-0" fill="currentColor" />}
          {done && <CircleCheck size={13} className="shrink-0" />}
        </div>
        <div className="mt-1 text-[17px] font-semibold leading-snug" style={{ display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{r.climb.name}</div>
        <div className="mt-2 flex flex-wrap gap-x-1.5 text-[14px] tabular-nums dl-muted">
          <span>{fmtMin(r.total)} away</span><span>·</span><span>{fmtKm(r.len)}</span><span>·</span><span>{d} {Math.round(r.up)} m</span>
        </div>
      </div>
    </button>
  );
}

// the stretch's own profile, line coloured by grade
function Thumb({ r }) {
  const { z } = along(r.climb, r.dir);
  const zz = z.slice(r.i, r.j + 1);
  const lo = Math.min(...zz), hi = Math.max(...zz), n = zz.length;
  const X = (k) => 6 + (k / Math.max(1, n - 1)) * 92;
  const Y = (v) => 112 - ((v - lo) / (hi - lo || 1)) * 70;
  const area = zz.map((v, k) => `${k ? "L" : "M"}${X(k).toFixed(1)} ${Y(v).toFixed(1)}`).join("") + `L${X(n - 1)} 118L${X(0)} 118Z`;
  const segs = [];
  const sign = r.dir === "down" ? -1 : 1;
  for (let k = 0; k < n - 1; k++) {
    const a = Math.max(0, k - 2), b = Math.min(n - 1, k + 3);
    segs.push(<line key={k} x1={X(k)} y1={Y(zz[k])} x2={X(k + 1)} y2={Y(zz[k + 1])} stroke={gradeColor((sign * (zz[b] - zz[a])) / ((b - a) * r.climb.step))} strokeWidth="2.6" strokeLinecap="round" />);
  }
  return (
    <svg viewBox="0 0 104 118" className="absolute inset-0 h-full w-full" aria-hidden="true">
      <path d={area} fill="#FFFFFF" opacity="0.10" />
      {segs}
    </svg>
  );
}

function Chip({ on, onClick, children }) {
  return (
    <button onClick={onClick} aria-pressed={on}
      className={`min-h-[40px] shrink-0 whitespace-nowrap rounded-full px-4 text-[15px] ${on ? "dl-accent font-medium" : "dl-surface border dl-line"}`}>
      {children}
    </button>
  );
}

function Funnel({ run, q, onMore }) {
  const t = run.trace;
  const steps = [[t.stations, "stations"], [t.reach, `≤ ${q.maxTrain} min by train`], [t.nearStation, `climbs ≤ ${fmtKm(q.maxApproach)} away`], [t.matched, "match"]];
  return (
    <button onClick={onMore} className="mt-6 flex w-full flex-wrap items-center gap-x-1.5 gap-y-1 text-left text-xs dl-faint">
      {steps.map(([n, l], k) => (
        <React.Fragment key={l}>
          {k > 0 && <ArrowRight size={12} />}
          <span><b className="tabular-nums dl-muted">{n}</b> {l}</span>
        </React.Fragment>
      ))}
      <span className="ml-auto tabular-nums">{t.ms.toFixed(1)} ms · how it works</span>
    </button>
  );
}

function Empty({ children }) {
  return <div className="rounded-2xl border-2 border-dashed dl-line p-4 text-sm dl-muted">{children}</div>;
}

/* ================================================================== */
/* Filters — full screen, results count live at the bottom            */
/* ================================================================== */

function Filters({ db, q, set, setMode, run, onSavePreset, onClose, onOrigin, onReset }) {
  const [more, setMore] = useState(false);
  const [name, setName] = useState("");
  const origin = db.byId[q.origin];
  const D = q.dir === "down" ? "D−" : "D+";
  const imp = implied(q);
  const n = run.results.length;
  return (
    <FullSheet title="Filters" onClose={onClose} right={<button onClick={onReset} className="px-2 text-[15px] font-medium" style={{ color: "var(--abg)" }}>Reset</button>}
      footer={<button onClick={onClose} className="dl-accent min-h-[56px] w-full rounded-2xl text-[17px] font-semibold">Show {n} {q.dir === "down" ? "descent" : "segment"}{n === 1 ? "" : "s"}</button>}>

      <Group title="Start">
        <button onClick={onOrigin} className="dl-surface flex min-h-[56px] w-full items-center gap-3 rounded-2xl border dl-line px-4 text-left">
          <Search size={20} className="dl-muted" /><span className="flex-1 text-[17px]">{origin.name}</span><span className="text-sm dl-faint">change</span>
        </button>
        <div className="mt-3 grid grid-cols-3 gap-2">
          {db.meta.windows.map((w) => (
            <button key={w.id} onClick={() => set({ window: w.id })} aria-pressed={q.window === w.id}
              className={`min-h-[56px] rounded-2xl px-2 text-[15px] ${q.window === w.id ? "dl-accent font-medium" : "dl-surface border dl-line"}`}>
              {w.label.split(" ")[0]}<span className="block text-xs opacity-75">{w.label.split(" ").slice(1).join(" ")}</span>
            </button>
          ))}
        </div>
      </Group>

      <Group title="Getting there">
        <div className="no-scrollbar flex gap-2 overflow-x-auto">
          <Chip on onClick={() => {}}><span className="inline-flex items-center gap-1.5"><TrainFront size={16} /> Regional train</span></Chip>
          {[[Car, "Car"], [Bike, "Bike"]].map(([Icon, l]) => (
            <button key={l} disabled className="dl-surface flex min-h-[40px] shrink-0 items-center gap-1.5 rounded-full border dl-line px-4 text-[15px] opacity-50">
              <Icon size={16} /> {l} <span className="text-xs">· later</span>
            </button>
          ))}
        </div>
        <Slider label="Train, station to station" value={q.maxTrain} min={15} max={120} step={5} show={(v) => `≤ ${v} min`} onChange={(v) => set({ maxTrain: v })} />
        <Slider label="From the station to the start" value={q.maxApproach} min={500} max={8000} step={250} show={(v) => `≤ ${fmtKm(v)}`} onChange={(v) => set({ maxApproach: v })} />
      </Group>

      <Group title="Terrain">
        <Segmented value={q.dir} onChange={(v) => set({ dir: v })} options={[["up", "Climbs"], ["down", "Descents"]]} />
        <div className="mt-3">
          <Segmented value={q.mode} onChange={setMode} options={[["gain", `By ${D}`], ["grade", "By grade"]]} big />
        </div>

        {q.mode === "gain" ? (
          <div className="mt-4 grid grid-cols-2 gap-3">
            <Stepper label={`${D} at least`} value={q.gain} unit="m" step={25} min={25} max={1500} onChange={(v) => set({ gain: v })} />
            <Stepper label="Within at most" value={q.len / 1000} unit="km" step={0.1} min={0.2} max={4.5} decimals={1} onChange={(v) => set({ len: Math.round(v * 1000) })} />
          </div>
        ) : (
          <div className="mt-4 grid grid-cols-2 gap-3">
            <Stepper label={`Average ${q.dir === "down" ? "descent" : "grade"} at least`} value={Math.round(q.grade * 100)} unit="%" step={1} min={3} max={40} onChange={(v) => set({ grade: v / 100 })} />
            <Stepper label="Held over at least" value={q.len / 1000} unit="km" step={0.1} min={0.1} max={4.5} decimals={1} onChange={(v) => set({ len: Math.round(v * 1000) })} />
          </div>
        )}
        <div className="dl-soft mt-3 rounded-2xl p-4">
          <div className="text-[13px] opacity-80">which means</div>
          <div className="text-[26px] font-semibold leading-tight tabular-nums">
            {q.mode === "gain" ? `≥ ${fmtPct(imp.grade)} on average` : `≥ ${Math.round(imp.gain)} m ${D}`}
          </div>
          <p className="mt-1 text-sm opacity-90">
            {q.mode === "gain"
              ? `Any stretch up to ${fmtKm(q.len)} with ${q.gain} m of ${D} counts — shorter means steeper. Each result shows the most ${D} you can get in that distance.`
              : `The grade has to hold for at least ${fmtKm(q.len)}. Each result shows how far it really holds, and its flattest 100 m.`}
          </p>
        </div>

        <div className="no-scrollbar mt-4 flex gap-2 overflow-x-auto pb-1">
          {PRESETS.map((p) => <Chip key={p.id} on={q.preset === p.id} onClick={() => set({ preset: p.id, ...p.terrain })}>{p.label}</Chip>)}
        </div>

        <button onClick={() => setMore(!more)} className="mt-4 flex items-center gap-1 text-[15px] font-medium" style={{ color: "var(--abg)" }}>
          {more ? <ChevronUp size={18} /> : <ChevronDown size={18} />} More terrain settings
        </button>
        {more && (
          <div className="mt-3 space-y-2">
            <Stepper label={`${q.dir === "down" ? "Rises" : "Dips"} inside, at most`} value={Math.round(q.cap * 100)} unit={`% of ${D}`} step={5} min={0} max={100} onChange={(v) => set({ cap: v / 100 })} />
            <p className="text-xs dl-faint">{D} counts every metre {q.dir === "down" ? "lost" : "gained"}, as on the watch. At 10 %, a stretch with 300 m {D} may {q.dir === "down" ? "rise" : "dip"} 30 m at most. 0 % means pure {q.dir === "down" ? "descent" : "climb"}; 100 % allows rolling terrain.</p>
            <Toggle label="Forest tracks" sub="wide gravel tracks count as trail" on={q.tracks} onChange={(v) => set({ tracks: v })} />
            <Toggle label="Leave out tarmac" sub="no paved sections in the stretch" on={q.noPaved} onChange={(v) => set({ noPaved: v })} />
          </div>
        )}
      </Group>

      <Group title="Save these filters">
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (name.trim()) { onSavePreset(name.trim()); setName(""); } }}>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Saturday hill reps" aria-label="Name"
            className="dl-field min-h-[52px] min-w-0 flex-1 rounded-2xl border dl-line px-4 text-base" />
          <button type="submit" disabled={!name.trim()} className="dl-soft rounded-2xl px-5 font-semibold disabled:opacity-50">Save</button>
        </form>
      </Group>
    </FullSheet>
  );
}

function FullSheet({ title, onClose, right, footer, children }) {
  return (
    <div className="dl-root dl-bg dl-text fixed inset-0 z-50 flex flex-col" role="dialog" aria-modal="true" aria-label={title}>
      <div className="mx-auto flex w-full max-w-2xl items-center justify-between px-4 py-2" style={{ paddingTop: "calc(env(safe-area-inset-top) + 0.5rem)" }}>
        <button onClick={onClose} aria-label="Close" className="dl-float flex h-12 w-12 items-center justify-center rounded-full"><X size={22} /></button>
        <span className="text-[19px] font-semibold">{title}</span>
        <span className="flex min-w-[48px] justify-end">{right}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl px-4 pb-8">{children}</div>
      </div>
      {footer && (
        <div className="dl-bg border-t dl-line" style={{ paddingBottom: "env(safe-area-inset-bottom)" }}>
          <div className="mx-auto max-w-2xl px-4 py-3">{footer}</div>
        </div>
      )}
    </div>
  );
}

function Group({ title, children }) {
  return (
    <section className="mt-6">
      <h3 className="mb-3 text-[21px] font-semibold">{title}</h3>
      {children}
    </section>
  );
}

function Segmented({ value, onChange, options, big }) {
  return (
    <div className="dl-soft grid gap-1 rounded-2xl p-1" style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0,1fr))` }}>
      {options.map(([k, l]) => (
        <button key={k} onClick={() => onChange(k)} aria-pressed={value === k}
          className={`rounded-xl ${big ? "min-h-[48px] text-[17px]" : "min-h-[44px] text-[15px]"} ${value === k ? "dl-surface font-semibold shadow-sm" : ""}`}
          style={{ color: value === k ? "var(--text)" : "var(--softtext)" }}>{l}</button>
      ))}
    </div>
  );
}

function Stepper({ label, value, unit, step, min, max, decimals = 0, onChange }) {
  const [text, setText] = useState(value.toFixed(decimals));
  useEffect(() => setText(value.toFixed(decimals)), [value, decimals]);
  const clamp = (v) => Math.min(max, Math.max(min, Math.round(v / step) * step));
  return (
    <div className="dl-surface rounded-2xl border dl-line p-3">
      <div className="text-[13px] dl-muted">{label}</div>
      <div className="mt-1 flex items-center gap-1">
        <button onClick={() => onChange(clamp(value - step))} aria-label={`less ${label}`} className="dl-soft flex h-10 w-10 shrink-0 items-center justify-center rounded-full"><Minus size={18} /></button>
        <input inputMode="decimal" value={text} aria-label={label}
          className="w-full min-w-0 bg-transparent text-center text-[24px] font-semibold tabular-nums focus:outline-none"
          onChange={(e) => {
            setText(e.target.value);
            const v = parseFloat(e.target.value.replace(",", "."));
            if (!Number.isNaN(v) && v >= min && v <= max) onChange(v);
          }}
          onBlur={() => setText(value.toFixed(decimals))} />
        <button onClick={() => onChange(clamp(value + step))} aria-label={`more ${label}`} className="dl-soft flex h-10 w-10 shrink-0 items-center justify-center rounded-full"><Plus size={18} /></button>
      </div>
      <div className="text-center text-xs dl-faint">{unit}</div>
    </div>
  );
}

function Slider({ label, value, min, max, step, show, onChange }) {
  return (
    <label className="mt-4 block">
      <span className="flex items-baseline justify-between text-[15px]">
        <span className="dl-muted">{label}</span>
        <span className="font-semibold tabular-nums">{show(value)}</span>
      </span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} className="mt-1 h-9 w-full" />
    </label>
  );
}

function Toggle({ label, sub, on, onChange }) {
  return (
    <button onClick={() => onChange(!on)} role="switch" aria-checked={on} className="flex min-h-[52px] w-full items-center justify-between gap-3 text-left">
      <span><span className="block text-[15px]">{label}</span><span className="block text-xs dl-faint">{sub}</span></span>
      <span className="relative h-7 w-12 shrink-0 rounded-full transition" style={{ background: on ? "var(--abg)" : "var(--line)" }}>
        <span className="absolute top-0.5 h-6 w-6 rounded-full bg-white shadow transition-all" style={{ left: on ? 22 : 2 }} />
      </span>
    </button>
  );
}

/* ---------- origin ---------- */

function OriginPicker({ db, q, onPick, onClose }) {
  const [text, setText] = useState("");
  const norm = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const list = db.stations.filter((s) => norm(s.name).includes(norm(text)))
    .sort((a, b) => (a.id === "stg" ? -1 : b.id === "stg" ? 1 : a.name.localeCompare(b.name, "fr")));
  return (
    <FullSheet title="Start from" onClose={onClose}>
      <div className="dl-float mt-2 flex h-14 items-center gap-3 rounded-full px-5">
        <Search size={20} />
        <input autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder="Station" aria-label="Station"
          className="min-w-0 flex-1 bg-transparent text-[17px] focus:outline-none" />
      </div>
      <p className="mt-3 text-xs dl-faint">In the real app, “near me” uses your phone's location; it is blocked inside Claude. On the map, move to an area and tap “Start from …”.</p>
      <div className="mt-2 divide-y" style={{ borderColor: "var(--line)" }}>
        {list.map((s) => (
          <button key={s.id} onClick={() => onPick(s.id)} className="flex min-h-[52px] w-full items-center gap-3 border-b dl-line text-left">
            <TrainFront size={18} className="dl-muted" />
            <span className="flex-1 text-[17px]">{s.name}</span>
            {s.id === q.origin && <Check size={20} style={{ color: "var(--abg)" }} />}
          </button>
        ))}
      </div>
    </FullSheet>
  );
}

/* ================================================================== */
/* Saved                                                              */
/* ================================================================== */

function Saved({ db, q, pace, store, onOpenClimb, onRemoveDone, onUnfav, onApply, onDeletePreset, onSettings }) {
  const favs = Object.keys(store.favourites).map((id) => db.climbById[id]).filter(Boolean);
  const done = [...store.done].sort((a, b) => b.date.localeCompare(a.date));
  return (
    <div className="mx-auto max-w-2xl px-4 pb-10">
      <div className="flex items-center justify-between pt-4">
        <h1 className="text-[28px] font-semibold">Saved</h1>
        <button onClick={onSettings} aria-label="Settings" className="dl-float flex h-12 w-12 items-center justify-center rounded-full"><Settings2 size={20} /></button>
      </div>

      <Group title={`Segments · ${favs.length}`}>
        {favs.length ? (
          <div className="space-y-3">
            {favs.map((c) => (
              <ListRow key={c.id} title={c.name} sub={`whole climb ${c.dplus} m D+ · ${fmtKm(c.len)}`} onOpen={() => onOpenClimb(c.id)} onDelete={() => onUnfav(c.id)} />
            ))}
          </div>
        ) : <Empty>Tap Save on a segment to keep it here.</Empty>}
      </Group>

      <Group title={`Done · ${done.length}`}>
        {done.length ? (
          <div className="space-y-3">
            {done.map((d) => {
              const c = db.climbById[d.climbId];
              return c ? <ListRow key={d.id} title={c.name} sub={d.date} onOpen={() => onOpenClimb(c.id)} onDelete={() => onRemoveDone(d.id)} /> : null;
            })}
          </div>
        ) : <Empty>The ✓ on a segment logs the date here. Later: a link to the DayLoad session.</Empty>}
      </Group>

      <Group title={`Filters · ${store.presets.length}`}>
        {store.presets.length ? (
          <div className="space-y-3">
            {store.presets.map((p) => (
              <ListRow key={p.id} title={p.name} sub={`${db.byId[p.query.origin]?.name} · ≤ ${p.query.maxTrain} min · ${terrainLine(p.query)}`}
                onOpen={() => onApply(p)} onDelete={() => onDeletePreset(p.id)} />
            ))}
          </div>
        ) : <Empty>Filters → “Save these filters” keeps the whole search, start station included.</Empty>}
      </Group>

      <p className="mt-8 text-xs dl-faint">In this preview these stay in this browser. In the real app they live in a private <code>pathfinder-data</code> repo and sync between your devices with DayLoad's sync code.</p>
    </div>
  );
}

function ListRow({ title, sub, onOpen, onDelete }) {
  return (
    <div className="dl-surface flex items-center gap-2 rounded-2xl p-3 shadow-sm">
      <button onClick={onOpen} className="min-w-0 flex-1 text-left">
        <span className="block truncate text-[17px] font-medium">{title}</span>
        <span className="block text-sm tabular-nums dl-muted">{sub}</span>
      </button>
      <button onClick={onDelete} aria-label="Remove" className="flex h-11 w-11 items-center justify-center dl-faint"><Trash2 size={18} /></button>
    </div>
  );
}

/* ================================================================== */
/* How it works                                                       */
/* ================================================================== */

function How({ db, q, run, sizes, basemap }) {
  const origin = db.byId[q.origin];
  const win = db.meta.windows.find((w) => w.id === q.window);
  const t = run.trace;
  const D = q.dir === "down" ? "D−" : "D+";
  const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
  const stages = [
    { title: "Prepare", sub: "R pipeline, on your PC", items: [
      "OSM paths and forest tracks → a trail network, way types and surfaces",
      "IGN RGE ALTI 5 m → elevation every 20 m, smoothed",
      `a climb catalogue (${db.climbs.length} climbs here)`,
      `SNCF GTFS → r5r: ${db.stations.length} × ${db.stations.length} stations, ${db.meta.windows.length} departure windows`,
      "in this preview: a generator with the same output",
    ] },
    { title: "Ship", sub: "static files, GitHub Pages", items: FILES.map((f) => `${f}.json · ${kb(sizes[f])}`) },
    { title: "Answer", sub: "this app, in the browser", items: ["access: train times, then distances", "terrain: scan every stretch of each climb", "rank, explain the near misses", "saved segments → GitHub"] },
  ];
  const imp = implied(q);
  const terrainStep = q.mode === "gain"
    ? `Inside each, try every stretch up to ${fmtKm(q.len)} on the 20 m profile and keep the one with the most ${D}; it needs ${q.gain} m (≥ ${fmtPct(imp.grade)} on average), with dips ≤ ${Math.round(q.cap * 100)} % of its ${D}.`
    : `Inside each, try every stretch of at least ${fmtKm(q.len)} on the 20 m profile and keep the longest that averages ≥ ${fmtPct(q.grade)} (≥ ${Math.round(imp.gain)} m ${D}), with dips ≤ ${Math.round(q.cap * 100)} %.`;
  const steps = [
    `Start at ${origin.name}, ${win.label}.`,
    `Read ${origin.name}'s row of the precomputed matrix: ${t.reach} of ${t.stations} stations are ≤ ${q.maxTrain} min away (on board + connections).`,
    `${t.nearStation} of ${t.climbs} climbs start ≤ ${fmtKm(q.maxApproach)} from one of them (trail distance, not straight line).`,
    `${terrainStep} ${t.matched} climbs have one.`,
    `Rank by time from ${origin.name} to the start of the stretch (train + approach at your pace), and explain the ${t.near} closest misses.`,
  ];
  const mapping = [
    ["Repos", "DayLoad + dayload-data", "PathFinder + pathfinder-data"],
    ["Build", "Vite, React 18, Tailwind, PWA", "the same + MapLibre"],
    ["Deploy", "deploy.yml → GitHub Pages", "the same workflow"],
    ["Look", "dl-* themes", "the same, Komoot-style layout"],
    ["Your data", "storage.js · github.js · merge.js", "copied as is"],
    ["Robot", "Action fetches COROS", "Action refreshes timetables"],
  ];
  return (
    <div className="mx-auto max-w-2xl px-4 pb-10">
      <h1 className="pt-5 text-[28px] font-semibold leading-tight" style={{ textWrap: "balance" }}>Heavy work once, in R. Answers in milliseconds, on the phone.</h1>
      <p className="mt-2 text-[15px] dl-muted">Nothing runs on a server. The pipeline turns maps, elevation and timetables into five small files; the app only reads them.</p>
      <div className="mt-5 grid gap-3 sm:grid-cols-3">
        {stages.map((s, k) => (
          <div key={s.title} className="dl-surface rounded-2xl p-4 shadow-sm">
            <div className="flex items-baseline justify-between gap-2"><span className="text-[17px] font-semibold">{k + 1}. {s.title}</span><span className="text-xs dl-faint">{s.sub}</span></div>
            <ul className="mt-2 space-y-1 text-sm dl-muted">{s.items.map((i) => <li key={i} className="flex gap-2"><span className="dl-faint">·</span><span>{i}</span></li>)}</ul>
          </div>
        ))}
      </div>

      <Group title={`Your current search · ${t.ms.toFixed(1)} ms`}>
        <ol className="space-y-3">
          {steps.map((s, k) => (
            <li key={k} className="flex gap-3 text-[15px]">
              <span className="dl-accent flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-sm font-semibold">{k + 1}</span>
              <span className="dl-muted">{s}</span>
            </li>
          ))}
        </ol>
      </Group>

      <Group title="Two ways to ask for terrain">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="dl-surface rounded-2xl p-4 shadow-sm"><div className="font-semibold">By D+</div><p className="mt-1 text-sm dl-muted">“300 m within 2 km”. The length is a maximum, the grade follows (15 %). Shorter stretches count: shorter is steeper.</p></div>
          <div className="dl-surface rounded-2xl p-4 shadow-sm"><div className="font-semibold">By grade</div><p className="mt-1 text-sm dl-muted">“10 % over 1 km”. The length is a minimum, the D+ follows (100 m). A short wall doesn't count; the result says how far the grade holds.</p></div>
        </div>
      </Group>

      <Group title="Built like DayLoad">
        <div className="dl-surface overflow-x-auto rounded-2xl shadow-sm">
          <table className="w-full text-sm">
            <thead><tr className="text-left text-xs dl-faint"><th className="p-3 font-normal"></th><th className="p-3 font-normal">DayLoad</th><th className="p-3 font-normal">PathFinder</th></tr></thead>
            <tbody>{mapping.map(([k, a, b]) => <tr key={k} className="border-t dl-line align-top"><td className="p-3 text-xs dl-faint">{k}</td><td className="p-3 dl-muted">{a}</td><td className="p-3">{b}</td></tr>)}</tbody>
          </table>
        </div>
      </Group>

      <Group title="What is real in this preview">
        <ul className="space-y-1 text-[15px] dl-muted">
          {db.meta.notes.map((n) => <li key={n} className="flex gap-2"><span className="dl-faint">·</span><span>{n}</span></li>)}
          <li className="flex gap-2"><span className="dl-faint">·</span><span>Way types and surfaces are generated too.</span></li>
          <li className="flex gap-2"><span className="dl-faint">·</span><span>{basemap
            ? "The background map is real: IGN Géoplateforme (Plan IGN, aerial photos, relief shading, contour lines) or OpenStreetMap, switchable on the map."
            : "No background map here: this page cannot load map tiles inside Claude. Online (GitHub Pages) the app shows IGN's Plan IGN, relief and contour lines."}</span></li>
          <li className="flex gap-2"><span className="dl-faint">·</span><span>The engine, the filters, the ranking and the screens are the real ones.</span></li>
        </ul>
        <p className="mt-2 text-xs dl-faint">Next: {db.meta.sources_planned.join(" · ")}. France only for now.</p>
      </Group>
    </div>
  );
}

/* ================================================================== */
/* Settings                                                           */
/* ================================================================== */

function SettingsSheet({ store, pace, setSetting, onClose, onReset }) {
  const options = [["trail", "Trail"], ["auto", "Auto"], ...Object.entries(THEMES).filter(([k]) => k !== "trail").map(([k, t]) => [k, t.label])];
  const current = store.settings.theme || "trail";
  return (
    <FullSheet title="Settings" onClose={onClose}>
      <Group title="Theme">
        <div className="grid grid-cols-3 gap-2">
          {options.map(([k, l]) => (
            <button key={k} onClick={() => setSetting("theme", k)} aria-pressed={current === k}
              className={`min-h-[48px] rounded-2xl text-[15px] ${current === k ? "dl-accent font-semibold" : "dl-surface border dl-line"}`}>
              <span className="mr-1.5 inline-block h-3 w-3 rounded-full align-middle" style={{ background: THEMES[k] ? THEMES[k].accentBg : "linear-gradient(90deg,#000 50%,#fff 50%)", border: "1px solid var(--line)" }} />
              {l}
            </button>
          ))}
        </div>
        <p className="mt-2 text-xs dl-faint">Trail takes its colours from Komoot; the others are DayLoad's. Auto follows the device.</p>
      </Group>
      <Group title="Approach pace">
        <Slider label="Easy pace from the station" value={pace} min={4} max={9} step={0.25} show={fmtPace} onChange={(v) => setSetting("pace", v)} />
      </Group>
      <Group title="Sync">
        <div className="space-y-2 opacity-60">
          {["GitHub account", "Repository", "Token"].map((l, k) => (
            <input key={l} disabled placeholder={l} defaultValue={k === 1 ? "pathfinder-data" : ""} className="dl-field min-h-[52px] w-full rounded-2xl border dl-line px-4 text-base" />
          ))}
        </div>
        <p className="mt-2 text-xs dl-faint">Off in the preview: the page cannot reach GitHub from inside Claude. The real app uses DayLoad's Sync screen unchanged.</p>
      </Group>
      <Group title="Preview data">
        <button onClick={onReset} className="dl-surface min-h-[52px] w-full rounded-2xl border dl-line text-[15px]">Forget saved segments, done and filters</button>
      </Group>
    </FullSheet>
  );
}

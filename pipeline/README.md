# PathFinder data pipeline (R)

Builds the five files the app reads (`meta`, `stations`, `ttm`, `climbs`, `access`)
from real data, for one region at a time:

| Step | What | Source |
|---|---|---|
| osm | paths, tracks, roads; way type, surface, marked routes, summit names | OpenStreetMap (Geofabrik extracts) |
| network | ways cut at every junction | — |
| elevation | height every 10 m along every path; ways cut at humps | IGN RGE ALTI 5 m (Géoplateforme WMS, no key) |
| climbs | the most direct ways up to every high point, + gentler alternatives | — |
| timetables | trains and coaches, clipped to the region, dates patched | SNCF GTFS (TER), Fluo Grand Est GTFS |
| access | walking distance from every stop to the bottom and top of each climb | OSM network |
| times | on board + changes from each hub, last connection back, per window | r5r (R5, Java) |

Nothing here is specific to Alsace: a region is a YAML file in `config/`.

## Why Java?

Everything is run from R. One step, the train/coach times, uses **r5r**: an R package
that drives **R5**, a routing engine written in Java (Conveyal). R does not ship with
Java, so it must be installed once — from R, with `rJavaEnv` (no installer, no admin
rights). The other steps do not use Java.

## Step by step (Windows)

**1. R and RStudio.** In the RStudio console, `R.version.string` should say 4.3 or newer
(otherwise install the latest R from cran.r-project.org).

**2. Get the code with GitHub Desktop** (desktop.github.com, sign in with your GitHub account):
*File → Clone repository → GitHub.com →* `AdrienLevillainGH/PathFinder`.
Local path: a folder **outside OneDrive** (downloads ≈ 1–2 GB), e.g. `C:\PathFinder`. *Clone*.

**3. Open the project:** double-click `PathFinder.Rproj` in that folder. RStudio opens in it.

**4. Install the packages** (console, 5–10 min; if asked to compile from source, answer *No*):

```r
install.packages(c("here", "yaml", "dplyr", "tidyr", "purrr", "stringi", "sf", "terra",
                   "igraph", "data.table", "jsonlite", "zip", "ggplot2", "r5r", "rJavaEnv"))
```

**5. Install Java 21 from R** (≈ 200 MB, once; answer *yes* when it asks to set
JAVA_HOME and write `.Rprofile` in the project):

```r
rJavaEnv::java_quick_install(version = 21)
```

Then *Session → Restart R*, and check:

```r
source("pipeline/run.R")
check_setup()        # → "setup ok: packages, OpenStreetMap reader, Java 21"
```

**6. (Optional, 1–2 min) test on a made-up world:** `source("pipeline/tests/test_pipeline.R")`
→ ends with *all pipeline checks pass*.

**7. Run the test region** (keep RStudio open and the PC awake):

```r
source("pipeline/run.R")
run_region("bruche")
```

Roughly 30–45 min the first time (an estimate). The console prints each step.
If it stops with an error, send the red text to Claude; running `run_region("bruche")`
again resumes after the last finished step.

**8. Look at the charts** in RStudio's *Files* pane → `pipeline/out/bruche/diag/`:
network, climbs, gain vs length, profiles, travel times.

**9. Hand the result over**, either way:
- in the Claude desktop app, add the `PathFinder` folder to the conversation
  (*+ → Add folder*) and tell Claude; it reads `pipeline/out/bruche/` and pushes; or
- `run_region("bruche", install = TRUE)` (copies the 5 files into `public/data`),
  then GitHub Desktop → *Commit to main* → *Push origin*. The site rebuilds in a minute.

**Later:** `run_region("alsace", install = TRUE)` for the whole region — roughly 1–2 h
the first time, peak memory ≈ 10–12 GB (r5r uses 8 GB; `transit: java_memory`).
After changing settings in a YAML, redo from the step concerned:

```r
run_region("bruche", redo_from = "climbs")      # climb settings
run_region("bruche", redo_from = "timetables")  # new timetables / windows
```

## Departure windows and seasonal lines

`transit: scenarios` in `config/alsace.yml` defines the windows: next Saturday,
next Sunday, next Wednesday, and a Saturday and Sunday in early July. Each window
is routed on its real date, so lines that only run in summer (crest shuttles, …)
appear only in the summer windows.

A timetable that does not reach a date yet (the SNCF file is published a few months
ahead) borrows the same weekday from its last six published weeks — the busiest one,
to avoid a holiday. The app lists what was borrowed (`meta.json → windows → borrowed`).
Re-run in spring with fresh timetables to replace the borrowed days.

## Settings worth knowing (`config/alsace.yml`)

- `area` — the box searched for climbs; `transit: area` — the box for stations.
- `climbs: min_gain_m` (60), `max_len_m` (8 km), `flat_tol_m` (a climb may dip 4 m
  between junctions), `smooth_m` (60 m, applied twice), `road_penalty`, `max_overlap`.
- `transit: hubs` — where you can start from (station names).
- `transit: feeds` — timetable URLs; `exclude` drops TGV/OUIGO/Lyria.
- `dem: source: folder` + `folder:` — use RGE ALTI tiles you downloaded yourself
  (`.asc`/`.tif`, Lambert-93) if the IGN web service is down.

New region: copy `bruche.yml`, change `id`, `name`, `area`, `hubs`.
Outside France, set `crs`, the OSM extracts, the GTFS feeds and `dem: source: folder`.

## Tests (no downloads)

```
Rscript pipeline/tests/test_pipeline.R
```

Builds a small made-up world (two hills, a grid of tracks, a switchback path,
a train and a coach line with a summer-only service) and runs every step on it.
The r5r step runs where `osmium` is installed (to make a .pbf of the made-up
world; skipped on Windows). The result is loaded with the app's own engine
when Node is installed.

## Files

```
run.R                entry point: run_region()
config/*.yml         one file per region (bruche extends alsace)
R/setup.R            check_setup(): packages, OSM reader, Java 21
R/utils.R            helpers (caching, hstore tags, smoothing, ids, checks)
R/config.R           region config, study area
R/download.R         Geofabrik, GTFS
R/osm.R              ways → classified network, junctions
R/elevation.R        IGN tiles, profiles along ways, cut at humps
R/climbs.R           climb graph, tops, catalogue, 20 m profiles, names
R/gtfs.R             read/clip/patch GTFS, stop places, hubs, rail lines
R/transit.R          r5r travel times per window
R/access.R           walking distances stop → climb ends
R/export.R           the 5 JSON files
R/diagnostics.R      ggplot2 charts
tests/               made-up world, pipeline test, app-engine check
make_demo_data.py    the old demo generator (kept for the preview)
```

Licences: OSM data © OpenStreetMap contributors (ODbL); RGE ALTI © IGN (Etalab 2.0);
timetables from transport.data.gouv.fr (SNCF, Fluo Grand Est; see each dataset's licence).

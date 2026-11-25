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

## Install (once, on your PC)

1. R ≥ 4.3 and RStudio.
2. **Java 21** (for r5r): install *Eclipse Temurin 21 JDK* from adoptium.net, then restart RStudio.
3. In R:

```r
install.packages(c("here", "yaml", "dplyr", "tidyr", "purrr", "stringi", "sf", "terra",
                   "igraph", "data.table", "jsonlite", "zip", "ggplot2", "r5r"))
# check Java from R (should print 21.x):
rJava::.jinit(); rJava::.jcall("java/lang/System", "S", "getProperty", "java.version")
```

4. Get the code: GitHub Desktop → *Clone* `AdrienLevillainGH/PathFinder` (or *Code → Download ZIP*).
   Open `PathFinder.Rproj`.

## Run

```r
source("pipeline/run.R")
run_region("bruche")                    # test region first
```

First run of the Bruche test: roughly 30–45 min (an estimate) and ≈ 1 GB of downloads
(OSM Alsace + Lorraine ≈ 400 MB, SNCF timetable, elevation tiles ≈ 25 × 8 MB).
Later runs reuse everything in `pipeline/data-raw/` and `pipeline/work/`.

Then **look at the charts** in `pipeline/out/bruche/diag/`:

1. `1_network.png` — paths and tracks by type
2. `2_climbs.png` — the climbs, coloured by average grade, with stations and coach stops
3. `3_gain_length.png` — every climb, gain against length
4. `4_profiles.png` — the 12 biggest climbs
5. `5_times.png` — minutes from the first hub

If they look right:

```r
run_region("bruche", install = TRUE)    # copies the 5 files into public/data (replaces the demo)
```

Commit and push with GitHub Desktop; the site rebuilds by itself. (Or tell Claude
where the files are; it can pick them up from your computer and push them.)

Whole region: `run_region("alsace", install = TRUE)` — roughly 1–2 h the first time,
peak memory ≈ 10–12 GB (r5r uses 8 GB; change `transit: java_memory` if needed).

After changing settings in a YAML, redo from the step concerned:

```r
run_region("bruche", redo_from = "climbs")   # climb settings
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

## Tests (no downloads, no Java)

```
Rscript pipeline/tests/test_pipeline.R
```

Builds a small made-up world (two hills, a grid of tracks, a switchback path,
a train and a coach line with a summer-only service), runs every step except
r5r, and loads the result with the app's own engine.

## Files

```
run.R                entry point: run_region()
config/*.yml         one file per region (bruche extends alsace)
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

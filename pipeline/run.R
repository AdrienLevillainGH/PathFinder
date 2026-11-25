# ------------------------------------------------------------------
# PathFinder data pipeline - entry point.
#
# Open PathFinder.Rproj in RStudio, then:
#
#   source("pipeline/run.R")
#   run_region("bruche")                      # test region (~ 30 x 30 km) first
#   run_region("bruche", redo_from = "climbs")  # after changing climb settings
#   run_region("alsace", install = TRUE)      # whole region, copied into the app
#
# Each step saves its result in pipeline/work/<region>/ and is skipped
# next time; `redo_from` recomputes that step and everything after it.
# Steps: osm -> network -> elevation -> climbs -> timetables -> access -> times
# ------------------------------------------------------------------

# memory for the routing engine (Java); must be set before r5r is loaded
if (is.null(getOption("java.parameters"))) options(java.parameters = "-Xmx8G")

for (f in list.files(here::here("pipeline", "R"), pattern = "\\.R$", full.names = TRUE)) source(f, encoding = "UTF-8")

STEPS <- c("osm", "network", "elevation", "climbs", "timetables", "access", "times")

run_region <- function(id, redo_from = NULL, install = FALSE, today = Sys.Date()) {
  check_setup(java = TRUE)
  cfg <- load_config(id)
  t0 <- Sys.time()
  redo <- if (is.null(redo_from)) character() else STEPS[seq(match(match.arg(redo_from, STEPS), STEPS), length(STEPS))]
  if ("times" %in% redo) unlink(list.files(cfg$paths$work, "^ttm_.*\\.rds$", full.names = TRUE))
  f <- function(n) work_file(cfg, n)
  say("== %s ==", cfg$name)

  osm <- cached(f("1_osm.rds"), osm_read(cfg), "osm" %in% redo)
  if (!is.null(osm$features) && !"place" %in% names(osm$features)) {   # cache from before 26 Nov 2026
    say("re-reading named places (village names for coach stops)")
    osm$features <- osm_read_features(cfg)
    saveRDS(osm, f("1_osm.rds"))
  }
  net <- cached(f("2_network.rds"), {
    osm_network(osm$lines, osm_classify(osm$lines, cfg)) |> osm_flag_edges(osm, cfg)
  }, "network" %in% redo)
  ele <- cached(f("3_elevation.rds"), {
    ep <- edge_profiles(net, cfg)
    sp <- split_at_bumps(net, ep$pts, cfg$climbs$split_bump_m)
    list(net = node_elevation(sp$net, sp$pts), pts = sp$pts, dem = ep$dem)
  }, "elevation" %in% redo)
  climbs <- cached(f("4_climbs.rds"), {
    G <- climb_graph(ele$net, ele$pts, cfg)
    sel <- climb_catalogue(G, cfg)
    climb_profiles(sel, G, ele$pts, ele$net, osm, cfg)
  }, "climbs" %in% redo)
  tp <- cached(f(sprintf("5_timetables_%s.rds", today)), transit_prepare(cfg, today), "timetables" %in% redo)
  tp$places <- place_towns(tp$places, osm$features)
  acc <- cached(f(sprintf("6_access_%s.rds", today)), access_table(ele$net, climbs, tp$places, cfg), "access" %in% redo)
  ttm <- transit_times(cfg, tp, unique(c(acc$place, tp$hubs$id)))

  dir <- export_app_data(cfg, climbs, acc, tp, ttm, ele$dem)
  diagnostics(cfg, ele$net, climbs, acc, tp, ttm)
  if (install) install_in_app(cfg)
  say("done in %.1f min \u2192 %s", as.numeric(difftime(Sys.time(), t0, units = "mins")), dir)
  invisible(list(cfg = cfg, net = ele$net, climbs = climbs, access = acc, timetables = tp, ttm = ttm))
}

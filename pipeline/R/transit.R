# ------------------------------------------------------------------
# Travel times by train and coach, with r5r (R5 routing engine, Java).
#
# For each departure window (Saturday, Sunday, weekday, summer...):
#   out  : hubs -> every place near a climb, every minute of the morning
#          window -> the distinct trips, their durations (on board +
#          changes, without the wait before you leave), how many
#   back : every place -> hubs over the afternoon/evening -> the last
#          departure that still gets you home
# One row per (hub, place): [p50, p75, trips, last back, changes] -
# the same row the app reads (ttm.json).
# ------------------------------------------------------------------

transit_prepare <- function(cfg, today = Sys.Date(), zips = gtfs_files(cfg)) {
  area_ll <- area_polygon(list(area = cfg$transit$area, crs = cfg$crs))$lonlat
  scen <- scenario_dates(cfg$transit$scenarios, today)
  say("windows: %s", paste(sprintf("%s %s", scen$id, scen$date), collapse = " \u00b7 "))
  feeds <- purrr::map(cfg$transit$feeds, function(f) {
    g <- gtfs_read(zips[[f$id]]) |> gtfs_clip(area_ll, f$exclude, f$id)
    p <- gtfs_patch_dates(g, scen$date, f$id)
    list(id = f$id, label = f$label, page = f$page, g = p$g, log = p$log, coverage = p$coverage)
  })
  coach <- purrr::map_chr(cfg$transit$feeds, function(f) f$coach_stops %||% "") |> stats::setNames(purrr::map_chr(cfg$transit$feeds, "id"))
  points <- purrr::map(feeds, function(f) gtfs_stop_points(f$g, f$id, coach[[f$id]])) |> dplyr::bind_rows()
  pl <- gtfs_places(points, cfg)
  hubs <- match_hubs(pl$places, cfg$transit$hubs)
  say("hubs: %s", paste(hubs$name, collapse = ", "))
  lines <- purrr::map(feeds, function(f) gtfs_rail_lines(f$g, pl$members, f$id, coach[[f$id]])) |> purrr::list_flatten()
  list(feeds = feeds, scen = scen, places = pl$places, members = pl$members, hubs = hubs, lines = lines)
}

# minutes since midnight from r5r's departure_time ("07:42:00", or a time)
clock_min <- function(x) {
  if (is.character(x)) return(as.integer(substr(x, 1, 2)) * 60L + as.integer(substr(x, 4, 5)))
  if (inherits(x, "POSIXt")) return(as.integer(format(x, "%H")) * 60L + as.integer(format(x, "%M")))
  if (inherits(x, "difftime") || inherits(x, "hms")) return(as.integer(round(as.numeric(x, units = "mins"))))
  as.integer(x)
}

norm_expanded <- function(x) {
  x <- as.data.frame(x)
  tibble::tibble(from = as.character(x$from_id), to = as.character(x$to_id),
                 dep = clock_min(x$departure_time), total = as.numeric(x$total_time),
                 routes = if ("routes" %in% names(x)) as.character(x$routes) else NA_character_) |>
    dplyr::filter(!is.na(total))
}

# every minute of the window -> distinct trips. Leaving at minute m gets
# you there at m + total; the same arrival from several minutes is one
# trip, caught by leaving at the last of those minutes: its duration is
# arrival - that minute (no waiting at the start).
# r5r also returns walk-only journeys (any length up to max_trip_duration,
# whatever max_walk_time says): they count only when no train or coach
# does it and the walk is short (<= max_walk minutes): then trips = 99.
# dplyr tries a summary once on an empty table to learn its types, and
# min()/max() warn there (e.g. coach only, where nothing may run): skip it
if_rows <- function(d, empty, f) if (nrow(d)) f(d) else empty

trip_summary <- function(e, max_walk = 20) {
  g <- e |>
    dplyr::mutate(arr = dep + total) |>
    dplyr::group_by(from, to, arr) |>
    dplyr::summarise(dep = max(dep), routes = routes[which.max(dep)], .groups = "drop") |>
    dplyr::mutate(dur = arr - dep,
                  walk = is.na(routes) | routes == "" | grepl("WALK", routes, fixed = TRUE),
                  changes = dplyr::if_else(walk, 0L, lengths(strsplit(routes, "|", fixed = TRUE)) - 1L))
  none <- tibble::tibble(from = character(), to = character(), p50 = numeric(), p75 = numeric(),
                         trips = integer(), changes = integer(), best = numeric())
  ride <- if_rows(dplyr::filter(g, !walk), none, function(d) d |>
    dplyr::group_by(from, to) |>
    dplyr::summarise(p50 = round(stats::median(dur)), p75 = round(stats::quantile(dur, 0.75, names = FALSE)),
                     trips = dplyr::n(), changes = as.integer(round(stats::median(changes))), best = min(dur), .groups = "drop"))
  on_foot <- if_rows(dplyr::filter(g, walk, dur <= max_walk) |> dplyr::anti_join(ride, by = c("from", "to")), none, function(d) d |>
    dplyr::group_by(from, to) |>
    dplyr::summarise(p50 = round(min(dur)), p75 = round(min(dur)), trips = 99L, changes = 0L, best = min(dur), .groups = "drop"))
  dplyr::bind_rows(ride, on_foot)
}

# the last minute you can leave and still get back by train or coach
# (a short walk counts as "any time": the end of the window)
last_departure <- function(e, max_walk = 20, window_end = 24L * 60L) {
  e <- dplyr::mutate(e, walk = is.na(routes) | routes == "" | grepl("WALK", routes, fixed = TRUE))
  ride <- if_rows(dplyr::filter(e, !walk), tibble::tibble(from = character(), to = character(), last = integer()), function(d) d |>
    dplyr::group_by(from, to) |>
    dplyr::summarise(last = max(dep), .groups = "drop"))
  on_foot <- e |>
    dplyr::filter(walk, total <= max_walk) |>
    dplyr::distinct(from, to) |>
    dplyr::anti_join(ride, by = c("from", "to")) |>
    dplyr::mutate(last = as.integer(window_end))
  dplyr::bind_rows(ride, on_foot)
}

# r5r says "less than 20 % of the services run on that date" for every
# call: expected with the national SNCF file, so not shown
quiet_r5r <- function(expr) {
  withCallingHandlers(expr,
    message = function(m) if (grepl("20%", conditionMessage(m), fixed = TRUE)) invokeRestart("muffleMessage"),
    warning = function(w) if (grepl("20%", conditionMessage(w), fixed = TRUE)) invokeRestart("muffleWarning"))
}

r5r_core <- function(cfg, tp, pbf = NULL) {
  if (!requireNamespace("r5r", quietly = TRUE))
    stop("r5r is not installed: install.packages('r5r'), and Java 21 (see pipeline/README.md)", call. = FALSE)
  dir <- work_file(cfg, "r5")
  dir.create(dir, showWarnings = FALSE)
  unlink(list.files(dir, pattern = "\\.(zip|pbf)$", full.names = TRUE))
  if (is.null(pbf)) pbf <- osm_files(cfg, cfg$osm$r5r_extract)
  file.copy(pbf, file.path(dir, basename(pbf)), overwrite = TRUE)
  coach <- purrr::map_chr(cfg$transit$feeds, function(f) f$coach_stops %||% "") |> stats::setNames(purrr::map_chr(cfg$transit$feeds, "id"))
  for (f in tp$feeds) gtfs_write(gtfs_split_coaches(f$g, coach[[f$id]]), file.path(dir, paste0(f$id, ".zip")))
  say("r5r: building the network (a few minutes the first time)")
  ns <- getNamespaceExports("r5r")
  if ("build_network" %in% ns) r5r::build_network(dir, verbose = FALSE, overwrite = TRUE) else r5r::setup_r5(dir, verbose = FALSE, overwrite = TRUE)
}

# What each transport choice may use. "all" = any train or coach; the
# others are routed separately (a train-only trip is not simply the
# fastest trip that happens to use a train). Tram-trains count as trains.
TRANSIT_MODES <- list(all = c("WALK", "TRANSIT"), rail = c("WALK", "RAIL", "TRAM"), coach = c("WALK", "BUS"))

# Where a search can start: the hubs named in the config (listed first in
# the app), and with `transit: starts: rail` every train station in the
# area. Kept out of the cached timetables, so changing it needs no rerun.
transit_starts <- function(cfg, tp) {
  main <- dplyr::mutate(tp$hubs, main = TRUE)
  if (!identical(cfg$transit$starts, "rail")) return(main)
  bb <- unlist(cfg$area$bbox)
  rail <- dplyr::filter(tp$places, kind == "rail", lon >= bb[1], lon <= bb[3], lat >= bb[2], lat <= bb[4]) |>
    dplyr::anti_join(tp$hubs, by = "id") |>
    dplyr::mutate(main = FALSE)
  out <- dplyr::bind_rows(main, rail)
  check_unique(out, "id", "starting stations")
  say("starting stations: %d (%d hubs + %d other train stations)", nrow(out), nrow(main), nrow(rail))
  out
}

# Which places count for a transport choice. Train only: stations (you get
# off the train there, and everything after is the walk to the climb, drawn
# and counted). Coach only: places a coach stops at. The starting stations
# always count (you can walk from where you start).
mode_places <- function(tp, cfg, m) {
  if (m == "all") return(tp$places$id)
  starts <- (tp$starts %||% tp$hubs)$id
  if (m == "rail") return(union(tp$places$id[tp$places$kind == "rail"], starts))
  feeds <- purrr::map_chr(tp$feeds, "id")
  has_rail <- purrr::map_lgl(tp$feeds, function(f) any(col_or(f$g$routes, "route_type") %in% c("0", "2", as.character(100:117)))) |> stats::setNames(feeds)
  coach_re <- purrr::map_chr(cfg$transit$feeds, function(f) f$coach_stops %||% "") |> stats::setNames(purrr::map_chr(cfg$transit$feeds, "id"))
  mb <- tp$members
  re <- coach_re[mb$feed]
  is_coach <- !has_rail[mb$feed] | (!is.na(re) & nzchar(re) & mapply(function(p, s) grepl(p, s, perl = TRUE), re, mb$stop_id))
  union(unique(mb$place[is_coach]), starts)
}

# Returns one table per window and transport choice, named "<window>" for
# "all" and "<window>@<mode>" for the others (cfg$transit$modes).
transit_times <- function(cfg, tp, places_near, pbf = NULL) {
  options(java.parameters = paste0("-Xmx", cfg$transit$java_memory %||% "8G"))
  tr <- cfg$transit
  modes <- unique(c("all", unlist(tr$modes)))
  bad <- setdiff(modes, names(TRANSIT_MODES))
  if (length(bad)) stop("transit: unknown modes ", paste(bad, collapse = ", "), " (use rail, coach)", call. = FALSE)
  hubs <- dplyr::transmute(tp$starts %||% tp$hubs, id, lat, lon)
  dest <- dplyr::filter(tp$places, id %in% places_near) |> dplyr::transmute(id, lat, lon)
  # cached per set of starting stations (just the hubs: the old file names)
  sfx <- if (setequal(hubs$id, tp$hubs$id)) "" else paste0("_", hash_id(paste(sort(hubs$id), collapse = ",")))
  core <- NULL
  out <- list()
  for (m in modes) for (k in seq_len(nrow(tp$scen))) {
    s <- tp$scen[k, ]
    key <- if (m == "all") s$id else paste0(s$id, "@", m)
    keep <- mode_places(tp, cfg, m)
    file <- if (m == "all") sprintf("ttm_%s_%s%s.rds", s$id, s$date, sfx) else sprintf("ttm_%s_%s_%s%s.rds", m, s$id, s$date, sfx)
    out[[key]] <- cached(work_file(cfg, file), {
      if (is.null(core)) core <- r5r_core(cfg, tp, pbf)
      at <- function(m) as.POSIXct(sprintf("%s %02d:%02d:00", s$date, m %/% 60, m %% 60), tz = cfg$timezone)
      say("%s %s (%s): %d starting stations \u2192 %d places", s$id, s$date, m, nrow(hubs), nrow(dest))
      # out, 20 starting stations at a time (every minute of the window: many rows)
      fw <- split(hubs, ceiling(seq_len(nrow(hubs)) / 20)) |>
        purrr::map(function(o)
          quiet_r5r(r5r::expanded_travel_time_matrix(core, origins = o, destinations = dest, mode = TRANSIT_MODES[[m]],
                                               departure_datetime = at(s$out_start), time_window = s$out_end - s$out_start,
                                               max_trip_duration = tr$max_trip_min, max_walk_time = tr$max_walk_min,
                                               walk_speed = tr$walk_speed_kmh, progress = FALSE)) |>
            norm_expanded() |> trip_summary(tr$max_walk_min)) |>
        dplyr::bind_rows()
      # back, in batches of places: smaller ones when there are many starting stations
      per <- min(200, max(25, round(20000 / nrow(hubs))))
      chunks <- split(dest, ceiling(seq_len(nrow(dest)) / per))
      bk <- purrr::map(chunks, function(ch)
        quiet_r5r(r5r::expanded_travel_time_matrix(core, origins = ch, destinations = hubs, mode = TRANSIT_MODES[[m]],
                                         departure_datetime = at(s$back_start), time_window = s$back_end - s$back_start,
                                         max_trip_duration = tr$max_trip_min, max_walk_time = tr$max_walk_min,
                                         walk_speed = tr$walk_speed_kmh, progress = FALSE)) |>
          norm_expanded() |> last_departure(tr$max_walk_min, s$back_end)) |>
        dplyr::bind_rows()
      n0 <- nrow(fw)
      res <- fw |>
        dplyr::left_join(dplyr::rename(bk, to = from, from = to), by = c("from", "to")) |>
        dplyr::rename(hub = from, place = to, last_back = last)
      check_rows(n0, nrow(res), "trips out + last back", allow_drop = FALSE)
      res
    }) |>
      dplyr::filter(place %in% keep)
  }
  if (!is.null(core)) try(r5r::stop_r5(core), silent = TRUE)
  out
}

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
  points <- purrr::map(feeds, function(f) gtfs_stop_points(f$g, f$id)) |> dplyr::bind_rows()
  pl <- gtfs_places(points, cfg)
  hubs <- match_hubs(pl$places, cfg$transit$hubs)
  say("hubs: %s", paste(hubs$name, collapse = ", "))
  lines <- purrr::map(feeds, function(f) gtfs_rail_lines(f$g, pl$members, f$id)) |> purrr::list_flatten()
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
trip_summary <- function(e) {
  e |>
    dplyr::mutate(arr = dep + total) |>
    dplyr::group_by(from, to, arr) |>
    dplyr::summarise(dep = max(dep), routes = routes[which.max(dep)], .groups = "drop") |>
    dplyr::mutate(dur = arr - dep,
                  walk = is.na(routes) | routes == "" | grepl("WALK", routes, fixed = TRUE),
                  changes = dplyr::if_else(walk, 0L, lengths(strsplit(routes, "|", fixed = TRUE)) - 1L)) |>
    dplyr::group_by(from, to) |>
    dplyr::summarise(p50 = round(stats::median(dur)), p75 = round(stats::quantile(dur, 0.75, names = FALSE)),
                     trips = dplyr::if_else(all(walk), 99L, sum(!walk)),
                     changes = as.integer(round(stats::median(changes))), best = min(dur), .groups = "drop")
}

# the last minute you can leave and still get there
last_departure <- function(e) {
  e |>
    dplyr::group_by(from, to) |>
    dplyr::summarise(last = max(dep), .groups = "drop")
}

r5r_core <- function(cfg, tp) {
  if (!requireNamespace("r5r", quietly = TRUE))
    stop("r5r is not installed: install.packages('r5r'), and Java 21 (see pipeline/README.md)", call. = FALSE)
  dir <- work_file(cfg, "r5")
  dir.create(dir, showWarnings = FALSE)
  unlink(list.files(dir, pattern = "\\.(zip|pbf)$", full.names = TRUE))
  pbf <- osm_files(cfg, cfg$osm$r5r_extract)
  file.copy(pbf, file.path(dir, basename(pbf)), overwrite = TRUE)
  for (f in tp$feeds) gtfs_write(f$g, file.path(dir, paste0(f$id, ".zip")))
  say("r5r: building the network (a few minutes the first time)")
  ns <- getNamespaceExports("r5r")
  if ("build_network" %in% ns) r5r::build_network(dir, verbose = FALSE, overwrite = TRUE) else r5r::setup_r5(dir, verbose = FALSE, overwrite = TRUE)
}

transit_times <- function(cfg, tp, places_near) {
  options(java.parameters = paste0("-Xmx", cfg$transit$java_memory %||% "8G"))
  tr <- cfg$transit
  hubs <- dplyr::transmute(tp$hubs, id, lat, lon)
  dest <- dplyr::filter(tp$places, id %in% places_near) |> dplyr::transmute(id, lat, lon)
  core <- NULL
  out <- list()
  for (k in seq_len(nrow(tp$scen))) {
    s <- tp$scen[k, ]
    out[[s$id]] <- cached(work_file(cfg, sprintf("ttm_%s_%s.rds", s$id, s$date)), {
      if (is.null(core)) core <- r5r_core(cfg, tp)
      at <- function(m) as.POSIXct(sprintf("%s %02d:%02d:00", s$date, m %/% 60, m %% 60), tz = cfg$timezone)
      say("%s %s: %d hubs \u2192 %d places", s$id, s$date, nrow(hubs), nrow(dest))
      fw <- r5r::expanded_travel_time_matrix(core, origins = hubs, destinations = dest, mode = c("WALK", "TRANSIT"),
                                             departure_datetime = at(s$out_start), time_window = s$out_end - s$out_start,
                                             max_trip_duration = tr$max_trip_min, max_walk_time = tr$max_walk_min,
                                             walk_speed = tr$walk_speed_kmh, progress = FALSE) |>
        norm_expanded() |> trip_summary()
      chunks <- split(dest, ceiling(seq_len(nrow(dest)) / 200))
      bk <- purrr::map(chunks, function(ch)
        r5r::expanded_travel_time_matrix(core, origins = ch, destinations = hubs, mode = c("WALK", "TRANSIT"),
                                         departure_datetime = at(s$back_start), time_window = s$back_end - s$back_start,
                                         max_trip_duration = tr$max_trip_min, max_walk_time = tr$max_walk_min,
                                         walk_speed = tr$walk_speed_kmh, progress = FALSE) |>
          norm_expanded() |> last_departure()) |>
        dplyr::bind_rows()
      n0 <- nrow(fw)
      res <- fw |>
        dplyr::left_join(dplyr::rename(bk, to = from, from = to), by = c("from", "to")) |>
        dplyr::rename(hub = from, place = to, last_back = last)
      check_rows(n0, nrow(res), "trips out + last back", allow_drop = FALSE)
      res
    })
  }
  if (!is.null(core)) try(r5r::stop_r5(core), silent = TRUE)
  out
}

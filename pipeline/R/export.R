# ------------------------------------------------------------------
# The five files the app reads (public/data/*.json), same shape as the
# demo generator: meta, stations, ttm, climbs, access.
# ------------------------------------------------------------------

write_json_file <- function(x, path) {
  jsonlite::write_json(x, path, auto_unbox = TRUE, digits = NA, null = "null", na = "null")
  file.size(path)
}

fmt_hm <- function(m) sprintf("%02d:%02d", m %/% 60, m %% 60)

export_app_data <- function(cfg, prof, acc, tp, ttm, dem = NULL, dir = file.path(cfg$paths$out, "data")) {
  dir.create(dir, recursive = TRUE, showWarnings = FALSE)
  step <- cfg$climbs$step_m

  # stations: hubs + every place some climb can be walked to
  used <- unique(c(tp$hubs$id, acc$place))
  st <- dplyr::filter(tp$places, id %in% used) |> dplyr::arrange(dplyr::desc(kind == "rail"), name)
  if (!is.null(dem)) st$z <- round(dem_extract(dem, st$x, st$y))
  lines <- purrr::keep(tp$lines, function(L) sum(L$stops %in% st$id) >= 2) |>
    purrr::map(function(L) list(name = L$name, stops = L$stops[L$stops %in% st$id]))
  line_of <- purrr::imap(lines, function(L, id) tibble::tibble(place = L$stops, line = id)) |> dplyr::bind_rows()
  stations <- purrr::pmap(st, function(...) {
    r <- list(...)
    list(id = r$id, name = r$name, lat = round(r$lat, 5), lon = round(r$lon, 5), z = r$z %||% NULL,
         kind = r$kind, hub = r$id %in% tp$hubs$id,
         lines = as.list(line_of$line[line_of$place == r$id]),
         serves = as.list(head(r$lines, 8)))
  })

  # windows, with their dates and what was borrowed
  logs <- purrr::map(tp$feeds, "log") |> dplyr::bind_rows()
  windows <- purrr::pmap(tp$scen, function(id, label, date, out_start, out_end, back_start, back_end) {
    borrowed <- if (nrow(logs)) dplyr::filter(logs, .data$date == !!date) else logs
    list(id = id,
         label = sprintf("%s %s \u00b7 %s\u2013%s", label, format(date, "%d %b"), fmt_hm(out_start), fmt_hm(out_end)),
         date = format(date), out = c(fmt_hm(out_start), fmt_hm(out_end)), back = c(fmt_hm(back_start), fmt_hm(back_end)),
         borrowed = if (nrow(borrowed)) purrr::pmap(borrowed, function(feed, agency, date, proxy, services)
           list(feed = feed, network = agency, from = if (is.na(proxy)) NULL else format(proxy))) else list())
  })

  # ttm: by[window][hub] = one row per station, in `order`
  order <- vapply(stations, `[[`, "", "id")
  by <- purrr::imap(ttm, function(tab, w) {
    purrr::set_names(purrr::map(tp$hubs$id, function(h) {
      t <- dplyr::filter(tab, hub == h)
      i <- match(order, t$place)
      purrr::map(seq_along(order), function(k) {
        j <- i[k]
        if (is.na(j) || order[k] == h) return(NULL)
        list(t$p50[j], t$p75[j], t$trips[j], if (is.na(t$last_back[j])) NULL else t$last_back[j], t$changes[j])
      })
    }), tp$hubs$id)
  })

  # compact: heights in dm and lon/lat in 1e-5 degrees, as differences
  # from the previous point (the app's engine unpacks them); 3 x smaller
  delta <- function(v) as.integer(c(v[1], diff(v)))
  pack <- function(x, y, z) {
    p <- to_lonlat(x, y, cfg$crs)
    list(z10 = delta(round(z * 10)), lon = delta(round(p$lon * 1e5)), lat = delta(round(p$lat * 1e5)))
  }
  climbs <- purrr::pmap(prof, function(...) {
    r <- list(...)
    c(list(id = r$id, name = r$name, towards = r$towards), pack(r$x, r$y, r$z), list(
         way = runs(r$way), surf = runs(r$surf),
         len = round((r$n - 1) * step), dplus = round(r$dplus), dminus = round(r$dminus),
         track = round(r$track, 2), paved = round(r$paved, 2),
         sac = if (is.na(r$sac)) NULL else r$sac, marked = r$marked >= 0.5))
  })

  # the 15 closest stops per climb are plenty (and keep the file small)
  access <- acc |>
    dplyr::filter(climb %in% prof$id, place %in% order) |>
    dplyr::arrange(climb, pmin(d0, d1)) |>
    dplyr::group_by(climb) |>
    dplyr::slice_head(n = 15) |>
    dplyr::ungroup() |>
    dplyr::mutate(d0 = pmin(d0, 99999), d1 = pmin(d1, 99999))
  access <- split(access, access$climb) |>
    purrr::map(function(a) purrr::pmap(a[, c("place", "d0", "d1")], function(place, d0, d1) list(place, d0, d1)))

  cover <- purrr::map(tp$feeds, function(f) list(feed = f$id, label = f$label, page = f$page,
                                                 networks = purrr::pmap(f$coverage, function(...) {
                                                   r <- list(...); list(name = r$agency_name %||% r$agency_id, from = format(r$first), to = format(r$last)) })))
  meta <- list(
    app = "PathFinder", version = paste0("0.4-", cfg$id), built = format(Sys.Date()), demo = FALSE, climb_format = "delta1",
    region = cfg$name, profile_step_m = step, access_cutoff_m = cfg$access$max_walk_m,
    notes = c("Paths and tracks: OpenStreetMap. Elevation: IGN RGE ALTI 5 m, smoothed over about 100 m.",
              "Climbs are the most direct ways up to each high point; the app finds the best stretch inside each.",
              "Times: SNCF TER and Fluo Grand Est timetables, routed with r5r; on board + changes, not the wait before you leave.",
              "Walking distances follow paths and roads, from the stop to the bottom (or top) of each climb."),
    sources = c("\u00a9 OpenStreetMap contributors (ODbL)", "IGN RGE ALTI (Etalab 2.0)", "SNCF, Fluo Grand Est GTFS (transport.data.gouv.fr)"),
    sources_planned = c("Car and bike access", "More regions"),
    windows = windows, timetables = cover,
    counts = list(climbs = length(climbs), stations = length(stations), hubs = nrow(tp$hubs))
  )

  sizes <- c(
    meta.json = write_json_file(meta, file.path(dir, "meta.json")),
    stations.json = write_json_file(list(stations = stations, lines = if (length(lines)) lines else structure(list(), names = character())), file.path(dir, "stations.json")),
    ttm.json = write_json_file(list(windows = windows, order = order, by = by), file.path(dir, "ttm.json")),
    climbs.json = write_json_file(climbs, file.path(dir, "climbs.json")),
    access.json = write_json_file(access, file.path(dir, "access.json")))
  for (k in names(sizes)) say("%-14s %8.1f KB", k, sizes[[k]] / 1024)
  invisible(dir)
}

# copy a region's export into the app (public/data), replacing the demo
install_in_app <- function(cfg) {
  from <- file.path(cfg$paths$out, "data")
  to <- here::here("public", "data")
  files <- list.files(from, pattern = "\\.json$", full.names = TRUE)
  stopifnot(length(files) == 5)
  file.copy(files, to, overwrite = TRUE)
  say("copied %d files to %s", length(files), to)
}

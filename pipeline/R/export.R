# ------------------------------------------------------------------
# What the app reads (public/data/), by area so a phone only downloads
# what a search needs:
#   meta.json            region, windows, the tile index (which stops are near each tile)
#   stations.json        stops and rail lines
#   ttm/<hub>.json       train/coach times from one starting station
#   tiles/<tile>.json    climbs for the search (heights, way types, rough line) + stops near them
#   climbs/<id>.json     exact line + walking routes, fetched when a climb is shown
#   index.json           climb id -> tile (to reopen saved climbs)
# ------------------------------------------------------------------

write_json_file <- function(x, path) {
  jsonlite::write_json(x, path, auto_unbox = TRUE, digits = NA, null = "null", na = "null")
  file.size(path)
}

fmt_hm <- function(m) sprintf("%02d:%02d", m %/% 60, m %% 60)

export_app_data <- function(cfg, prof, acc, tp, ttm, dem = NULL, routes = NULL, dir = file.path(cfg$paths$out, "data")) {
  unlink(dir, recursive = TRUE)                    # no stale files from an earlier run
  dir.create(dir, recursive = TRUE, showWarnings = FALSE)
  step <- cfg$climbs$step_m

  # where a search can start (tp$starts: the hubs, and with `starts: rail`
  # every train station in the area)
  starts <- tp$starts %||% dplyr::mutate(tp$hubs, main = TRUE)

  # stations: starting stations + every place some climb can be walked to
  used <- unique(c(starts$id, acc$place))
  st <- dplyr::filter(tp$places, id %in% used) |> dplyr::arrange(dplyr::desc(kind == "rail"), name)
  if (!is.null(dem)) st$z <- round(dem_extract(dem, st$x, st$y))
  lines <- purrr::keep(tp$lines, function(L) sum(L$stops %in% st$id) >= 2) |>
    purrr::map(function(L) list(name = L$name, stops = L$stops[L$stops %in% st$id]))
  line_of <- purrr::imap(lines, function(L, id) tibble::tibble(place = L$stops, line = id)) |> dplyr::bind_rows()
  stations <- purrr::pmap(st, function(...) {
    r <- list(...)
    list(id = r$id, name = r$name, lat = round(r$lat, 5), lon = round(r$lon, 5), z = r$z %||% NULL,
         kind = r$kind, hub = r$id %in% tp$hubs$id, start = r$id %in% starts$id,
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

  # ttm: per starting station, one row per station in stations.json order:
  # [p50, p75, trips, last back, changes] or null. Table names are
  # "<window>" (train + coach) or "<window>@<mode>" (train only, coach only).
  # Written as JSON text: 189 starts x 3,047 stops x 15 tables is slow as lists.
  order <- vapply(stations, `[[`, "", "id")
  int <- function(v) ifelse(is.na(v), "null", as.character(as.integer(round(v))))
  row_json <- function(t, h) {
    if (is.null(t)) return(paste0("[", paste(rep("null", length(order)), collapse = ","), "]"))
    i <- match(order, t$place)
    ok <- !is.na(i) & order != h
    cell <- rep("null", length(order))
    j <- i[ok]
    cell[ok] <- paste0("[", int(t$p50[j]), ",", int(t$p75[j]), ",", int(t$trips[j]), ",", int(t$last_back[j]), ",", int(t$changes[j]), "]")
    paste0("[", paste(cell, collapse = ","), "]")
  }
  by_hub <- purrr::map(ttm, function(tab) split(tab, tab$hub))

  # climbs, split by area. A tile holds what the search needs (heights,
  # way types, a rough line every 100 m, the stops nearby); the exact line
  # and the walking routes are one small file per climb, fetched when shown.
  delta <- function(v) as.integer(c(v[1], diff(v)))
  flat <- function(lon, lat) as.integer(t(cbind(delta(round(lon * 1e5)), delta(round(lat * 1e5)))))
  TILE <- c(lon = 0.2, lat = 0.15)
  ll <- purrr::map2(prof$x, prof$y, function(x, y) to_lonlat(x, y, cfg$crs))
  prof$tile <- vapply(ll, function(p) sprintf("%d_%d", floor(p$lon[1] / TILE[["lon"]]), floor(p$lat[1] / TILE[["lat"]])), "")

  # the 15 closest stops per climb are plenty (and keep the files small)
  acc15 <- acc |>
    dplyr::filter(climb %in% prof$id, place %in% order) |>
    dplyr::arrange(climb, pmin(d0, d1)) |>
    dplyr::group_by(climb) |>
    dplyr::slice_head(n = 15) |>
    dplyr::ungroup() |>
    dplyr::mutate(d0 = pmin(d0, 99999), d1 = pmin(d1, 99999))
  access <- split(acc15, acc15$climb) |>
    purrr::map(function(a) purrr::pmap(a[, c("place", "d0", "d1")], function(place, d0, d1) list(place, d0, d1)))

  climb_json <- function(k) {
    r <- as.list(prof[k, ]); r <- lapply(r, function(v) if (is.list(v)) v[[1]] else v)
    p <- ll[[k]]
    n <- length(r$z)
    keep <- unique(c(seq(1, n, by = 5), n))
    list(id = r$id, name = r$name, towards = r$towards, tile = r$tile,
         z10 = delta(round(r$z * 10)), c = flat(p$lon[keep], p$lat[keep]),
         way = runs(r$way), surf = runs(r$surf),
         len = round((n - 1) * step), dplus = round(r$dplus), dminus = round(r$dminus),
         track = round(r$track, 2), paved = round(r$paved, 2),
         sac = if (is.na(r$sac)) NULL else r$sac, marked = r$marked >= 0.5)
  }
  for (sub in c("tiles", "climbs", "ttm")) dir.create(file.path(dir, sub), showWarnings = FALSE)
  tiles <- split(seq_len(nrow(prof)), prof$tile)
  tile_index <- purrr::imap(tiles, function(ks, tid) {
    cl <- lapply(ks, climb_json)
    ids <- prof$id[ks]
    write_json_file(list(climbs = cl, access = access[intersect(ids, names(access))]), file.path(dir, "tiles", paste0(tid, ".json")))
    lon <- unlist(lapply(ll[ks], `[[`, "lon")); lat <- unlist(lapply(ll[ks], `[[`, "lat"))
    near <- acc15 |> dplyr::filter(climb %in% ids) |> dplyr::group_by(place) |> dplyr::summarise(d = min(pmin(d0, d1)), .groups = "drop")
    list(id = tid, n = length(ks), bbox = round(c(min(lon), min(lat), max(lon), max(lat)), 4),
         near = as.list(stats::setNames(as.integer(near$d), near$place)))
  }) |> unname()

  # exact line + walking routes, one file per climb
  pack_route <- function(m) flat(m[, 1], m[, 2])
  rts <- if (is.null(routes)) NULL else split(routes, routes$climb)
  for (k in seq_len(nrow(prof))) {
    id <- prof$id[k]
    out <- list(lon = delta(round(ll[[k]]$lon * 1e5)), lat = delta(round(ll[[k]]$lat * 1e5)))
    r <- rts[[id]]
    for (sd in c("b", "t")) {
      x <- if (is.null(r)) NULL else r[r$side == sd, ]
      out[[sd]] <- if (is.null(x) || !nrow(x)) structure(list(), names = character()) else stats::setNames(lapply(x$coords, pack_route), x$place)
    }
    jsonlite::write_json(out, file.path(dir, "climbs", paste0(id, ".json")), auto_unbox = FALSE, digits = NA)
  }

  # travel times, one file per starting station and transport choice:
  # ttm/<hub>.json (train + coach), ttm/<hub>.<mode>.json (loaded when chosen)
  key_mode <- ifelse(grepl("@", names(ttm), fixed = TRUE), sub(".*@", "", names(ttm)), "all")
  key_win <- sub("@.*", "", names(ttm))
  modes <- unique(c("all", key_mode))
  for (m in modes) for (h in starts$id) {
    keys <- names(ttm)[key_mode == m]
    rows <- vapply(keys, function(k) row_json(by_hub[[k]][[h]], h), "")
    txt <- sprintf('{"hub":"%s","mode":"%s","by":{%s}}', h, m,
                   paste0('"', key_win[key_mode == m], '":', rows, collapse = ","))
    writeLines(txt, file.path(dir, "ttm", paste0(h, if (m == "all") "" else paste0(".", m), ".json")), useBytes = TRUE)
  }

  cover <- purrr::map(tp$feeds, function(f) list(feed = f$id, label = f$label, page = f$page,
                                                 networks = purrr::pmap(f$coverage, function(...) {
                                                   r <- list(...); list(name = r$agency_name %||% r$agency_id, from = format(r$first), to = format(r$last)) })))
  meta <- list(
    app = "PathFinder", version = paste0("0.5-", cfg$id), built = format(Sys.Date()), demo = FALSE, climb_format = "tiles1",
    region = cfg$name, profile_step_m = step, access_cutoff_m = cfg$access$max_walk_m,
    notes = c("Paths and tracks: OpenStreetMap. Elevation: IGN RGE ALTI 5 m, smoothed over about 100 m.",
              "Climbs are the most direct ways up to each high point; the app finds the best stretch inside each.",
              "Times: SNCF TER and Fluo Grand Est timetables, routed with r5r; on board + changes, not the wait before you leave.",
              "Walking distances follow paths and roads, from the stop to the bottom (or top) of each climb."),
    sources = c("\u00a9 OpenStreetMap contributors (ODbL)", "IGN RGE ALTI (Etalab 2.0)", "SNCF, Fluo Grand Est GTFS (transport.data.gouv.fr)"),
    sources_planned = c("Car and bike access", "More regions"),
    windows = windows, modes = as.list(modes), timetables = cover,
    counts = list(climbs = nrow(prof), stations = length(stations), hubs = nrow(tp$hubs), starts = nrow(starts)),
    tile = as.list(TILE), tiles = tile_index
  )

  sizes <- c(
    meta.json = write_json_file(meta, file.path(dir, "meta.json")),
    stations.json = write_json_file(list(stations = stations, lines = if (length(lines)) lines else structure(list(), names = character())), file.path(dir, "stations.json")),
    index.json = write_json_file(as.list(stats::setNames(prof$tile, prof$id)), file.path(dir, "index.json")))
  for (k in names(sizes)) say("%-14s %8.1f KB", k, sizes[[k]] / 1024)
  for (sub in c("tiles", "climbs", "ttm")) {
    f <- list.files(file.path(dir, sub), full.names = TRUE)
    say("%-14s %8.1f KB in %d files (largest %.0f KB)", paste0(sub, "/"), sum(file.size(f)) / 1024, length(f), max(file.size(f)) / 1024)
  }
  invisible(dir)
}

# copy a region's export into the app (public/data), replacing what is there
install_in_app <- function(cfg) {
  from <- file.path(cfg$paths$out, "data")
  to <- here::here("public", "data")
  stopifnot(file.exists(file.path(from, "meta.json")))
  unlink(to, recursive = TRUE)
  dir.create(to, recursive = TRUE)
  file.copy(list.files(from, full.names = TRUE), to, recursive = TRUE)
  say("copied %d files to %s", length(list.files(to, recursive = TRUE)), to)
}

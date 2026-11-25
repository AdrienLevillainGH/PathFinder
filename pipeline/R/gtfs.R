# ------------------------------------------------------------------
# GTFS timetables (SNCF TER, Fluo Grand Est coaches): read, clip to the
# region, find which dates each network covers, patch the gaps, merge
# stop points into "places" (a station and the coach stops in front of
# it are one place), draw rail lines for the map.
#
# Seasonal lines: they simply appear on the dates they run, so the
# summer windows (July) see the summer coaches. A network whose feed
# does not reach a window's date (e.g. trains published until April)
# borrows the same weekday from its last published weeks; the borrowing
# is logged and shown in the app's "How it works".
# ------------------------------------------------------------------

GTFS_TABLES <- c("agency", "routes", "trips", "stop_times", "stops", "calendar", "calendar_dates", "transfers", "feed_info")
WEEKDAYS_EN <- c("sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday")

gtfs_read <- function(zipfile) {
  dir <- tempfile("gtfs")
  utils::unzip(zipfile, exdir = dir)
  on.exit(unlink(dir, recursive = TRUE), add = TRUE)
  files <- list.files(dir, pattern = "\\.txt$", recursive = TRUE, full.names = TRUE)
  g <- list()
  for (f in files) {
    nm <- sub("\\.txt$", "", basename(f))
    if (nm %in% GTFS_TABLES)
      g[[nm]] <- tibble::as_tibble(data.table::fread(f, colClasses = "character", encoding = "UTF-8", na.strings = NULL, showProgress = FALSE, data.table = FALSE))
  }
  for (need in c("routes", "trips", "stop_times", "stops"))
    if (is.null(g[[need]])) stop(basename(zipfile), ": no ", need, ".txt", call. = FALSE)
  if (is.null(g[["calendar"]]) && is.null(g$calendar_dates)) stop(basename(zipfile), ": no calendar", call. = FALSE)
  g
}

col_or <- function(df, col, default = "") if (col %in% names(df)) df[[col]] else rep(default, nrow(df))

gtfs_clip <- function(g, area_ll, exclude = NULL, feed = "") {
  n_trips0 <- nrow(g$trips)
  st <- g$stops |>
    dplyr::mutate(lon = suppressWarnings(as.numeric(stop_lon)), lat = suppressWarnings(as.numeric(stop_lat)),
                  loc = col_or(g$stops, "location_type"))
  cand <- st |> dplyr::filter(loc %in% c("", "0"), !is.na(lon), !is.na(lat))
  inside <- lengths(sf::st_intersects(sf::st_as_sf(cand, coords = c("lon", "lat"), crs = 4326), area_ll)) > 0
  keep <- cand$stop_id[inside]

  routes <- g$routes
  if (!is.null(exclude) && nzchar(exclude)) {
    ag <- if (!is.null(g$agency)) dplyr::select(g$agency, dplyr::any_of(c("agency_id", "agency_name"))) else NULL
    txt <- paste(col_or(routes, "route_short_name"), col_or(routes, "route_long_name"), col_or(routes, "route_desc"))
    if (!is.null(ag) && "agency_id" %in% names(routes) && "agency_name" %in% names(ag))
      txt <- paste(txt, ag$agency_name[match(routes$agency_id, ag$agency_id)])
    bad <- grepl(exclude, txt, perl = TRUE)
    routes <- routes[!bad, ]
  }
  trips <- dplyr::filter(g$trips, route_id %in% routes$route_id)
  stt <- g$stop_times |> dplyr::filter(stop_id %in% keep, trip_id %in% trips$trip_id)
  if (!is.null(exclude) && nzchar(exclude)) stt <- dplyr::filter(stt, !grepl(exclude, stop_id, perl = TRUE))
  # a trip cut at the border must start and end on a timed stop
  stt <- stt |>
    dplyr::mutate(seqn = as.integer(stop_sequence), timed = arrival_time != "" | departure_time != "") |>
    dplyr::arrange(trip_id, seqn) |>
    dplyr::group_by(trip_id) |>
    dplyr::filter(cumsum(timed) > 0, rev(cumsum(rev(timed))) > 0) |>
    dplyr::filter(dplyr::n() >= 2) |>
    dplyr::ungroup() |>
    dplyr::select(-seqn, -timed)
  trips <- dplyr::filter(trips, trip_id %in% stt$trip_id)
  routes <- dplyr::filter(routes, route_id %in% trips$route_id)
  used <- unique(stt$stop_id)
  parents <- setdiff(unique(col_or(g$stops, "parent_station")[g$stops$stop_id %in% used]), "")
  stops <- dplyr::filter(g$stops, stop_id %in% c(used, parents))

  out <- list(routes = routes, trips = trips, stop_times = stt, stops = stops)
  if (!is.null(g$agency)) out$agency <- g$agency
  if (!is.null(g[["calendar"]])) out$calendar <- dplyr::filter(g[["calendar"]], service_id %in% trips$service_id)
  if (!is.null(g$calendar_dates)) out$calendar_dates <- dplyr::filter(g$calendar_dates, service_id %in% trips$service_id)
  if (!is.null(g$transfers)) out$transfers <- dplyr::filter(g$transfers, from_stop_id %in% stops$stop_id, to_stop_id %in% stops$stop_id)
  if (!is.null(g$feed_info)) out$feed_info <- g$feed_info
  say("%s: %d of %d trips touch the region, %d stops", feed, nrow(trips), n_trips0, length(used))
  out
}

# every (service, date) on which a service runs
gtfs_service_days <- function(g) {
  parts <- list()
  if (!is.null(g[["calendar"]]) && nrow(g[["calendar"]])) {
    cal <- g[["calendar"]] |>
      dplyr::mutate(start = as.Date(start_date, "%Y%m%d"), end = as.Date(end_date, "%Y%m%d")) |>
      dplyr::filter(!is.na(start), !is.na(end), end >= start)
    n <- as.integer(cal$end - cal$start) + 1L
    row <- rep(seq_len(nrow(cal)), n)
    date <- cal$start[row] + (sequence(n) - 1L)
    flags <- as.matrix(cal[, WEEKDAYS_EN]) == "1"
    on <- flags[cbind(row, as.POSIXlt(date)$wday + 1L)]
    parts$cal <- tibble::tibble(service_id = cal$service_id[row], date = date)[on, ]
  }
  days <- dplyr::bind_rows(c(list(tibble::tibble(service_id = character(), date = as.Date(character()))), parts))
  if (!is.null(g$calendar_dates) && nrow(g$calendar_dates)) {
    cd <- g$calendar_dates |> dplyr::mutate(date = as.Date(date, "%Y%m%d"))
    days <- days |>
      dplyr::anti_join(dplyr::filter(cd, exception_type == "2"), by = c("service_id", "date")) |>
      dplyr::bind_rows(dplyr::filter(cd, exception_type == "1") |> dplyr::select(service_id, date))
  }
  dplyr::distinct(days, service_id, date)
}

# trips per agency per date, and the dates each agency's timetable covers
gtfs_coverage <- function(g, days) {
  tr <- g$trips |>
    dplyr::select(trip_id, service_id, route_id) |>
    dplyr::left_join(dplyr::transmute(g$routes, route_id, agency_id = col_or(g$routes, "agency_id")), by = "route_id")
  per <- days |>
    dplyr::inner_join(dplyr::count(tr, service_id, agency_id, name = "trips"), by = "service_id", relationship = "many-to-many") |>
    dplyr::group_by(agency_id, date) |>
    dplyr::summarise(trips = sum(trips), .groups = "drop")
  span <- per |> dplyr::group_by(agency_id) |> dplyr::summarise(first = min(date), last = max(date), .groups = "drop")
  if (!is.null(g$agency) && "agency_name" %in% names(g$agency))
    span <- span |> dplyr::left_join(dplyr::transmute(g$agency, agency_id = col_or(g$agency, "agency_id"), agency_name), by = "agency_id")
  list(per = per, span = span, services = dplyr::distinct(tr, service_id, agency_id))
}

# the dates of each departure window, from the config rules
scenario_dates <- function(scenarios, today = Sys.Date()) {
  purrr::map(scenarios, function(s) {
    from <- s$from %||% "next"
    start <- if (identical(from, "next")) today + 1 else if (grepl("^\\d{4}-\\d{2}-\\d{2}$", from)) as.Date(from) else {
      d <- as.Date(paste0(format(today, "%Y"), "-", from))
      if (d <= today) d <- as.Date(paste0(as.integer(format(today, "%Y")) + 1L, "-", from))
      d
    }
    target <- match(tolower(s$weekday), WEEKDAYS_EN) - 1L
    date <- start + ((target - as.POSIXlt(start)$wday) %% 7)
    hm <- function(x) { p <- as.integer(strsplit(x, ":")[[1]]); p[1] * 60L + p[2] }
    tibble::tibble(id = s$id, label = s$label, date = date,
                   out_start = hm(s$out[[1]]), out_end = hm(s$out[[2]]),
                   back_start = hm(s$back[[1]]), back_end = hm(s$back[[2]]))
  }) |> dplyr::bind_rows()
}

# a network that does not cover a window's date borrows the busiest
# same weekday from the last (or first) six weeks it does cover
gtfs_patch_dates <- function(g, dates, feed = "") {
  days <- gtfs_service_days(g)
  cov <- gtfs_coverage(g, days)
  add <- list(); log <- list()
  for (a in seq_len(nrow(cov$span))) {
    ag <- cov$span[a, ]
    for (D in as.list(dates)) {
      if (D >= ag$first && D <= ag$last) next
      pool <- cov$per |>
        dplyr::filter(agency_id == ag$agency_id, as.POSIXlt(date)$wday == as.POSIXlt(D)$wday,
                      if (D > ag$last) date >= ag$last - 41 else date <= ag$first + 41)
      if (!nrow(pool)) {
        log[[length(log) + 1]] <- tibble::tibble(feed, agency = ag$agency_name %||% ag$agency_id, date = D, proxy = as.Date(NA), services = 0L)
        next
      }
      P <- pool$date[order(-pool$trips, -as.numeric(pool$date))][1]
      sv <- days |>
        dplyr::filter(date == P) |>
        dplyr::semi_join(dplyr::filter(cov$services, agency_id == ag$agency_id), by = "service_id")
      add[[length(add) + 1]] <- tibble::tibble(service_id = sv$service_id, date = format(D, "%Y%m%d"), exception_type = "1")
      log[[length(log) + 1]] <- tibble::tibble(feed, agency = ag$agency_name %||% ag$agency_id, date = D, proxy = P, services = nrow(sv))
    }
  }
  if (length(add)) {
    cd <- g$calendar_dates %||% tibble::tibble(service_id = character(), date = character(), exception_type = character())
    extra <- dplyr::bind_rows(add) |> dplyr::distinct()
    # an explicit "removed" exception on that date would cancel ours
    cd <- cd |> dplyr::anti_join(dplyr::select(extra, service_id, date), by = c("service_id", "date"))
    g$calendar_dates <- dplyr::bind_rows(cd, extra)
  }
  log <- dplyr::bind_rows(log)
  if (nrow(log)) for (i in seq_len(nrow(log)))
    say("%s \u00b7 %s: %s not published \u2192 uses %s", feed, log$agency[i], log$date[i], ifelse(is.na(log$proxy[i]), "nothing", format(log$proxy[i])))
  list(g = g, log = log, coverage = cov$span)
}

gtfs_write <- function(g, file) {
  dir <- tempfile("gtfsw")
  dir.create(dir)
  on.exit(unlink(dir, recursive = TRUE), add = TRUE)
  # empty optional tables (e.g. SNCF transfers once clipped) are left out
  keep <- names(g)[vapply(names(g), function(nm) nrow(g[[nm]]) > 0 || nm %in% c("agency", "stops", "routes", "trips", "stop_times"), logical(1))]
  for (nm in keep) data.table::fwrite(g[[nm]], file.path(dir, paste0(nm, ".txt")), quote = "auto")
  file <- normalizePath(file, mustWork = FALSE)
  if (file.exists(file)) unlink(file)
  zip::zip(file, files = paste0(keep, ".txt"), root = dir, mode = "cherry-pick")
  invisible(file)
}

# stop points actually served, with what serves them. `coach_stops`: a
# regex for stop ids that are coach stops even on a "rail" route (SNCF
# runs some coach services under train lines: StopPoint:OCECar TER-...)
gtfs_stop_points <- function(g, feed, coach_stops = NULL) {
  rt <- g$routes |>
    dplyr::transmute(route_id, rail = col_or(g$routes, "route_type") %in% c("2", as.character(100:117)),
                     line = dplyr::if_else(col_or(g$routes, "route_short_name") != "", col_or(g$routes, "route_short_name"), col_or(g$routes, "route_long_name")))
  serve <- g$stop_times |>
    dplyr::distinct(stop_id, trip_id) |>
    dplyr::inner_join(dplyr::select(g$trips, trip_id, route_id), by = "trip_id") |>
    dplyr::inner_join(rt, by = "route_id") |>
    dplyr::group_by(stop_id) |>
    dplyr::summarise(rail = any(rail), lines = list(sort(unique(line[line != ""]))), trips = dplyr::n(), .groups = "drop")
  if (!is.null(coach_stops) && nzchar(coach_stops)) serve$rail <- serve$rail & !grepl(coach_stops, serve$stop_id, perl = TRUE)
  st <- g$stops |>
    dplyr::mutate(parent = col_or(g$stops, "parent_station"), lon = as.numeric(stop_lon), lat = as.numeric(stop_lat))
  st |>
    dplyr::inner_join(serve, by = "stop_id") |>
    dplyr::left_join(dplyr::select(st, parent = stop_id, parent_name = stop_name), by = "parent") |>
    dplyr::transmute(feed = feed, stop_id, group = paste(feed, dplyr::if_else(parent != "", parent, stop_id)),
                     name = dplyr::coalesce(parent_name, stop_name), lon, lat, rail, lines, trips)
}

# stop points -> places. Same parent station = one place; coach stops
# within merge_m of a station join it; coach stops with the same name
# within merge_m (the two directions) are one place.
gtfs_places <- function(points, cfg) {
  grp <- points |>
    dplyr::group_by(group) |>
    dplyr::summarise(name = dplyr::first(name), lon = mean(lon), lat = mean(lat), rail = any(rail),
                     lines = list(sort(unique(unlist(lines)))), trips = sum(trips), .groups = "drop")
  m <- to_metric(grp$lon, grp$lat, cfg$crs)
  grp$x <- m$x; grp$y <- m$y
  near <- sf::st_is_within_distance(sf::st_as_sf(grp, coords = c("x", "y"), crs = cfg$crs), dist = cfg$transit$stop_merge_m)
  pairs <- tibble::tibble(i = rep(seq_along(near), lengths(near)), j = unlist(near)) |>
    dplyr::filter(i < j) |>
    dplyr::filter(grp$rail[i] | grp$rail[j] | norm_name(grp$name[i]) == norm_name(grp$name[j]))
  gg <- igraph::make_graph(rbind(pairs$i, pairs$j), n = nrow(grp), directed = FALSE)
  grp$cluster <- igraph::components(gg)$membership

  uic <- function(ids) { u <- regmatches(ids, regexpr("87[0-9]{6}", ids)); if (length(u)) u[1] else NA_character_ }
  members <- points |> dplyr::left_join(dplyr::select(grp, group, cluster), by = "group")
  places <- grp |>
    dplyr::group_by(cluster) |>
    dplyr::summarise(
      rail_any = any(rail),
      name = if (rail_any) name[rail][which.max(trips[rail])] else name[which.max(trips)],
      lon = if (rail_any) lon[rail][which.max(trips[rail])] else mean(lon),
      lat = if (rail_any) lat[rail][which.max(trips[rail])] else mean(lat),
      lines = list(sort(unique(unlist(lines)))), trips = sum(trips), .groups = "drop") |>
    dplyr::rename(rail = rail_any)
  codes <- members |> dplyr::group_by(cluster) |> dplyr::summarise(uic = uic(stop_id), .groups = "drop")
  places <- places |>
    dplyr::left_join(codes, by = "cluster") |>
    dplyr::mutate(id = dplyr::if_else(rail & !is.na(uic), paste0("r", uic),
                                      hash_id(sprintf("%s|%.4f|%.4f", norm_name(name), lon, lat), dplyr::if_else(rail, "r", "b"))),
                  kind = dplyr::if_else(rail, "rail", "coach"))
  places$id <- make.unique(places$id, sep = "_")
  check_unique(places, "id", "places")
  m <- to_metric(places$lon, places$lat, cfg$crs)
  places$x <- m$x; places$y <- m$y
  members <- members |> dplyr::left_join(dplyr::select(places, cluster, place = id), by = "cluster")
  say("stops \u2192 places: %d stop points, %d places (%d rail)", nrow(points), nrow(places), sum(places$rail))
  list(places = dplyr::select(places, -cluster, -uic), members = dplyr::select(members, feed, stop_id, place))
}

# the departure hubs named in the config, matched to rail places
match_hubs <- function(places, hubs) {
  rail <- dplyr::filter(places, kind == "rail")
  out <- purrr::map(hubs, function(h) {
    n <- norm_name(h)
    cand <- rail[norm_name(rail$name) == n, ]
    if (!nrow(cand)) cand <- rail[startsWith(norm_name(rail$name), n), ]
    if (!nrow(cand)) { warning("hub not found among stations: ", h); return(NULL) }
    cand[which.max(cand$trips), ]
  })
  dplyr::bind_rows(out) |> dplyr::distinct(id, .keep_all = TRUE)
}

# rail lines for the map: per route, its longest trip, as places
gtfs_rail_lines <- function(g, members, feed, coach_stops = NULL) {
  rt <- g$routes |>
    dplyr::mutate(lname = col_or(g$routes, "route_long_name"), sname = col_or(g$routes, "route_short_name"),
                  rtype = col_or(g$routes, "route_type")) |>
    dplyr::filter(rtype %in% c("2", as.character(100:117)))
  if (!nrow(rt)) return(list())
  tr <- g$trips |> dplyr::filter(route_id %in% rt$route_id)
  st <- dplyr::filter(g$stop_times, trip_id %in% tr$trip_id)
  if (!is.null(coach_stops) && nzchar(coach_stops)) st <- dplyr::filter(st, !grepl(coach_stops, stop_id, perl = TRUE))
  st <- st |>
    dplyr::mutate(seqn = as.integer(stop_sequence)) |>
    dplyr::left_join(dplyr::filter(members, feed == !!feed) |> dplyr::select(stop_id, place), by = "stop_id")
  longest <- st |> dplyr::count(trip_id) |> dplyr::inner_join(dplyr::select(tr, trip_id, route_id), by = "trip_id") |>
    dplyr::group_by(route_id) |> dplyr::slice_max(n, n = 1, with_ties = FALSE) |> dplyr::ungroup()
  seqs <- st |>
    dplyr::filter(trip_id %in% longest$trip_id) |>
    dplyr::arrange(trip_id, seqn) |>
    dplyr::group_by(trip_id) |>
    dplyr::summarise(stops = list(rle(place[!is.na(place)])$values), .groups = "drop") |>
    dplyr::inner_join(dplyr::select(longest, trip_id, route_id), by = "trip_id") |>
    dplyr::inner_join(dplyr::select(rt, route_id, lname, sname), by = "route_id") |>
    dplyr::filter(lengths(stops) >= 2)
  # one line per set of stops (both directions, duplicates)
  sig <- vapply(seqs$stops, function(s) paste(sort(s), collapse = ","), "")
  seqs <- seqs[!duplicated(sig), ]
  nm <- dplyr::if_else(seqs$lname != "", seqs$lname, seqs$sname)
  ids <- make.unique(hash_id(seqs$route_id, "L"), sep = "_")
  stats::setNames(purrr::map2(nm, seqs$stops, function(n, s) list(name = n, stops = s)), ids)
}

# Bas-Rhin coach stops are called "Mairie", "Centre", "Eglise"...: put the
# village in front ("Grendelbruch \u00b7 Mairie"), from the nearest OSM
# town/village (or any named place if their type is not known)
place_towns <- function(places, features, max_m = 2500) {
  if (is.null(features)) return(places)
  towns <- dplyr::filter(features, kind == "place")
  if ("place" %in% names(towns)) {
    big <- dplyr::filter(towns, place %in% c("town", "village"))
    if (nrow(big)) towns <- big
  }
  if (!nrow(towns)) return(places)
  town <- rep(NA_character_, nrow(places))
  idx <- seq_len(nrow(places))
  for (ch in split(idx, ceiling(idx / 500))) {
    d2 <- outer(places$x[ch], towns$x, "-")^2 + outer(places$y[ch], towns$y, "-")^2
    j <- max.col(-d2, ties.method = "first")
    town[ch] <- ifelse(d2[cbind(seq_along(ch), j)] <= max_m^2, towns$name[j], NA_character_)
  }
  # names that already start with a place in capitals ("KLINGENTHAL - Dreistein") are left alone
  has_place <- grepl("^[[:upper:][:digit:]' -]{3,} - ", places$name)
  named <- !is.na(town) & !has_place & !mapply(function(t, n) grepl(t, n, fixed = TRUE), norm_name(town), norm_name(places$name))
  places$name <- unname(ifelse(places$kind == "coach" & named, paste0(town, " \u00b7 ", places$name), places$name))
  places
}

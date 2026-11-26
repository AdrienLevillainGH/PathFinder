# ------------------------------------------------------------------
# On foot from a stop to the bottom and to the top of each climb,
# along paths and roads (shortest walking distance on the OSM network).
# Output: one row per (climb, place) within access$max_walk_m.
# ------------------------------------------------------------------

walk_graph <- function(net) {
  e <- dplyr::filter(net$edges, walk_ok, from != to)
  ids <- sort(unique(c(e$from, e$to)))
  g <- igraph::make_graph(rbind(match(e$from, ids), match(e$to, ids)), n = length(ids), directed = FALSE)
  igraph::E(g)$len <- e$len
  igraph::E(g)$edge <- e$edge
  xy <- net$nodes[match(ids, net$nodes$node), c("x", "y")]
  list(g = g, ids = ids, x = xy$x, y = xy$y, from = e$from)
}

# the nearest junction of the walking network to each place
snap_places <- function(W, places, crs) {
  P <- sf::st_as_sf(places, coords = c("x", "y"), crs = crs, remove = FALSE)
  N <- sf::st_as_sf(tibble::tibble(v = seq_along(W$ids), x = W$x, y = W$y), coords = c("x", "y"), crs = crs)
  nn <- sf::st_nearest_feature(P, N)
  tibble::tibble(place = places$id, v = nn, snap = sqrt((places$x - W$x[nn])^2 + (places$y - W$y[nn])^2))
}

access_table <- function(net, prof, places, cfg) {
  W <- walk_graph(net)
  maxd <- cfg$access$max_walk_m
  ends <- tibble::tibble(node = unique(c(prof$start, prof$end))) |>
    dplyr::mutate(v = match(node, W$ids))
  if (anyNA(ends$v)) stop("some climb ends are not on the walking network", call. = FALSE)

  # only stops that could be close enough, snapped to the nearest junction
  P <- sf::st_as_sf(places, coords = c("x", "y"), crs = cfg$crs, remove = FALSE)
  E <- sf::st_as_sf(tibble::tibble(x = W$x[ends$v], y = W$y[ends$v]), coords = c("x", "y"), crs = cfg$crs)
  P <- P[lengths(sf::st_is_within_distance(P, E, maxd)) > 0, ]
  if (!nrow(P)) return(tibble::tibble(climb = character(), place = character(), d0 = integer(), d1 = integer()))
  P <- snap_places(W, sf::st_drop_geometry(P), cfg$crs) |> dplyr::filter(snap <= cfg$access$max_snap_m)
  say("walking: %d places \u00d7 %d climb ends", nrow(P), nrow(ends))

  src <- unique(P$v)
  D <- purrr::map(split(src, ceiling(seq_along(src) / 50)), function(s) {
    m <- igraph::distances(W$g, v = s, to = ends$v, weights = igraph::E(W$g)$len)
    tibble::tibble(v = rep(s, times = ncol(m)), node = rep(ends$node, each = length(s)), d = as.vector(m)) |>
      dplyr::filter(is.finite(d), d <= maxd)
  }) |> dplyr::bind_rows()

  climbs <- dplyr::select(prof, climb = id, start, end)
  res <- P |>
    dplyr::inner_join(D, by = "v", relationship = "many-to-many") |>
    dplyr::mutate(d = d + snap)
  out <- climbs |>
    dplyr::inner_join(dplyr::select(res, place, node, d0 = d), by = c(start = "node"), relationship = "many-to-many") |>
    dplyr::full_join(
      climbs |> dplyr::inner_join(dplyr::select(res, place, node, d1 = d), by = c(end = "node"), relationship = "many-to-many"),
      by = c("climb", "start", "end", "place")) |>
    dplyr::mutate(d0 = round(dplyr::coalesce(d0, Inf)), d1 = round(dplyr::coalesce(d1, Inf))) |>
    dplyr::filter(pmin(d0, d1) <= maxd) |>
    dplyr::select(climb, place, d0, d1)
  check_unique(out, c("climb", "place"), "access rows")
  say("access: %d climb\u2013place pairs, %d climbs reachable on foot from a stop", nrow(out), dplyr::n_distinct(out$climb))
  out
}

# ------------------------------------------------------------------
# The walking routes themselves, to draw them in the app: from each of
# the k closest stops to the bottom (b) and to the top (t) of each climb,
# along the same network as the distances. One small file per climb,
# fetched when the climb is opened. `ttm` may hold several transport
# choices ("sat", "sat@rail", ...): the default stop of each is drawn.
# `known`: routes already drawn (same columns as the result); only the
# missing ones are computed, then both are returned.
# ------------------------------------------------------------------
access_paths <- function(net, acc, prof, places, cfg, ttm = NULL, hubs = NULL, k = 5, tol = 5, known = NULL, batch_n = 20000) {
  W <- walk_graph(net)
  ends <- dplyr::select(prof, climb = id, start, end)
  sides <- dplyr::bind_rows(
    dplyr::transmute(acc, climb, place, side = "b", d = d0),
    dplyr::transmute(acc, climb, place, side = "t", d = d1)) |>
    dplyr::filter(is.finite(d), d <= cfg$access$max_walk_m)
  # the k closest stops...
  near <- sides |>
    dplyr::group_by(climb, side) |>
    dplyr::slice_min(d, n = k, with_ties = FALSE) |>
    dplyr::ungroup()
  # ...plus the hubs themselves (you can walk from the station you start at)
  # and every stop the app can pick. The app takes the soonest stop (minutes
  # on board + walking) within your limits (time, distance); over all
  # possible limits, that is any stop no other stop beats on both time and
  # distance, for some hub, window and transport choice, with a way back.
  extra <- NULL
  if (!is.null(hubs)) extra <- dplyr::filter(sides, place %in% hubs$id)
  if (!is.null(ttm)) {
    best <- purrr::map(names(ttm), function(w) {
      tt <- dplyr::filter(ttm[[w]], !is.na(last_back)) |> dplyr::select(hub, place, p50)
      if (!is.null(hubs)) tt <- dplyr::bind_rows(tt, tibble::tibble(hub = hubs$id, place = hubs$id, p50 = 0))
      sides |>
        dplyr::inner_join(tt, by = "place", relationship = "many-to-many") |>
        dplyr::arrange(climb, side, hub, p50, d) |>
        dplyr::group_by(climb, side, hub) |>
        dplyr::filter(d < dplyr::lag(cummin(d), default = Inf)) |>
        dplyr::ungroup() |>
        dplyr::distinct(climb, place, side, d)
    }) |>
      dplyr::bind_rows() |>
      dplyr::distinct(climb, place, side, .keep_all = TRUE)
    extra <- dplyr::bind_rows(extra, best)
  }
  pairs <- dplyr::bind_rows(near, extra) |>
    dplyr::distinct(climb, place, side, .keep_all = TRUE) |>
    dplyr::inner_join(ends, by = "climb") |>
    dplyr::mutate(node = dplyr::if_else(side == "b", start, end), tv = match(node, W$ids)) |>
    dplyr::select(climb, place, side, d, tv)
  if (!is.null(known)) {
    n_all <- nrow(pairs)
    pairs <- dplyr::anti_join(pairs, known, by = c("climb", "place", "side"))
    say("walking routes: %d needed, %d already drawn, %d to add", n_all, n_all - nrow(pairs), nrow(pairs))
    if (!nrow(pairs)) return(known)
  }
  snaps <- snap_places(W, dplyr::filter(places, id %in% pairs$place), cfg$crs)
  say("walking routes: %d stop-to-climb routes from %d stops", nrow(pairs), nrow(snaps))

  # drawn in batches of stops (about batch_n routes each), to keep memory low
  draw <- function(pairs) {
  # shortest paths, stop by stop: the edges in order, and which way each is walked
  steps <- purrr::map(split(pairs, pairs$place), function(p) {
    v <- snaps$v[snaps$place == p$place[1]]
    tv <- unique(p$tv)
    sp <- suppressWarnings(igraph::shortest_paths(W$g, from = v, to = tv, weights = igraph::E(W$g)$len, output = "both"))
    purrr::map2(sp$vpath, sp$epath, function(vp, ep) {
      vp <- as.integer(vp); ep <- as.integer(ep)
      # the stop is at the climb's end already: no edge, just the stop and that point
      if (length(vp) == 1) return(tibble::tibble(place = p$place[1], tv = vp, ord = 1L, ge = NA_integer_, rev = FALSE))
      if (!length(ep)) return(NULL)
      tibble::tibble(place = p$place[1], tv = vp[length(vp)], ord = seq_along(ep), ge = ep,
                     rev = W$from[ep] != W$ids[vp[-length(vp)]])
    }) |> dplyr::bind_rows()
  }) |> dplyr::bind_rows() |>
    dplyr::mutate(edge = igraph::E(W$g)$edge[ge], route = dplyr::consecutive_id(place, tv))
  keys <- dplyr::distinct(steps, route, place, tv)
  at_end <- dplyr::filter(steps, is.na(ge)) |> dplyr::transmute(route, ord = 1L, x = W$x[tv], y = W$y[tv])
  steps <- dplyr::filter(steps, !is.na(ge))

  # full geometry: each edge's vertices, reversed when walked backwards
  verts <- net$verts |> dplyr::filter(edge %in% unique(steps$edge))
  pts <- steps |>
    dplyr::select(route, ord, edge, rev) |>
    dplyr::inner_join(verts, by = "edge", relationship = "many-to-many") |>
    dplyr::mutate(o2 = dplyr::if_else(rev, -s, s)) |>
    dplyr::arrange(route, ord, o2) |>
    dplyr::group_by(route) |>
    dplyr::filter(!(x == dplyr::lag(x, default = -1) & y == dplyr::lag(y, default = -1))) |>
    dplyr::ungroup()
  # from the stop itself (a few metres to the network) to the climb end
  stop_xy <- dplyr::filter(places, id %in% keys$place) |> dplyr::select(place = id, x, y)
  pts <- dplyr::bind_rows(keys |> dplyr::inner_join(stop_xy, by = "place") |> dplyr::transmute(route, ord = 0L, x, y),
                          dplyr::select(pts, route, ord, x, y), at_end) |>
    dplyr::arrange(route, ord)
  # lighter lines (5 m tolerance), then lon/lat
  lines <- split(as.matrix(pts[, c("x", "y")]), pts$route)
  geoms <- sf::st_sfc(lapply(lines, function(v) sf::st_linestring(matrix(v, ncol = 2))), crs = cfg$crs) |>
    sf::st_simplify(dTolerance = tol) |>
    sf::st_transform(4326)
  routes <- keys |>
    dplyr::arrange(route) |>
    dplyr::mutate(coords = lapply(geoms, sf::st_coordinates)) |>
    dplyr::inner_join(pairs, by = c("place", "tv"), relationship = "many-to-many")
  dplyr::select(routes, climb, side, place, d, coords)
  }
  per <- dplyr::count(pairs, place) |> dplyr::mutate(b = cumsum(n) %/% batch_n)
  batches <- unname(split(pairs, per$b[match(pairs$place, per$place)]))
  routes <- purrr::imap(batches, function(p, i) {
    if (length(batches) > 1) say("walking routes: batch %s of %d (%d routes)", i, length(batches), nrow(p))
    draw(p)
  }) |> dplyr::bind_rows()
  check_unique(routes, c("climb", "side", "place"), "walking routes")
  say("walking routes: %d drawn, median %.0f points", nrow(routes), stats::median(vapply(routes$coords, nrow, 0L)))
  if (!is.null(known)) {
    routes <- dplyr::bind_rows(dplyr::select(known, climb, side, place, d, coords), routes)
    check_unique(routes, c("climb", "side", "place"), "walking routes, old + new")
  }
  routes
}

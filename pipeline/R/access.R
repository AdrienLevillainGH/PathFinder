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
  xy <- net$nodes[match(ids, net$nodes$node), c("x", "y")]
  list(g = g, ids = ids, x = xy$x, y = xy$y)
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
  N <- sf::st_as_sf(tibble::tibble(v = seq_along(W$ids), x = W$x, y = W$y), coords = c("x", "y"), crs = cfg$crs)
  nn <- sf::st_nearest_feature(P, N)
  snap <- sqrt((P$x - W$x[nn])^2 + (P$y - W$y[nn])^2)
  P <- tibble::tibble(place = P$id, v = nn, snap = snap) |> dplyr::filter(snap <= cfg$access$max_snap_m)
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

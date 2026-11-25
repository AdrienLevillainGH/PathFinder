# ------------------------------------------------------------------
# OpenStreetMap -> a routable network of paths, tracks and roads.
#
#   osm_read()     ways (+ named summits/places, + marked hiking routes)
#   osm_classify() way type m/p/t/r and surface k/n/u/a/x, as in the app
#   osm_network()  ways cut at every shared node -> edges between junctions
#
# Read with sf/GDAL's OSM driver (no extra package). Tags that are not
# columns by default (sac_scale, surface, ...) come from `other_tags`.
# ------------------------------------------------------------------

osm_query_lines <- function(highways) {
  sprintf("SELECT osm_id, name, highway, other_tags FROM lines WHERE highway IN (%s)",
          paste0("'", highways, "'", collapse = ","))
}

# named things a climb can lead to (key in other_tags; man_made is a column of its own)
OSM_FEATURES <- c(peak = "natural", saddle = "natural", rock = "natural", viewpoint = "tourism",
                  castle = "historic", ruins = "historic")

osm_query_features <- function() {
  tags <- sprintf("other_tags LIKE '%%\"%s\"=>\"%s\"%%'", OSM_FEATURES, names(OSM_FEATURES))
  sprintf("SELECT osm_id, name, place, man_made, other_tags FROM points WHERE name IS NOT NULL AND (place IN ('town','village','hamlet','locality','isolated_dwelling') OR man_made = 'tower' OR %s)",
          paste(tags, collapse = " OR "))
}

osm_query_routes <- function() {
  "SELECT osm_id, name, other_tags FROM multilinestrings WHERE other_tags LIKE '%\"route\"=>\"hiking\"%' OR other_tags LIKE '%\"route\"=>\"foot\"%'"
}

st_read_or_empty <- function(file, query, wkt) {
  tryCatch(sf::st_read(file, query = query, wkt_filter = wkt, quiet = TRUE),
           error = function(e) { warning(basename(file), ": ", conditionMessage(e)); NULL })
}

# read far enough around the climbs to walk to them from a stop
osm_reach_wkt <- function(cfg) {
  A <- area_polygon(cfg)
  reach <- sf::st_buffer(A$metric, cfg$access$max_walk_m) |> sf::st_transform(4326)
  sf::st_as_text(sf::st_geometry(reach)[[1]])
}

osm_read_query <- function(files, q, wkt) {
  parts <- Filter(Negate(is.null), lapply(files, st_read_or_empty, query = q, wkt = wkt))
  if (!length(parts)) return(NULL)
  x <- do.call(rbind, parts)
  x[!duplicated(x$osm_id), ]                       # a feature in two extracts is kept once
}

# named summits, castles, viewpoints, towers and villages
osm_read_features <- function(cfg, files = osm_files(cfg)) {
  feats <- osm_read_query(files, osm_query_features(), osm_reach_wkt(cfg))
  if (is.null(feats)) NULL else osm_feature_table(feats, cfg$crs)
}

osm_read <- function(cfg, files = osm_files(cfg)) {
  wkt <- osm_reach_wkt(cfg)
  hw <- unique(c(cfg$network$trail_highways, cfg$network$minor_roads, cfg$network$walk_only))
  one <- function(q) osm_read_query(files, q, wkt)
  lines <- one(osm_query_lines(hw))
  if (is.null(lines) || !nrow(lines)) stop("no ways read from ", paste(basename(files), collapse = ", "), call. = FALSE)
  say("OSM ways: %d", nrow(lines))
  feats <- one(osm_query_features())
  routes <- one(osm_query_routes())
  say("named summits/places: %d \u00b7 marked routes: %d", NROW(feats), NROW(routes))

  list(
    lines = sf::st_transform(lines, cfg$crs),
    features = if (is.null(feats)) NULL else osm_feature_table(feats, cfg$crs),
    routes = if (is.null(routes)) NULL else sf::st_transform(routes, cfg$crs)
  )
}

osm_feature_table <- function(feats, crs) {
  kind <- rep(NA_character_, nrow(feats))
  for (k in names(OSM_FEATURES)) {
    hit <- is.na(kind) & hstore_get(feats$other_tags, OSM_FEATURES[[k]]) %in% k
    kind[hit] <- k
  }
  kind[is.na(kind) & feats$man_made %in% "tower"] <- "tower"
  kind[is.na(kind) & !is.na(feats$place)] <- "place"
  xy <- sf::st_coordinates(sf::st_transform(feats, crs))
  tibble::tibble(osm_id = feats$osm_id, name = feats$name, kind = kind, place = feats$place,
                 ele = suppressWarnings(as.numeric(hstore_get(feats$other_tags, "ele"))),
                 x = xy[, 1], y = xy[, 2]) |>
    dplyr::filter(!is.na(kind)) |>
    dplyr::mutate(prio = dplyr::if_else(kind == "place", 2L, 1L))
}

# way type and surface, coded like the app (engine.js WAYS / SURFACES)
osm_classify <- function(lines, cfg) {
  nw <- cfg$network
  tag <- function(k) hstore_get(lines$other_tags, k)
  paved <- c("paved", "asphalt", "concrete", "concrete:plates", "concrete:lanes", "paving_stones", "sett", "chipseal", "metal")
  rocky <- c("rock", "stone", "bare_rock", "rocky", "scree", "pebblestone")
  natural <- c("ground", "dirt", "earth", "grass", "mud", "sand", "woodchips", "natural", "soil", "forest_floor")
  unpaved <- c("unpaved", "gravel", "fine_gravel", "compacted", "grass_paver", "wood", "unhewn_cobblestone")

  sf::st_drop_geometry(lines) |>
    tibble::as_tibble() |>
    dplyr::mutate(
      sac = tag("sac_scale"), surface = tag("surface"), tracktype = tag("tracktype"),
      visibility = tag("trail_visibility"), foot = tag("foot"), access = tag("access"),
      footway = tag("footway"),
      walk_ok = !(foot %in% c("no", "private") |
                  (access %in% c("no", "private") & !(foot %in% c("yes", "designated", "permissive")))),
      way = dplyr::case_when(
        highway %in% c("path", "footway", "bridleway", "steps") &
          (sac %in% nw$mountain_sac | visibility %in% nw$bad_visibility) ~ "m",
        highway %in% c("path", "footway", "bridleway", "steps") ~ "p",
        highway == "track" ~ "t",
        TRUE ~ "r"),
      surf = dplyr::case_when(
        surface %in% paved ~ "a",
        surface %in% rocky ~ "k",
        surface %in% natural ~ "n",
        surface %in% unpaved ~ "u",
        is.na(surface) & way == "r" ~ "a",                       # French roads are tarmac
        is.na(surface) & way == "t" & tracktype %in% c("grade1", "grade2") ~ "u",
        is.na(surface) & way == "t" & !is.na(tracktype) ~ "n",
        TRUE ~ "x"),
      climb_ok = walk_ok & highway %in% c(nw$trail_highways, nw$minor_roads) &
        !(footway %in% c("sidewalk", "crossing")),
      road = way == "r"
    ) |>
    dplyr::select(osm_id, name, highway, way, surf, sac, walk_ok, climb_ok, road)
}

# ways -> edges between junctions. A junction is a vertex shared by two
# ways (or used twice by one), or a way's end. Coordinates are matched
# to the centimetre in the metric CRS (shared OSM nodes match exactly).
osm_network <- function(lines, attrs) {
  stopifnot(nrow(lines) == nrow(attrs))
  co <- sf::st_coordinates(lines)
  v <- tibble::tibble(line = as.integer(co[, "L1"]), x = co[, "X"], y = co[, "Y"],
                      kx = round(co[, "X"] * 100), ky = round(co[, "Y"] * 100)) |>
    dplyr::filter(!(line == dplyr::lag(line, default = -1L) & kx == dplyr::lag(kx) & ky == dplyr::lag(ky))) |>
    dplyr::group_by(line) |>
    dplyr::mutate(seq = dplyr::row_number(), n = dplyr::n()) |>
    dplyr::ungroup() |>
    dplyr::filter(n >= 2) |>
    dplyr::group_by(kx, ky) |>
    dplyr::mutate(node = dplyr::cur_group_id(), uses = dplyr::n()) |>
    dplyr::ungroup() |>
    dplyr::mutate(split = seq == 1 | seq == n | uses >= 2) |>
    dplyr::arrange(line, seq) |>
    dplyr::group_by(line) |>
    dplyr::mutate(e = cumsum(split & seq < n)) |>
    dplyr::ungroup()

  # a junction inside a way ends one edge and starts the next
  ends <- v |> dplyr::filter(split, seq > 1, seq < n) |> dplyr::mutate(e = e - 1L)
  verts <- dplyr::bind_rows(v, ends) |>
    dplyr::arrange(line, e, seq) |>
    dplyr::mutate(edge = dplyr::consecutive_id(line, e)) |>
    dplyr::group_by(edge) |>
    dplyr::mutate(s = cumsum(dplyr::coalesce(sqrt((x - dplyr::lag(x))^2 + (y - dplyr::lag(y))^2), 0))) |>
    dplyr::ungroup()

  edges <- verts |>
    dplyr::group_by(edge) |>
    dplyr::summarise(line = dplyr::first(line), from = dplyr::first(node), to = dplyr::last(node),
                     len = dplyr::last(s), .groups = "drop") |>
    dplyr::filter(len > 0.5)
  n_e <- nrow(edges)
  edges <- edges |> dplyr::left_join(dplyr::mutate(attrs, line = dplyr::row_number()), by = "line")
  check_rows(n_e, nrow(edges), "edges + way attributes", allow_drop = FALSE)

  nodes <- verts |>
    dplyr::filter(edge %in% edges$edge, split) |>
    dplyr::distinct(node, .keep_all = TRUE) |>
    dplyr::select(node, x, y)
  verts <- verts |> dplyr::filter(edge %in% edges$edge) |> dplyr::select(edge, x, y, s)
  check_unique(nodes, "node", "nodes")
  say("network: %d edges, %d junctions, %.0f km", nrow(edges), nrow(nodes), sum(edges$len) / 1000)
  list(edges = edges, nodes = nodes, verts = verts)
}

# point half-way along each edge (for "is this edge in the area / on a
# marked route" questions)
edge_midpoints <- function(verts, edges) {
  verts |>
    dplyr::inner_join(dplyr::select(edges, edge, len), by = "edge") |>
    dplyr::group_by(edge) |>
    dplyr::mutate(px = dplyr::lag(x), py = dplyr::lag(y), ps = dplyr::lag(s)) |>
    dplyr::ungroup() |>
    dplyr::filter(!is.na(ps), s >= len / 2, ps < len / 2) |>
    dplyr::mutate(t = (len / 2 - ps) / pmax(s - ps, 1e-9), mx = px + t * (x - px), my = py + t * (y - py)) |>
    dplyr::select(edge, mx, my)
}

# flags edges: inside the climb area, and on a marked hiking route
osm_flag_edges <- function(net, osm, cfg) {
  A <- area_polygon(cfg)$metric
  mid <- edge_midpoints(net$verts, net$edges)
  pts <- sf::st_as_sf(mid, coords = c("mx", "my"), crs = cfg$crs)
  inside <- lengths(sf::st_intersects(pts, A)) > 0
  flags <- tibble::tibble(edge = mid$edge, in_area = inside)
  # on a marked route: route relations reuse the ways' nodes, so most of
  # the edge's vertices are route vertices (exact match, to the cm)
  if (!is.null(osm$routes) && nrow(osm$routes)) {
    rk <- sf::st_coordinates(osm$routes)
    rk <- tibble::tibble(kx = round(rk[, "X"] * 100), ky = round(rk[, "Y"] * 100), on = TRUE) |> dplyr::distinct()
    share <- net$verts |>
      dplyr::mutate(kx = round(x * 100), ky = round(y * 100)) |>
      dplyr::left_join(rk, by = c("kx", "ky")) |>
      dplyr::group_by(edge) |>
      dplyr::summarise(marked = mean(!is.na(on)) >= 0.5, .groups = "drop")
    flags <- dplyr::left_join(flags, share, by = "edge")
  } else flags$marked <- FALSE
  n0 <- nrow(net$edges)
  net$edges <- net$edges |>
    dplyr::left_join(flags, by = "edge") |>
    dplyr::mutate(in_area = dplyr::coalesce(in_area, FALSE), marked = dplyr::coalesce(marked, FALSE))
  check_rows(n0, nrow(net$edges), "edge flags", allow_drop = FALSE)
  say("edges in the climb area: %d \u00b7 on marked routes: %d", sum(net$edges$in_area), sum(net$edges$marked))
  net
}

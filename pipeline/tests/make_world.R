# ------------------------------------------------------------------
# A small made-up world to test the pipeline without downloads:
# two hills, a grid of forest tracks, a valley road, a switchback path
# (marked hiking route) to the big hill, a straight steep path up the
# small one, a train line and a coach line. Written as the real inputs
# are: an .osm file (read by GDAL's OSM driver), a GeoTIFF DEM in
# Lambert-93, and two GTFS zips.
# ------------------------------------------------------------------

X0 <- 1010000; Y0 <- 6820000
terrain <- function(x, y) {
  200 + 700 * exp(-((x - (X0 + 3000))^2 + (y - (Y0 + 3500))^2) / (2 * 1300^2)) +
    420 * exp(-((x - (X0 + 7500))^2 + (y - (Y0 + 2500))^2) / (2 * 650^2)) + 0.004 * (y - Y0)
}

make_world <- function(dir) {
  dir.create(dir, recursive = TRUE, showWarnings = FALSE)

  # --- DEM, 5 m
  r <- terra::rast(xmin = X0 - 4000, xmax = X0 + 11000, ymin = Y0 - 2000, ymax = Y0 + 7000, resolution = 5, crs = "EPSG:2154")
  xy <- terra::xyFromCell(r, seq_len(terra::ncell(r)))
  terra::values(r) <- terrain(xy[, 1], xy[, 2])
  dem_dir <- file.path(dir, "dem")
  dir.create(dem_dir, showWarnings = FALSE)
  terra::writeRaster(r, file.path(dem_dir, "dem.tif"), overwrite = TRUE)

  # --- OSM
  nodes <- new.env()
  nodes$tab <- tibble::tibble(id = integer(), x = numeric(), y = numeric(), tags = list())
  node_id <- function(x, y, tags = NULL) {
    key <- which(abs(nodes$tab$x - x) < 0.01 & abs(nodes$tab$y - y) < 0.01)
    if (length(key)) {
      if (!is.null(tags)) nodes$tab$tags[[key]] <- tags
      return(nodes$tab$id[key])
    }
    id <- nrow(nodes$tab) + 1L
    nodes$tab <- dplyr::bind_rows(nodes$tab, tibble::tibble(id = id, x = x, y = y, tags = list(tags)))
    id
  }
  ways <- list()
  add_way <- function(x, y, tags) {
    ids <- mapply(node_id, x, y)
    ways[[length(ways) + 1]] <<- list(id = 1000L + length(ways), nds = ids, tags = tags)
    1000L + length(ways) - 1L
  }
  # grid of tracks every km, vertices every 100 m; bottom row is a road
  for (gy in seq(0, 6000, 1000)) {
    xs <- X0 + seq(0, 10000, 100)
    add_way(xs, rep(Y0 + gy, length(xs)),
            if (gy == 0) c(highway = "tertiary", name = "Route de la vall\u00e9e") else c(highway = "track", tracktype = "grade2"))
  }
  for (gx in seq(0, 10000, 1000)) {
    ys <- Y0 + seq(1000, 6000, 100)                       # tracks start at the first row above the road...
    add_way(rep(X0 + gx, length(ys)), ys, c(highway = "track", tracktype = "grade3"))
    add_way(rep(X0 + gx, 11), Y0 + seq(0, 1000, 100), c(highway = "unclassified"))   # ...lanes join them to the road
  }
  # switchback path up the big hill (ends on the track vertex at the summit)
  zz <- c(0, 300, -300, 300, -300, 300, -300, 300, -300, 300, 0)
  sy <- seq(Y0 + 1000, Y0 + 3500, length.out = length(zz))
  px <- unlist(lapply(seq_len(length(zz) - 1), function(i) seq(X0 + 3000 + zz[i], X0 + 3000 + zz[i + 1], length.out = 13)[-13]))
  py <- unlist(lapply(seq_len(length(zz) - 1), function(i) seq(sy[i], sy[i + 1], length.out = 13)[-13]))
  path_a <- add_way(c(px, X0 + 3000), c(py, Y0 + 3500), c(highway = "path", sac_scale = "mountain_hiking", surface = "ground", name = "Sentier des lacets"))
  node_id(X0 + 3000, Y0 + 3500, c(natural = "peak", name = "Mont Test", ele = "914"))
  # straight steep path up the small hill
  t <- seq(0, 1, length.out = 64)
  add_way(X0 + 7000 + t * 500, Y0 + 1000 + t * 1500, c(highway = "path", surface = "rock", name = "Raidillon"))
  node_id(X0 + 7500, Y0 + 2500, c(natural = "peak", name = "Rocher B"))
  node_id(X0 + 1000, Y0 - 300, c(place = "village", name = "Testheim"))
  node_id(X0 + 9000, Y0 + 5000, c(man_made = "tower", tower_type = "observation", name = "Tour test"))

  ll <- to_lonlat(nodes$tab$x, nodes$tab$y, 2154)
  tag_xml <- function(tags) if (is.null(tags)) "" else
    paste0(sprintf('<tag k="%s" v="%s"/>', names(tags), tags), collapse = "")
  node_xml <- sprintf('<node id="%d" version="1" lat="%.8f" lon="%.8f">%s</node>', nodes$tab$id, ll$lat, ll$lon,
                      vapply(nodes$tab$tags, tag_xml, ""))
  way_xml <- vapply(ways, function(w) sprintf('<way id="%d" version="1">%s%s</way>', w$id,
                                              paste0(sprintf('<nd ref="%d"/>', w$nds), collapse = ""), tag_xml(w$tags)), "")
  rel_xml <- sprintf('<relation id="5000" version="1"><member type="way" ref="%d" role=""/>%s</relation>', path_a,
                     tag_xml(c(type = "route", route = "hiking", name = "GR test")))
  osm <- file.path(dir, "world.osm")
  con <- file(osm, "wb")
  writeLines(enc2utf8(c('<?xml version="1.0" encoding="UTF-8"?>', '<osm version="0.6" generator="pathfinder-test">',
                        node_xml, way_xml, rel_xml, "</osm>")), con, useBytes = TRUE)
  close(con)

  # --- GTFS
  st_ll <- function(x, y) { p <- to_lonlat(x, y, 2154); sprintf("%.6f", c(p$lat, p$lon)) }
  stop_row <- function(id, name, x, y, parent = "", type = "0") {
    p <- to_lonlat(x, y, 2154)
    tibble::tibble(stop_id = id, stop_name = name, stop_lat = sprintf("%.6f", p$lat), stop_lon = sprintf("%.6f", p$lon),
                   location_type = type, parent_station = parent)
  }
  hm <- function(m) sprintf("%02d:%02d:00", m %/% 60, m %% 60)
  rail <- list(
    agency = tibble::tibble(agency_id = c("TER", "HS"), agency_name = c("TER Test", "TGV Test"), agency_url = "https://example.org", agency_timezone = "Europe/Paris"),
    stops = dplyr::bind_rows(
      stop_row("SA:87000001", "Hubville", X0 - 3000, Y0 - 1000, type = "1"),
      stop_row("SP:TER-87000001", "Hubville", X0 - 3000, Y0 - 1000, parent = "SA:87000001"),
      stop_row("SP:TER-87000002", "Val Station", X0 + 1000, Y0 - 150),
      stop_row("SP:TER-87000003", "Far Station", X0 + 9000, Y0 - 150),
      stop_row("SP:TGV-87000009", "Elsewhere", X0 + 400000, Y0 + 300000)),
    routes = tibble::tibble(route_id = c("R1", "T1"), agency_id = c("TER", "HS"), route_short_name = c("TER", "TGV"),
                            route_long_name = c("Hubville - Far", "Hubville - Elsewhere"), route_type = "2"),
    trips = tibble::tibble(route_id = c("R1", "R1", "R1", "R1", "T1"), service_id = "SAT",
                           trip_id = c("o1", "o2", "b1", "b2", "tgv1")),
    calendar = tibble::tibble(service_id = "SAT", monday = "0", tuesday = "0", wednesday = "0", thursday = "0", friday = "0",
                              saturday = "1", sunday = "0", start_date = "20261101", end_date = "20270331"),
    calendar_dates = tibble::tibble(service_id = "SAT", date = "20261226", exception_type = "2"))
  st <- function(trip, stops, t0) tibble::tibble(trip_id = trip, arrival_time = hm(t0 + c(0, 12, 22)[seq_along(stops)]),
                                                 departure_time = hm(t0 + c(0, 12, 22)[seq_along(stops)]),
                                                 stop_id = stops, stop_sequence = as.character(seq_along(stops)))
  rail$stop_times <- dplyr::bind_rows(
    st("o1", c("SP:TER-87000001", "SP:TER-87000002", "SP:TER-87000003"), 7 * 60 + 10),
    st("o2", c("SP:TER-87000001", "SP:TER-87000002", "SP:TER-87000003"), 9 * 60 + 10),
    st("b1", c("SP:TER-87000003", "SP:TER-87000002", "SP:TER-87000001"), 17 * 60),
    st("b2", c("SP:TER-87000003", "SP:TER-87000002", "SP:TER-87000001"), 19 * 60 + 30),
    tibble::tibble(trip_id = "tgv1", arrival_time = hm(c(480, 600)), departure_time = hm(c(480, 600)),
                   stop_id = c("SP:TER-87000001", "SP:TGV-87000009"), stop_sequence = c("1", "2")))
  coach <- list(
    agency = tibble::tibble(agency_id = "FLUO", agency_name = "Fluo Test", agency_url = "https://example.org", agency_timezone = "Europe/Paris"),
    stops = dplyr::bind_rows(
      stop_row("C1", "Val Gare", X0 + 1060, Y0 - 150),
      stop_row("C2", "Col du Test", X0 + 5000, Y0 + 2000),
      stop_row("C3", "Col du Test", X0 + 5040, Y0 + 2000)),
    routes = tibble::tibble(route_id = c("L201", "N5"), agency_id = "FLUO", route_short_name = c("201", "Navette des cr\u00eates"),
                            route_long_name = "", route_type = "3"),
    trips = tibble::tibble(route_id = c("L201", "L201", "N5"), service_id = c("WK", "WK", "SUMMER"), trip_id = c("w1", "w2", "s1")),
    calendar = tibble::tibble(service_id = c("WK", "SUMMER"), monday = c("1", "0"), tuesday = c("1", "0"), wednesday = c("1", "0"),
                              thursday = c("1", "0"), friday = c("1", "0"), saturday = c("0", "1"), sunday = c("0", "1"),
                              start_date = c("20261101", "20270701"), end_date = c("20270831", "20270831")),
    stop_times = dplyr::bind_rows(
      tibble::tibble(trip_id = "w1", arrival_time = hm(c(480, 500)), departure_time = hm(c(480, 500)), stop_id = c("C1", "C2"), stop_sequence = c("1", "2")),
      tibble::tibble(trip_id = "w2", arrival_time = hm(c(1020, 1040)), departure_time = hm(c(1020, 1040)), stop_id = c("C3", "C1"), stop_sequence = c("1", "2")),
      tibble::tibble(trip_id = "s1", arrival_time = hm(c(540, 560)), departure_time = hm(c(540, 560)), stop_id = c("C1", "C2"), stop_sequence = c("1", "2"))))
  gtfs_dir <- file.path(dir, "gtfs")
  dir.create(gtfs_dir, showWarnings = FALSE)
  gtfs_write(rail, file.path(gtfs_dir, "rail.zip"))
  gtfs_write(coach, file.path(gtfs_dir, "coach.zip"))

  # --- config: Alsace rules, this world's box
  box <- to_lonlat(c(X0 - 300, X0 + 10300), c(Y0 - 300, Y0 + 6300), 2154)
  tbox <- to_lonlat(c(X0 - 5000, X0 + 12000), c(Y0 - 3000, Y0 + 8000), 2154)
  cfg_dir <- file.path(dir, "config")
  dir.create(cfg_dir, showWarnings = FALSE)
  file.copy(here::here("pipeline", "config", "alsace.yml"), cfg_dir, overwrite = TRUE)
  yaml::write_yaml(list(
    extends = "alsace", id = "testworld", name = "Test world",
    area = list(bbox = c(box$lon[1], box$lat[1], box$lon[2], box$lat[2]), buffer_km = 0),
    dem = list(source = "folder", folder = dem_dir),
    transit = list(area = list(bbox = c(tbox$lon[1], tbox$lat[1], tbox$lon[2], tbox$lat[2]), buffer_km = 0),
                   hubs = list("Hubville", "Nowhere"),
                   feeds = list(list(id = "rail", label = "Test trains", url = "file://rail", exclude = "TGV"),
                                list(id = "coach", label = "Test coaches", url = "file://coach", exclude = NULL)))),
    file.path(cfg_dir, "testworld.yml"))
  list(osm = osm, gtfs = c(rail = file.path(gtfs_dir, "rail.zip"), coach = file.path(gtfs_dir, "coach.zip")),
       config_dir = cfg_dir, dem = dem_dir)
}

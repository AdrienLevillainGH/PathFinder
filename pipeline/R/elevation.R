# ------------------------------------------------------------------
# Elevation: IGN RGE ALTI (5 m) along every path and track.
#
#   dem_prepare()       tiles from the IGN Geoplateforme WMS (GeoTIFF,
#                       no key), or RGE ALTI tiles you downloaded yourself
#   edge_profiles()     points every 10 m along each way + elevation
#   split_at_bumps()    a way that goes over a hump (>= 8 m up then down)
#                       is cut at the top, so every edge is one-way-ish
#
# Tiles are cached in pipeline/data-raw/dem/ and shared by regions.
# Flat tiles (relief < 40 m on the 25 m model) keep the 25 m model.
# ------------------------------------------------------------------

IGN_WMS <- "https://data.geopf.fr/wms-r/wms"

is_xml_file <- function(f) {
  con <- file(f, "rb"); on.exit(close(con))
  head <- readBin(con, "raw", 64)
  grepl("<\\?xml|<ServiceException|<html", rawToChar(head[head != as.raw(0)]), ignore.case = TRUE)
}

ign_tile <- function(layer, x0, y0, size_m, res_m, dest) {
  if (file.exists(dest) && file.size(dest) > 1000) return(dest)
  dir.create(dirname(dest), recursive = TRUE, showWarnings = FALSE)
  px <- round(size_m / res_m)
  url <- sprintf("%s?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS=%s&STYLES=&CRS=EPSG:2154&BBOX=%.0f,%.0f,%.0f,%.0f&WIDTH=%d&HEIGHT=%d&FORMAT=image/geotiff",
                 IGN_WMS, layer, x0, y0, x0 + size_m, y0 + size_m, px, px)
  tmp <- tempfile(fileext = ".tif")
  on.exit(unlink(tmp), add = TRUE)
  ok <- FALSE
  for (attempt in 1:4) {
    ok <- tryCatch({ utils::download.file(url, tmp, mode = "wb", quiet = TRUE); TRUE }, error = function(e) FALSE) &&
      file.size(tmp) > 1000 && !is_xml_file(tmp)
    if (ok) break
    Sys.sleep(2^attempt)
  }
  if (!ok) {
    msg <- if (file.exists(tmp) && is_xml_file(tmp)) substr(paste(readLines(tmp, warn = FALSE), collapse = " "), 1, 300) else "no answer"
    stop("IGN elevation tile failed (", x0, ", ", y0, "): ", msg,
         "\nURL: ", url, "\nTry again later, or set dem.source: folder (see README).", call. = FALSE)
  }
  r <- terra::rast(tmp)
  r <- terra::classify(r, cbind(-Inf, -1000, NA))          # no-data (-99999) outside France
  terra::crs(r) <- "EPSG:2154"
  terra::writeRaster(r, dest, overwrite = TRUE, datatype = "FLT4S",
                     gdal = c("COMPRESS=DEFLATE", "PREDICTOR=3", "TILED=YES"))
  dest
}

tile_grid <- function(x, y, size_m) {
  tibble::tibble(x0 = floor(x / size_m) * size_m, y0 = floor(y / size_m) * size_m) |>
    dplyr::count(x0, y0, name = "points")
}

# which DEM files describe the climb area; returns paths to two VRTs
dem_prepare <- function(cfg, pts_xy) {
  d <- cfg$dem
  out <- list(fine = NULL, coarse = NULL)
  if (identical(d$source, "folder")) {
    files <- list.files(d$folder, pattern = "\\.(asc|tif|tiff)$", full.names = TRUE, recursive = TRUE, ignore.case = TRUE)
    if (!length(files)) stop("dem.folder has no .asc/.tif tiles: ", d$folder, call. = FALSE)
    out$fine <- work_file(cfg, "dem_folder.vrt")
    terra::vrt(files, out$fine, overwrite = TRUE)
    say("DEM: %d tiles from %s", length(files), d$folder)
    return(out)
  }
  if (cfg$crs != 2154) stop("dem.source ign_wms only covers France (EPSG:2154); use dem.source: folder", call. = FALSE)
  raw <- file.path(cfg$paths$raw, "dem")

  # 1. coarse model of the whole area
  ct <- d$coarse_tile_km * 1000
  coarse_tiles <- tile_grid(pts_xy$x, pts_xy$y, ct)
  say("DEM %d m: %d tiles", d$coarse_res_m, nrow(coarse_tiles))
  cf <- purrr::pmap_chr(coarse_tiles, function(x0, y0, points)
    ign_tile(d$layer, x0, y0, ct, d$coarse_res_m, file.path(raw, paste0("r", d$coarse_res_m), sprintf("%d_%d.tif", x0, y0))))
  out$coarse <- work_file(cfg, "dem_coarse.vrt")
  terra::vrt(cf, out$coarse, overwrite = TRUE)

  # 2. fine model where there is relief and there are paths
  ft <- d$tile_km * 1000
  fine_tiles <- tile_grid(pts_xy$x, pts_xy$y, ft)
  coarse <- terra::rast(out$coarse)
  fine_tiles$relief <- purrr::pmap_dbl(fine_tiles, function(x0, y0, points) {
    v <- terra::values(terra::crop(coarse, terra::ext(x0, x0 + ft, y0, y0 + ft)), mat = FALSE)
    if (all(is.na(v))) NA_real_ else diff(range(v, na.rm = TRUE))
  })
  fine_tiles <- dplyr::filter(fine_tiles, !is.na(relief), relief >= d$relief_min_m)
  say("DEM %d m: %d tiles with \u2265 %d m of relief (\u2248 %.0f MB to fetch the first time)",
      d$fine_res_m, nrow(fine_tiles), d$relief_min_m, nrow(fine_tiles) * 8)
  if (nrow(fine_tiles)) {
    ff <- purrr::pmap_chr(dplyr::select(fine_tiles, x0, y0), function(x0, y0)
      ign_tile(d$layer, x0, y0, ft, d$fine_res_m, file.path(raw, paste0("r", d$fine_res_m), sprintf("%d_%d.tif", x0, y0))))
    out$fine <- work_file(cfg, "dem_fine.vrt")
    terra::vrt(ff, out$fine, overwrite = TRUE)
  }
  out
}

dem_extract <- function(dem, x, y, chunk = 5e5) {
  z <- rep(NA_real_, length(x))
  pull <- function(path, idx) {
    r <- terra::rast(path)
    for (s in split(idx, ceiling(seq_along(idx) / chunk)))
      z[s] <<- terra::extract(r, cbind(x[s], y[s]), method = "bilinear")[, 1]
  }
  if (!is.null(dem$fine)) pull(dem$fine, seq_along(x))
  miss <- which(is.na(z))
  if (length(miss) && !is.null(dem$coarse)) pull(dem$coarse, miss)
  z
}

# points every `step` metres along each edge (vertices kept)
densify <- function(verts, step) {
  verts <- dplyr::arrange(verts, edge, s)
  seg <- verts |>
    dplyr::mutate(x1 = dplyr::lead(x), y1 = dplyr::lead(y), s1 = dplyr::lead(s), e1 = dplyr::lead(edge)) |>
    dplyr::filter(!is.na(e1), e1 == edge) |>
    dplyr::mutate(k = pmax(1L, as.integer(ceiling((s1 - s) / step))))
  i <- rep(seq_len(nrow(seg)), seg$k)
  t <- (sequence(seg$k) - 1) / seg$k[i]
  inner <- tibble::tibble(edge = seg$edge[i],
                          x = seg$x[i] + t * (seg$x1[i] - seg$x[i]),
                          y = seg$y[i] + t * (seg$y1[i] - seg$y[i]),
                          s = seg$s[i] + t * (seg$s1[i] - seg$s[i]))
  last <- verts |> dplyr::filter(edge != dplyr::lead(edge, default = -1L)) |> dplyr::select(edge, x, y, s)
  dplyr::bind_rows(inner, last) |> dplyr::arrange(edge, s)
}

# elevation along every edge that can be part of a climb
edge_profiles <- function(net, cfg, dem = NULL) {
  cl <- cfg$climbs
  use <- net$edges |> dplyr::filter(climb_ok, in_area) |> dplyr::pull(edge)
  verts <- dplyr::filter(net$verts, edge %in% use)
  if (is.null(dem)) dem <- dem_prepare(cfg, verts)
  pts <- densify(verts, cl$densify_m)
  say("elevation at %d points along %d edges", nrow(pts), length(use))
  pts$z <- dem_extract(dem, pts$x, pts$y)

  # holes (edge of the model, no-data): fill along the edge; an edge with
  # no elevation at all cannot be part of a climb
  holes <- unique(pts$edge[is.na(pts$z)])
  if (length(holes)) {
    fixed <- pts |>
      dplyr::filter(edge %in% holes) |>
      dplyr::group_by(edge) |>
      dplyr::filter(sum(!is.na(z)) >= 1) |>
      dplyr::mutate(z = stats::approx(s, z, s, rule = 2, ties = mean)$y) |>
      dplyr::ungroup()
    say("%d edges with gaps in the elevation model: %d filled along the way, %d left out",
        length(holes), dplyr::n_distinct(fixed$edge), length(holes) - dplyr::n_distinct(fixed$edge))
    pts <- dplyr::bind_rows(dplyr::filter(pts, !edge %in% holes), fixed) |> dplyr::arrange(edge, s)
  }

  h <- max(1L, round(cl$edge_smooth_m / 2 / cl$densify_m))
  pts$zs <- roll_mean_by(roll_mean_by(pts$z, pts$edge, h), pts$edge, h)
  list(pts = pts, dem = dem)
}

# cut edges at inner high/low points, so climbs can start and end there
split_at_bumps <- function(net, pts, thr) {
  summ <- pts |>
    dplyr::group_by(edge) |>
    dplyr::summarise(z1 = dplyr::first(zs), z2 = dplyr::last(zs), hi = max(zs), lo = min(zs), n = dplyr::n(), .groups = "drop") |>
    dplyr::filter(n >= 3, hi > pmax(z1, z2) + thr | lo < pmin(z1, z2) - thr)
  cuts <- pts |>
    dplyr::filter(edge %in% summ$edge) |>
    dplyr::group_by(edge) |>
    dplyr::summarise(k = list(turning_points(zs, thr)), .groups = "drop") |>
    dplyr::filter(lengths(k) > 0)
  if (!nrow(cuts)) { say("no humps to cut"); return(list(net = net, pts = pts)) }

  cut_long <- tidyr::unnest_longer(cuts, k) |> dplyr::mutate(cut = TRUE)
  sub <- pts |>
    dplyr::filter(edge %in% cuts$edge) |>
    dplyr::group_by(edge) |>
    dplyr::mutate(i = dplyr::row_number()) |>
    dplyr::ungroup() |>
    dplyr::left_join(cut_long, by = c("edge", i = "k")) |>
    dplyr::mutate(cut = dplyr::coalesce(cut, FALSE)) |>
    dplyr::group_by(edge) |>
    dplyr::mutate(part = cumsum(cut)) |>
    dplyr::ungroup()
  dup <- sub |> dplyr::filter(cut) |> dplyr::mutate(part = part - 1L)
  next_node <- max(net$nodes$node)
  new_nodes <- sub |> dplyr::filter(cut) |>
    dplyr::mutate(node = next_node + dplyr::row_number()) |>
    dplyr::select(edge, i, node, x, y)
  next_edge <- max(net$edges$edge)
  sub <- dplyr::bind_rows(sub, dup) |>
    dplyr::arrange(edge, part, i) |>
    dplyr::mutate(new_edge = next_edge + dplyr::consecutive_id(edge, part))

  # new edges: same way attributes as the edge they come from
  parent <- dplyr::filter(net$edges, edge %in% cuts$edge)
  ends <- sub |>
    dplyr::group_by(new_edge) |>
    dplyr::summarise(edge = dplyr::first(edge), i1 = dplyr::first(i), i2 = dplyr::last(i),
                     s1 = dplyr::first(s), len = dplyr::last(s) - dplyr::first(s), .groups = "drop") |>
    dplyr::left_join(dplyr::select(new_nodes, edge, i, n1 = node), by = c("edge", i1 = "i")) |>
    dplyr::left_join(dplyr::select(new_nodes, edge, i, n2 = node), by = c("edge", i2 = "i")) |>
    dplyr::left_join(dplyr::select(parent, edge, from, to), by = "edge") |>
    dplyr::mutate(from = dplyr::coalesce(n1, from), to = dplyr::coalesce(n2, to))
  new_edges <- ends |>
    dplyr::select(new_edge, edge, from, to, len) |>
    dplyr::left_join(dplyr::select(parent, -from, -to, -len), by = "edge") |>
    dplyr::rename(parent = edge, edge = new_edge)

  pts_new <- sub |>
    dplyr::left_join(dplyr::select(ends, new_edge, s1), by = "new_edge") |>
    dplyr::transmute(edge = new_edge, x, y, s = s - s1, z, zs)
  verts_new <- dplyr::select(pts_new, edge, x, y, s)

  net$edges <- dplyr::bind_rows(dplyr::filter(net$edges, !edge %in% cuts$edge),
                                dplyr::mutate(new_edges, parent = as.integer(parent)))
  net$verts <- dplyr::bind_rows(dplyr::filter(net$verts, !edge %in% cuts$edge), verts_new)
  net$nodes <- dplyr::bind_rows(net$nodes, dplyr::select(new_nodes, node, x, y))
  pts <- dplyr::bind_rows(dplyr::filter(pts, !edge %in% cuts$edge), pts_new) |> dplyr::arrange(edge, s)
  check_unique(net$edges, "edge", "edges after cutting humps")
  say("cut %d ways at %d humps/dips", nrow(cuts), nrow(new_nodes))
  list(net = net, pts = pts)
}

# elevation of each junction (raw model value, same for every edge there)
node_elevation <- function(net, pts) {
  pts <- dplyr::arrange(pts, edge, s)
  first <- pts$edge != dplyr::lag(pts$edge, default = -1L)
  last <- pts$edge != dplyr::lead(pts$edge, default = -1L)
  ends <- dplyr::bind_rows(
    pts[first, ] |> dplyr::inner_join(dplyr::select(net$edges, edge, node = from), by = "edge"),
    pts[last, ] |> dplyr::inner_join(dplyr::select(net$edges, edge, node = to), by = "edge")) |>
    dplyr::group_by(node) |>
    dplyr::summarise(z = mean(z), .groups = "drop")
  n0 <- nrow(net$nodes)
  net$nodes <- net$nodes |> dplyr::select(-dplyr::any_of("z")) |> dplyr::left_join(ends, by = "node")
  check_rows(n0, nrow(net$nodes), "junction elevations", allow_drop = FALSE)
  net
}

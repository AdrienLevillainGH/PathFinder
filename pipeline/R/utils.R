# ------------------------------------------------------------------
# PathFinder pipeline - small helpers shared by every step
# ------------------------------------------------------------------

say <- function(...) message(format(Sys.time(), "%H:%M:%S"), "  ", sprintf(...))

# run `code` once and keep the result: later runs read the .rds back.
# Delete the file (or pass force = TRUE) to recompute that step.
cached <- function(path, code, force = FALSE) {
  if (!force && file.exists(path)) {
    say("cached  %s", basename(path))
    return(readRDS(path))
  }
  value <- code
  dir.create(dirname(path), recursive = TRUE, showWarnings = FALSE)
  saveRDS(value, path)
  value
}

# OSM "other_tags" (hstore text: "key"=>"value","k2"=>"v2") -> one tag
hstore_get <- function(x, key) {
  x <- ifelse(is.na(x), "", x)
  pat <- sprintf('"%s"=>"([^"]*)"', key)
  out <- rep(NA_character_, length(x))
  m <- regexpr(pat, x, perl = TRUE)
  hit <- m > 0
  out[hit] <- sub(pat, "\\1", regmatches(x, m), perl = TRUE)
  out
}

# centred moving average inside contiguous groups (g must be sorted so
# that each group is one block); windows shrink at group edges
roll_mean_by <- function(z, g, h) {
  n <- length(z)
  if (n == 0 || h < 1) return(z)
  i <- seq_len(n)
  first <- match(g, g)
  last <- n + 1L - match(g, rev(g))
  lo <- pmax(i - h, first)
  hi <- pmin(i + h, last)
  cs <- c(0, cumsum(z))
  (cs[hi + 1] - cs[lo]) / (hi - lo + 1)
}

# interior turning points of a profile, with hysteresis `thr` (metres):
# a high point counts only if the profile rose at least thr to it and
# falls at least thr after it (same for low points)
turning_points <- function(z, thr) {
  n <- length(z)
  if (n < 3) return(integer(0))
  pts <- 1L
  hi <- 1L
  lo <- 1L
  dir <- 0L
  for (i in 2:n) {
    last <- pts[length(pts)]
    if (z[i] > z[hi]) hi <- i
    if (z[i] < z[lo]) lo <- i
    if (dir >= 0L && hi > last && z[hi] - z[i] >= thr && z[hi] - z[last] >= thr) {
      pts <- c(pts, hi); dir <- -1L; hi <- i; lo <- i
    } else if (dir <= 0L && lo > last && z[i] - z[lo] >= thr && z[last] - z[lo] >= thr) {
      pts <- c(pts, lo); dir <- 1L; hi <- i; lo <- i
    }
  }
  pts <- pts[-1]
  pts[pts > 1L & pts < n]
}

# runs of codes -> [[first step (0-based), code], ...] as in the app
runs <- function(codes) {
  r <- rle(codes)
  starts <- c(0L, cumsum(r$lengths))[seq_along(r$lengths)]
  Map(function(k, v) list(k, v), starts, r$values) |> unname()
}

# stable short ids: a 31-bit polynomial hash in base 36
to_b36 <- function(n) {
  digits <- c(0:9, letters)
  vapply(n, function(v) {
    if (v == 0) return("0")
    out <- character(0)
    while (v > 0) { out <- c(digits[v %% 36 + 1], out); v <- v %/% 36 }
    paste(out, collapse = "")
  }, "")
}
hash_id <- function(s, prefix = "") {
  h <- vapply(s, function(x) {
    v <- 0
    for (cp in utf8ToInt(enc2utf8(x))) v <- (v * 131 + cp) %% 2147483629
    v
  }, 0)
  paste0(prefix, to_b36(h))
}

# compass point a climb starts from, seen from its top
WINDS <- c("north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west")
wind8 <- function(dx, dy) {
  b <- (atan2(dx, dy) * 180 / pi) %% 360
  WINDS[((b + 22.5) %% 360) %/% 45 + 1]
}

norm_name <- function(x) {
  x <- stringi::stri_trans_general(x, "Latin-ASCII")
  x <- tolower(gsub("[^A-Za-z0-9]+", " ", x))
  trimws(gsub("\\s+", " ", x))
}

# lon/lat <-> Lambert-93 (or any metric CRS) for plain matrices
to_metric <- function(lon, lat, crs) {
  p <- sf::sf_project("EPSG:4326", sf::st_crs(crs)$wkt, cbind(lon, lat))
  list(x = p[, 1], y = p[, 2])
}
to_lonlat <- function(x, y, crs) {
  p <- sf::sf_project(sf::st_crs(crs)$wkt, "EPSG:4326", cbind(x, y))
  list(lon = p[, 1], lat = p[, 2])
}

# checks that stop the run with a clear message instead of a silent error
check_unique <- function(df, key, what) {
  d <- df |> dplyr::count(dplyr::across(dplyr::all_of(key))) |> dplyr::filter(n > 1)
  if (nrow(d)) stop(sprintf("%s: %d duplicated %s", what, nrow(d), paste(key, collapse = "+")), call. = FALSE)
  invisible(df)
}
check_rows <- function(before, after, what, allow_drop = TRUE) {
  if (after > before) stop(sprintf("%s: rows went up (%d \u2192 %d), a join duplicated rows", what, before, after), call. = FALSE)
  if (!allow_drop && after < before) stop(sprintf("%s: rows lost (%d \u2192 %d)", what, before, after), call. = FALSE)
  if (after < before) say("%s: %d \u2192 %d rows", what, before, after)
  invisible(TRUE)
}

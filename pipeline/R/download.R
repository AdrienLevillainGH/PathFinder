# ------------------------------------------------------------------
# Downloads: OpenStreetMap extracts (Geofabrik) and GTFS timetables.
# Elevation tiles are fetched in elevation.R, tile by tile.
# Everything lands in pipeline/data-raw/ and is reused by all regions.
# ------------------------------------------------------------------

download_once <- function(url, dest, max_age_days = Inf, min_bytes = 1000) {
  fresh <- file.exists(dest) && file.size(dest) > min_bytes &&
    difftime(Sys.time(), file.mtime(dest), units = "days") < max_age_days
  if (fresh) return(dest)
  dir.create(dirname(dest), recursive = TRUE, showWarnings = FALSE)
  part <- paste0(dest, ".part")
  old <- options(timeout = max(3600, getOption("timeout")))
  on.exit(options(old), add = TRUE)
  say("download %s", url)
  ok <- tryCatch({ utils::download.file(url, part, mode = "wb", quiet = TRUE); TRUE },
                 error = function(e) { message(conditionMessage(e)); FALSE })
  if (!ok || !file.exists(part) || file.size(part) < min_bytes) {
    if (file.exists(dest)) { warning("download failed, keeping the older copy of ", basename(dest)); return(dest) }
    stop("could not download ", url, call. = FALSE)
  }
  file.rename(part, dest)
  say("  %s, %.1f MB", basename(dest), file.size(dest) / 1e6)
  dest
}

osm_files <- function(cfg, extracts = cfg$osm$extracts) {
  vapply(extracts, function(p) {
    dest <- file.path(cfg$paths$raw, "osm", paste0(basename(p), "-latest.osm.pbf"))
    download_once(sprintf("https://download.geofabrik.de/%s-latest.osm.pbf", p), dest, max_age_days = 60)
  }, "")
}

gtfs_files <- function(cfg) {
  feeds <- cfg$transit$feeds
  paths <- vapply(feeds, function(f) {
    dest <- file.path(cfg$paths$raw, "gtfs", paste0(f$id, ".zip"))
    download_once(f$url, dest, max_age_days = cfg$transit$max_age_days %||% 7)
  }, "")
  stats::setNames(paths, vapply(feeds, `[[`, "", "id"))
}

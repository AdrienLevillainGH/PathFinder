# ------------------------------------------------------------------
# Region packs: one YAML per region, `extends:` to inherit a parent
# (bruche.yml = alsace.yml with a smaller box). Everything a region
# needs to know lives in its YAML; the R code stays region-agnostic.
# ------------------------------------------------------------------

load_config <- function(id, dir = here::here("pipeline", "config")) {
  file <- file.path(dir, paste0(id, ".yml"))
  if (!file.exists(file)) stop("no config ", file, call. = FALSE)
  cfg <- read_yaml_utf8(file)
  if (!is.null(cfg$extends)) {
    parent <- load_config(cfg$extends, dir)
    parent$paths <- NULL
    cfg <- merge_config(parent, cfg[setdiff(names(cfg), "extends")])
  }
  root <- here::here("pipeline")
  cfg$paths <- list(
    raw = file.path(root, "data-raw"),               # downloads, shared by regions
    work = file.path(root, "work", cfg$id),          # one .rds per step
    out = file.path(root, "out", cfg$id)             # JSON for the app + diagnostics
  )
  for (p in cfg$paths) dir.create(p, recursive = TRUE, showWarnings = FALSE)
  cfg
}

work_file <- function(cfg, name) file.path(cfg$paths$work, name)

# the study area: the box, buffered, in the metric CRS and in lon/lat
area_polygon <- function(cfg) {
  b <- unlist(cfg$area$bbox)
  box <- sf::st_bbox(c(xmin = b[1], ymin = b[2], xmax = b[3], ymax = b[4]), crs = 4326) |> sf::st_as_sfc()
  metric <- sf::st_transform(box, cfg$crs) |> sf::st_buffer((cfg$area$buffer_km %||% 0) * 1000)
  list(metric = metric, lonlat = sf::st_transform(metric, 4326))
}

`%||%` <- function(a, b) if (is.null(a)) b else a

# UTF-8 whatever the session's locale (Windows, C, ...)
read_yaml_utf8 <- function(file) {
  yaml::yaml.load(paste(readLines(file, encoding = "UTF-8", warn = FALSE), collapse = "\n"))
}

# child settings win; maps merge key by key, lists (feeds, windows) are replaced whole
merge_config <- function(x, y) {
  named <- function(v) is.list(v) && !is.null(names(v)) && all(names(v) != "")
  for (k in names(y)) x[[k]] <- if (named(x[[k]]) && named(y[[k]])) merge_config(x[[k]], y[[k]]) else y[[k]]
  x
}

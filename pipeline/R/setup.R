# ------------------------------------------------------------------
# Checks run at the start of run_region(), so a missing package or a
# missing Java stops the run in the first second, not after an hour.
# ------------------------------------------------------------------

PIPELINE_PKGS <- c("here", "yaml", "dplyr", "tidyr", "purrr", "stringi", "sf", "terra", "igraph",
                   "data.table", "jsonlite", "zip", "ggplot2", "r5r", "rJavaEnv")

# major version of the Java that rJava (hence r5r) will start
java_major <- function() {
  jh <- Sys.getenv("JAVA_HOME")
  exe <- if (nzchar(jh)) file.path(jh, "bin", "java") else Sys.which("java")
  if (!nzchar(exe)) return(NA_integer_)
  out <- tryCatch(suppressWarnings(system2(exe, "-version", stdout = TRUE, stderr = TRUE)), error = function(e) character())
  m <- regmatches(out, regexpr('version "[0-9]+', out))
  if (!length(m)) return(NA_integer_)
  as.integer(sub('version "', "", m[1]))
}

check_setup <- function(java = TRUE) {
  missing <- PIPELINE_PKGS[!vapply(PIPELINE_PKGS, requireNamespace, logical(1), quietly = TRUE)]
  if (length(missing))
    stop("Some R packages are missing. Run this in the console, then try again:\n  install.packages(c(",
         paste0('"', missing, '"', collapse = ", "), "))", call. = FALSE)
  if (!"OSM" %in% sf::st_drivers()$name)
    stop("This installation of sf cannot read OpenStreetMap files (GDAL without its OSM driver).\n",
         "Reinstall sf: install.packages(\"sf\")", call. = FALSE)
  if (java) {
    v <- java_major()
    if (is.na(v) || v < 21)
      stop("The travel-time step (r5r) needs Java 21", if (!is.na(v)) sprintf(" (found Java %d)", v), ".\n",
           "Run this once in the console, answer yes, then Session > Restart R:\n",
           "  rJavaEnv::java_quick_install(version = 21)", call. = FALSE)
  }
  say("setup ok: packages, OpenStreetMap reader%s", if (java) sprintf(", Java %d", java_major()) else "")
  invisible(TRUE)
}

# ------------------------------------------------------------------
# Diagnostic maps and charts (ggplot2), saved next to the export:
# pipeline/out/<region>/diag/*.png. Look at them before trusting a run.
# ------------------------------------------------------------------

WAY_COLS <- c(m = "#8C6D46", p = "#C8A46E", t = "#9AA7B4", r = "#5E6670")
WAY_LABS <- c(m = "Mountain path", p = "Hiking path", t = "Forest track", r = "Road")

diag_theme <- function() {
  ggplot2::theme_minimal(base_size = 10) +
    ggplot2::theme(panel.grid = ggplot2::element_line(colour = "grey92", linewidth = 0.3),
                   legend.position = "bottom", plot.title.position = "plot", legend.key.width = ggplot2::unit(1.5, "cm"))
}

# a chart that fails is reported and skipped: it never stops a run
diag_save <- function(p, cfg, name, w = 8, h = 8) {
  dir <- file.path(cfg$paths$out, "diag")
  dir.create(dir, recursive = TRUE, showWarnings = FALSE)
  f <- file.path(dir, name)
  ok <- tryCatch({ ggplot2::ggsave(f, p, width = w, height = h, dpi = 150, bg = "white"); TRUE },
                 error = function(e) { warning("chart ", name, " not drawn: ", conditionMessage(e), call. = FALSE); FALSE })
  if (ok) f else character()
}

diagnostics <- function(cfg, net, prof, acc = NULL, tp = NULL, ttm = NULL) {
  files <- character()
  km <- function(v) v / 1000

  # 1. the network that climbs can use, by way type
  ev <- net$verts |>
    dplyr::inner_join(dplyr::filter(net$edges, climb_ok, in_area) |> dplyr::select(edge, way), by = "edge")
  p1 <- ggplot2::ggplot(ev, ggplot2::aes(km(x), km(y), group = edge, colour = way)) +
    ggplot2::geom_path(linewidth = 0.15) +
    ggplot2::scale_colour_manual(values = WAY_COLS, labels = WAY_LABS, name = NULL) +
    ggplot2::coord_equal() + ggplot2::labs(x = "Lambert-93 x (km)", y = "y (km)",
      title = sprintf("%s \u00b7 paths, tracks and roads climbs may use (%.0f km)", cfg$name, sum(net$edges$len[net$edges$climb_ok & net$edges$in_area]) / 1000)) +
    diag_theme() + ggplot2::guides(colour = ggplot2::guide_legend(override.aes = list(linewidth = 1.5)))
  files <- c(files, diag_save(p1, cfg, "1_network.png"))

  # 2. the climbs, coloured by average grade, with stops
  cl <- prof |>
    dplyr::mutate(grade = (zt - purrr::map_dbl(z, 1)) / len) |>
    dplyr::select(id, grade, x, y) |>
    tidyr::unnest(c(x, y))
  p2 <- ggplot2::ggplot() +
    ggplot2::geom_path(data = ev, ggplot2::aes(km(x), km(y), group = edge), colour = "grey85", linewidth = 0.1) +
    ggplot2::geom_path(data = cl, ggplot2::aes(km(x), km(y), group = id, colour = grade), linewidth = 0.5) +
    ggplot2::scale_colour_steps(low = "#C9D23F", high = "#A3201B", breaks = c(.05, .1, .15, .2, .25),
                                labels = function(b) paste0(round(100 * b), " %"), name = "average grade") +
    ggplot2::coord_equal() + diag_theme() +
    ggplot2::labs(x = "x (km)", y = "y (km)", title = sprintf("%d climbs", nrow(prof)))
  if (!is.null(tp)) {
    st <- dplyr::filter(tp$places, id %in% c(acc$place, tp$hubs$id))
    p2 <- p2 + ggplot2::geom_point(data = st, ggplot2::aes(km(x), km(y), shape = kind), size = 1.3) +
      ggplot2::scale_shape_manual(values = c(rail = 15, coach = 1), name = NULL) +
      ggplot2::geom_text(data = dplyr::filter(st, id %in% tp$hubs$id), ggplot2::aes(km(x), km(y), label = name),
                         size = 3, vjust = -0.8, check_overlap = TRUE)
  }
  files <- c(files, diag_save(p2, cfg, "2_climbs.png"))

  # 3. how the climbs are spread: gain against length
  s3 <- prof |> dplyr::mutate(gain = zt - purrr::map_dbl(z, 1), steep = gain / len)
  p3 <- ggplot2::ggplot(s3, ggplot2::aes(len, gain, colour = steep)) +
    ggplot2::geom_abline(slope = c(.05, .1, .15, .2), intercept = 0, colour = "grey80", linetype = 2) +
    ggplot2::geom_point(size = 1, alpha = .7) +
    ggplot2::scale_colour_steps(low = "#C9D23F", high = "#A3201B", name = "average grade") +
    ggplot2::labs(x = "length (m)", y = "net gain (m)", title = "Climbs: gain vs length (dashed: 5, 10, 15, 20 %)") +
    diag_theme()
  files <- c(files, diag_save(p3, cfg, "3_gain_length.png", 7, 5))

  # 4. the twelve biggest climbs' profiles
  top <- s3 |> dplyr::slice_max(gain, n = 12, with_ties = FALSE) |>
    dplyr::mutate(d = purrr::map2(n, len, function(n, L) seq(0, L, length.out = n))) |>
    dplyr::select(name, d, z) |> tidyr::unnest(c(d, z))
  p4 <- ggplot2::ggplot(top, ggplot2::aes(d / 1000, z)) +
    ggplot2::geom_area(fill = "#E3D2B4", colour = "#564637", linewidth = .3) +
    ggplot2::facet_wrap(~name, scales = "free", ncol = 3) +
    ggplot2::coord_cartesian(ylim = NULL) +
    ggplot2::labs(x = "km", y = "m", title = "The 12 biggest climbs") + diag_theme() +
    ggplot2::theme(strip.text = ggplot2::element_text(size = 7))
  files <- c(files, diag_save(p4, cfg, "4_profiles.png", 10, 9))

  # 5. train/coach minutes from the first hub, first window
  if (!is.null(ttm) && length(ttm)) {
    h <- tp$hubs[1, ]
    w <- names(ttm)[1]
    t5 <- ttm[[w]] |> dplyr::filter(hub == h$id) |> dplyr::inner_join(tp$places, by = c(place = "id"))
    p5 <- ggplot2::ggplot(t5, ggplot2::aes(km(x), km(y), colour = p50, shape = kind)) +
      ggplot2::geom_point(size = 1.6) +
      ggplot2::scale_colour_steps(low = "#F2E3B3", high = "#3B2A6B", breaks = c(15, 30, 45, 60, 90), name = "minutes") +
      ggplot2::scale_shape_manual(values = c(rail = 15, coach = 16), name = NULL) +
      ggplot2::coord_equal() + diag_theme() +
      ggplot2::labs(x = "x (km)", y = "y (km)", title = sprintf("From %s, window %s: on board + changes", h$name, w))
    files <- c(files, diag_save(p5, cfg, "5_times.png"))
  }
  say("diagnostics: %s", paste(basename(files), collapse = ", "))
  invisible(files)
}

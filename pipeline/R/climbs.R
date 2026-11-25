# ------------------------------------------------------------------
# Climb catalogue: the steepest ways up to every high point.
#
# 1. Every edge that may be part of a climb gets a direction: you may
#    run it from a to b if b is not more than flat_tol below a.
# 2. A "top" is a junction higher than all its neighbours (edges were
#    already cut at humps, so tops include summits mid-way along a path).
# 3. From each top, a reverse shortest-path search (length; roads count
#    a bit longer) gives the most direct way up from every lower point.
#    The branches' lowest points are the candidate starts; the best
#    few per compass sector are kept.
# 4. The flat run-up at the bottom is trimmed; climbs gaining less than
#    min_gain, or mostly on roads, are dropped; a climb that shares more
#    than max_overlap of its length with a better one is dropped.
# 5. Profiles: elevation every 10 m along the line, smoothed, then every
#    20 m (the app's step), with way type and surface per step.
#
# The app's engine then finds the best stretch inside each climb, both
# ways up and down, for whatever filter the user sets.
# ------------------------------------------------------------------

climb_graph <- function(net, pts, cfg) {
  cl <- cfg$climbs
  nodes <- dplyr::filter(net$nodes, !is.na(z))
  e <- net$edges |>
    dplyr::filter(climb_ok, in_area, edge %in% unique(pts$edge), from != to) |>
    dplyr::mutate(zf = nodes$z[match(from, nodes$node)], zt = nodes$z[match(to, nodes$node)],
                  w = len * (1 + cl$road_penalty * road)) |>
    dplyr::filter(!is.na(zf), !is.na(zt))
  arcs <- dplyr::bind_rows(
    e |> dplyr::filter(zt - zf >= -cl$flat_tol_m) |> dplyr::transmute(a = from, b = to, edge, rev = FALSE, w, len, road),
    e |> dplyr::filter(zf - zt >= -cl$flat_tol_m) |> dplyr::transmute(a = to, b = from, edge, rev = TRUE, w, len, road))
  vids <- sort(unique(c(arcs$a, arcs$b)))
  V <- tibble::tibble(node = vids) |> dplyr::left_join(nodes, by = "node")
  g <- igraph::make_graph(rbind(match(arcs$a, vids), match(arcs$b, vids)), n = length(vids), directed = TRUE)
  igraph::V(g)$vid <- seq_along(vids)
  igraph::E(g)$arc <- seq_len(nrow(arcs))
  igraph::E(g)$w <- arcs$w

  # tops: higher than every neighbour, and reachable from below
  nb <- dplyr::bind_rows(dplyr::transmute(e, v = from, zu = zt), dplyr::transmute(e, v = to, zu = zf)) |>
    dplyr::group_by(v) |>
    dplyr::summarise(max_nb = max(zu), .groups = "drop")
  tops <- V |>
    dplyr::inner_join(nb, by = c(node = "v")) |>
    dplyr::filter(z > max_nb) |>
    dplyr::mutate(vid = match(node, vids))
  tops <- tops[igraph::degree(g, tops$vid, mode = "in") > 0, ]
  say("climb graph: %d junctions, %d one-way steps, %d tops", length(vids), nrow(arcs), nrow(tops))
  list(g = g, arcs = arcs, V = V, tops = tops, edges = e)
}

climb_candidates <- function(G, cfg) {
  cl <- cfg$climbs
  R <- cl$max_len_m
  tm <- cl$tile_km * 1000
  tops <- G$tops |> dplyr::mutate(tx = floor(x / tm), ty = floor(y / tm))
  V <- G$V
  out <- vector("list", nrow(tops))
  n_out <- 0L
  tiles <- split(tops, list(tops$tx, tops$ty), drop = TRUE)
  say("searching %d tops in %d tiles", nrow(tops), length(tiles))
  for (tile in tiles) {
    x0 <- tile$tx[1] * tm - R; y0 <- tile$ty[1] * tm - R
    inside <- which(V$x >= x0 & V$x <= x0 + tm + 2 * R & V$y >= y0 & V$y <= y0 + tm + 2 * R)
    sg <- igraph::induced_subgraph(G$g, inside)
    svid <- igraph::V(sg)$vid
    sarc <- igraph::E(sg)$arc
    sw <- igraph::E(sg)$w
    el <- igraph::as_edgelist(sg, names = FALSE)
    for (k in seq_len(nrow(tile))) {
      t <- match(tile$vid[k], svid)
      d <- igraph::distances(sg, v = t, mode = "in", weights = sw)[1, ]
      ok <- is.finite(d) & d <= R
      if (sum(ok) < 2) next
      # shortest-path tree: each node's next step towards the top
      tree <- ok[el[, 1]] & ok[el[, 2]] & abs(sw + d[el[, 2]] - d[el[, 1]]) < 1e-6
      ta <- el[tree, 1]; tb <- el[tree, 2]
      tb <- tb[!duplicated(ta)]
      leaves <- setdiff(which(ok), c(t, tb))
      if (!length(leaves)) next
      zt <- V$z[svid[t]]
      gain <- zt - V$z[svid[leaves]]
      keep <- gain >= cl$min_gain_m
      if (!any(keep)) next
      leaves <- leaves[keep]; gain <- gain[keep]
      dx <- V$x[svid[leaves]] - V$x[svid[t]]
      dy <- V$y[svid[leaves]] - V$y[svid[t]]
      sector <- ((atan2(dx, dy) * 180 / pi + 22.5) %% 360) %/% 45
      o <- order(sector, -gain)
      rank <- sequence(rle(sector[o])$lengths)
      pick <- leaves[o][rank <= cl$per_sector]
      ep <- suppressWarnings(igraph::shortest_paths(sg, from = t, to = pick, mode = "in", weights = sw, output = "epath")$epath)
      for (p in ep) {
        if (!length(p)) next
        n_out <- n_out + 1L
        out[[n_out]] <- list(top = tile$node[k], arcs = rev(sarc[as.integer(p)]))
      }
    }
  }
  out <- out[seq_len(n_out)]
  say("%d candidate lines up", length(out))
  out
}

# trim the flat run-up, measure, drop weak ones, then remove overlaps
# (`used`: edges already in climbs kept by an earlier pass)
climb_select <- function(cands, G, cfg, used = NULL) {
  cl <- cfg$climbs
  A <- G$arcs
  zn <- G$V$z[match(c(A$a, A$b), G$V$node)]
  za <- zn[seq_len(nrow(A))]; zb <- zn[nrow(A) + seq_len(nrow(A))]
  rows <- lapply(seq_along(cands), function(i) {
    a <- cands[[i]]$arcs
    zs <- c(za[a[1]], zb[a])                       # junction heights, bottom -> top
    up <- which(zs > zs[1] + cl$trim_tol_m)
    if (!length(up)) return(NULL)
    first <- max(1L, up[1] - 1L)                   # last junction before it starts rising
    a <- a[first:length(a)]
    len <- sum(A$len[a])
    gain <- zs[length(zs)] - zs[first]
    road <- sum(A$len[a] * A$road[a]) / len
    if (gain < cl$min_gain_m || len < cl$min_len_m || len > cl$max_len_m || road > cl$max_road_share) return(NULL)
    list(top = cands[[i]]$top, arcs = a, len = len, gain = gain)
  })
  rows <- Filter(Negate(is.null), rows)
  rows <- rows[order(-vapply(rows, `[[`, 0, "gain"))]
  if (is.null(used)) used <- logical(max(A$edge))
  keep <- logical(length(rows))
  for (i in seq_along(rows)) {
    e <- A$edge[rows[[i]]$arcs]
    l <- A$len[rows[[i]]$arcs]
    if (sum(l[used[e]]) / sum(l) <= cl$max_overlap) { keep[i] <- TRUE; used[e] <- TRUE }
  }
  rows <- rows[keep]
  say("%d climbs kept (gain \u2265 %d m, \u2264 %.0f %% shared with a better one)", length(rows), cl$min_gain_m, 100 * cl$max_overlap)
  attr(rows, "used") <- used
  rows
}

# the most direct way up hides gentler alternatives (a switchback path
# next to a straight track). Later passes make edges already used cost
# more, so the next-best lines up come out too.
climb_catalogue <- function(G, cfg) {
  cl <- cfg$climbs
  used <- logical(max(G$arcs$edge))
  sel <- list()
  for (pass in seq_len(cl$passes %||% 1)) {
    igraph::E(G$g)$w <- G$arcs$w * ifelse(used[G$arcs$edge], 1 + (cl$reuse_penalty %||% 3), 1)
    new <- climb_candidates(G, cfg) |> climb_select(G, cfg, used)
    used <- attr(new, "used")
    say("pass %d: +%d climbs", pass, length(new))
    if (!length(new)) break
    sel <- c(sel, new)
  }
  sel
}

SAC_ORDER <- c("hiking", "mountain_hiking", "demanding_mountain_hiking", "alpine_hiking", "demanding_alpine_hiking", "difficult_alpine_hiking")

# 20 m profiles with way type and surface, in lon/lat, ready for the app
climb_profiles <- function(sel, G, pts, net, osm, cfg) {
  cl <- cfg$climbs
  A <- G$arcs
  seqs <- purrr::imap(sel, function(r, i) tibble::tibble(climb = i, ord = seq_along(r$arcs), arc = r$arcs)) |>
    dplyr::bind_rows() |>
    dplyr::mutate(edge = A$edge[arc], rev = A$rev[arc])
  elen <- pts |> dplyr::group_by(edge) |> dplyr::summarise(elen = max(s), .groups = "drop")
  seqs <- seqs |>
    dplyr::left_join(elen, by = "edge") |>
    dplyr::left_join(dplyr::select(net$edges, edge, way, surf, sac, marked, road), by = "edge") |>
    dplyr::group_by(climb) |>
    dplyr::mutate(off = cumsum(elen) - elen) |>
    dplyr::ungroup()
  check_rows(sum(lengths(lapply(sel, `[[`, "arcs"))), nrow(seqs), "climb steps + edge attributes", allow_drop = FALSE)

  P <- seqs |>
    dplyr::select(climb, ord, edge, rev, off, elen) |>
    dplyr::inner_join(dplyr::select(pts, edge, s, x, y, z), by = "edge", relationship = "many-to-many") |>
    dplyr::mutate(sc = off + dplyr::if_else(rev, elen - s, s)) |>
    dplyr::arrange(climb, sc) |>
    dplyr::distinct(climb, sck = round(sc, 1), .keep_all = TRUE)

  h <- max(1L, round(cl$smooth_m / 2 / cl$densify_m))
  Ps <- split(P, P$climb)
  Ss <- split(seqs, seqs$climb)
  prof <- purrr::map(names(Ps), function(k) {
    p <- Ps[[k]]; s <- Ss[[k]]
    L <- max(p$sc)
    sd <- seq(0, L, length.out = max(2, round(L / cl$densify_m) + 1))
    zd <- stats::approx(p$sc, p$z, sd, ties = mean, rule = 2)$y
    one <- rep(1L, length(zd))
    zd <- roll_mean_by(roll_mean_by(zd, one, h), one, h)
    n <- max(2, round(L / cl$step_m) + 1)
    s20 <- seq(0, L, length.out = n)
    mid <- (s20[-1] + s20[-n]) / 2
    at <- findInterval(mid, s$off, all.inside = FALSE)
    at[at < 1] <- 1
    tibble::tibble(
      climb = as.integer(k),
      z = list(round(stats::approx(sd, zd, s20)$y, 1)),
      x = list(stats::approx(p$sc, p$x, s20, ties = mean, rule = 2)$y),
      y = list(stats::approx(p$sc, p$y, s20, ties = mean, rule = 2)$y),
      way = list(s$way[at]), surf = list(s$surf[at]),
      len = L,
      marked = sum(s$elen[s$marked]) / sum(s$elen),
      sac = { v <- s$sac[!is.na(s$sac) & s$sac %in% SAC_ORDER]; if (length(v)) SAC_ORDER[max(match(v, SAC_ORDER))] else NA_character_ })
  }) |> dplyr::bind_rows()

  prof <- prof |>
    dplyr::mutate(
      top = vapply(sel, `[[`, 0, "top")[climb],
      n = lengths(z),
      dplus = purrr::map_dbl(z, function(v) sum(pmax(diff(v), 0))),
      dminus = purrr::map_dbl(z, function(v) sum(pmax(-diff(v), 0))),
      xs = purrr::map_dbl(x, 1), ys = purrr::map_dbl(y, 1),
      xt = purrr::map_dbl(x, dplyr::last), yt = purrr::map_dbl(y, dplyr::last),
      zt = purrr::map_dbl(z, dplyr::last),
      start = A$a[purrr::map_int(sel, function(r) r$arcs[1])][climb],
      end = A$b[purrr::map_int(sel, function(r) r$arcs[length(r$arcs)])][climb],
      track = purrr::map_dbl(way, function(v) mean(v == "t")),
      paved = purrr::map_dbl(surf, function(v) mean(v == "a")))

  prof <- climb_names(prof, osm$features, cfg)
  key <- sprintf("%.0f,%.0f,%.0f,%.0f", prof$xs / 25, prof$ys / 25, prof$xt / 25, prof$yt / 25)
  prof$id <- make.unique(hash_id(key, "c"), sep = "_")
  say("profiles: %d climbs, %.0f km, median gain %.0f m", nrow(prof), sum(prof$len) / 1000, stats::median(prof$zt - purrr::map_dbl(prof$z, 1)))
  prof
}

# "Champ du Feu - north slope": the named summit (or place) at the top,
# and the side of it the climb starts on
climb_names <- function(prof, features, cfg) {
  r <- cfg$climbs$name_radius_m
  towards <- rep(NA_character_, nrow(prof))
  if (!is.null(features) && nrow(features)) {
    for (pr in 1:2) {
      f <- dplyr::filter(features, prio == pr)
      if (!nrow(f)) next
      todo <- which(is.na(towards))
      lim <- if (pr == 1) r else 3 * r
      for (ch in split(todo, ceiling(seq_along(todo) / 500))) {
        d2 <- outer(prof$xt[ch], f$x, "-")^2 + outer(prof$yt[ch], f$y, "-")^2
        j <- max.col(-d2, ties.method = "first")
        best <- d2[cbind(seq_along(ch), j)]
        nm <- f$name[j]
        towards[ch] <- ifelse(best <= lim^2, if (pr == 1) nm else paste("above", nm), NA_character_)
      }
    }
  }
  towards <- ifelse(is.na(towards), sprintf("Point %d m", round(prof$zt)), towards)
  base <- sprintf("%s \u00b7 %s slope", towards, wind8(prof$xs - prof$xt, prof$ys - prof$yt))
  prof$towards <- towards
  # same name twice: number them by gain
  prof <- prof |>
    dplyr::mutate(gain = zt - purrr::map_dbl(z, 1), base = base) |>
    dplyr::group_by(base) |>
    dplyr::mutate(k = rank(-gain, ties.method = "first"),
                  name = dplyr::if_else(dplyr::n() > 1 & k > 1, paste(base, k), base)) |>
    dplyr::ungroup() |>
    dplyr::select(-k, -base)
  prof
}

# ------------------------------------------------------------------
# Pipeline tests on a made-up world (no downloads, no Java):
#   Rscript pipeline/tests/test_pipeline.R
# Every step runs for real except r5r, which is replaced by a
# straight-line stand-in with the same output columns. The export is
# then loaded by the app's own engine (tests/check_export.mjs).
# ------------------------------------------------------------------

suppressPackageStartupMessages({ library(dplyr); library(sf) })
for (f in list.files(here::here("pipeline", "R"), pattern = "\\.R$", full.names = TRUE)) source(f, encoding = "UTF-8")
source(here::here("pipeline", "tests", "make_world.R"))

ok <- function(cond, what) {
  if (!isTRUE(cond)) stop("FAILED: ", what, call. = FALSE)
  message("  ok  ", what)
}

# ---------------------------------------------------------------- helpers
message("helpers")
ok(identical(hstore_get(c('"sac_scale"=>"hiking","surface"=>"rock"', NA, '"x"=>"1"'), "surface"), c("rock", NA, NA)), "hstore_get")
z <- c(0, 5, 12, 20, 14, 9, 15, 30, 40, 38)
ok(identical(turning_points(z, 8), c(4L, 6L)), "turning_points: high at 4, low at 6")
ok(length(turning_points(c(0, 3, 1, 4, 2, 5), 8)) == 0, "turning_points: small bumps ignored")
rm <- roll_mean_by(c(1, 2, 3, 10, 20, 30), c(1, 1, 1, 2, 2, 2), 1)
ok(isTRUE(all.equal(rm, c(1.5, 2, 2.5, 15, 20, 25))), "roll_mean_by stays inside groups")
ok(identical(runs(c("p", "p", "t", "t", "t", "p")), list(list(0L, "p"), list(2L, "t"), list(5L, "p"))), "runs")
ok(wind8(0, -1) == "south" && wind8(1, 0) == "east" && wind8(-1, 1) == "north-west", "wind8")
ok(norm_name("S\u00e9lestat") == "selestat" && norm_name("Saint-Louis (Haut-Rhin)") == "saint louis haut rhin", "norm_name")
ok(!any(duplicated(hash_id(sprintf("k%d", 1:5000), "c"))), "hash ids: no collision in 5000")

d <- scenario_dates(read_yaml_utf8(here::here("pipeline", "config", "alsace.yml"))$transit$scenarios, as.Date("2026-11-25"))
ok(identical(format(d$date), c("2026-11-28", "2026-11-29", "2026-12-02", "2027-07-10", "2027-07-11")), "window dates from 2026-11-25")
# r5r departure times: local clock, summer time included
at <- as.POSIXct(sprintf("%s %02d:%02d:00", as.Date("2027-07-10"), 6, 30), tz = "Europe/Paris")
ok(format(at, "%H:%M %Z") == "06:30 CEST" && format(as.POSIXct("2026-11-28 06:30", tz = "Europe/Paris"), "%Z") == "CET", "local clock times, CET and CEST")

# trips out of r5r's minute-by-minute output
mins <- (6 * 60 + 30):(10 * 60 + 29)
arr <- ifelse(mins <= 7 * 60 + 10, 7 * 60 + 32, ifelse(mins <= 9 * 60 + 10, 9 * 60 + 32, NA))
fake <- tibble::tibble(from_id = "h", to_id = "p", departure_time = sprintf("%02d:%02d:00", mins %/% 60, mins %% 60),
                       draw_number = 1, routes = "TER1", total_time = arr - mins)
ts <- norm_expanded(fake) |> trip_summary()
ok(ts$trips == 2 && ts$p50 == 22 && ts$changes == 0, "trip_summary: 2 trains of 22 min, no wait counted")
fake2 <- dplyr::mutate(fake, routes = "BUS1|TER1")
ok(trip_summary(norm_expanded(fake2))$changes == 1, "trip_summary: one change")
lb <- last_departure(norm_expanded(dplyr::filter(fake, !is.na(total_time))))
ok(lb$last == 9 * 60 + 10, "last departure")
# r5r's walk-only journeys: ignored when long, "any time" when short
walk_long <- dplyr::bind_rows(fake, tibble::tibble(from_id = "h", to_id = "p", departure_time = "10:15:00", draw_number = 1, routes = "[WALK]", total_time = 72))
ok(trip_summary(norm_expanded(walk_long))$trips == 2 && trip_summary(norm_expanded(walk_long))$p50 == 22, "a 72-minute walk is not a trip")
ok(last_departure(norm_expanded(dplyr::filter(walk_long, !is.na(total_time))))$last == 9 * 60 + 10, "nor a way back")
walk_short <- tibble::tibble(from_id = "h", to_id = "q", departure_time = sprintf("07:%02d:00", 0:30), draw_number = 1, routes = "[WALK]", total_time = 12)
ws <- trip_summary(norm_expanded(walk_short))
ok(ws$trips == 99 && ws$p50 == 12, "a 12-minute walk: on foot, any time")
ok(last_departure(norm_expanded(walk_short), 20, 23 * 60 + 30)$last == 23 * 60 + 30, "…and back any time")

# ---------------------------------------------------------------- world
message("world")
root <- here::here("pipeline", "work", "_test")
unlink(root, recursive = TRUE)
W <- make_world(root)
cfg <- load_config("testworld", W$config_dir)
cfg$paths <- list(raw = file.path(root, "raw"), work = file.path(root, "work"), out = file.path(root, "out"))
for (p in cfg$paths) dir.create(p, recursive = TRUE, showWarnings = FALSE)

# ---------------------------------------------------------------- osm
message("osm")
osm <- osm_read(cfg, W$osm)
ok(nrow(osm$lines) == 7 + 22 + 3, "all 32 ways read")
ok(all(c("Mont Test", "Rocher B", "Testheim", "Tour test") %in% osm$features$name) &&
     osm$features$kind[osm$features$name == "Tour test"] == "tower", "summits, tower and village read")
ok(NROW(osm$routes) == 1, "hiking route read")
attrs <- osm_classify(osm$lines, cfg)
ok(attrs$way[attrs$name %in% "Sentier des lacets"] == "m" && attrs$surf[attrs$name %in% "Raidillon"] == "k", "way types and surfaces from tags")
ok(all(attrs$surf[attrs$highway == "tertiary"] == "a"), "roads without surface tag \u2192 paved")
net <- osm_network(osm$lines, attrs) |> osm_flag_edges(osm, cfg)
# grid: 7 rows x 10 + 11 tracks x 5 + 11 lanes; the switchback path joins at 2 points, the steep path at 1
ok(nrow(net$edges) >= 7 * 10 + 11 * 5 + 11 + 2, sprintf("edges cut at junctions (%d)", nrow(net$edges)))
ok(!anyNA(net$edges$from) && !anyNA(net$edges$to), "every edge has both ends")
ok(abs(sum(net$edges$len) - sum(as.numeric(sf::st_length(osm$lines)))) < 1, "edge lengths add up to way lengths")
ok(any(net$edges$marked) && all(net$edges$marked[net$edges$marked] == (net$edges$name[net$edges$marked] %in% "Sentier des lacets")), "marked = the hiking route only")

# ---------------------------------------------------------------- elevation
message("elevation")
ep <- edge_profiles(net, cfg)
true_z <- terrain(ep$pts$x, ep$pts$y)
ok(max(abs(ep$pts$z - true_z)) < 0.5, "DEM sampled at the right place (bilinear, < 0.5 m)")
sp <- split_at_bumps(net, ep$pts, cfg$climbs$split_bump_m)
net2 <- node_elevation(sp$net, sp$pts)
summit <- net2$nodes |> mutate(d = sqrt((x - (X0 + 3000))^2 + (y - (Y0 + 3500))^2)) |> slice_min(d, n = 1)
ok(summit$d < 1 && abs(summit$z - terrain(X0 + 3000, Y0 + 3500)) < 1, "big summit is a junction, at the right height")
hump <- net2$edges |> filter(!is.na(parent))
ok(nrow(hump) > 0, sprintf("tracks over hills cut at their high points (%d new edges)", nrow(hump)))
ok(abs(sum(sp$pts |> group_by(edge) |> summarise(l = max(s)) |> pull(l)) - sum(net2$edges$len[net2$edges$edge %in% sp$pts$edge])) < 1, "lengths kept when cutting")

# ---------------------------------------------------------------- climbs
message("climbs")
G <- climb_graph(net2, sp$pts, cfg)
ok(any(abs(G$tops$x - (X0 + 3000)) < 1 & abs(G$tops$y - (Y0 + 3500)) < 1), "big summit found as a top")
sel <- climb_catalogue(G, cfg)
prof <- climb_profiles(sel, G, sp$pts, net2, osm, cfg)
print(prof |> transmute(id, name, len = round(len), gain = round(zt - purrr::map_dbl(z, 1)), dplus = round(dplus), dminus = round(dminus), track = round(track, 2), marked = round(marked, 2)), n = 30)
ok(nrow(prof) >= 4, "several climbs")
ok(all(prof$dplus >= prof$zt - purrr::map_dbl(prof$z, 1) - 1e-6), "D+ \u2265 net gain")
ok(all(prof$n == lengths(prof$x) & prof$n == lengths(prof$z)), "one point per 20 m step")
ok(all(abs(prof$len / (prof$n - 1) - 20) < 1), "steps of 20 m (\u00b1 1 m)")
ok(all(lengths(prof$way) == prof$n - 1 & lengths(prof$surf) == prof$n - 1), "one way type and surface per step")
ok(!any(duplicated(prof$id)) && !any(duplicated(prof$name)), "ids and names unique")
ok(any(grepl("^Mont Test", prof$name)) && any(grepl("^Rocher B", prof$name)), "named after the summits")
ok(any(prof$marked > 0.5 & grepl("^Mont Test", prof$name)), "2nd pass: the switchback path (marked route) is a climb too")
big <- prof |> filter(grepl("^Mont Test", name)) |> mutate(gain = zt - purrr::map_dbl(z, 1)) |> slice_max(gain, n = 1, with_ties = FALSE)
ok(big$gain > 600 && abs(big$zt - terrain(X0 + 3000, Y0 + 3500)) < 15, sprintf("Mont Test climb gains %.0f m and ends near the top", big$gain))
best_window <- function(z, k) if (length(z) <= k) NA else max(z[(k + 1):length(z)] - z[1:(length(z) - k)])
steep <- prof |> filter(grepl("^Rocher B", name)) |> mutate(w1500 = purrr::map_dbl(z, best_window, k = 75)) |> slice_max(w1500, n = 1, with_ties = FALSE)
ok(steep$w1500 > 330, sprintf("Rocher B: the steep path is in a climb (%.0f m in 1.5 km)", steep$w1500))
zz <- unlist(steep$z); xx <- unlist(steep$x); yy <- unlist(steep$y)
ok(max(abs(zz - terrain(xx, yy))) < 6, "smoothed profile within 6 m of the true terrain")
# a profile's geometry follows the network (no jumps)
jumps <- purrr::map_dbl(seq_len(nrow(prof)), function(i) max(sqrt(diff(prof$x[[i]])^2 + diff(prof$y[[i]])^2)))
ok(all(jumps < 21), "no jumps between consecutive points")

# ---------------------------------------------------------------- timetables
message("timetables")
tp <- transit_prepare(cfg, as.Date("2026-11-25"), zips = W$gtfs)
ok(!"tgv1" %in% tp$feeds[[1]]$g$trips$trip_id, "high-speed train excluded")
rail_log <- tp$feeds[[1]]$log
ok(all(c("2027-07-10") %in% format(rail_log$date[!is.na(rail_log$proxy)])), "summer Saturday borrows a published Saturday")
ok(format(rail_log$proxy[format(rail_log$date) == "2027-07-10"]) == "2027-03-27", "\u2026the busiest of the last six weeks (27 Mar)")
ok(nrow(tp$feeds[[2]]$log) == 0, "coaches published through the summer: nothing borrowed")
patched <- gtfs_service_days(tp$feeds[[1]]$g)
ok(any(patched$date == as.Date("2027-07-10")), "patched train service runs on 10 Jul")
coach_days <- gtfs_service_days(tp$feeds[[2]]$g)
ok(any(coach_days$service_id == "SUMMER" & coach_days$date == as.Date("2027-07-10")) &&
     !any(coach_days$service_id == "SUMMER" & coach_days$date == as.Date("2026-11-28")), "summer coach: July yes, November no")
ok(nrow(tp$places) == 4, sprintf("places: Hubville, Val (station + coach stop), Far, Col du Test (%d)", nrow(tp$places)))
val <- tp$places |> filter(grepl("Val", name))
ok(nrow(val) == 1 && val$kind == "rail" && val$id == "r87000002", "coach stop in front of the station merged into it")
ok(nrow(tp$hubs) == 1 && tp$hubs$name == "Hubville", "hub matched (unknown hub skipped with a warning)")
ok(length(tp$lines) == 1 && paste(sort(tp$lines[[1]]$stops), collapse = ",") == "r87000001,r87000002,r87000003" &&
     tp$lines[[1]]$stops[2] == "r87000002", "rail line for the map, stops in order")
tmp_zip <- file.path(root, "roundtrip.zip")
gtfs_write(tp$feeds[[2]]$g, tmp_zip)
rt <- gtfs_read(tmp_zip)
ok(identical(rt$stop_times, tp$feeds[[2]]$g$stop_times), "GTFS write \u2192 read round trip")

# ---------------------------------------------------------------- access
message("access")
acc <- access_table(net2, prof, tp$places, cfg)
ok(nrow(acc) > 0 && all(acc$d0 >= 0) && all(pmin(acc$d0, acc$d1) <= cfg$access$max_walk_m), "walking distances within the limit")
pl <- tp$places |> select(place = id, px = x, py = y)
chk <- acc |> inner_join(pl, by = "place") |> inner_join(prof |> select(climb = id, xs, ys), by = "climb") |>
  mutate(euclid = sqrt((px - xs)^2 + (py - ys)^2))
ok(all(chk$d0[is.finite(chk$d0) & chk$d0 < 99999] >= chk$euclid[is.finite(chk$d0) & chk$d0 < 99999] - 1), "walking \u2265 straight line")

# ---------------------------------------------------------------- export
message("export")
fake_ttm <- purrr::set_names(purrr::map(tp$scen$id, function(w) {
  tidyr::expand_grid(hub = tp$hubs$id, place = unique(c(acc$place, tp$hubs$id))) |>
    left_join(select(tp$places, hub = id, hx = x, hy = y), by = "hub") |>
    left_join(select(tp$places, place = id, x, y), by = "place") |>
    mutate(p50 = round(5 + sqrt((x - hx)^2 + (y - hy)^2) / 1000 * 1.5), p75 = p50 + 5L, trips = 2L, changes = 0L,
           best = p50, last_back = 19L * 60L + 30L) |>
    select(hub, place, p50, p75, trips, changes, best, last_back)
}), tp$scen$id)
out <- export_app_data(cfg, prof, acc, tp, fake_ttm, ep$dem)
js <- purrr::map(c("meta", "stations", "ttm", "climbs", "access"), function(n) jsonlite::read_json(file.path(out, paste0(n, ".json"))))
ok(length(js[[4]]) == nrow(prof), "climbs.json has every climb")
ok(length(js[[3]]$order) == length(js[[2]]$stations), "ttm order = stations")
ok(all(names(js[[5]]) %in% prof$id), "access keys are climb ids")
files <- diagnostics(cfg, net2, prof, acc, tp, fake_ttm)
ok(all(file.exists(files)), "diagnostic charts written")
# ---------------------------------------------------------------- routing (r5r)
# only where r5r, Java 21 and osmium (to turn the .osm into a .pbf) are installed
if (requireNamespace("r5r", quietly = TRUE) && isTRUE(java_major() >= 21) && nzchar(Sys.which("osmium"))) {
  message("routing (r5r)")
  pbf <- file.path(root, "world.osm.pbf")
  system2("osmium", c("cat", W$osm, "-o", pbf, "--overwrite"))
  tp2 <- tp
  tp2$scen <- dplyr::filter(tp$scen, id %in% c("sat", "sat_summer"))
  tt <- transit_times(cfg, tp2, unique(c(acc$place, tp$hubs$id, tp$places$id)), pbf = pbf)
  print(tt)
  sat <- tt$sat; summer <- tt$sat_summer
  v <- dplyr::filter(sat, place == "r87000002")
  ok(nrow(v) == 1 && v$trips == 2 && v$p50 >= 12 && v$p50 <= 20 && v$changes == 0,
     sprintf("Saturday Hubville -> Val: 2 trains, %s min (12 on board + a few on foot), direct", v$p50))
  ok(v$last_back >= 19 * 60 + 30 && v$last_back <= 19 * 60 + 42,
     sprintf("leave Val by %02d:%02d for the last train (19:42), not the 72-min walk", v$last_back %/% 60, v$last_back %% 60))
  col_sat <- dplyr::filter(sat, place == tp$places$id[tp$places$name == "Col du Test"])
  col_sum <- dplyr::filter(summer, place == tp$places$id[tp$places$name == "Col du Test"])
  ok(nrow(col_sat) == 0, "November Saturday: no coach to Col du Test")
  ok(nrow(col_sum) == 1 && col_sum$changes == 1 && col_sum$trips == 1,
     sprintf("July Saturday: train + summer coach to Col du Test (%s min, %d change)", col_sum$p50, col_sum$changes))
  ok(nrow(dplyr::filter(summer, place == "r87000002")) == 1, "July Saturday: borrowed train days are routed")
}

if (nzchar(Sys.which("node"))) {
  message("app engine")
  status <- system2("node", c(here::here("pipeline", "tests", "check_export.mjs"), out))
  ok(status == 0, "the app's engine loads the export and every result respects the filters")
}
message("\nall pipeline checks pass \u00b7 export in ", out)

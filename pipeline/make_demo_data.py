"""
PathFinder — demo data generator.

Stands in for the real R pipeline (OSM + RGE ALTI + SNCF GTFS + r5r) while
those sources are out of reach. It writes the same five files, in the same
shape, that pipeline/export.R will write later:

    meta.json  stations.json  ttm.json  climbs.json  access.json

Stations, lines and summits are placed where they really are (approximately).
Train times are a schematic of the TER network. Climbs and their profiles are
GENERATED — plausible, not measured. The app says so in its banner.
"""

import json, math, random
from pathlib import Path
import heapq

random.seed(7)
# the demo world now lives with the tests; the app reads real data (pipeline/)
OUT = Path(__file__).resolve().parent.parent / "tests" / "fixtures" / "demo"
OUT.mkdir(parents=True, exist_ok=True)

# ---------------------------------------------------------------- stations
# id, name, lat, lon, elevation (m)
S = [
    ("stg", "Strasbourg", 48.585, 7.735, 142),
    ("ent", "Entzheim-Aéroport", 48.538, 7.638, 150),
    ("mol", "Molsheim", 48.540, 7.494, 190),
    ("mut", "Mutzig", 48.538, 7.457, 200),
    ("gre", "Gresswiller", 48.534, 7.428, 205),
    ("hei", "Heiligenberg", 48.530, 7.395, 210),
    ("urm", "Urmatt", 48.527, 7.324, 235),
    ("lut", "Lutzelhouse", 48.522, 7.285, 255),
    ("wis", "Wisches", 48.509, 7.267, 280),
    ("rus", "Russ-Hersbach", 48.497, 7.256, 290),
    ("sch", "Schirmeck-La Broque", 48.483, 7.218, 315),
    ("rot", "Rothau", 48.456, 7.207, 340),
    ("fou", "Fouday", 48.423, 7.187, 400),
    ("sbl", "Saint-Blaise-la-Roche", 48.405, 7.170, 420),
    ("saa", "Saales", 48.346, 7.113, 555),
    ("ros", "Rosheim", 48.497, 7.470, 190),
    ("bis", "Bischoffsheim", 48.488, 7.493, 190),
    ("obe", "Obernai", 48.461, 7.488, 185),
    ("gox", "Goxwiller", 48.433, 7.488, 190),
    ("ger", "Gertwiller", 48.411, 7.469, 200),
    ("bar", "Barr", 48.408, 7.452, 210),
    ("eic", "Eichhoffen", 48.384, 7.445, 215),
    ("epf", "Epfig", 48.360, 7.470, 190),
    ("dam", "Dambach-la-Ville", 48.325, 7.430, 210),
    ("sel", "Sélestat", 48.260, 7.443, 175),
    ("hoc", "Hochfelden", 48.756, 7.567, 170),
    ("det", "Dettwiller", 48.754, 7.467, 180),
    ("sav", "Saverne", 48.742, 7.365, 200),
    ("lzb", "Lutzelbourg", 48.734, 7.256, 230),
    ("sar", "Sarrebourg", 48.735, 7.055, 265),
    ("hag", "Haguenau", 48.815, 7.792, 150),
    ("mer", "Mertzwiller", 48.868, 7.680, 175),
    ("rei", "Reichshoffen", 48.932, 7.664, 185),
    ("nie", "Niederbronn-les-Bains", 48.951, 7.640, 190),
    ("sou", "Soultz-sous-Forêts", 48.937, 7.883, 160),
    ("hun", "Hunspach", 48.952, 7.945, 165),
    ("wiss", "Wissembourg", 49.035, 7.946, 160),
    ("col", "Colmar", 48.073, 7.347, 195),
    ("tur", "Turckheim", 48.087, 7.278, 230),
    ("mun", "Munster", 48.040, 7.135, 380),
    ("muh", "Muhlbach-sur-Munster", 48.028, 7.075, 450),
    ("met", "Metzeral", 48.013, 7.072, 480),
    ("mul", "Mulhouse", 47.742, 7.343, 240),
    ("cer", "Cernay", 47.805, 7.172, 275),
    ("tha", "Thann", 47.809, 7.103, 330),
    ("sam", "Saint-Amarin", 47.876, 7.025, 410),
    ("kru", "Kruth", 47.932, 6.962, 490),
]
idx = {s[0]: i for i, s in enumerate(S)}

# ---------------------------------------------------------------- lines
# stops with minutes from the first stop; headway (min) per window;
# last departure from the far terminal back towards the hub, per window
WINDOWS = [
    {"id": "wd", "label": "Weekday 07:00–10:00"},
    {"id": "sat", "label": "Saturday 07:00–10:00"},
    {"id": "sun", "label": "Sunday 08:00–11:00"},
]
LINES = {
    "bruche": dict(name="Strasbourg – Saales (Bruche valley)",
        stops=[("stg",0),("ent",9),("mol",17),("mut",21),("gre",24),("hei",27),("urm",31),("lut",35),("wis",38),("rus",40),("sch",44),("rot",48),("fou",53),("sbl",56),("saa",66)],
        headway=dict(wd=30, sat=60, sun=60), last=dict(wd=21*60+5, sat=20*60+35, sun=19*60+50)),
    "obernai": dict(name="Strasbourg – Sélestat (via Obernai, Barr)",
        stops=[("stg",0),("ent",9),("mol",18),("ros",25),("bis",28),("obe",32),("gox",36),("ger",39),("bar",42),("eic",45),("epf",50),("dam",54),("sel",64)],
        headway=dict(wd=30, sat=60, sun=120), last=dict(wd=20*60+50, sat=20*60+10, sun=19*60+15)),
    "saverne": dict(name="Strasbourg – Sarrebourg (via Saverne)",
        stops=[("stg",0),("hoc",17),("det",22),("sav",26),("lzb",34),("sar",47)],
        headway=dict(wd=30, sat=60, sun=60), last=dict(wd=21*60+40, sat=21*60+10, sun=20*60+40)),
    "niederbronn": dict(name="Strasbourg – Niederbronn-les-Bains",
        stops=[("stg",0),("hag",26),("mer",36),("rei",43),("nie",47)],
        headway=dict(wd=30, sat=60, sun=120), last=dict(wd=20*60+55, sat=20*60+25, sun=19*60+25)),
    "wissembourg": dict(name="Strasbourg – Wissembourg",
        stops=[("stg",0),("hag",26),("sou",43),("hun",47),("wiss",56)],
        headway=dict(wd=60, sat=60, sun=120), last=dict(wd=20*60+30, sat=20*60+5, sun=19*60+5)),
    "rhin": dict(name="Strasbourg – Mulhouse (via Sélestat, Colmar)",
        stops=[("stg",0),("sel",21),("col",31),("mul",55)],
        headway=dict(wd=30, sat=30, sun=60), last=dict(wd=22*60+10, sat=22*60+10, sun=21*60+40)),
    "munster": dict(name="Colmar – Metzeral (Munster valley)",
        stops=[("col",0),("tur",8),("mun",22),("muh",26),("met",30)],
        headway=dict(wd=60, sat=60, sun=120), last=dict(wd=20*60+20, sat=19*60+50, sun=18*60+50)),
    "thur": dict(name="Mulhouse – Kruth (Thur valley)",
        stops=[("mul",0),("cer",16),("tha",24),("sam",37),("kru",46)],
        headway=dict(wd=30, sat=60, sun=60), last=dict(wd=20*60+45, sat=20*60+15, sun=19*60+30)),
}
TRANSFER_MIN = 4   # minimum connection time

# ---------------------------------------------------------------- ttm
def ttm_from(origin, w):
    """Dijkstra over (station, line) states. Time = on board + connection
    waits; you leave on a departing train. Returns per station:
    (minutes, transfers, first_line, last_line)."""
    best = {}
    pq = []
    for lid, L in LINES.items():
        for k, (sid, t) in enumerate(L["stops"]):
            if sid == origin:
                heapq.heappush(pq, (0, 0, origin, lid, lid))
    seen = set()
    while pq:
        t, nx, sid, lid, first = heapq.heappop(pq)
        if (sid, lid) in seen:
            continue
        seen.add((sid, lid))
        if sid not in best or t < best[sid][0]:
            best[sid] = (t, nx, first, lid)
        L = LINES[lid]
        stops = L["stops"]
        pos = [i for i, (s, _) in enumerate(stops) if s == sid][0]
        for j in (pos - 1, pos + 1):
            if 0 <= j < len(stops):
                dt = abs(stops[j][1] - stops[pos][1])
                heapq.heappush(pq, (t + dt, nx, stops[j][0], lid, first))
        # change line here
        for lid2, L2 in LINES.items():
            if lid2 != lid and any(s == sid for s, _ in L2["stops"]):
                wait = max(TRANSFER_MIN, min(L2["headway"][w] / 2, 20))
                heapq.heappush(pq, (t + wait, nx + 1, sid, lid2, first))
    return best

def last_back(dest, lid, w):
    """Last departure from `dest` on line `lid` back towards its first stop."""
    L = LINES[lid]
    stops = L["stops"]
    t_end = stops[-1][1]
    t_here = [t for s, t in stops if s == dest][0]
    return L["last"][w] + (t_end - t_here)

ttm = {"windows": WINDOWS, "order": [s[0] for s in S], "by": {}}
for w in [x["id"] for x in WINDOWS]:
    ttm["by"][w] = {}
    for o in [s[0] for s in S]:
        best = ttm_from(o, w)
        row = []
        for d in [s[0] for s in S]:
            if d == o or d not in best:
                row.append(None)
                continue
            t, nx, first, lastl = best[d]
            p50 = round(t)
            p75 = round(t + 2 + nx * 6)
            trains = int(180 // LINES[first]["headway"][w])
            lb = last_back(d, lastl, w) - nx * 10
            row.append([p50, p75, trains, int(lb), nx])
        ttm["by"][w][o] = row

# ---------------------------------------------------------------- terrain
SUMMITS = [
    ("Donon", 48.512, 7.170, 1009, 1.0),
    ("Champ du Feu", 48.394, 7.264, 1099, 1.0),
    ("Mont Sainte-Odile", 48.437, 7.404, 764, 0.9),
    ("Schneeberg", 48.553, 7.258, 961, 0.9),
    ("Ungersberg", 48.354, 7.371, 901, 0.9),
    ("Haut-Barr", 48.727, 7.354, 460, 0.6),
    ("Grand Wintersberg", 48.965, 7.600, 581, 0.7),
    ("Petit Ballon", 47.986, 7.139, 1272, 1.1),
    ("Hohneck", 48.040, 7.017, 1363, 1.2),
    ("Grand Ballon", 47.901, 7.098, 1424, 1.2),
    ("Rossberg", 47.840, 7.020, 1191, 1.1),
]

def km(lat1, lon1, lat2, lon2):
    dy = (lat2 - lat1) * 111.2
    dx = (lon2 - lon1) * 111.2 * math.cos(math.radians((lat1 + lat2) / 2))
    return math.hypot(dx, dy)

def bearing(lat1, lon1, lat2, lon2):
    dy = (lat2 - lat1)
    dx = (lon2 - lon1) * math.cos(math.radians((lat1 + lat2) / 2))
    return math.atan2(dx, dy)

def move(lat, lon, b, metres):
    dlat = metres * math.cos(b) / 111200
    dlon = metres * math.sin(b) / (111200 * math.cos(math.radians(lat)))
    return lat + dlat, lon + dlon

STEP = 20.0
climbs = []
letters = "ABCDEFGHJK"

def make_climb(st, summit, steep=None, length=None):
    sid, sname, slat, slon, sz = st
    tname, tlat, tlon, tz, rugged = summit
    b0 = bearing(slat, slon, tlat, tlon)
    r = random.uniform(300, 6500)
    blat, blon = move(slat, slon, b0 + random.uniform(-0.9, 0.9), r)
    z0 = sz + r / 1000 * random.uniform(8, 45)
    room = tz - z0 - 20
    if room < 80:
        return None
    g0 = steep if steep is not None else random.uniform(0.06, 0.20) * rugged
    L = length if length is not None else random.uniform(500, 4500)
    L = min(L, room / max(g0, 0.03) * 0.95)
    if L < 400:
        return None
    n = int(L // STEP)
    # piecewise grades with the odd dip or flat
    grades = []
    while len(grades) < n:
        u = random.random()
        if u < 0.10:
            g, m = -random.uniform(0.02, 0.08), random.randint(2, 6)
        elif u < 0.18:
            g, m = random.uniform(0.0, 0.03), random.randint(3, 8)
        else:
            g, m = g0 * random.uniform(0.6, 1.45), random.randint(5, 15)
        grades += [g] * m
    grades = grades[:n]
    z = [z0]
    for g in grades:
        z.append(z[-1] + g * STEP)
    # gentle smoothing (the real pipeline smooths DEM samples the same way)
    zs = []
    for i in range(len(z)):
        a, bb = max(0, i - 1), min(len(z), i + 2)
        zs.append(sum(z[a:bb]) / (bb - a))
    # geometry: head for the summit, switchbacks when steep
    bt = bearing(blat, blon, tlat, tlon)
    lat, lon = blat, blon
    coords = [[round(lon, 5), round(lat, 5)]]
    zig = 1
    seg = random.randint(6, 14)
    for i in range(n):
        if i % seg == 0:
            zig = -zig
        swing = (0.9 if g0 > 0.13 else 0.35) * zig
        h = bt + swing + random.uniform(-0.25, 0.25)
        lat, lon = move(lat, lon, h, STEP)
        coords.append([round(lon, 5), round(lat, 5)])
    steepness = sum(1 for g in grades if g > 0.18) / max(1, len(grades))
    track = max(0.0, min(1.0, random.betavariate(2, 3) * (1.4 - 4 * g0)))
    paved = 0.0 if random.random() < 0.8 else round(random.uniform(0.05, 0.35), 2)
    way, surf = trail_runs(grades, track, paved)
    return dict(
        name=None,
        station=sid, towards=tname,
        z=[round(v, 1) for v in zs],
        coords=coords,
        way=way, surf=surf,
        sac="mountain_hiking" if steepness > 0.25 else "hiking",
        marked=random.random() < 0.7,
    )

def trail_runs(grades, track, paved):
    """Way type and surface along the climb, as runs: [[first edge, code], ...].
    way:  m mountain path · p hiking path · t forest track · r road
    surf: k rocky · n natural · u unpaved · a paved · x unknown
    (the real pipeline reads these from OSM highway, sac_scale and surface)"""
    n = len(grades)
    way, surf = [], []
    k = 0
    road_left = int(paved * n)
    while k < n:
        m = random.randint(5, 25)
        g = sum(grades[k:k + m]) / max(1, len(grades[k:k + m]))
        if road_left > 0 and k < n * 0.35:
            w = "r"
            road_left -= m
        elif random.random() < track:
            w = "t"
        else:
            w = "m" if g > 0.2 else "p"
        sf = {"r": "a", "t": "u", "p": "n", "m": "k"}[w]
        u = random.random()
        if u < 0.08:
            sf = "x"
        elif u < 0.16 and w in "pt":
            sf = "n" if w == "t" else "u"
        if not way or way[-1][1] != w:
            way.append([k, w])
        if not surf or surf[-1][1] != sf:
            surf.append([k, sf])
        k += m
    return way, surf

mountain = {}
for st in S:
    near = sorted(SUMMITS, key=lambda m: km(st[2], st[3], m[1], m[2]))
    near = [m for m in near if km(st[2], st[3], m[1], m[2]) < 10.5]
    if near:
        mountain[st[0]] = near[:2]

for st in S:
    if st[0] not in mountain:
        continue
    near = mountain[st[0]]
    k = random.randint(2, 4)
    made = 0
    tries = 0
    while made < k and tries < 30:
        tries += 1
        summit = near[made % len(near)]
        # one deliberately steep climb per rugged station, so the
        # "300 m in under 2 km" preset has something to find
        close = km(st[2], st[3], summit[1], summit[2]) < 8
        steep = (random.uniform(0.15, 0.21)
                 if made == 0 and summit[4] >= 0.9 and close and random.random() < 0.55 else None)
        length = random.uniform(1800, 3200) if steep else None
        c = make_climb(st, summit, steep, length)
        if c:
            climbs.append(c)
            made += 1

# names: the summit, and which slope of it the climb starts on
WINDS = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"]
SUM = {m[0]: m for m in SUMMITS}
seen_names = {}
for c in climbs:
    m = SUM[c["towards"]]
    lon0, lat0 = c["coords"][0]
    b = math.degrees(bearing(m[1], m[2], lat0, lon0)) % 360
    base = f"{m[0]} · {WINDS[int(((b + 22.5) % 360) // 45)]} slope"
    seen_names[base] = seen_names.get(base, 0) + 1
    c["name"] = base if seen_names[base] == 1 else f"{base} {seen_names[base]}"

# ids, metrics
for i, c in enumerate(climbs):
    c["id"] = f"c{i+1:03d}"
    z = c["z"]
    up = sum(max(0, z[k+1]-z[k]) for k in range(len(z)-1))
    dn = sum(max(0, z[k]-z[k+1]) for k in range(len(z)-1))
    c["len"] = round((len(z)-1) * STEP)
    c["dplus"] = round(up)
    c["dminus"] = round(dn)
    edges = len(z) - 1
    def share(runs, codes):
        tot = 0
        for a, (k0, code) in enumerate(runs):
            k1 = runs[a + 1][0] if a + 1 < len(runs) else edges
            if code in codes:
                tot += max(0, min(k1, edges) - k0)
        return round(tot / max(1, edges), 2)
    c["track"] = share(c["way"], "t")
    c["paved"] = share(c["surf"], "a")

# ---------------------------------------------------------------- access
access = {}
for c in climbs:
    lon0, lat0 = c["coords"][0]
    lon1, lat1 = c["coords"][-1]
    rows = []
    for sid, _, slat, slon, _ in S:
        d0 = km(slat, slon, lat0, lon0) * 1000
        d1 = km(slat, slon, lat1, lon1) * 1000
        n0 = round(d0 * random.uniform(1.22, 1.45) + 80)
        n1 = round(d1 * random.uniform(1.22, 1.45) + 80)
        if min(n0, n1) <= 8000:
            rows.append([sid, n0, n1])
    rows.sort(key=lambda r: min(r[1], r[2]))
    access[c["id"]] = rows

# ---------------------------------------------------------------- write
meta = dict(
    app="PathFinder", version="0.1-demo", built="2026-11-25", demo=True,
    region="Strasbourg TER area (Alsace, edges of Vosges and Moselle)",
    profile_step_m=STEP, access_cutoff_m=8000,
    notes=[
        "Station positions, lines and summits are real (approximate).",
        "Train times are a schematic of the TER network, not the SNCF timetable.",
        "Climbs and elevation profiles are generated, not measured.",
    ],
    sources_planned=["OpenStreetMap (ODbL)", "IGN RGE ALTI 5 m (Etalab 2.0)", "SNCF GTFS (transport.data.gouv.fr)"],
    windows=WINDOWS,
)
stations = [dict(id=s[0], name=s[1], lat=s[2], lon=s[3], z=s[4],
                 lines=[lid for lid, L in LINES.items() if any(x == s[0] for x, _ in L["stops"])]) for s in S]
lines = {lid: dict(name=L["name"], stops=[x for x, _ in L["stops"]]) for lid, L in LINES.items()}

def dump(name, obj):
    p = OUT / name
    p.write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")))
    return p.stat().st_size

sizes = {
    "meta.json": dump("meta.json", meta),
    "stations.json": dump("stations.json", dict(stations=stations, lines=lines)),
    "ttm.json": dump("ttm.json", ttm),
    "climbs.json": dump("climbs.json", climbs),
    "access.json": dump("access.json", access),
}
print(len(climbs), "climbs")
for k, v in sizes.items():
    print(f"{k:14s} {v/1024:7.1f} KB")

#!/usr/bin/env python3
"""Fetch open data for every building (pand) in Leiden and write data/leiden.json.

Sources (all open, no API key):
  - BAG panden + verblijfsobjecten   PDOK WFS  https://service.pdok.nl/lv/bag/wfs/v2_0
  - Rijksmonumenten                  PDOK WFS  https://service.pdok.nl/rce/ps-ch/wfs/v1_0
  - Officiele bekendmakingen (permits, Gemeenteblad Leiden)  SRU  https://repository.overheid.nl/sru

Only the Python standard library is used. Run:  python3 scripts/fetch_leiden.py
Takes a few minutes (about 250 WFS pages).
"""
import json, math, re, sys, time, urllib.parse, urllib.request
import xml.etree.ElementTree as ET
from collections import defaultdict
from datetime import date

WOONPLAATS = "Leiden"
GEMEENTE = "Leiden"
BBOX = (52.12, 4.43, 52.19, 4.54)  # lat/lon box around the municipality
NOTICES_SINCE = "2023-01-01"
OUT = "data/leiden.json"
UA = {"User-Agent": "pandenkaart-leiden prototype (github.com/BorisP2101/pandenkaart-leiden)"}


def get(url, tries=4):
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=90) as r:
                return r.read()
        except Exception as e:  # network hiccup: back off and retry
            if i == tries - 1:
                raise
            print(f"  retry ({e})", file=sys.stderr)
            time.sleep(2 * (i + 1))


def wfs_all(base, type_name, sort_by, step=0.01):
    """All features in BBOX. PDOK refuses startIndex > 50,000 and pages may hold fewer
    than `count` features, so: split the box into cells, ask each cell for its total
    (resultType=hits), then page through it. Features are de-duplicated by id."""
    out, seen = [], set()
    lat = BBOX[0]
    while lat < BBOX[2] - 1e-9:
        lon = BBOX[1]
        while lon < BBOX[3] - 1e-9:
            bbox = f"{lat},{lon},{min(lat + step, BBOX[2])},{min(lon + step, BBOX[3])},urn:ogc:def:crs:EPSG::4326"
            base_q = {"service": "WFS", "version": "2.0.0", "request": "GetFeature", "typeName": type_name, "bbox": bbox}
            hits = get(base + "?" + urllib.parse.urlencode({**base_q, "resultType": "hits"})).decode()
            total = int(re.search(r'numberMatched="(\d+)"', hits).group(1))
            for start in range(0, total, 1000):
                q = {**base_q, "count": 1000, "startIndex": start, "outputFormat": "application/json", "srsName": "EPSG:4326"}
                if sort_by:
                    q["sortBy"] = sort_by
                for f in json.loads(get(base + "?" + urllib.parse.urlencode(q)))["features"]:
                    key = f.get("id") or json.dumps(f["properties"], sort_keys=True)
                    if key not in seen:
                        seen.add(key); out.append(f)
            lon += step
        lat += step
        print(f"  {type_name}: {len(out)}", file=sys.stderr)
    return out


# ---------- geometry helpers ----------
def rd_to_wgs84(x, y):
    """Rijksdriehoek (EPSG:28992) -> WGS84, approximation accurate to about 1 m."""
    K = [(0, 1, 3235.65389), (2, 0, -32.58297), (0, 2, -0.24750), (2, 1, -0.84978), (0, 3, -0.06550),
         (2, 2, -0.01709), (1, 0, -0.00738), (4, 0, 0.00530), (2, 3, -0.00039), (4, 1, 0.00033), (1, 1, -0.00012)]
    L = [(1, 0, 5260.52916), (1, 1, 105.94684), (1, 2, 2.45656), (3, 0, -0.81885), (1, 3, 0.05594), (3, 1, -0.05607),
         (0, 1, 0.01199), (3, 2, -0.00256), (1, 4, 0.00128), (0, 2, 0.00022), (2, 0, -0.00022), (5, 0, 0.00026)]
    dx, dy = (x - 155000) * 1e-5, (y - 463000) * 1e-5
    lat = 52.15517440 + sum(c * dx ** p * dy ** q for p, q, c in K) / 3600
    lon = 5.38720621 + sum(c * dx ** p * dy ** q for p, q, c in L) / 3600
    return lon, lat


def inside(pt, ring):
    x, y = pt
    hit = False
    for i in range(len(ring)):
        x1, y1 = ring[i - 1]
        x2, y2 = ring[i]
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
            hit = not hit
    return hit


def centroid(ring):
    xs = [p[0] for p in ring[:-1]] or [ring[0][0]]
    ys = [p[1] for p in ring[:-1]] or [ring[0][1]]
    return sum(xs) / len(xs), sum(ys) / len(ys)


class Grid:
    """Tiny spatial index over pand polygons for point-in-polygon joins."""
    def __init__(self, panden, cell=0.002):
        self.cell, self.cells = cell, defaultdict(list)
        for p in panden:
            xs = [c[0] for c in p["ring"]]; ys = [c[1] for c in p["ring"]]
            for i in range(int(min(xs) / cell), int(max(xs) / cell) + 1):
                for j in range(int(min(ys) / cell), int(max(ys) / cell) + 1):
                    self.cells[(i, j)].append(p)

    def find(self, pt, near_m=0):
        i, j = int(pt[0] / self.cell), int(pt[1] / self.cell)
        for p in self.cells.get((i, j), []):
            if inside(pt, p["ring"]):
                return p
        if not near_m:
            return None
        best, bd = None, near_m
        for di in (-1, 0, 1):
            for dj in (-1, 0, 1):
                for p in self.cells.get((i + di, j + dj), []):
                    d = math.hypot((p["c"][0] - pt[0]) * 68000, (p["c"][1] - pt[1]) * 111000)
                    if d < bd:
                        best, bd = p, d
        return best


# ---------- 1. verblijfsobjecten -> aggregate per pand ----------
def load_vbo():
    print("Verblijfsobjecten...", file=sys.stderr)
    agg = defaultdict(lambda: {"m2": 0, "func": defaultdict(int), "n": 0, "nb": 0, "nv": 0, "adr": None, "pc": None})
    for f in wfs_all("https://service.pdok.nl/lv/bag/wfs/v2_0", "bag:verblijfsobject", "identificatie"):
        p = f["properties"]
        if p.get("woonplaats") != WOONPLAATS:
            continue
        for pid in str(p.get("pandidentificatie") or "").split(","):
            pid = pid.strip()
            if not pid:
                continue
            a = agg[pid]
            m2 = int(p.get("oppervlakte") or 0)
            a["m2"] += m2; a["n"] += 1
            for g in str(p.get("gebruiksdoel") or "").split(","):
                if g.strip():
                    a["func"][g.strip()] += m2
            st = p.get("status") or ""
            if "buiten gebruik" in st:
                a["nb"] += 1
            if "Verbouwing" in st:
                a["nv"] += 1
            if a["adr"] is None:
                a["adr"] = f'{p.get("openbare_ruimte", "")} {p.get("huisnummer", "")}{p.get("huisletter", "")}{("-" + p["toevoeging"]) if p.get("toevoeging") else ""}'.strip()
                a["pc"] = p.get("postcode")
    return agg


# ---------- 2. panden ----------
def load_panden(agg):
    print("Panden...", file=sys.stderr)
    out = []
    for f in wfs_all("https://service.pdok.nl/lv/bag/wfs/v2_0", "bag:pand", "identificatie"):
        p = f["properties"]
        pid = p["identificatie"]
        if pid not in agg or not f.get("geometry"):
            continue
        g = f["geometry"]
        ring = g["coordinates"][0] if g["type"] == "Polygon" else g["coordinates"][0][0]
        ring = [[round(x, 6), round(y, 6)] for x, y in ring]
        a = agg[pid]
        funcs = sorted(a["func"].items(), key=lambda kv: -kv[1])
        out.append({
            "id": pid, "ring": ring, "c": centroid(ring),
            "bouwjaar": p.get("bouwjaar"), "status": p.get("status"),
            "functie": funcs[0][0] if funcs else "", "functies": [k for k, _ in funcs],
            "m2": a["m2"], "vbo": a["n"], "vbo_buiten_gebruik": a["nb"], "vbo_verbouwing": a["nv"],
            "adres": a["adr"], "postcode": a["pc"], "monument": None, "bekendmakingen": [],
        })
    return out


# ---------- 3. rijksmonumenten ----------
def join_monuments(grid):
    print("Rijksmonumenten...", file=sys.stderr)
    n = 0
    for f in wfs_all("https://service.pdok.nl/rce/ps-ch/wfs/v1_0", "ps-ch:rce_inspire_points", None):
        if (f["properties"].get("namespace") or "") != "nlps-rijksmonumenten":
            continue
        p = grid.find(tuple(f["geometry"]["coordinates"]))
        if p:
            p["monument"] = f["properties"].get("ciCitation"); n += 1
    print(f"  monuments joined: {n}", file=sys.stderr)


# ---------- 4. bekendmakingen (permits) ----------
SIGNALS = [
    ("sloop", re.compile(r"\bsloop|slopen", re.I)),
    ("leegstand", re.compile(r"leegstand", re.I)),
    ("functiewijziging", re.compile(r"wijzig\w* (van )?(het )?gebruik|functiewijziging|transformatie|omzetten|gebruiken .* als", re.I)),
]
NS = {"sru": "http://docs.oasis-open.org/ns/search-ws/sruResponse", "dcterms": "http://purl.org/dc/terms/",
      "overheidwetgeving": "http://standaarden.overheid.nl/wetgeving/"}


def load_notices(grid):
    print("Bekendmakingen...", file=sys.stderr)
    words = "sloop slopen sloopmelding leegstand leegstandwet transformatie functiewijziging gebruik"
    query = (f'c.product-area==officielepublicaties AND dt.creator=="{GEMEENTE}" '
             f'AND dt.title any "{words}" AND dt.modified>={NOTICES_SINCE}')
    start, total, kept, seen = 1, None, 0, set()
    while total is None or start <= total:
        url = "https://repository.overheid.nl/sru?" + urllib.parse.urlencode(
            {"query": query, "maximumRecords": 1000, "startRecord": start, "httpAccept": "application/xml"})
        root = ET.fromstring(get(url))
        total = int(root.findtext("sru:numberOfRecords", "0", NS))
        recs = root.findall(".//sru:record", NS)
        if not recs:
            break
        for r in recs:
            title = r.findtext(".//dcterms:title", "", NS)
            ident = r.findtext(".//dcterms:identifier", "", NS)
            when = (r.findtext(".//dcterms:available", "", NS) or r.findtext(".//dcterms:modified", "", NS))[:10]
            kinds = [k for k, rx in SIGNALS if rx.search(title)]
            if not kinds or ident in seen:
                continue
            seen.add(ident)
            pts = [m for g in r.findall(".//overheidwetgeving:geometrie", NS)
                   for m in re.findall(r"POINT\(([\d.]+) ([\d.]+)\)", g.text or "")]
            hits = set()
            for x, y in pts:
                p = grid.find(rd_to_wgs84(float(x), float(y)), near_m=25)
                if p and p["id"] not in hits:
                    hits.add(p["id"])
                    p["bekendmakingen"].append({"titel": title, "datum": when, "soort": kinds,
                                                "url": f"https://zoek.officielebekendmakingen.nl/{ident}"})
            kept += bool(hits)
        start += len(recs)
        print(f"  notices: {min(start - 1, total)}/{total}", file=sys.stderr)
    print(f"  notices linked to a pand: {kept}", file=sys.stderr)


def main():
    agg = load_vbo()
    panden = load_panden(agg)
    grid = Grid(panden)
    join_monuments(grid)
    load_notices(grid)
    for p in panden:
        p["bekendmakingen"].sort(key=lambda b: b["datum"], reverse=True)
    rows = [[p["id"], [[round(x - 4, 6), round(y - 52, 6)] for x, y in p["ring"]], p["bouwjaar"], p["status"],
             p["functie"], p["functies"], p["m2"], p["vbo"], p["vbo_buiten_gebruik"], p["vbo_verbouwing"],
             p["adres"], p["postcode"], p["monument"], p["bekendmakingen"]] for p in panden]
    data = {
        "gemeente": GEMEENTE, "gegenereerd": date.today().isoformat(), "bekendmakingen_vanaf": NOTICES_SINCE,
        "kolommen": ["id", "ring (lon-4, lat-52)", "bouwjaar", "status", "functie", "functies", "m2", "vbo",
                     "vbo_buiten_gebruik", "vbo_verbouwing", "adres", "postcode", "monument", "bekendmakingen"],
        "bronnen": ["BAG via PDOK (Kadaster)", "Rijksmonumentenregister via PDOK (RCE)",
                    "Officiële bekendmakingen (KOOP), Gemeenteblad " + GEMEENTE],
        "panden": rows,
    }
    with open(OUT, "w", encoding="utf8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
    print(f"Wrote {OUT}: {len(rows)} panden", file=sys.stderr)


if __name__ == "__main__":
    main()

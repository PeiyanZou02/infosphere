#!/usr/bin/env python3
"""import_land.py — build app/land.json for the orbital view's scan-line globe.

Downloads the Natural Earth 1:110m land polygons (public domain) and
rasterises them into "on every latitude line, which longitude intervals
are land". The browser draws those intervals as line segments: a globe
made of latitude scan lines, no texture, no runtime dependency.

Run from the infosphere root:  python tools/import_land.py
"""
import json
import os
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "app", "land.json")
URL = ("https://raw.githubusercontent.com/nvkelso/natural-earth-vector/"
       "master/geojson/ne_110m_land.geojson")
STEP = 1.5      # degrees between scan lines


def rings(geo):
    for f in geo["features"]:
        g = f["geometry"]
        polys = g["coordinates"] if g["type"] == "MultiPolygon" else [g["coordinates"]]
        for poly in polys:
            for ring in poly:
                yield ring


def main():
    req = urllib.request.Request(URL, headers={"User-Agent": "Mozilla/5.0 (infosphere/1.0)"})
    with urllib.request.urlopen(req, timeout=120) as r:
        geo = json.load(r)
    all_rings = list(rings(geo))
    rows = []
    lat = -90 + STEP / 2
    while lat < 90:
        xs = []
        for ring in all_rings:                       # even-odd rule across every ring
            for (x0, y0), (x1, y1) in zip(ring, ring[1:]):
                if (y0 > lat) != (y1 > lat):
                    xs.append(x0 + (lat - y0) * (x1 - x0) / (y1 - y0))
        xs.sort()
        spans = [round(v, 2) for pair in zip(xs[0::2], xs[1::2]) if pair[1] - pair[0] > 0.2 for v in pair]
        if spans:
            rows.append([round(lat, 2), spans])
        lat += STEP
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump({"step": STEP, "rows": rows}, f, separators=(",", ":"))
    print(f"{len(rows)} scan lines, {sum(len(r[1]) for r in rows) // 2} land spans -> {OUT}"
          f" ({os.path.getsize(OUT) // 1024} KB)")


if __name__ == "__main__":
    main()

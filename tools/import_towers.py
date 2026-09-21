#!/usr/bin/env python3
"""import_towers.py — Filter OpenCelliD / WiGLE CSV exports to a local area.

OpenCelliD (free registration at opencellid.org -> Downloads) provides
country-level CSV dumps with columns:
    radio,mcc,net,area,cell,unit,lon,lat,range,samples,changeable,
    created,updated,averageSignal

WiGLE (free account at wigle.net) exports similar location CSVs.

Usage:
    python tools/import_towers.py path/to/cell_towers.csv \
        --lat 42.3741 --lon -71.1147 --radius 3000

Output: data/towers.csv  (radio,lat,lon,range,samples)
"""
import argparse
import csv
import math
import os
import sys

M_PER_DEG_LAT = 111_320.0


def haversine_m(lat1, lon1, lat2, lon2):
    r = 6_371_000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("csv_path")
    ap.add_argument("--lat", type=float, required=True)
    ap.add_argument("--lon", type=float, required=True)
    ap.add_argument("--radius", type=float, default=3000.0,
                    help="radius in meters (default 3000)")
    ap.add_argument("--out", default=os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        "data", "towers.csv"))
    args = ap.parse_args()

    kept = 0
    seen = 0
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.csv_path, newline="", encoding="utf-8", errors="replace") as f, \
         open(args.out, "w", newline="", encoding="utf-8") as g:
        reader = csv.reader(f)
        writer = csv.writer(g)
        writer.writerow(["radio", "lat", "lon", "range", "samples"])
        header = None
        for row in reader:
            if not row or len(row) < 9:
                continue
            # detect & skip header row
            if header is None and row[0].lower() in ("radio", "mcc"):
                header = row
                continue
            seen += 1
            try:
                # OpenCelliD order: radio,mcc,net,area,cell,unit,lon,lat,range,samples,...
                radio = row[0]
                lon = float(row[6])
                lat = float(row[7])
                rng = float(row[8]) if row[8] else 0.0
                samples = int(float(row[9])) if len(row) > 9 and row[9] else 0
            except (ValueError, IndexError):
                continue
            if haversine_m(args.lat, args.lon, lat, lon) <= args.radius:
                writer.writerow([radio, f"{lat:.6f}", f"{lon:.6f}",
                                 f"{rng:.0f}", samples])
                kept += 1
    print(f"scanned {seen} rows, kept {kept} towers within "
          f"{args.radius:.0f} m of ({args.lat}, {args.lon})")
    print(f"written to {args.out}")


if __name__ == "__main__":
    sys.exit(main())

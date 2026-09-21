#!/usr/bin/env python3
"""import_broadcast.py — build data/am_stations.csv and data/tv_stations.csv
from the FCC's public AM / TV query endpoints (pipe-delimited `list=4`).

Licensed US stations only, one row per station. AM keeps the daytime
record (night power differs; day is the larger footprint). TV rows carry
the RF channel converted to its real 6 MHz centre frequency.

Run from the infosphere root:  python tools/import_broadcast.py
"""
import csv
import os
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
AM_URL = "https://transition.fcc.gov/fcc-bin/amq?list=4&ctry=US"
TV_URL = "https://transition.fcc.gov/fcc-bin/tvq?list=4&ctry=US"
FIELDS = ["callsign", "freq_mhz", "city", "state", "class", "erp_kw", "lat", "lon"]


def fetch(url):
    # the FCC edge rejects urllib's bare header set (403) — send a full one
    req = urllib.request.Request(url, headers={
        "User-Agent": "Mozilla/5.0 (infosphere/1.0; art installation)",
        "Accept": "text/html,text/plain,*/*", "Accept-Language": "en-US,en"})
    with urllib.request.urlopen(req, timeout=180) as r:
        return r.read().decode("latin-1")


def dms(d, m, s, hemi):
    try:
        v = int(d) + int(m) / 60 + float(s) / 3600
    except ValueError:
        return None
    return -v if hemi in ("S", "W") else v


def tv_channel_mhz(ch):
    """Centre frequency of a US RF television channel (post-repack, 2–36)."""
    if 2 <= ch <= 4:
        return 57 + (ch - 2) * 6
    if 5 <= ch <= 6:
        return 79 + (ch - 5) * 6
    if 7 <= ch <= 13:
        return 177 + (ch - 7) * 6
    if 14 <= ch <= 36:
        return 473 + (ch - 14) * 6
    return None


def first_number(s):
    try:
        return float(s.split()[0])
    except (ValueError, IndexError):
        return 0.0


def rows(text):
    for line in text.splitlines():
        p = [c.strip() for c in line.split("|")]
        if len(p) > 27 and p[9] == "LIC":
            yield p


def build_am(text):
    out = {}
    for p in rows(text):
        lat, lon = dms(p[20], p[21], p[22], p[19]), dms(p[24], p[25], p[26], p[23])
        khz = first_number(p[2])
        if lat is None or lon is None or not khz:
            continue
        rec = {"callsign": p[1], "freq_mhz": round(khz / 1000, 4), "city": p[10].title(),
               "state": p[11], "class": p[7], "erp_kw": first_number(p[14]),
               "lat": round(lat, 5), "lon": round(lon, 5)}
        key = p[18] or p[1]                       # facility id
        if key not in out or p[5] == "DAY":
            out[key] = rec
    return list(out.values())


def build_tv(text):
    out = {}
    for p in rows(text):
        lat, lon = dms(p[20], p[21], p[22], p[19]), dms(p[24], p[25], p[26], p[23])
        try:
            mhz = tv_channel_mhz(int(p[4]))
        except ValueError:
            mhz = None
        if lat is None or lon is None or mhz is None:
            continue
        rec = {"callsign": p[1], "freq_mhz": mhz, "city": p[10].title(),
               "state": p[11], "class": p[3], "erp_kw": first_number(p[14]),
               "lat": round(lat, 5), "lon": round(lon, 5)}
        key = p[18] or p[1]
        if key not in out or rec["erp_kw"] > out[key]["erp_kw"]:
            out[key] = rec
    return list(out.values())


def write(name, recs):
    path = os.path.join(DATA, name)
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=FIELDS)
        w.writeheader()
        for r in sorted(recs, key=lambda r: (r["state"], r["callsign"])):
            w.writerow(r)
    print(f"{len(recs):6d} stations -> {path}")


def main():
    os.makedirs(DATA, exist_ok=True)
    print("fetching FCC AM query…")
    write("am_stations.csv", build_am(fetch(AM_URL)))
    print("fetching FCC TV query…")
    write("tv_stations.csv", build_tv(fetch(TV_URL)))


if __name__ == "__main__":
    main()

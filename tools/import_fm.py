#!/usr/bin/env python3
"""import_fm.py — build data/fm_stations.csv from FCC CDBS dumps.

Joins facility.dat (callsign / frequency / city / state / license status)
with fm_eng_data.dat (transmitter coordinates / ERP / station class)
on facility_id. Output rows: licensed FM stations with valid coords.

Run from the infosphere root:  python tools/import_fm.py
"""
import csv
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
FACILITY = os.path.join(DATA, "facility.dat")
ENG = os.path.join(DATA, "fm_eng_data.dat")
OUT = os.path.join(DATA, "fm_stations.csv")


def dms_to_deg(d, m, s, direction):
    try:
        val = int(d) + int(m) / 60 + float(s) / 3600
    except (ValueError, TypeError):
        return None
    if direction in ("S", "W"):
        val = -val
    return val


def main():
    # facility.dat field map (pipe-delimited, 32 cols, ends with '^'):
    #  5 callsign | 7 city | 9 frequency MHz | 10 service | 11 state |
    # 14 facility_id (verified by 99.6% join overlap) | 16 status (LICEN)
    fac = {}
    with open(FACILITY, encoding="utf-8", errors="replace") as f:
        for line in f:
            p = line.rstrip("\n").split("|")
            if len(p) < 18 or p[10] != "FM":
                continue
            if p[16] != "LICEN":
                continue
            fac[p[14]] = {
                "callsign": p[5].strip(),
                "freq_mhz": p[9].strip(),
                "city": p[7].strip().title(),
                "state": p[11].strip(),
            }

    # fm_eng_data.dat field map (73 cols):
    #  7 service | 20 facility_id | 21 eng status | 29 ERP kW |
    # 30-33 lat deg/dir/min/sec | 34-37 lon deg/dir/min/sec | 50 class
    rows = {}
    with open(ENG, encoding="utf-8", errors="replace") as f:
        for line in f:
            p = line.rstrip("\n").split("|")
            if len(p) < 51 or p[7] != "FM":
                continue
            fid = p[20]
            if fid not in fac:
                continue
            lat = dms_to_deg(p[30], p[32], p[33], p[31])
            lon = dms_to_deg(p[34], p[36], p[37], p[35])
            if lat is None or lon is None:
                continue
            try:
                erp = float(p[29])
            except ValueError:
                erp = 0.0
            rec = dict(fac[fid])
            rec.update({
                "facility_id": fid,
                "erp_kw": erp,
                "class": p[50].strip(),
                "lat": round(lat, 6),
                "lon": round(lon, 6),
                "eng_status": p[21].strip(),
            })
            # keep the licensed (LIC) engineering record when duplicated
            if fid not in rows or p[21] == "LIC":
                rows[fid] = rec

    with open(OUT, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=[
            "callsign", "freq_mhz", "city", "state", "class",
            "erp_kw", "lat", "lon", "facility_id"])
        w.writeheader()
        for r in sorted(rows.values(), key=lambda r: (r["state"], r["callsign"])):
            w.writerow({k: r[k] for k in w.fieldnames})
    print(f"facility FM licensed: {len(fac)}")
    print(f"with transmitter coords: {len(rows)} -> {OUT}")


if __name__ == "__main__":
    main()

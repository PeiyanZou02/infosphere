#!/usr/bin/env python3
"""server.py — Infosphere local server. Python stdlib only.

Bridges the browser to things JavaScript cannot touch.

  measured by this machine (background threads, answers are instant)
    /api/wifi          active wlanapi scan: dBm, channel width, BSS load, beacon bytes
    /api/ble           BLE advertisements (needs `pip install bleak`)
    /api/net           live throughput, TCP connections, LAN neighbours (masked)
  live from the network (cached, stale copy served if the source is down)
    /api/aircraft      ADS-B: adsb.lol, OpenSky as fallback
    /api/sondes        radiosondes in flight (SondeHub)
    /api/spaceweather  Kp, solar wind, IMF, F10.7, GOES X-ray (NOAA SWPC)
    /api/tle           CelesTrak orbital elements (6 h disk cache)
    /api/masts         communication masts / antennas (OpenStreetMap Overpass)
    /api/hotspots      places announcing public WiFi + telecom plant nearby (OpenStreetMap)
  offline datasets, filtered around the observer
    /api/fm /api/am /api/tv   FCC broadcast stations
    /api/towers               OpenCelliD cells (tools/import_towers.py)
  /api/config          fallback location + what is available

Everything else is static files from app/.

Usage:  python server.py [port] [--no-https] [--https-port N]
        HTTP on 8000 for this machine, HTTPS on 8443 for phones (sensors,
        GPS and camera need a secure context). The certificate is
        self-signed and generated on first start if openssl is around.
"""
import csv
import glob
import json
import math
import os
import shutil
import socket
import ssl
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

ROOT = os.path.dirname(os.path.abspath(__file__))
APP_DIR = os.path.join(ROOT, "app")
DATA_DIR = os.path.join(ROOT, "data")
TOWERS_CSV = os.path.join(DATA_DIR, "towers.csv")
TLE_CACHE = os.path.join(DATA_DIR, "tle_cache.json")
MASTS_CACHE = os.path.join(DATA_DIR, "masts_cache.json")
CERT_PEM = os.path.join(DATA_DIR, "cert.pem")
KEY_PEM = os.path.join(DATA_DIR, "key.pem")
STATION_CSV = {s: os.path.join(DATA_DIR, f"{s}_stations.csv") for s in ("fm", "am", "tv")}

sys.path.insert(0, os.path.join(ROOT, "tools"))
import wifi_scan  # noqa: E402
import ble_scan  # noqa: E402
import net_scan  # noqa: E402

# Used only when the browser cannot get a position fix.
FALLBACK_LOCATION = {  # Gund Hall, Harvard GSD, 42 Quincy St, Cambridge MA
    "lat": 42.3741, "lon": -71.1147, "label": "Gund Hall, Harvard GSD"
}

TLE_GROUPS = ["stations", "visual", "gnss", "weather", "amateur",
              "iridium-NEXT", "oneweb", "starlink"]
TLE_URL = "https://celestrak.org/NORAD/elements/gp.php?GROUP={}&FORMAT=tle"
TLE_CACHE_TTL = 6 * 3600
TLE_RETRY = 1800            # wait this long before re-asking for a failed group
WIFI_MERGE_DECAY = 90       # seconds a BSSID stays visible after last seen
UA = {"User-Agent": "infosphere/1.0 (art installation; local cache)"}


def haversine(lat1, lon1, lat2, lon2):
    r = 6_371_000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def fetch(url, timeout=20, data=None):
    req = urllib.request.Request(url, data=data, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def fetch_json(url, timeout=20, data=None):
    return json.loads(fetch(url, timeout, data))


# ---- memory cache: one refresh at a time per key, stale copy on failure ----
_cache = {}
_cache_locks = {}
_cache_guard = threading.Lock()


def cached(key, ttl, fn):
    with _cache_guard:
        lock = _cache_locks.setdefault(key, threading.Lock())
    with lock:
        hit = _cache.get(key)
        now = time.time()
        if hit and now - hit["t"] < ttl:
            return hit["data"]
        try:
            data = fn()
            _cache[key] = {"t": now, "data": data}
            return data
        except Exception as e:  # noqa: BLE001
            if hit:                                    # serve stale, retry in 30 s
                hit["t"] = now - ttl + 30
                return dict(hit["data"], stale=True, error=str(e))
            _cache[key] = {"t": now - ttl + 30, "data": {"error": str(e)}}
            return {"error": str(e)}


# ---- WiFi: a scan takes ~10-30 s, so it lives in its own thread ----
_wifi_seen = {}   # bssid -> {entry, last_seen}
_wifi_state = {"scans": 0, "last_scan": 0.0, "status": "starting", "connected": None}


def _wifi_loop():
    while True:
        try:
            nets = wifi_scan.scan(retries=1)
            now = time.time()
            for n in nets:
                n["est_distance_m"] = round(wifi_scan.rssi_to_distance(n["rssi_dbm"]), 1)
                _wifi_seen[n["bssid"]] = {"entry": n, "last_seen": now}
            for bssid in [b for b, r in _wifi_seen.items()
                          if now - r["last_seen"] > WIFI_MERGE_DECAY]:
                del _wifi_seen[bssid]
            _wifi_state.update(scans=_wifi_state["scans"] + 1, last_scan=now,
                               status="live" if nets else "no networks",
                               connected=wifi_scan.connected_bssid())
        except Exception as e:  # noqa: BLE001
            _wifi_state["status"] = f"error: {e}"
        time.sleep(3)


def get_wifi():
    now = time.time()
    nets = []
    for rec in list(_wifi_seen.values()):
        e = dict(rec["entry"])
        e["age_s"] = round(now - rec["last_seen"])
        nets.append(e)
    nets.sort(key=lambda n: n["rssi_dbm"], reverse=True)
    return {"timestamp": now, "count": len(nets), "networks": nets,
            "scans": _wifi_state["scans"], "last_scan": _wifi_state["last_scan"],
            "status": _wifi_state["status"], "connected": _wifi_state["connected"]}


# ---- satellites: CelesTrak TLE, compact [name, line1, line2] rows ----
_tle_lock = threading.Lock()


def parse_tle(text):
    lines = [l.rstrip() for l in text.splitlines() if l.strip()]
    sats, i = [], 0
    while i + 2 < len(lines):
        if lines[i + 1].startswith("1 ") and lines[i + 2].startswith("2 "):
            sats.append([lines[i].strip(), lines[i + 1], lines[i + 2]])
            i += 3
        else:
            i += 1
    return sats


def get_tle():
    with _tle_lock:
        cache = {"v": 2, "groups": {}, "fetched": {}, "tried": {}}
        try:
            with open(TLE_CACHE, encoding="utf-8") as f:
                old = json.load(f)
            if old.get("v") == 2:
                cache = old
        except (OSError, json.JSONDecodeError):
            pass
        now, errors, dirty = time.time(), [], False
        for g in TLE_GROUPS:
            if now - cache["fetched"].get(g, 0) < TLE_CACHE_TTL:
                continue
            if now - cache["tried"].get(g, 0) < TLE_RETRY:
                continue
            cache["tried"][g] = now
            dirty = True
            try:
                sats = parse_tle(fetch(TLE_URL.format(g), timeout=60).decode("utf-8", "replace"))
                if not sats:
                    raise ValueError("empty response")
                cache["groups"][g] = sats
                cache["fetched"][g] = now
            except Exception as e:  # noqa: BLE001
                errors.append(f"{g}: {e}")
                cache["groups"].setdefault(g, [])
        if dirty:
            try:
                os.makedirs(DATA_DIR, exist_ok=True)
                with open(TLE_CACHE + ".tmp", "w", encoding="utf-8") as f:
                    json.dump(cache, f)
                os.replace(TLE_CACHE + ".tmp", TLE_CACHE)
            except OSError:
                pass
        return {"groups": cache["groups"], "fetched": cache["fetched"], "errors": errors}


# ---- aircraft: adsb.lol first, OpenSky if it is down ----
def _aircraft_adsblol(lat, lon, radius_km):
    nm = max(5, min(250, int(radius_km / 1.852)))
    raw = fetch_json(f"https://api.adsb.lol/v2/lat/{lat:.4f}/lon/{lon:.4f}/dist/{nm}")
    out = []
    for a in raw.get("ac") or []:
        alt = a.get("alt_geom", a.get("alt_baro"))
        if a.get("lat") is None or a.get("lon") is None or not isinstance(alt, (int, float)):
            continue                                   # no position, or on the ground
        out.append({"icao": a.get("hex", ""), "callsign": (a.get("flight") or "").strip(),
                    "lat": a["lat"], "lon": a["lon"], "alt_m": round(alt * 0.3048),
                    "vel_ms": round((a.get("gs") or 0) * 0.5144, 1),
                    "heading": a.get("track") or 0,
                    "vrate_ms": round((a.get("baro_rate") or 0) * 0.00508, 1),
                    "type": a.get("t"), "reg": a.get("r"), "squawk": a.get("squawk"),
                    "category": a.get("category")})
    return out, "adsb.lol"


def _aircraft_opensky(lat, lon, radius_km):
    dlat = radius_km / 111.32
    dlon = radius_km / (111.32 * math.cos(math.radians(lat)) or 1e-6)
    raw = fetch_json("https://opensky-network.org/api/states/all"
                     f"?lamin={lat - dlat:.4f}&lomin={lon - dlon:.4f}"
                     f"&lamax={lat + dlat:.4f}&lomax={lon + dlon:.4f}")
    out = []
    for s in raw.get("states") or []:
        if s[5] is None or s[6] is None or s[8]:
            continue
        out.append({"icao": s[0], "callsign": (s[1] or "").strip(),
                    "lon": s[5], "lat": s[6],
                    "alt_m": s[7] if s[7] is not None else (s[13] or 0),
                    "vel_ms": s[9] or 0, "heading": s[10] or 0, "vrate_ms": s[11] or 0,
                    "type": None, "reg": None, "squawk": s[14] if len(s) > 14 else None,
                    "category": None})
    return out, "opensky"


def get_aircraft(lat, lon, radius_km):
    def load():
        try:
            ac, src = _aircraft_adsblol(lat, lon, radius_km)
        except Exception:  # noqa: BLE001
            ac, src = _aircraft_opensky(lat, lon, radius_km)
        return {"fetched_at": time.time(), "source": src, "count": len(ac), "aircraft": ac}
    return cached(f"ac:{lat:.2f}:{lon:.2f}", 8, load)


# ---- radiosondes (SondeHub): weather balloons transmitting right now ----
def get_sondes(lat, lon, radius_km):
    def load():
        raw = fetch_json("https://api.v2.sondehub.org/sondes"
                         f"?lat={lat:.4f}&lon={lon:.4f}&distance={int(radius_km * 1000)}&last=10800")
        out = []
        for serial, s in (raw or {}).items():
            if s.get("lat") is None or s.get("lon") is None:
                continue
            out.append({"serial": serial, "type": s.get("type"), "lat": s["lat"], "lon": s["lon"],
                        "alt_m": s.get("alt") or 0, "freq_mhz": s.get("frequency"),
                        "temp_c": s.get("temp"), "humidity": s.get("humidity"),
                        "vel_v": s.get("vel_v"), "datetime": s.get("datetime")})
        return {"fetched_at": time.time(), "count": len(out), "sondes": out}
    return cached(f"sondes:{lat:.1f}:{lon:.1f}", 30, load)


# ---- space weather (NOAA SWPC) ----
SWPC = "https://services.swpc.noaa.gov"


def _last(obj):
    """SWPC summaries come as a dict, a list of dicts, or header + rows."""
    if isinstance(obj, list) and obj:
        last = obj[-1]
        if isinstance(last, list) and isinstance(obj[0], list):
            return dict(zip(obj[0], last))
        return last
    return obj or {}


def _num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def get_spaceweather():
    def load():
        out, errors = {"fetched_at": time.time()}, []

        def grab(name, url, fn):
            try:
                fn(fetch_json(SWPC + url))
            except Exception as e:  # noqa: BLE001
                errors.append(f"{name}: {e}")

        def kp(j):
            r = _last(j)
            out["kp"] = _num(r.get("Kp", r.get("kp_index")))
            out["kp_time"] = r.get("time_tag")

        def xray(j):
            long_band = [r for r in j if r.get("energy") == "0.1-0.8nm" and r.get("flux")]
            flux = long_band[-1]["flux"]
            out["xray_flux"] = flux
            for letter, floor in (("X", 1e-4), ("M", 1e-5), ("C", 1e-6), ("B", 1e-7), ("A", 1e-8)):
                if flux >= floor:
                    out["xray_class"] = f"{letter}{flux / floor:.1f}"
                    break
            else:
                out["xray_class"] = "A0.0"
            out["xray_history"] = [r["flux"] for r in long_band[-120:]]

        grab("kp", "/products/noaa-planetary-k-index.json", kp)
        grab("wind", "/products/summary/solar-wind-speed.json",
             lambda j: out.update(wind_kms=_num(_last(j).get("proton_speed", _last(j).get("WindSpeed")))))
        grab("imf", "/products/summary/solar-wind-mag-field.json",
             lambda j: out.update(bt_nt=_num(_last(j).get("bt", _last(j).get("Bt"))),
                                  bz_nt=_num(_last(j).get("bz_gsm", _last(j).get("Bz")))))
        grab("f107", "/products/summary/10cm-flux.json",
             lambda j: out.update(f107_sfu=_num(_last(j).get("flux", _last(j).get("Flux")))))
        grab("xray", "/json/goes/primary/xrays-6-hour.json", xray)
        out["errors"] = errors
        if len(errors) == 5:
            raise RuntimeError("; ".join(errors))
        return out
    return cached("spaceweather", 120, load)


# ---- masts and antennas that physically exist (OpenStreetMap) ----
_masts_lock = threading.Lock()
MASTS_RADIUS = 6000
MASTS_TTL = 7 * 86400


def get_masts(lat, lon):
    key = f"{lat:.2f},{lon:.2f}"                        # ~1 km grid: walking rarely refetches
    with _masts_lock:
        try:
            with open(MASTS_CACHE, encoding="utf-8") as f:
                disk = json.load(f)
        except (OSError, json.JSONDecodeError):
            disk = {}
        hit = disk.get(key)
        if hit and time.time() - hit["t"] < MASTS_TTL:
            return {"masts": hit["masts"], "source": "osm (disk cache)"}
        a = f"(around:{MASTS_RADIUS},{lat:.5f},{lon:.5f})"
        q = ("[out:json][timeout:25];("
             f'nwr["man_made"="mast"]["tower:type"!~"lighting|bird"]{a};'
             f'nwr["man_made"="tower"]["tower:type"="communication"]{a};'
             f'nwr["man_made"="communications_tower"]{a};'
             f'nwr["man_made"="antenna"]{a};'
             f'nwr[~"^communication:"~"."]{a};'
             ");out center tags 500;")
        try:
            raw = fetch_json("https://overpass-api.de/api/interpreter", timeout=40,
                             data=urllib.parse.urlencode({"data": q}).encode())
        except Exception as e:  # noqa: BLE001
            return {"masts": hit["masts"] if hit else [], "error": str(e)}
        masts = []
        for el in raw.get("elements", []):
            c = el.get("center", el)
            if "lat" not in c:
                continue
            tags = el.get("tags", {})
            uses = sorted(k.split(":", 1)[1] for k, v in tags.items()
                          if k.startswith("communication:") and v != "no")
            masts.append({"id": el["id"], "lat": c["lat"], "lon": c["lon"],
                          "kind": tags.get("man_made", "antenna"), "uses": uses,
                          "height_m": _num(tags.get("height")),
                          "operator": tags.get("operator"), "name": tags.get("name")})
        disk[key] = {"t": time.time(), "masts": masts}
        try:
            with open(MASTS_CACHE, "w", encoding="utf-8") as f:
                json.dump(disk, f)
        except OSError:
            pass
        return {"masts": masts, "source": "osm overpass"}


# ---- places that announce public WiFi, and telecom plant, within walking distance (OpenStreetMap) ----
HOTSPOTS_CACHE = os.path.join(DATA_DIR, "hotspots_cache.json")
HOTSPOTS_RADIUS = 2500


def get_hotspots(lat, lon):
    key = f"{lat:.2f},{lon:.2f}"
    with _masts_lock:
        try:
            with open(HOTSPOTS_CACHE, encoding="utf-8") as f:
                disk = json.load(f)
        except (OSError, json.JSONDecodeError):
            disk = {}
        hit = disk.get(key)
        if hit and time.time() - hit["t"] < MASTS_TTL:
            return {"hotspots": hit["hotspots"], "source": "osm (disk cache)"}
        a = f"(around:{HOTSPOTS_RADIUS},{lat:.5f},{lon:.5f})"
        q = ("[out:json][timeout:25];("
             f'nwr["internet_access"~"wlan|yes"]{a};'
             f'nwr["telecom"]{a};'
             f'nwr["man_made"="street_cabinet"]["street_cabinet"="telecom"]{a};'
             ");out center tags 600;")
        try:
            raw = fetch_json("https://overpass-api.de/api/interpreter", timeout=40,
                             data=urllib.parse.urlencode({"data": q}).encode())
        except Exception as e:  # noqa: BLE001
            return {"hotspots": hit["hotspots"] if hit else [], "error": str(e)}
        out = []
        for el in raw.get("elements", []):
            c = el.get("center", el)
            if "lat" not in c:
                continue
            t = el.get("tags", {})
            wlan = t.get("internet_access") in ("wlan", "yes")
            out.append({"id": el["id"], "lat": c["lat"], "lon": c["lon"],
                        "kind": "wifi" if wlan else (t.get("telecom") or "telecom cabinet"),
                        "name": t.get("name"), "ssid": t.get("internet_access:ssid"),
                        "fee": t.get("internet_access:fee"),
                        "place": t.get("amenity") or t.get("shop") or t.get("tourism") or t.get("building"),
                        "operator": t.get("operator")})
        disk[key] = {"t": time.time(), "hotspots": out}
        try:
            with open(HOTSPOTS_CACHE, "w", encoding="utf-8") as f:
                json.dump(disk, f)
        except OSError:
            pass
        return {"hotspots": out, "source": "osm overpass"}


# ---- offline datasets: FCC broadcast stations, OpenCelliD cells ----
_stations = {}
_towers_cache = None


def get_stations(service, lat, lon, radius, limit=400):
    if service not in _stations:
        rows = []
        if os.path.exists(STATION_CSV[service]):
            with open(STATION_CSV[service], newline="", encoding="utf-8") as f:
                for row in csv.DictReader(f):
                    try:
                        rows.append({"callsign": row["callsign"], "freq_mhz": float(row["freq_mhz"]),
                                     "city": row["city"], "state": row["state"], "class": row["class"],
                                     "erp_kw": float(row["erp_kw"]),
                                     "lat": float(row["lat"]), "lon": float(row["lon"])})
                    except (ValueError, KeyError):
                        continue
        _stations[service] = rows
    out = []
    for s in _stations[service]:
        if abs(s["lat"] - lat) > radius / 111_000:      # cheap reject before haversine
            continue
        d = haversine(lat, lon, s["lat"], s["lon"])
        if d <= radius:
            out.append(dict(s, distance_m=round(d, 1)))
    out.sort(key=lambda s: s["distance_m"])
    return {"stations": out[:limit], "count_source": len(_stations[service])}


def get_towers(lat, lon, radius):
    global _towers_cache
    if _towers_cache is None:
        _towers_cache = []
        if os.path.exists(TOWERS_CSV):
            with open(TOWERS_CSV, newline="", encoding="utf-8") as f:
                for row in csv.DictReader(f):
                    try:
                        _towers_cache.append({
                            "radio": row["radio"], "lat": float(row["lat"]), "lon": float(row["lon"]),
                            "range": float(row.get("range") or 0),
                            "samples": int(float(row.get("samples") or 0))})
                    except (ValueError, KeyError):
                        continue
    out = []
    for t in _towers_cache:
        d = haversine(lat, lon, t["lat"], t["lon"])
        if d <= radius:
            out.append(dict(t, distance_m=round(d, 1)))
    out.sort(key=lambda t: t["distance_m"])
    return {"towers": out[:800], "count_source": len(_towers_cache)}


CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon",
}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):  # quieter logs
        pass

    def _json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        u = urlparse(self.path)
        path = u.path
        q = parse_qs(u.query)

        def num(name, default):
            try:
                return float(q.get(name, [default])[0])
            except ValueError:
                return float(default)

        lat = num("lat", FALLBACK_LOCATION["lat"])
        lon = num("lon", FALLBACK_LOCATION["lon"])
        try:
            if path == "/api/config":
                return self._json({"fallback_location": FALLBACK_LOCATION,
                                   "ble": ble_scan.snapshot()["status"],
                                   "datasets": {s: os.path.exists(p) for s, p in STATION_CSV.items()}})
            if path == "/api/wifi":
                return self._json(get_wifi())
            if path == "/api/ble":
                return self._json(ble_scan.snapshot())
            if path == "/api/net":
                return self._json(net_scan.snapshot())
            if path == "/api/tle":
                return self._json(get_tle())
            if path == "/api/aircraft":
                return self._json(get_aircraft(lat, lon, num("r", 150)))
            if path == "/api/sondes":
                return self._json(get_sondes(lat, lon, num("r", 400)))
            if path == "/api/spaceweather":
                return self._json(get_spaceweather())
            if path == "/api/masts":
                return self._json(get_masts(lat, lon))
            if path == "/api/hotspots":
                return self._json(get_hotspots(lat, lon))
            if path in ("/api/fm", "/api/am", "/api/tv"):
                default_r = {"fm": 120000, "am": 300000, "tv": 150000}[path[5:]]
                return self._json(get_stations(path[5:], lat, lon, num("r", default_r)))
            if path == "/api/towers":
                return self._json(get_towers(lat, lon, num("r", 3000)))
            return self._static(path)
        except (BrokenPipeError, ConnectionError):
            return None
        except Exception as e:  # noqa: BLE001
            return self._json({"error": str(e)}, status=500)

    def _static(self, path):
        if path in ("/", ""):
            path = "/index.html"
        rel = os.path.normpath(path.lstrip("/"))
        full = os.path.join(APP_DIR, rel)
        if not os.path.abspath(full).startswith(os.path.abspath(APP_DIR)) \
                or not os.path.isfile(full):
            self.send_error(404)
            return
        ext = os.path.splitext(full)[1].lower()
        with open(full, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", CONTENT_TYPES.get(ext, "application/octet-stream"))
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)


# ---- HTTPS: phones only hand out GPS / orientation / camera to secure origins ----
def lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))               # no packet is sent
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


def find_openssl():
    exe = shutil.which("openssl")
    if exe:
        return exe
    for pattern in (r"C:\Program Files\Git\mingw64\bin\openssl.exe",
                    r"C:\Program Files\Git\usr\bin\openssl.exe",
                    r"C:\Program Files*\OpenSSL*\bin\openssl.exe"):
        hits = glob.glob(pattern)
        if hits:
            return hits[0]
    return None


def ensure_cert(ip):
    if os.path.exists(CERT_PEM) and os.path.exists(KEY_PEM):
        return True
    exe = find_openssl()
    if not exe:
        return False
    os.makedirs(DATA_DIR, exist_ok=True)
    r = subprocess.run(
        [exe, "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "825",
         "-keyout", KEY_PEM, "-out", CERT_PEM, "-subj", "/CN=infosphere",
         "-addext", f"subjectAltName=DNS:localhost,IP:127.0.0.1,IP:{ip}"],
        capture_output=True, text=True)
    return r.returncode == 0 and os.path.exists(CERT_PEM)


def serve_https(port, ip):
    if not ensure_cert(ip):
        print("HTTPS off: openssl not found (phones will not get GPS / compass)")
        return
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(CERT_PEM, KEY_PEM)
    httpd = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    print(f"Phone (same Wi-Fi)  -> https://{ip}:{port}   (self-signed: accept the warning once)")


if __name__ == "__main__":
    # PORT is set by dev-server launchers that pick a free port; an explicit argument still wins
    port, https_port, use_https = int(os.environ.get("PORT") or 8000), 8443, True
    args = sys.argv[1:]
    for i, a in enumerate(args):
        if a == "--port" and i + 1 < len(args):
            port = int(args[i + 1])
        elif a == "--https-port" and i + 1 < len(args):
            https_port = int(args[i + 1])
        elif a == "--no-https":
            use_https = False
        elif a.isdigit() and (i == 0 or not args[i - 1].startswith("--")):
            port = int(a)
    print(f"This machine        -> http://localhost:{port}")
    if use_https:
        serve_https(https_port, lan_ip())
    threading.Thread(target=_wifi_loop, daemon=True).start()
    ble_scan.start()
    net_scan.start()
    threading.Thread(target=get_tle, daemon=True).start()   # warm the orbit cache
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()

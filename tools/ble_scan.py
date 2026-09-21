#!/usr/bin/env python3
"""ble_scan.py — continuous BLE advertisement scanner built on bleak.

Runs in a background thread inside server.py. Every scan cycle (~5 s)
refreshes a shared dict of nearby BLE devices: headphones, watches,
beacons — the human-carried signal field.

Beyond RSSI it keeps what each advertisement actually says: the
manufacturer (Bluetooth SIG company id), Apple Continuity message type
(AirPods / Find My / Handoff ...), service UUIDs, announced TX power and
the raw payload bytes (barcode source for the browser).

Graceful degradation: if bleak or a Bluetooth adapter is missing,
`status()` reports the reason and the server returns empty lists.
"""
import asyncio
import threading
import time

try:
    from bleak import BleakScanner
    _HAS_BLEAK = True
except ImportError:
    _HAS_BLEAK = False

_devices = {}          # addr -> {name, rssi, last_seen, ...}
_state = {"status": "starting", "error": None, "cycles": 0}
_thread = None
SCAN_TIMEOUT = 5.0     # seconds per bleak discover cycle
CYCLE_PAUSE = 2.0      # pause between cycles
STALE_AFTER = 25.0     # drop devices not seen for this long

# Bluetooth SIG assigned company identifiers (the common body-worn ones)
COMPANIES = {
    0x0002: "intel", 0x0006: "microsoft", 0x000A: "qualcomm", 0x000F: "broadcom",
    0x001D: "qualcomm", 0x004C: "apple", 0x0059: "nordic", 0x0067: "jabra",
    0x0075: "samsung", 0x0087: "garmin", 0x009E: "bose", 0x00E0: "google",
    0x012D: "sony", 0x0157: "huami", 0x0171: "amazon", 0x01DA: "logitech",
    0x02E5: "espressif", 0x038F: "xiaomi",
}
# Apple Continuity protocol message types (first byte of the 0x004C payload)
APPLE_TYPES = {
    0x02: "ibeacon", 0x05: "airdrop", 0x07: "airpods", 0x08: "hey-siri",
    0x09: "airplay", 0x0A: "airplay", 0x0B: "magic-switch", 0x0C: "handoff",
    0x0D: "hotspot", 0x0E: "hotspot", 0x0F: "nearby-action",
    0x10: "nearby-info", 0x12: "find-my",
}


def rssi_to_distance(rssi, tx_power=-59, n=2.7):
    """Rough log-distance path-loss estimate, meters."""
    try:
        return round(10 ** ((tx_power - rssi) / (10 * n)), 1)
    except Exception:  # noqa: BLE001
        return None


def _describe(adv):
    """(company, kind, payload_hex) from one AdvertisementData."""
    company, kind, payload = None, None, b""
    for cid, data in (adv.manufacturer_data or {}).items():
        company = COMPANIES.get(cid, f"0x{cid:04x}")
        payload = cid.to_bytes(2, "little") + bytes(data)
        if cid == 0x004C and data:
            kind = APPLE_TYPES.get(data[0])
        break
    if not payload:
        for uuid, data in (adv.service_data or {}).items():
            payload = bytes.fromhex(uuid.replace("-", "")[:8]) + bytes(data)
            break
    return company, kind, payload[:48].hex()


async def _scan_once():
    found = await BleakScanner.discover(timeout=SCAN_TIMEOUT, return_adv=True)
    now = time.time()
    for addr, (dev, adv) in found.items():
        company, kind, payload = _describe(adv)
        _devices[addr] = {
            "addr": addr,
            "name": dev.name or adv.local_name or "",
            "rssi": adv.rssi,
            "company": company,
            "kind": kind,
            "tx_power": adv.tx_power,
            "services": len(adv.service_uuids or []),
            "payload_hex": payload,
            "last_seen": now,
        }


def _loop():
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    while True:
        try:
            loop.run_until_complete(_scan_once())
            _state["status"] = "live"
            _state["error"] = None
            _state["cycles"] += 1
        except Exception as e:  # noqa: BLE001
            _state["status"] = "error"
            _state["error"] = str(e)
            time.sleep(5)
        time.sleep(CYCLE_PAUSE)


def start():
    """Start the background scanner thread (idempotent)."""
    global _thread
    if not _HAS_BLEAK:
        _state["status"] = "unavailable"
        _state["error"] = "bleak not installed"
        return
    if _thread is None:
        _thread = threading.Thread(target=_loop, daemon=True)
        _thread.start()


def snapshot():
    """Current device list, freshest first."""
    now = time.time()
    for addr in [a for a, d in _devices.items()
                 if now - d["last_seen"] > STALE_AFTER]:
        del _devices[addr]
    devs = []
    for d in _devices.values():
        devs.append({
            "addr": d["addr"],
            "name": d["name"],
            "rssi_dbm": d["rssi"],
            "company": d["company"],
            "kind": d["kind"],
            "tx_power": d["tx_power"],
            "services": d["services"],
            "payload_hex": d["payload_hex"],
            "est_distance_m": rssi_to_distance(d["rssi"]),
            "age_s": round(now - d["last_seen"], 1),
        })
    devs.sort(key=lambda d: d["rssi_dbm"], reverse=True)
    return {
        "timestamp": now,
        "status": _state["status"],
        "error": _state["error"],
        "count": len(devs),
        "devices": devs,
    }

#!/usr/bin/env python3
"""wifi_scan.py — Real-time WiFi scanner (Windows).

Primary backend: native wlanapi.dll via ctypes — triggers an ACTIVE scan
and returns BSSID list with true RSSI in dBm.
Fallback backend: `netsh wlan show networks mode=bssid` (passive cache,
sometimes only shows the connected AP).

No third-party dependencies.

Usage:
    python tools/wifi_scan.py            # scan once, print JSON
    python tools/wifi_scan.py --watch 5  # rescan every 5 seconds
"""
import ctypes
import json
import re
import subprocess
import sys
import time
from ctypes import wintypes

# ---------------------------------------------------------------- ctypes backend

DOT11_PHY_TYPES = {
    1: "802.11 (FHSS)", 2: "802.11 (DSSS)", 3: "802.11 (IR)",
    4: "802.11a", 5: "802.11b", 6: "802.11g", 7: "802.11n",
    8: "802.11ac", 9: "802.11ad", 10: "802.11ax", 11: "802.11be",
}


class GUID(ctypes.Structure):
    _fields_ = [("Data1", ctypes.c_ulong), ("Data2", ctypes.c_ushort),
                ("Data3", ctypes.c_ushort), ("Data4", ctypes.c_ubyte * 8)]


class DOT11_SSID(ctypes.Structure):
    _fields_ = [("uSSIDLength", wintypes.ULONG), ("ucSSID", ctypes.c_ubyte * 32)]


class WLAN_RATE_SET(ctypes.Structure):
    _fields_ = [("uRateSetLength", wintypes.ULONG),
                ("usRateSet", ctypes.c_ushort * 126)]


class WLAN_BSS_ENTRY(ctypes.Structure):
    _fields_ = [
        ("dot11Ssid", DOT11_SSID),
        ("uPhyId", wintypes.ULONG),
        ("dot11Bssid", ctypes.c_ubyte * 6),
        ("dot11BssType", ctypes.c_int),
        ("dot11BssPhyType", ctypes.c_int),
        ("lRssi", wintypes.LONG),
        ("uLinkQuality", wintypes.ULONG),
        ("bInRegDomain", wintypes.BOOLEAN),
        ("usBeaconPeriod", ctypes.c_ushort),
        ("ullTimestamp", ctypes.c_ulonglong),
        ("ullHostTimestamp", ctypes.c_ulonglong),
        ("usCapabilityInformation", ctypes.c_ushort),
        ("ulChCenterFrequency", wintypes.ULONG),
        ("wlanRateSet", WLAN_RATE_SET),
        ("ulIeOffset", wintypes.ULONG),
        ("ulIeSize", wintypes.ULONG),
    ]


class WLAN_BSS_LIST(ctypes.Structure):
    _fields_ = [("dwTotalSize", wintypes.DWORD),
                ("dwNumberOfItems", wintypes.DWORD),
                ("wlanBssEntries", WLAN_BSS_ENTRY * 1)]


class WLAN_INTERFACE_INFO(ctypes.Structure):
    _fields_ = [("InterfaceGuid", GUID),
                ("strInterfaceDescription", wintypes.WCHAR * 256),
                ("isState", ctypes.c_int)]


class WLAN_INTERFACE_INFO_LIST(ctypes.Structure):
    _fields_ = [("dwNumberOfItems", wintypes.DWORD),
                ("dwIndex", wintypes.DWORD),
                ("InterfaceInfo", WLAN_INTERFACE_INFO * 1)]


IE_HEX_BYTES = 160  # raw beacon bytes forwarded to the browser (barcode source)


def parse_ies(raw: bytes) -> dict:
    """Walk the 802.11 Information Elements of a beacon / probe response.

    Extracts what the radio really announced: channel width, country code,
    BSS Load (associated station count + channel utilisation), PHY
    generation and the vendor OUIs of the chipset.
    """
    info = {"width_mhz": 20, "country": None, "sta_count": None,
            "ch_util": None, "gen": None, "vendors": []}
    gen = 0
    i = 0
    while i + 2 <= len(raw):
        eid, ln = raw[i], raw[i + 1]
        body = raw[i + 2:i + 2 + ln]
        i += 2 + ln
        if len(body) < ln:
            break
        if eid == 7 and ln >= 2:                      # Country
            cc = body[:2].decode("ascii", "replace")
            if cc.isalpha():
                info["country"] = cc
        elif eid == 11 and ln >= 3:                   # BSS Load
            info["sta_count"] = body[0] | (body[1] << 8)
            info["ch_util"] = round(body[2] / 255.0, 3)
        elif eid == 45:                               # HT capabilities
            gen = max(gen, 4)
        elif eid == 61 and ln >= 2:                   # HT operation
            if body[1] & 0x03:
                info["width_mhz"] = max(info["width_mhz"], 40)
        elif eid == 191:                              # VHT capabilities
            gen = max(gen, 5)
        elif eid == 192 and ln >= 3:                  # VHT operation
            if body[0] == 1:
                wide = body[2] and abs(body[2] - body[1]) == 8
                info["width_mhz"] = max(info["width_mhz"], 160 if wide else 80)
            elif body[0] in (2, 3):
                info["width_mhz"] = 160
        elif eid == 255 and ln >= 1:                  # extension elements
            if body[0] in (35, 36):                   # HE (wifi 6)
                gen = max(gen, 6)
            elif body[0] in (106, 108):               # EHT (wifi 7)
                gen = max(gen, 7)
        elif eid == 221 and ln >= 3:                  # vendor specific
            oui = body[:3].hex()
            if oui not in info["vendors"] and len(info["vendors"]) < 6:
                info["vendors"].append(oui)
    info["gen"] = gen or None
    return info


def _scan_wlanapi() -> list:
    wlanapi = ctypes.windll.wlanapi
    handle = wintypes.HANDLE()
    ver = wintypes.DWORD()
    if wlanapi.WlanOpenHandle(2, None, ctypes.byref(ver), ctypes.byref(handle)) != 0:
        raise RuntimeError("WlanOpenHandle failed")
    try:
        p_list = ctypes.POINTER(WLAN_INTERFACE_INFO_LIST)()
        if wlanapi.WlanEnumInterfaces(handle, None, ctypes.byref(p_list)) != 0:
            raise RuntimeError("WlanEnumInterfaces failed")
        if p_list.contents.dwNumberOfItems < 1:
            raise RuntimeError("no wireless interface")
        # copy the GUID out before freeing the list it lives in
        guid = GUID.from_buffer_copy(p_list.contents.InterfaceInfo[0].InterfaceGuid)
        wlanapi.WlanFreeMemory(p_list)

        # trigger ACTIVE scan, then poll BSS list until populated
        wlanapi.WlanScan(handle, ctypes.byref(guid), None, None, None)
        entries = []
        for _ in range(8):
            time.sleep(1.2)
            p_bss = ctypes.POINTER(WLAN_BSS_LIST)()
            if wlanapi.WlanGetNetworkBssList(handle, ctypes.byref(guid), None,
                                             1, True, None,
                                             ctypes.byref(p_bss)) != 0:
                continue
            try:
                n = p_bss.contents.dwNumberOfItems
                base = ctypes.addressof(p_bss.contents.wlanBssEntries)
                size = ctypes.sizeof(WLAN_BSS_ENTRY)
                entries = []
                for i in range(n):
                    e = WLAN_BSS_ENTRY.from_address(base + i * size)
                    ssid_len = min(e.dot11Ssid.uSSIDLength, 32)
                    ssid = bytes(e.dot11Ssid.ucSSID[:ssid_len]).decode(
                        "utf-8", "replace")
                    bssid = ":".join(f"{b:02x}" for b in e.dot11Bssid)
                    freq_mhz = e.ulChCenterFrequency / 1000.0
                    channel = (int((freq_mhz - 2407) / 5) if freq_mhz < 3000
                               else int((freq_mhz - 5950) / 5) if freq_mhz > 5945
                               else int((freq_mhz - 5000) / 5))
                    ie_raw = b""
                    if 0 < e.ulIeSize < 4096:
                        ie_raw = bytes((ctypes.c_ubyte * e.ulIeSize).from_address(
                            base + i * size + e.ulIeOffset))
                    entry = {
                        "ssid": ssid,
                        "bssid": bssid,
                        "signal_pct": int(e.uLinkQuality),
                        "rssi_dbm": int(e.lRssi),
                        "channel": channel,
                        "freq_mhz": round(freq_mhz, 1),
                        "beacon_tu": int(e.usBeaconPeriod),
                        "band": "2.4 GHz" if freq_mhz < 3000 else (
                            "6 GHz" if freq_mhz > 5945 else "5 GHz"),
                        "radio": DOT11_PHY_TYPES.get(
                            e.dot11BssPhyType, f"phy{e.dot11BssPhyType}"),
                        "ie_hex": ie_raw[:IE_HEX_BYTES].hex(),
                    }
                    entry.update(parse_ies(ie_raw))
                    entries.append(entry)
            finally:
                wlanapi.WlanFreeMemory(p_bss)
            if entries:
                break
        entries.sort(key=lambda n: n["rssi_dbm"], reverse=True)
        return entries
    finally:
        wlanapi.WlanCloseHandle(handle, None)


# ---------------------------------------------------------------- netsh fallback

def pct_to_dbm(pct: int) -> int:
    """Approximate conversion: Windows signal % -> dBm."""
    return int(pct / 2) - 100


def _scan_netsh() -> list:
    out = subprocess.run(
        ["netsh", "wlan", "show", "networks", "mode=bssid"],
        capture_output=True, text=True, timeout=30,
        encoding="utf-8", errors="replace",
    ).stdout
    networks = []
    current_ssid = None
    current = None

    def flush():
        nonlocal current
        if current is not None:
            networks.append(current)
            current = None

    for line in out.splitlines():
        m = re.match(r"^SSID\s+\d+\s*:\s?(.*)$", line)
        if m:
            flush()
            current_ssid = m.group(1).strip()
            continue
        m = re.match(r"^\s+BSSID\s+\d+\s*:\s*([0-9a-fA-F:]{17})", line)
        if m:
            flush()
            current = {"ssid": current_ssid, "bssid": m.group(1).lower(),
                       "signal_pct": None, "rssi_dbm": None,
                       "channel": None, "band": None, "radio": None}
            continue
        if current is None:
            continue
        m = re.match(r"^\s+Signal\s*:\s*(\d+)%", line)
        if m:
            current["signal_pct"] = int(m.group(1))
            current["rssi_dbm"] = pct_to_dbm(current["signal_pct"])
            continue
        m = re.match(r"^\s+Channel\s*:\s*(\d+)", line)
        if m:
            current["channel"] = int(m.group(1))
            continue
        m = re.match(r"^\s+Band\s*:\s*(.+)$", line)
        if m:
            current["band"] = m.group(1).strip()
            continue
        m = re.match(r"^\s+Radio type\s*:\s*(.+)$", line)
        if m:
            current["radio"] = m.group(1).strip()
    flush()
    networks = [n for n in networks if n.get("rssi_dbm") is not None]
    networks.sort(key=lambda n: n["rssi_dbm"], reverse=True)
    return networks


def connected_bssid():
    """BSSID of the access point this machine is associated with, or None."""
    try:
        out = subprocess.run(["netsh", "wlan", "show", "interfaces"], capture_output=True,
                             text=True, timeout=10, errors="replace",
                             creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0)).stdout
    except Exception:  # noqa: BLE001
        return None
    m = re.search(r"BSSID\s*:\s*([0-9a-fA-F]{2}(?::[0-9a-fA-F]{2}){5})", out)
    return m.group(1).lower() if m else None


# ---------------------------------------------------------------- public API

def scan(min_expected: int = 5, retries: int = 3, delay: float = 2.0) -> list:
    """Active scan via wlanapi; fall back to netsh (with retry for sparse
    passive results). Keeps the richest result seen."""
    best = []
    backend = "wlanapi"
    for attempt in range(retries):
        try:
            nets = _scan_wlanapi()
        except Exception:  # noqa: BLE001
            backend = "netsh"
            try:
                nets = _scan_netsh()
            except Exception:  # noqa: BLE001
                nets = []
        if len(nets) > len(best):
            best = nets
        if len(best) >= min_expected:
            break
        if attempt < retries - 1:
            time.sleep(delay)
    for n in best:
        n["backend"] = backend
    return best


def rssi_to_distance(rssi_dbm: float, tx_power: float = -40.0, n: float = 3.0) -> float:
    """Log-distance path loss model: estimate meters from RSSI.

    tx_power: expected RSSI at 1 m (typ. -30..-50 dBm for WiFi APs)
    n: path-loss exponent (2 free space, 3-4 indoor)
    """
    d = 10 ** ((tx_power - rssi_dbm) / (10.0 * n))
    return max(1.0, min(d, 80.0))


if __name__ == "__main__":
    watch = None
    if "--watch" in sys.argv:
        i = sys.argv.index("--watch")
        watch = float(sys.argv[i + 1]) if i + 1 < len(sys.argv) else 5.0
    while True:
        nets = scan()
        for n in nets:
            n["est_distance_m"] = round(rssi_to_distance(n["rssi_dbm"]), 1)
        print(json.dumps({"timestamp": time.time(), "count": len(nets),
                          "networks": nets}, ensure_ascii=False, indent=2))
        if watch is None:
            break
        time.sleep(watch)

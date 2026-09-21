#!/usr/bin/env python3
"""net_scan.py — this machine's own traffic, read from netstat / arp.

  throughput   `netstat -e` byte counters, differenced into live bps
  connections  `netstat -n -p TCP` established sockets
  neighbours   `arp -a` devices on the local network

Privacy: this server listens on the LAN, so identities are masked before
they leave the machine — remote IPs keep only their first two octets,
MACs keep only the vendor OUI. A short stable hash stands in for the rest
so the browser can still tell entries apart.

Parsing is numeric / regex only, so it does not depend on the Windows
display language.

Usage:  python tools/net_scan.py      # print one snapshot as JSON
"""
import hashlib
import json
import re
import subprocess
import threading
import time

POLL_SECONDS = 2.0
_state = {"rx_bps": 0, "tx_bps": 0, "rx_total": 0, "tx_total": 0,
          "connections": [], "neighbours": [], "t": 0.0, "status": "starting"}
_prev = {"rx": None, "tx": None, "t": None}
_thread = None


def _run(args):
    return subprocess.run(args, capture_output=True, text=True, timeout=15,
                          errors="replace",
                          creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0)).stdout


def _tag(s):
    return hashlib.sha1(s.encode()).hexdigest()[:6]


def _mask_ip(ip):
    if ":" in ip:                                  # IPv6: keep the /32
        head = ip.split(":")[:2]
        return ":".join(head) + "::x"
    p = ip.split(".")
    return f"{p[0]}.{p[1]}.x.x" if len(p) == 4 else "x"


def read_counters():
    """(rx_bytes, tx_bytes): first row of `netstat -e` holding two integers."""
    for line in _run(["netstat", "-e"]).splitlines():
        m = re.match(r"^\S.*?\s(\d+)\s+(\d+)\s*$", line)
        if m:
            return int(m.group(1)), int(m.group(2))
    return None, None


def read_connections():
    conns = []
    for line in _run(["netstat", "-n", "-p", "TCP"]).splitlines():
        p = line.split()
        if len(p) < 4 or p[0] != "TCP" or p[3] != "ESTABLISHED":
            continue
        rip, _, rport = p[2].rpartition(":")
        rip = rip.strip("[]")
        if rip.startswith("127.") or rip == "::1":
            continue
        conns.append({"id": _tag(p[2]), "remote": _mask_ip(rip),
                      "port": int(rport) if rport.isdigit() else 0})
    return conns


def read_neighbours():
    out = []
    for line in _run(["arp", "-a"]).splitlines():
        m = re.match(r"^\s*(\d+\.\d+\.\d+\.\d+)\s+([0-9a-fA-F]{2}(?:[-:][0-9a-fA-F]{2}){5})\s", line)
        if not m:
            continue
        ip, mac = m.group(1), m.group(2).lower().replace("-", ":")
        first = int(mac[:2], 16)
        if mac == "ff:ff:ff:ff:ff:ff" or first & 1:      # broadcast / multicast
            continue
        out.append({"id": _tag(mac), "oui": mac[:8],
                    "host": ip.rsplit(".", 1)[-1],
                    "random_mac": bool(first & 2)})       # locally administered
    return out


def poll():
    now = time.time()
    rx, tx = read_counters()
    if rx is not None:
        if _prev["rx"] is not None and now > _prev["t"]:
            dt = now - _prev["t"]
            # counters are 32-bit on some adapters: ignore the wrap sample
            if rx >= _prev["rx"] and tx >= _prev["tx"]:
                _state["rx_bps"] = int((rx - _prev["rx"]) * 8 / dt)
                _state["tx_bps"] = int((tx - _prev["tx"]) * 8 / dt)
        _prev.update(rx=rx, tx=tx, t=now)
        _state["rx_total"], _state["tx_total"] = rx, tx
    _state["connections"] = read_connections()
    _state["neighbours"] = read_neighbours()
    _state["t"] = now
    _state["status"] = "live"


def _loop():
    while True:
        try:
            poll()
        except Exception as e:  # noqa: BLE001
            _state["status"] = f"error: {e}"
        time.sleep(POLL_SECONDS)


def start():
    global _thread
    if _thread is None:
        _thread = threading.Thread(target=_loop, daemon=True)
        _thread.start()


def snapshot():
    s = dict(_state)
    s["timestamp"] = s.pop("t")
    s["conn_count"] = len(s["connections"])
    return s


if __name__ == "__main__":
    poll()
    time.sleep(POLL_SECONDS)
    poll()
    print(json.dumps(snapshot(), indent=2))

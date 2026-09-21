# INFOSPHERE

### An AR signal field — every invisible signal around you, drawn live in hard-edged pixel blocks

Black background, hard-edged blocks, barcodes and 1 px lines. No gradients, no antialiasing.
**Signal strength is never transparency — it is the duty cycle of a binary flicker**: strong signals stay lit, weak ones drop frames.

## Quick start

```bash
python server.py
```

- This machine: open **http://localhost:8000** and allow location.
- Phone (same Wi-Fi): open the **https://<computer-ip>:8443** address printed in the terminal, accept the self-signed certificate once, allow location; on iOS tap `ar` to grant the motion sensors.
  Phone browsers only hand GPS / compass / camera to secure origins, hence HTTPS (the certificate is generated on first start with the local openssl, which ships with Git for Windows).
- Optional: `pip install bleak` enables the Bluetooth layer; `python tools/import_broadcast.py` refreshes the AM / TV station tables.

**The observer is the device's live position**, tracked continuously. Walk 250 m and broadcast stations, masts and hotspots reload for the new place; satellites, the sun and pulsars are recomputed every second.
The built-in fallback location is used only when no fix is available, and the top-right corner then says `location: fallback`.

## How to read the picture: three rules

1. **Bearing is always true.** The top edge is a compass tape; what you face is what is there.
2. **Distance is log-compressed.** `R(d) = 60·log10(1 + d/1.5)`, so an earbud 3 m away and a geostationary satellite 36 000 km away share one room. The concentric floor rings are 10 m / 100 m / 1 km … 10 000 km.
3. **Elevation 0°–24.5° above the horizon is a frequency axis.** Ground emitters all sit at about 0° elevation, so that band of sky is free — it is used for frequency:
   **the 360° horizon is a spectrum wall — horizontal = true bearing, vertical = frequency, flicker = received power.**
   Seven stacked bands, bottom to top: `AM` · `FM` · `TV (RF ch 2–36)` · `CELLULAR 600–4000` · `ISM 2.4` · `WIFI 5 G` · `WIFI 6E`.
   The pitch ladder on the right edge doubles as the frequency ruler for that band and uses the same function as the scene (`space.js: elOf`), so ticks line up with what they measure.
   Above 24.5° is the real sky.

Every emitter is a **barcode**: the stripes are its real bytes (a WiFi beacon frame, a BLE advertisement payload, a station's callsign and frequency), the thickness is its real bandwidth,
a hairline (a lattice mast for the strongest) drops to the floor to mark bearing and distance, and it owns one spike on the power rose at your feet.

| What you see | What it is |
|---|---|
| White horizontal barcode + a point of light; the loudest also send a beam of 3D rings toward you | WiFi access point. Ring spacing follows the real 2.4 / 5 / 6 GHz wavelength ratio, the gaps in each ring come from beacon bytes, busier channels travel faster; **the AP you are connected to has the largest halo** |
| Three short grey barcodes + small rings | BLE device (advertising channels 37 / 38 / 39); cross = Find My, hollow frame = AirPods |
| White / light-grey thin barcode + a faint lattice mast with a lit tip | FM / AM / TV station (white = strong estimated power). AM adds a carrier line, TV adds the ATSC pilot on the channel's lower edge |
| Grey seven-segment barcode column + grey lattice mast | Communication mast / antenna (bands shown are allocations, not measurements) |
| Grey hollow frames in the middle distance | Places that announce public WiFi (cafés, libraries…) from OpenStreetMap — too far to receive, shown because the map knows they exist |
| **The polar "power rose" on the floor at your feet** | One radial spike per emitter along its true bearing, length = received power (rings at −90 / −70 / −50 / −30 dBm). The outline is a **peak-hold envelope** like a spectrum analyser's: lit spikes push it up and it sinks back by itself — steady where signals are strong, breathing where they are weak. A faint ray continues to the real tower. Only the ~150 loudest sources get a spike; measured WiFi / BLE spikes are doubled |
| A web of faint white lines (clearest from third person) | **Only relations that really exist**: same SSID, same channel (they interfere), same router, BLE devices of one maker, stations sharing one tower, this machine's TCP connections (you → gateway → one hub per /16 prefix → each remote host); the dots sliding along them move at the real interface throughput. Each line is faint; crowded places become bright by overlap |
| Blue points + meteor-like wakes | Satellites. Starlink bright blue, OneWeb / Iridium mid blue, GNSS pale-blue hollow frames (with a short line pointing at you). The wake is a smooth curve through about two minutes of **real past positions**: near-white at the head, fading continuously to nothing; when selected it turns red and the next two minutes are drawn as a dashed prediction |
| White cross + halo / white hollow frame + wake / white cross + plumb line | Crewed space station / aircraft (flashes on every ADS-B update) / radiosonde |
| Large white hollow frame + halo, white points blinking at a fixed period | The sun, radio sources, pulsars (blinking at their true rotation period) |
| White point cloud arching across the sky | **The magnetosphere** (placed like satellites: true direction, log-compressed distance, so first person shows the same density as the orbital view): ~120 000 one-pixel points flowing along dipole field lines, flattened on the day side and dragged into a tail on the night side. Flow speed and tail length ← measured solar-wind speed; lean ← the sun's real position; day side opening up ← IMF Bz; turbulence ← Kp; brightness ← X-ray flux |

Colour: **white / grey = everything on and near the ground, blue = the sky, red = only the one thing you have selected** (its barcode, its spike and ray on the rose, its wake and prediction, its orbit, its line on the spectrum and its corner frame all turn red together). Structural lines (masts, hairlines, rays, axes) are faint additive lines that only brighten where they pile up. Dark grey is for reference marks only.
Style boundary: blocks, barcodes and lines are always hard-edged and single-coloured; exactly three things may be soft — the **white halo** on a few chosen points, the magnetosphere point cloud, and the additive overlap of network edges.

## Three scales, one continuous zoom

Mouse wheel / pinch (`O` toggles between the first two, double-click returns to first person, `Shift + wheel` changes the field of view):

- **0 · first person** — you stand inside the signals. The ring instrument at the centre of the screen belongs to this scale only and fades out as soon as you pull back.
- **1 · third person** — the camera backs out along your line of sight and rises, always looking at you; turn around (or turn the phone) and it swings round with you. Selection switches to **mouse hover (tap on touch)**: a red corner frame plus a readout panel that follows the target, paused while dragging. From here you see the whole figure: the barcode cylinder on the horizon, the pixel dome, the web radiating from you, the power rose at your feet.
- **2 · orbital view** — a hard cut to the planet: a globe drawn only with latitude scan lines over land, **about 12 000 satellites at their real 3D positions** (linear scale here), each trailing about five minutes of real track; you are a point of light on the surface with thin lines to the satellites that can see you right now; crewed stations always show their full orbit and any selected satellite gets its ellipse. The bottom edge becomes a satellite data table.

## The instruments on the four edges

- **Top: compass tape** — scrolls with your heading; the small pips under it are the bearings of the strongest emitters.
- **Right: pitch ladder / frequency ruler** — see rule 3 (the frequency annotation fades out once you leave first person, because "elevation = frequency" only holds from your eye).
- **Bottom: the spectrum of what you face** — a 100 kHz → 13 GHz log ruler with a waterfall that **only sums emitters inside a cone from you along the way you face**, regardless of how far the camera has pulled back (in third person the cone is drawn on the floor): turn and it changes; look up to find the faint haze of GPS L1 and Starlink Ku. The selected target's frequency is marked with a red line. Every instrument sits on an opaque black plate so the scene never bleeds through a scale.
- **Left: data bars that are also the layer filter** — throughput, TCP sockets, WiFi networks / clients / channel load, BLE, aircraft, satellites, Starlink, GNSS, broadcast, masts · hotspots, Kp, solar wind, Bz, X-ray, F10.7, each with a short history. **Click a row to show / hide its layers; hover a row and everything it counts is framed in red in the field.**
- **Centre: the ring instrument** (first person only; every arc is a reading):
  - thick inner arc = signal strength of the selected target; thin inner arc = a type-specific quantity (WiFi channel load / satellite range…); inside the ring, its shape glyph on the left and three live key numbers on the right.
  - middle ring = heading; its gap always points north and the whole ring turns as you turn; the ticks on the left half slide with it; the thin outermost arc = pitch.
  - lower-right scale = frequency, with a long tick at the selected target's frequency; outside it, the last 30 seconds of its strength.
  - **the outermost ring of 72 dots = signal density around the full 360°**; four grey arcs = how many targets lie ahead / right / behind / left, with a small triangle at the loudest source in each quadrant; △ / ▽ = the loudest ground source and the highest sky object in the cone you face.
  - three dots = **how these numbers were obtained**: filled white = measured, filled grey = database, hollow = estimated. The colour of the small triangle = its family.
  - the small text block at the top right is the selected target's **real raw bytes** (beacon hex and bits, TLE lines…); with nothing selected it scrolls the latest raw JSON from the feeds.
- **Selection** — a red corner frame on the target itself, a leader that starts at that frame, and the full record on an opaque panel with its bytes scrolling as a barcode.

`H` cycles instruments → labels only → clean picture. `camera` passthrough is off by default; when on, the video is pushed to greyscale, high contrast and very dark.

## Data sources

| Layer | Source | Refresh |
|---|---|---|
| WiFi | native `wlanapi.dll` active scan + beacon Information Elements | continuous background thread |
| BLE | bleak | ~7 s |
| This machine's network | `netstat -e` / `netstat -n` / `arp -a` | 2 s |
| Aircraft | adsb.lol (falls back to OpenSky) | 10 s |
| Radiosondes | SondeHub | 30 s |
| Space weather | NOAA SWPC: Kp, solar wind, IMF, F10.7, GOES X-ray | 2 min |
| Satellites | CelesTrak TLE + SGP4: stations / GNSS / weather / amateur / visual / Iridium / OneWeb / **Starlink ~10 700** | TLE cached 6 h on disk; positions amortised across frames |
| Masts / antennas | OpenStreetMap Overpass (disk cache on a ~1 km grid, 7 days) | with position |
| Public-WiFi places / telecom plant | OpenStreetMap Overpass, 2.5 km | with position |
| FM / AM / TV | FCC licence database (offline CSV) | with position |
| Coastlines | Natural Earth 110m (public domain), rasterised offline by `python tools/import_land.py` into `app/land.json` | — |
| Cells (optional) | OpenCelliD: `python tools/import_towers.py cell_towers.csv --lat … --lon … --radius 5000` | with position |
| Sun / radio sources / pulsars | built-in catalogue + real-time astronomy | 1 s |

## Honesty statement (please keep when exhibiting)

| Level | What |
|---|---|
| **Measured** | WiFi: dBm, channel, width, associated stations, channel utilisation, beacon bytes. BLE: dBm, maker, message type, payload. This machine's throughput and TCP connections. Aircraft positions. Radiosonde position / frequency / temperature. Kp, solar wind, F10.7, X-ray. |
| **Real, from a database** | Station frequency / power / coordinates (FCC). Mast and hotspot coordinates (OSM). Satellite orbits (NORAD elements + SGP4, ~100 m). Celestial positions (~0.1°). Pulsar periods. |
| **A model driven by measurements** | The magnetosphere cloud: an analytic dipole model whose shape and motion are driven by the measured solar-wind speed / Bz / Kp / X-ray flux — not a measurement of the field. |
| **Estimated** | WiFi / BLE distance (log-distance path loss). Received power of broadcast stations and aircraft (free-space loss + a 35 dB/decade terrain slope; AM adds daytime ground / D-layer loss, so distant AM stations light up after dusk and the AM band dims during M-class flares). Satellite downlinks are typical values for the constellation. OSM antennas carry no frequency, so the US cellular downlink **allocations** are drawn. The bottom spectrum is **reconstructed** from known emitters, not an SDR measurement. |
| **Aesthetic placement** | The position of remote TCP hosts (networks have no bearing; hashed from the address into clusters). The bearing of WiFi / BLE devices: a network card cannot measure direction, so a stable hash of the ID is used (BSSIDs of one router sit together). |

Scope: WiFi / BLE / TCP are measured by **the computer running `server.py`**; the phone is only a window, so keep the computer with you.
FM / AM / TV use US FCC data — outside the US those three layers are empty, everything else works worldwide.
Privacy: the server listens on the LAN, so remote IPs keep only their first two octets and MACs only their vendor OUI before they leave the machine.

## Architecture

```
server.py                 Python standard library only; HTTP :8000 + HTTPS :8443
tools/wifi_scan.py        wlanapi active scan + IE parsing
tools/ble_scan.py         bleak advertisement scanner
tools/net_scan.py         throughput / TCP / ARP (masked)
tools/import_broadcast.py FCC AM / TV -> data/*.csv     tools/import_fm.py   FCC FM
tools/import_land.py      Natural Earth -> app/land.json
tools/import_towers.py    OpenCelliD / WiGLE CSV filter

app/gfx.js     rendering primitives: pixel-snapped blocks + white halo, ring beams, wakes, additive lines
app/space.js   the three rules: log distance, frequency <-> elevation, power estimate, planet frame
app/store.js   all polling + the observer
app/field.js   every data layer -> blocks, lines and targets (things that can be labelled, selected, summed)
app/web.js     the network of real relations     app/flow.js  magnetosphere cloud     app/orbit.js  orbital view
app/hud.js     edge instruments, labels, ring instrument, selection, satellite table
app/ar.js      live position, 3-DOF orientation, camera
app/astro.js · cosmos.js · bands.js   astronomy, radio-source catalogue, spectrum allocations
```

## Credit

In its direction this project is an homage to Richard Vijgen's *The Architecture of Radio*.

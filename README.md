# Harogic analyzers for SoundBase

Maintained by Matt Bell ([matt@mbsound.org](mailto:matt@mbsound.org)). Issues and
pull requests: [github.com/mbsound/soundbase-plugin-harogic](https://github.com/mbsound/soundbase-plugin-harogic).

A SoundBase plugin that brings Harogic spectrum analyzers into SoundBase's live
scan, over **USB** and over the **network** (Harogic network analyzers such as
the R1000), using the [Harogic SDK for macOS](https://github.com/mbsound/Harogic-Mac-SDK).

**Runs on Apple Silicon Macs only** (`darwin-arm64`). Nothing to install: the
SDK, libusb and the C++ runtime ship inside the plugin.

## Using it

- The device picker lists only analyzers that are present, named by how they
  are reached: **Harogic USB Analyzer · SN …** for one on USB, **Harogic Network
  Analyzer · name** for one on the network. There is nothing to add by hand.
- **Network analyzers** with the network settings service installed announce
  themselves (mDNS) and appear by themselves, also from another subnet over
  IPv6 link-local (same cable or switch). For one that does not announce
  itself, list its address or name under the plugin's *Network analyzers to
  look for*, e.g. `192.168.1.100, harogic-net1.local` (add `:port` if the data
  port is not 5000).

Close SAStudio4 or fReqon first: an analyzer serves one application at a time.

**Defaults are chosen to look right out of the box:** the trace is served at
the analyzer's own resolution (about 4000 points on a wide span, whatever the
RBW; SoundBase shows no point-count box for this device), RBW is automatic
(50 kHz on a 146 MHz span, hundreds of sweeps a second), the reference level
starts at −30 dBm with the automatic reference level on, preamplifier and
attenuation on Auto. Nothing needs changing for a good first scan.

Beside SoundBase's own RBW, each analyzer offers:

| Control | |
|---|---|
| Reference level | −100 to +20 dBm, default −30. Sets the gain and with it the noise floor (−20 → about −108 dBm, −30 → −112, −40 → −114 at RBW 5 kHz). |
| Auto reference level | On (default): while the input overloads the level is raised in 5 dB steps until it stops, and lowered again after 30 s clean, never below a level that overloaded in the last 5 minutes; the level in force is shown as a notice. Off: the level is used as set. |
| Attenuation | Auto, or 0–30 dB in 5 dB steps |
| Preamplifier | Auto, Off, or Low/Medium/High gain on models that have them |
| Detector | Peak (default), Average, RMS, Sample |
| VBW Mode | fReqon's list: Auto (VBW=RBW, default), 0.1 * RBW (SAStudio's default, ~1 dB lower noise at half the sweep rate), 0.01 * RBW, 10 * RBW, or a fixed 1 kHz … 3 MHz |
| Spur rejection | Off, Standard (default), Enhanced |

**Preamplifier High is easy to overload.** Next to a strong transmitter (a TV
station in the band), the hop containing it clips, and that whole hop (tens of
MHz) reads up to 30 dB too high on the clipped sweeps. The plugin reports this
as an overload warning, critical once a quarter of sweeps clip. Auto or Medium
gain avoids it; add attenuation only after turning the gain down. A bus-powered
analyzer can also brown out at High gain with a narrow RBW (every hop fails
with a bus error): run it from its power supply.

**Noise floor and reference level.** The reference level sets the analyzer's
gain and therefore the floor: measured on a SAN-60 at RBW 5 kHz, preamp
Medium, attenuation Auto, a reference level of −20 dBm gives a floor of about
−108 dBm, −30 gives −112 and −40 gives −114, until strong signals in the band
overload the input (the overload warning says so). Lower it until the warning
appears, then back off. The trace is always at the analyzer's resolution
(about 4000 points for a 146 MHz span whatever the RBW), so nothing is
averaged away or doubled up.

**Sweep rate on USB.** Measured on a SAN-60 over a 146 MHz span: about 880
sweeps/s at RBW 100 kHz and 520 at 50 kHz, sustained. At 30 kHz and below
the SDK moves much larger frames per hop and the rate settles at roughly
15–30 sweeps/s after a fast first few seconds (a limitation in the Mac SDK
port's USB path, not in the analyzer; the data stays live). Still several
sweeps a second more than SoundBase needs. A cable that is not the
analyzer's own can halve every rate or keep it off the bus altogether.

RBW left on auto follows fReqon's rule: 10 kHz up to a 15 MHz span, 30 kHz to
50 MHz, 50 kHz to 150 MHz, 100 kHz above.

## What the plugin does on its own

- **Reconnects.** When the analyzer stops answering (unplugged, powered off,
  a network blip, a brown-out), the device shows a critical "reconnecting"
  warning and the plugin reopens it and re-applies the settings for up to two
  minutes, then resumes sweeping. Only after that does the device fail.
- **Watches the supply and temperature** every 5 s: a USB analyzer running
  from USB power alone, a sagging USB voltage, or a core above 65 °C each get a
  warning that says what to do.
- **Times a sweep** after every configuration change and reports it, so
  SoundBase can tell a slow sweep (narrow RBW and VBW) from a stalled one.
- **Names the hardware** from the SDK's core table: "SAN-60 (N60 core R6)",
  "N90 core R0" for a network analyzer built around an N90.

`npm run hw-check` proves all of this against a connected analyzer.

## Firmware and SDK builds

Each Harogic SDK release only opens analyzers whose firmware matches it, so
the plugin ships two builds and tries them in turn, remembering which one
worked:

| Analyzer firmware | SDK build |
|---|---|
| 0.55.109 (`0x376d`) | 0.55.100 |
| 0.55.104 (`0x3768`) | 0.55.89 |

An analyzer neither build opens is reported as such in SoundBase, with the
suggestion to update its firmware.

## How it works

```
SoundBase ──HTTP── main.js + @soundbase/plugin-shell
                      │
                   adapter.js          discovery, config clamping, warnings
                      │
                   driver/analyzer.js  SDK build choice, open retries, deadlines
                      │  JSON lines over stdio, one process per analyzer
                   native/darwin-arm64/sdk<ver>/harogic-worker   (C, links libhtraapi.dylib)
```

The SDK runs in a **worker process per analyzer**. Every call has a deadline;
a call that misses it (a cable pulled mid-transfer, a network analyzer that
stops answering) gets the worker killed and the device marked failed, and the
plugin stays up. The next request reopens the analyzer. This is also how a
network open that stalls part-way through the handshake (about one in four,
see the SDK's README) is cut short and retried after 12 s instead of 21.

The worker resamples each sweep onto exactly the grid SoundBase asked for,
keeping the strongest native point in each output bin, so a narrow carrier
survives a coarse point count.

- **USB discovery** reads the IORegistry (`ioreg`), never the SDK, so it does
  not disturb an analyzer that is sweeping. Device ids are `usb:<serial>`, or
  `usb:loc-<locationID>` when the analyzer reports no serial.
- **Network discovery** browses mDNS (`_workstation._tcp`, refreshed every
  15 s in the background) and identifies analyzers by their factory name
  (`67-<serial>`), their settings service (`/harogic-info` on port 8080, over
  IPv4 or IPv6), or Harogic's system port 9000 — never the data port the SDK
  uses, which would disturb a session.
- **Routing** (`driver/net-route.js`, a port of fReqon's `net_route.py`): a
  name resolves to its IPv4 address and the SDK's sockets are pinned to the
  interface it is on (`HTRAAPI_NET_IF`), so a Wi-Fi network on the same subnet
  cannot take the traffic. Off-subnet, the SDK connects to a forwarder on
  127.0.0.1 that carries its connection to the analyzer's IPv6 link-local
  address.
- Calibration is cached in `~/Library/Application Support/htraapi`, shared
  with fReqon and other apps built on the Mac SDK.

## Developing

```sh
npm install
npm test                          # the whole stack against a fake worker, plus the real workers in mock mode
HAROGIC_PLUGIN_MOCK=1 npm run smoke   # boot as SoundBase does, with two simulated analyzers
npm run smoke                     # the same with real discovery
npm run hw-check                  # open, configure, sweep and read back a connected analyzer
```

To try it in SoundBase Desktop without packing anything:

```sh
SB_PLUGIN_DIRS="$HOME/Documents/Harogic Agent" open -a "SoundBase Desktop"
```

| Environment | |
|---|---|
| `HAROGIC_PLUGIN_MOCK=1` | two simulated analyzers; the real workers load their SDKs but open nothing |
| `HAROGIC_PLUGIN_DEBUG=1` | worker stderr in the plugin log |
| `HAROGIC_PLUGIN_WORKERS` | JSON list of `{ label, command, args?, env? }` replacing the shipped workers |
| `HAROGIC_PLUGIN_FORCE_LINK_LOCAL=1` | take the IPv6 link-local route for a name whenever there is one (tests the cross-subnet path on a same-subnet bench) |

### Rebuilding the workers

`native/` is committed: it is what ships. To rebuild it, unzip the
Harogic-Mac-SDK release zips (one per SDK build) into a folder and run:

```sh
driver/worker/build.sh <folder holding Harogic-Mac-SDK-*-sdk<ver>/>
```

The worker can be driven by hand:

```sh
printf '%s\n' '{"id":1,"op":"open","iface":"eth","ip":"192.168.1.100"}' \
  '{"id":2,"op":"config","startHz":470e6,"stopHz":616e6,"pointCount":11}' \
  '{"id":3,"op":"sweep"}' | native/darwin-arm64/sdk0.55.100/harogic-worker
```

## Licence

MIT for this plugin's code; see [LICENSE](LICENSE) for the components it ships
under their own terms (the SoundBase plugin SDK is BUSL-1.1, and Harogic's SDK
is Harogic's). Installing a plugin means trusting its author: it runs with your
user's privileges.

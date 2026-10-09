# Harogic analyzers for SoundBase

A SoundBase plugin that brings Harogic spectrum analyzers into SoundBase's live
scan, over **USB** and over the **network** (Harogic network analyzers such as
the R1000), using the [Harogic SDK for macOS](https://github.com/mbsound/Harogic-Mac-SDK).

**Runs on Apple Silicon Macs only** (`darwin-arm64`). Nothing to install: the
SDK, libusb and the C++ runtime ship inside the plugin.

## Using it

- **USB analyzers** appear in SoundBase's device picker as soon as they are
  plugged in.
- **Network analyzers**: in the plugin's settings, list their addresses in
  *Network analyzer addresses*, e.g. `192.168.1.100, harogic-net1.local`
  (add `:port` if the data port is not 5000). Each one that answers appears in
  the picker. A network analyzer can also be added by hand with its address in
  the device's *Address* field.

Close SAStudio4 or fReqon first: an analyzer serves one application at a time.

Beside SoundBase's own RBW and point count, each analyzer offers:

| Control | |
|---|---|
| Reference level | −100 to +20 dBm. The analyzer settles it; SoundBase shows the value in force. Lower it if an overload warning appears. |
| Attenuation | Auto, or 0–30 dB in 5 dB steps |
| Preamplifier | Auto, Off, or Low/Medium/High gain on models that have them |
| Detector | Peak (default), Average, RMS, Sample |
| Spur rejection | Off, Standard (default), Enhanced |

RBW left on auto follows fReqon's rule: 10 kHz up to a 15 MHz span, 30 kHz to
50 MHz, 50 kHz to 150 MHz, 100 kHz above.

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
- **Network discovery** probes TCP port 9000 (the analyzer's system server),
  never the data port the SDK uses.
- Calibration is cached in `~/Library/Application Support/htraapi`, shared
  with fReqon and other apps built on the Mac SDK.

## Developing

```sh
npm install
npm test                          # the whole stack against a fake worker, plus the real workers in mock mode
HAROGIC_PLUGIN_MOCK=1 npm run smoke   # boot as SoundBase does, with two simulated analyzers
npm run smoke                     # the same with real discovery
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
| `HTRAAPI_NET_IF=en7` | pin the SDK's sockets to one interface (see the SDK README) |

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

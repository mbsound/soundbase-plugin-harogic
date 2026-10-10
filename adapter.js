// Harogic spectrum analyzers, over USB and over the network, through the
// Harogic SDK for macOS (https://github.com/mbsound/Harogic-Mac-SDK).
//
// The SDK runs in a worker process per analyzer (driver/worker/), so a call
// that wedges inside the vendor library is killed rather than taking the
// plugin down with it, and so the driver can try each SDK build the plugin
// ships until one matches the analyzer's firmware.

import { HarogicAnalyzer } from './driver/analyzer.js';
import {
  DEFAULT_DATA_PORT,
  listUsbAnalyzers,
  parseAddresses,
  probeHost,
} from './driver/discovery.js';
import { mdnsAnalyzers, resolveTarget, startForwarder } from './driver/net-route.js';

// Each MUST be a `deviceTypeId` declared in soundbase-plugin.json.
export const USB_PRODUCT = 'plugin:harogic/usb';
export const NETWORK_PRODUCT = 'plugin:harogic/network';

const MIN_FREQUENCY_HZ = 9_000;
const MAX_FREQUENCY_HZ = 6_300_000_000;
const RBW_HZ = [1_000, 3_000, 10_000, 30_000, 100_000, 300_000, 1_000_000];
const MIN_POINTS = 2;
const MAX_POINTS = 32_001;
const DEFAULT_POINTS = 1_001;
const DEFAULT_START_HZ = 470_000_000;
const DEFAULT_STOP_HZ = 616_000_000;

// A sweep that keeps failing for this long means the analyzer has gone
// (unplugged, powered off, network down), not that one read was unlucky.
const LOST_AFTER_MS = 3_000;
// Overload is judged over the sweeps of the last couple of seconds: at
// hundreds of sweeps a second, one overloaded sweep would otherwise keep the
// warning lit whatever the user changes. Above this share it is reported.
const OVERLOAD_WINDOW_MS = 2_000;
const OVERLOAD_MIN_SHARE = 0.01;
// Above this share the plot is misleading: a clipped hop reads up to 30 dB
// too high across tens of MHz (measured on a SAN-60 at preamp High).
const OVERLOAD_CRITICAL_SHARE = 0.25;
const WARNINGS_INTERVAL_MS = 500;

const PREAMP = { auto: 0, off: 1, low: 2, medium: 3, high: 4 };
const DETECTOR = { peak: 1, average: 2, rms: 6, sample: 0 };
const SPUR = { off: 0, standard: 1, enhanced: 2 };

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const nearest = (list, v) =>
  list.reduce((best, c) => (Math.abs(c - v) < Math.abs(best - v) ? c : best));
const choice = (table, v, fallback) => (Object.hasOwn(table, v) ? v : fallback);

/** fReqon's automatic RBW: coarser resolution for wider spans. */
export function autoRbwHz(spanHz) {
  if (spanHz <= 15e6) return 10_000;
  if (spanHz <= 50e6) return 30_000;
  if (spanHz <= 150e6) return 50_000;
  return 100_000;
}

const simulated = () => process.env.HAROGIC_PLUGIN_MOCK === '1';

// ---------------------------------------------------------------------------
// discovery
// ---------------------------------------------------------------------------

/**
 * USB analyzers are listed from the IORegistry; network analyzers from the
 * addresses (or names) in the plugin settings, and from mDNS — every analyzer
 * announcing itself on this Mac's links, on this subnet or another one —
 * probed without touching their data port.
 */
export async function discoverDevices(pluginConfig = {}) {
  if (simulated()) {
    return [
      { id: 'usb:simulated', name: 'Harogic USB (simulated)', product: USB_PRODUCT,
        transport: { kind: 'usb', path: 'simulated' } },
      { id: 'net:simulated', name: 'Harogic network (simulated)', product: NETWORK_PRODUCT,
        transport: { kind: 'network', host: 'simulated', port: DEFAULT_DATA_PORT } },
    ];
  }
  const usb = (await listUsbAnalyzers()).map((a) => ({
    id: usbId(a),
    name: `Harogic ${a.product}`,
    product: USB_PRODUCT,
    transport: { kind: 'usb', path: a.serial ?? `location ${a.locationId}` },
  }));
  const network = await Promise.all(
    parseAddresses(pluginConfig.addresses).map(async ({ host, port }) => {
      // An analyzer this plugin already has open is present by definition, and
      // is not worth a probe; anything else is probed on its system port.
      if (!openHosts.has(host) && !(await probeHost(host))) return null;
      return {
        id: netId(host, port),
        name: `Harogic network analyzer (${host})`,
        product: NETWORK_PRODUCT,
        transport: { kind: 'network', host, port },
      };
    })
  );
  const listed = network.filter(Boolean);
  if (pluginConfig.mdns !== false) {
    const known = new Set(listed.map((d) => d.transport.host.toLowerCase()));
    for (const a of mdnsAnalyzers()) {
      // an analyzer already listed by its address or name is not listed twice
      if (known.has(a.host.toLowerCase()) || (a.ip && known.has(a.ip))) continue;
      listed.push({
        id: netId(a.host, DEFAULT_DATA_PORT),
        name: `${a.name} (Harogic network analyzer${a.via === 'ipv6' ? ', other subnet, over IPv6' : ''})`,
        product: NETWORK_PRODUCT,
        transport: { kind: 'network', host: a.host, port: DEFAULT_DATA_PORT },
      });
    }
  }
  return [...usb, ...listed];
}

const usbId = (a) => (a.serial ? `usb:${a.serial}` : `usb:loc-${a.locationId}`);
// host names are case-insensitive: one analyzer, one id, however it was typed
const netId = (host, port) => {
  const h = host.toLowerCase();
  return port === DEFAULT_DATA_PORT ? `net:${h}` : `net:${h}:${port}`;
};

const openHosts = new Set();

// ---------------------------------------------------------------------------
// SpectrumAnalyzer
// ---------------------------------------------------------------------------

export function createSpectrumAnalyzerAdapter(device) {
  return new HarogicAdapter(device);
}

class HarogicAdapter {
  constructor(device) {
    this.device = device;
    this.analyzer = null;
    this.effective = null;
    this.sweeping = false;
    this.generation = 0; // bumped by every applyConfig; stale sweeps are dropped
    this.sweepTimeoutMs = 10_000;
    this.warnings = { info: [], refNotice: null };
    this.recentSweeps = []; // [time, overloaded] over OVERLOAD_WINDOW_MS
    this.lastWarningsAt = 0;
    this.requestedRefDbm = undefined; // what the user asked for, not what the analyzer applied
    /** assigned by the shell */
    this.onFatal = null;
    this.onWarnings = null;
  }

  async open() {
    const { key, target, describe, host, env } = await this.#target();
    this.analyzer = new HarogicAnalyzer({ key, target, describe, env, log: logger });
    this.analyzer.onLost = (err) =>
      this.#lost(err.timeout
        ? `${describe} stopped answering (${err.message}). It may have been unplugged, powered off or disconnected from the network.`
        : `${describe}: the SDK worker stopped (${err.message}).`);
    let info;
    try {
      info = await this.analyzer.open();
    } catch (err) {
      this.forwarder?.close();
      this.forwarder = null;
      throw err;
    }
    if (host) {
      this.host = host;
      openHosts.add(host);
    }
    if (target.iface === 'usb' && info.busSpeed > 0 && info.busSpeed < 3) {
      this.warnings.info = [{
        id: 'usb-2', severity: 'info',
        message: 'The analyzer is on a USB 2 link. Sweeps are slower than on USB 3; use a USB 3 port and cable for full speed.',
      }];
    }
    this.#reportWarnings();

    return {
      capabilities: {
        minFrequencyHz: MIN_FREQUENCY_HZ,
        maxFrequencyHz: MAX_FREQUENCY_HZ,
        rbwHz: [...RBW_HZ],
        controls: [
          { id: 'refLevelDbm', type: 'number', label: 'Reference level', unit: 'dBm',
            default: -20, min: -100, max: 20, step: 1,
            help: 'Sets the analyzer’s gain while attenuation is on Auto; raise it if strong nearby transmitters cause overload warnings. With attenuation set by hand, the attenuation decides the reference level, and the preamplifier limits the highest one. The analyzer’s actual value is shown in its notices.' },
          { id: 'attenDb', type: 'dropdown', label: 'Attenuation', default: 'auto',
            choices: [{ id: 'auto', label: 'Auto' },
              ...[0, 5, 10, 15, 20, 25, 30].map((db) => ({ id: String(db), label: `${db} dB` }))] },
          { id: 'preamp', type: 'dropdown', label: 'Preamplifier', default: 'auto',
            choices: [{ id: 'auto', label: 'Auto' }, { id: 'off', label: 'Off' },
              { id: 'low', label: 'Low gain' }, { id: 'medium', label: 'Medium gain' },
              { id: 'high', label: 'High gain' }],
            help: 'More gain shows weaker signals but overloads sooner near strong transmitters. If an overload warning appears, turn this down before adding attenuation. Low/Medium/High are supported on some models only.' },
          { id: 'detector', type: 'dropdown', label: 'Detector', default: 'peak',
            choices: [{ id: 'peak', label: 'Peak' }, { id: 'average', label: 'Average' },
              { id: 'rms', label: 'RMS' }, { id: 'sample', label: 'Sample' }] },
          { id: 'spurRejection', type: 'dropdown', label: 'Spur rejection', default: 'standard',
            choices: [{ id: 'off', label: 'Off' }, { id: 'standard', label: 'Standard' },
              { id: 'enhanced', label: 'Enhanced' }],
            help: 'Enhanced removes more internal spurs at the cost of sweep speed.' },
        ],
      },
      identity: {
        manufacturer: 'Harogic',
        model: `Model 0x${info.model.toString(16)}`,
        firmware: `MCU 0x${info.mcuFirmware.toString(16)}, FPGA 0x${info.fpgaFirmware.toString(16)}, SDK ${info.sdk}`,
        serial: info.uid,
      },
    };
  }

  /** Where this device is: from device.config, or from the id it was discovered under. */
  async #target() {
    const config = this.device.config ?? {};
    const id = this.device.id ?? '';
    if (this.device.product === NETWORK_PRODUCT || id.startsWith('net:')) {
      let host = config.host?.trim();
      let port = Number(config.port) || DEFAULT_DATA_PORT;
      if (!host) {
        const m = /^net:(.+?)(?::(\d+))?$/.exec(id);
        if (!m) throw new Error(`device ${id} has no address: set "host" in its configuration`);
        host = m[1];
        port = Number(m[2]) || DEFAULT_DATA_PORT;
      }
      const describe = `Network analyzer ${host}`;
      if (simulated()) return { key: id, describe, host, target: { iface: 'eth', ip: '127.0.0.1', port } };
      let route;
      try {
        route = await resolveTarget(host, port);
      } catch (err) {
        throw new Error(`${describe}: ${err.message}.`);
      }
      if (route.note) logger('info', `${describe}: ${route.note}`);
      if (route.linkLocal) {
        // the SDK speaks IPv4 only: it connects here, and this carries it over IPv6
        this.forwarder = await startForwarder(route.linkLocal.host, port);
        route.port = this.forwarder.port;
      }
      return {
        key: id, describe, host,
        target: { iface: 'eth', ip: route.ip, port: route.port },
        env: route.netIf ? { HTRAAPI_NET_IF: route.netIf } : {},
      };
    }
    if (simulated()) return { key: id, describe: 'USB analyzer', target: { iface: 'usb', index: 0 } };
    const found = await listUsbAnalyzers();
    const match = found.find((a) => usbId(a) === id) ?? (found.length === 1 && !id.startsWith('usb:') ? found[0] : null);
    if (!match)
      throw new Error(`USB analyzer ${id.replace(/^usb:/, '')} is not connected. Check the cable and that the analyzer is powered.`);
    // the USB serial ends in the analyzer's UID: let the worker check it
    const uid = /([0-9a-f]{16})$/i.exec(match.serial ?? '')?.[1];
    return {
      key: id, describe: `USB analyzer ${match.serial ?? match.locationId}`,
      target: { iface: 'usb', index: match.index, ...(uid ? { expectUid: uid } : {}) },
    };
  }

  /**
   * Clamp, apply, echo. The trace is resampled in the worker onto exactly the
   * grid SoundBase asked for (peak-preserving), so start, stop and point count
   * come back as requested unless the hardware narrowed the range.
   */
  async applyConfig(cfg = {}) {
    const prev = this.effective ?? { controls: {} };
    const startHz = clamp(isNum(cfg.startHz) ? cfg.startHz : (prev.startHz ?? DEFAULT_START_HZ),
      MIN_FREQUENCY_HZ, MAX_FREQUENCY_HZ - 1_000);
    const stopHz = clamp(isNum(cfg.stopHz) ? cfg.stopHz : (prev.stopHz ?? DEFAULT_STOP_HZ),
      startHz + 1_000, MAX_FREQUENCY_HZ);
    const span = stopHz - startHz;

    let pointCount;
    if (isNum(cfg.pointCount)) pointCount = Math.round(cfg.pointCount);
    else if (isNum(cfg.stepHz) && cfg.stepHz > 0) pointCount = Math.round(span / cfg.stepHz) + 1;
    else pointCount = prev.pointCount ?? DEFAULT_POINTS;
    pointCount = clamp(pointCount, MIN_POINTS, MAX_POINTS);

    // Absent means unchanged; never set means automatic.
    const rbwRequested = isNum(cfg.rbwHz) ? nearest(RBW_HZ, cfg.rbwHz)
      : cfg.rbwHz === null ? undefined : prev.rbwHz;
    const rbwHz = rbwRequested ?? autoRbwHz(span);

    // the reference level the user asked for, not the one the analyzer
    // settled on last time, so a preamp turned back down restores it
    const c = { ...prev.controls, refLevelDbm: this.requestedRefDbm ?? prev.controls.refLevelDbm,
      ...(cfg.controls ?? {}) };
    const controls = {
      refLevelDbm: isNum(c.refLevelDbm) ? clamp(Math.round(c.refLevelDbm), -100, 20) : -20,
      attenDb: c.attenDb === 'auto' || c.attenDb == null ? 'auto'
        : String(nearest([0, 5, 10, 15, 20, 25, 30], clamp(Number(c.attenDb) || 0, 0, 30))),
      preamp: choice(PREAMP, c.preamp, 'auto'),
      detector: choice(DETECTOR, c.detector, 'peak'),
      spurRejection: choice(SPUR, c.spurRejection, 'standard'),
    };

    this.generation += 1;
    const applied = await this.analyzer.configure({
      startHz, stopHz, pointCount, rbwHz,
      refLevelDbm: controls.refLevelDbm,
      atten: controls.attenDb === 'auto' ? -1 : Number(controls.attenDb),
      preamp: PREAMP[controls.preamp],
      detector: DETECTOR[controls.detector],
      spur: SPUR[controls.spurRejection],
    });

    // the analyzer settles the reference level; report what it chose
    this.requestedRefDbm = controls.refLevelDbm;
    const appliedRef = Math.round(applied.refLevelDbm);
    this.warnings.refNotice = Math.abs(appliedRef - controls.refLevelDbm) >= 1 ? {
      id: 'ref-level', severity: 'info',
      message: (`A reference level of ${controls.refLevelDbm} dBm is not available with these settings; the analyzer is using ${appliedRef} dBm. ` +
        (controls.attenDb !== 'auto'
          ? 'With attenuation set by hand, the attenuation decides the reference level; set it to Auto to choose the reference level.'
          : controls.preamp !== 'off' ? 'The preamplifier limits the highest reference level; turn it down or off for a higher one.' : '')).trim(),
    } : null;
    const appliedPreamp = Object.keys(PREAMP).find((k) => PREAMP[k] === applied.preamp);
    this.warnings.preampNotice = appliedPreamp && appliedPreamp !== controls.preamp ? {
      id: 'preamp', severity: 'info',
      message: `The analyzer turned the preamplifier ${appliedPreamp === 'off' ? 'off' : `to ${appliedPreamp}`} (asked for ${controls.preamp}). ` +
        (controls.attenDb !== 'auto'
          ? `With ${controls.attenDb} dB of attenuation set by hand, the reference level is ${appliedRef} dBm and weak signals can sink below the noise floor; use Auto, or less attenuation, to see them.`
          : ''),
    } : null;
    if (applied.fallback)
      logger('warn', `${this.analyzer.describe}: the analyzer refused these settings (SWP_Configuration ${applied.firstStatus}) ` +
        'and was configured with its defaults for everything but the span and RBW.');
    logger('info', `${this.analyzer.describe}: ${(startHz / 1e6).toFixed(3)}–${(stopHz / 1e6).toFixed(3)} MHz, ` +
      `${pointCount} points, RBW ${Math.round(applied.rbwHz)} Hz; asked ref ${controls.refLevelDbm} dBm, atten ${controls.attenDb}, ` +
      `preamp ${controls.preamp}, detector ${controls.detector}, spur ${controls.spurRejection}; ` +
      `applied ref ${appliedRef} dBm, atten ${applied.atten < 0 ? 'auto' : applied.atten}, preamp ${appliedPreamp ?? applied.preamp}`);
    controls.refLevelDbm = appliedRef;
    this.recentSweeps = []; // overloads under the old settings no longer count
    this.#reportWarnings();
    const sweepTimeMs = Math.max(1, Math.round(applied.minSweepTimeS * 1000));
    this.sweepTimeoutMs = Number(process.env.HAROGIC_PLUGIN_SWEEP_TIMEOUT_MS) ||
      Math.max(10_000, sweepTimeMs * 4 + 5_000);

    const effective = {
      startHz: applied.startHz,
      stopHz: applied.stopHz,
      pointCount: applied.pointCount,
      controls,
      resolved: { sweepTimeMs },
    };
    if (rbwRequested !== undefined) effective.rbwHz = Math.round(applied.rbwHz);
    else effective.resolved.rbwHz = Math.round(applied.rbwHz);
    this.effective = effective;
    return effective;
  }

  async startSweep(onTrace) {
    if (this.sweeping) return;
    this.sweeping = true;
    (async () => {
      let failingSince = null;
      while (this.sweeping && this.analyzer) {
        const generation = this.generation;
        try {
          const { amps, overflow } = await this.analyzer.sweep(this.sweepTimeoutMs);
          failingSince = null;
          if (generation === this.generation) {
            const now = Date.now();
            this.recentSweeps.push([now, Boolean(overflow)]);
            while (this.recentSweeps.length && this.recentSweeps[0][0] < now - OVERLOAD_WINDOW_MS)
              this.recentSweeps.shift();
            // at hundreds of sweeps a second, judge the warnings a few times a second
            if (now - this.lastWarningsAt >= WARNINGS_INTERVAL_MS) {
              this.lastWarningsAt = now;
              this.#reportWarnings();
            }
          }
          if (this.sweeping && generation === this.generation && amps.length === this.effective?.pointCount)
            onTrace(amps);
        } catch (err) {
          if (!this.sweeping) return;
          if (err.timeout || err.exited) return; // the worker is gone; onLost reports it
          failingSince ??= Date.now();
          if (Date.now() - failingSince >= LOST_AFTER_MS) {
            this.#lost(`${this.analyzer?.describe ?? 'Analyzer'} stopped delivering sweeps (${err.message}). ` +
              'It may have been unplugged or powered off.');
            return;
          }
          await new Promise((r) => setTimeout(r, 50));
        }
      }
    })();
  }

  async stopSweep() {
    this.sweeping = false;
  }

  async close() {
    this.sweeping = false;
    if (this.host) openHosts.delete(this.host);
    this.forwarder?.close();
    this.forwarder = null;
    const analyzer = this.analyzer;
    this.analyzer = null;
    if (analyzer) {
      analyzer.onLost = null;
      await analyzer.close().catch(() => {});
    }
  }

  #lost(message) {
    if (!this.analyzer) return;
    this.sweeping = false;
    this.onFatal?.(new Error(message));
  }

  #reportWarnings() {
    const list = [...this.warnings.info];
    if (this.warnings.refNotice) list.push(this.warnings.refNotice);
    if (this.warnings.preampNotice) list.push(this.warnings.preampNotice);
    const sweeps = this.recentSweeps.length;
    const overloaded = this.recentSweeps.filter(([, o]) => o).length;
    if (sweeps > 0 && overloaded / sweeps >= OVERLOAD_MIN_SHARE) {
      // in steps of 5, so the text does not change on every report
      const pct = Math.max(1, 5 * Math.round((100 * overloaded) / sweeps / 5));
      const c = this.effective?.controls ?? {};
      const advice = c.preamp && c.preamp !== 'off'
        ? 'Turn the preamplifier down or off, then add attenuation if it continues.'
        : c.attenDb === 'auto'
          ? 'Raise the reference level, or set the attenuation by hand.'
          : Number(c.attenDb) < 30
            ? 'Add attenuation.'
            : 'The attenuation is at its maximum: use an external attenuator or a filter.';
      const critical = overloaded / sweeps >= OVERLOAD_CRITICAL_SHARE;
      list.push({
        id: 'overload', severity: critical ? 'critical' : 'warning',
        message: critical
          ? `Input overload on ${pct}% of sweeps: a strong signal is saturating the analyzer. The part of the band it falls in reads up to 30 dB too high on those sweeps, so the plot cannot be trusted. ${advice}`
          : `Input overload on ${pct}% of sweeps: a strong signal is saturating the analyzer, so levels near it are not reliable. ${advice}`,
      });
    }
    this.onWarnings?.(list);
  }
}

// Driver messages go to stdout, which the host shows as this plugin's log.
// Worker chatter (debug) only with HAROGIC_PLUGIN_DEBUG=1.
function logger(level, message) {
  if (level === 'debug' && process.env.HAROGIC_PLUGIN_DEBUG !== '1') return;
  process.stdout.write(`[${level}] ${message}\n`);
}

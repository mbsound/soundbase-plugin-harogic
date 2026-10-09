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
  resolveIPv4,
} from './driver/discovery.js';

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
// An IF overflow warning stays up this long after the last overloaded sweep,
// so it does not flicker on a signal that comes and goes.
const OVERLOAD_HOLD_MS = 2_000;

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
 * addresses in the plugin settings, probed without touching their data port.
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
  return [...usb, ...network.filter(Boolean)];
}

const usbId = (a) => (a.serial ? `usb:${a.serial}` : `usb:loc-${a.locationId}`);
const netId = (host, port) =>
  port === DEFAULT_DATA_PORT ? `net:${host}` : `net:${host}:${port}`;

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
    this.warnings = { overloadUntil: 0, info: [] };
    /** assigned by the shell */
    this.onFatal = null;
    this.onWarnings = null;
  }

  async open() {
    const { key, target, describe, host } = await this.#target();
    this.analyzer = new HarogicAnalyzer({ key, target, describe, log: logger });
    this.analyzer.onLost = (err) => this.#lost(`${describe}: the SDK worker stopped (${err.message}).`);
    const info = await this.analyzer.open();
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
            help: 'Sets the analyzer’s gain. Lower it if strong nearby transmitters cause overload warnings.' },
          { id: 'attenDb', type: 'dropdown', label: 'Attenuation', default: 'auto',
            choices: [{ id: 'auto', label: 'Auto' },
              ...[0, 5, 10, 15, 20, 25, 30].map((db) => ({ id: String(db), label: `${db} dB` }))] },
          { id: 'preamp', type: 'dropdown', label: 'Preamplifier', default: 'auto',
            choices: [{ id: 'auto', label: 'Auto' }, { id: 'off', label: 'Off' },
              { id: 'low', label: 'Low gain' }, { id: 'medium', label: 'Medium gain' },
              { id: 'high', label: 'High gain' }],
            help: 'Low/medium/high gain are supported on some models only; others treat them as on.' },
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
      let ip;
      try {
        ip = await resolveIPv4(host);
      } catch {
        throw new Error(`${describe}: cannot resolve "${host}" to an IPv4 address.`);
      }
      return { key: id, describe, host, target: { iface: 'eth', ip, port } };
    }
    if (simulated()) return { key: id, describe: 'USB analyzer', target: { iface: 'usb', index: 0 } };
    const found = await listUsbAnalyzers();
    const match = found.find((a) => usbId(a) === id) ?? (found.length === 1 && !id.startsWith('usb:') ? found[0] : null);
    if (!match)
      throw new Error(`USB analyzer ${id.replace(/^usb:/, '')} is not connected. Check the cable and that the analyzer is powered.`);
    return { key: id, describe: `USB analyzer ${match.serial ?? match.locationId}`, target: { iface: 'usb', index: match.index } };
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

    const c = { ...prev.controls, ...(cfg.controls ?? {}) };
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
    controls.refLevelDbm = Math.round(applied.refLevelDbm);
    const sweepTimeMs = Math.max(1, Math.round(applied.minSweepTimeS * 1000));
    this.sweepTimeoutMs = Math.max(10_000, sweepTimeMs * 4 + 5_000);

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
          if (overflow) this.warnings.overloadUntil = Date.now() + OVERLOAD_HOLD_MS;
          this.#reportWarnings();
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
    if (Date.now() < this.warnings.overloadUntil) {
      list.push({
        id: 'overload', severity: 'warning',
        message: 'Input overload: a strong signal is saturating the analyzer, so levels are not reliable. Raise the reference level or add attenuation.',
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

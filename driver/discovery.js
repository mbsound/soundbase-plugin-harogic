// Finding analyzers without opening them.
//
// Discovery runs once a second while SoundBase is listing devices, so it must
// be cheap and must never touch an analyzer's measurement session: USB
// analyzers are read from the IORegistry, and network analyzers are probed on
// their system port (9000) or settings service, never the data port the SDK
// uses. mDNS browsing is in net-route.js.

import { execFile } from 'node:child_process';
import { Socket } from 'node:net';
import { resolveTarget, SYSTEM_PORT } from './net-route.js';

// From the SDK's htrausb.conf: vendor/product ids of Harogic analyzers.
export const HAROGIC_USB_IDS = [
  { vendor: 0x367f, product: 0x0001 }, // HTRA
  { vendor: 0x6430, product: 0x0001 }, // SAE
  { vendor: 0x6430, product: 0x0003 }, // TRX
  { vendor: 0x6430, product: 0x0005 }, // SAM/SAN
];

export const DEFAULT_DATA_PORT = 5000;
const PROBE_TIMEOUT_MS = 800;

/**
 * Harogic USB analyzers in the IORegistry, ordered by locationID — the order
 * the SDK enumerates them in, which is what Device_Open's index refers to.
 * @returns {Promise<{ locationId: string, index: number, product: string, serial?: string }[]>}
 */
export async function listUsbAnalyzers() {
  // tests: a fixed list, so what is plugged into the developer's Mac does not matter
  if (process.env.HAROGIC_PLUGIN_USB_LIST) return JSON.parse(process.env.HAROGIC_PLUGIN_USB_LIST);
  if (process.platform !== 'darwin') return [];
  const text = await new Promise((resolve) => {
    execFile('/usr/sbin/ioreg', ['-p', 'IOUSB', '-l', '-w0'], { timeout: 3_000, maxBuffer: 8 << 20 },
      (err, stdout) => resolve(err ? '' : stdout));
  });
  return parseIoreg(text);
}

/** Exported for the tests: ioreg -p IOUSB -l text -> Harogic analyzers. */
export function parseIoreg(text) {
  const devices = [];
  let current = null;
  for (const line of text.split('\n')) {
    if (/\+-o /.test(line)) {
      current = {};
      devices.push(current);
      continue;
    }
    const m = /"([^"]+)" = (.*)$/.exec(line);
    if (!m || !current) continue;
    const [, key, raw] = m;
    current[key] = raw.startsWith('"') ? raw.slice(1, -1) : Number(raw);
  }
  return devices
    .filter((d) =>
      HAROGIC_USB_IDS.some((id) => id.vendor === d.idVendor && id.product === d.idProduct)
    )
    .sort((a, b) => a.locationID - b.locationID)
    .map((d, index) => ({
      locationId: d.locationID.toString(16).padStart(8, '0'),
      index,
      product: d['USB Product Name'] || 'Harogic analyzer',
      serial: d['USB Serial Number'] || undefined,
    }));
}

/** "192.168.1.100, harogic-net1.local:5000" -> [{ host, port }] */
export function parseAddresses(raw) {
  if (typeof raw !== 'string') return [];
  return raw
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const m = /^(.*?)(?::(\d+))?$/.exec(entry);
      return { host: m[1], port: Number(m[2]) || DEFAULT_DATA_PORT };
    });
}

/**
 * Is an analyzer answering at this address or name? On this Mac's networks:
 * its system port (9000) accepts, or refuses — a refusal still proves the host
 * is up. A name on another subnet counts when it answers over IPv6
 * link-local. The SDK's data port is never touched.
 */
export async function probeHost(host) {
  let route;
  try {
    route = await resolveTarget(host);
  } catch {
    return false;
  }
  if (route.linkLocal) return true;
  return new Promise((resolve) => {
    const socket = new Socket();
    const done = (up) => {
      socket.destroy();
      resolve(up);
    };
    socket.setTimeout(PROBE_TIMEOUT_MS, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', (err) => done(err.code === 'ECONNREFUSED'));
    socket.connect(SYSTEM_PORT, route.ip);
  });
}

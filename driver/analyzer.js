// A Harogic analyzer behind a worker process: which SDK build to run, opening
// with the retries the hardware needs, and the measurement calls.

import { chmodSync, constants, accessSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkerClient, WorkerError } from './worker-client.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const NATIVE_DIR = join(ROOT, 'native', `${process.platform}-${process.arch}`);

/** Device_Open: the analyzer's firmware does not match this SDK build. */
export const FIRMWARE_MISMATCH = -49;

// A network open normally takes ~3 s. About one in four, the analyzer stops
// answering part-way through the handshake and Device_Open only returns after
// the SDK's read timeouts (~21 s) with a dead session. Killing the worker and
// opening again is the cure (Harogic-Mac-SDK README, "Ethernet analyzers").
const NET_OPEN_STALL_MS = Number(process.env.HAROGIC_PLUGIN_STALL_MS) || 12_000;
const NET_OPEN_ATTEMPTS = 3;
// USB: the SDK reads calibration from flash on a first open, which is slow
const USB_OPEN_TIMEOUT_MS = 45_000;
const CONFIG_TIMEOUT_MS = 15_000;

const versionKey = (label) =>
  label.replace(/^sdk/, '').split('.').map((n) => n.padStart(6, '0')).join('.');

/**
 * The worker builds to try, newest SDK first. `HAROGIC_PLUGIN_WORKERS` (a JSON
 * array of { label, command, args?, env? }) replaces them — the tests point it
 * at a scripted fake, and it is the escape hatch for an SDK build this plugin
 * does not ship.
 */
export function workerBuilds(env = process.env) {
  if (env.HAROGIC_PLUGIN_WORKERS) return JSON.parse(env.HAROGIC_PLUGIN_WORKERS);
  if (!existsSync(NATIVE_DIR)) return [];
  return readdirSync(NATIVE_DIR)
    .filter((d) => existsSync(join(NATIVE_DIR, d, 'harogic-worker')))
    .sort((a, b) => versionKey(b).localeCompare(versionKey(a)))
    .map((d) => ({
      label: d.replace(/^sdk/, ''),
      command: ensureExecutable(join(NATIVE_DIR, d, 'harogic-worker')),
      cwd: join(NATIVE_DIR, d),
      env: env.HAROGIC_PLUGIN_MOCK === '1' ? { HAROGIC_WORKER_MOCK: '1' } : {},
    }));
}

// A zip extracted without its permission bits leaves the worker
// non-executable; put the bit back if the folder lets us.
function ensureExecutable(path) {
  try {
    accessSync(path, constants.X_OK);
  } catch {
    try {
      chmodSync(path, 0o755);
    } catch {
      // read-only install: spawning will say so
    }
  }
  return path;
}

// Which build last opened a given analyzer, so a reopen goes straight to it.
const preferredBuild = new Map();

export class HarogicAnalyzer {
  /**
   * @param {{ key: string, target: { iface: 'usb', index: number } |
   *           { iface: 'eth', ip: string, port: number },
   *           describe: string, log?: Function }} opts
   */
  constructor({ key, target, describe, log, env = {} }) {
    this.key = key;
    this.env = env;
    this.target = target;
    this.describe = describe;
    this.log = log ?? (() => {});
    this.worker = null;
    this.info = null;
    /** assigned by the adapter: the worker went away on its own */
    this.onLost = null;
  }

  async open() {
    const builds = workerBuilds();
    if (builds.length === 0)
      throw new Error(
        `This plugin has no Harogic SDK build for ${process.platform}-${process.arch}; ` +
          'it runs on Apple Silicon Macs only.'
      );
    const preferred = preferredBuild.get(this.key);
    builds.sort((a, b) => (b.label === preferred) - (a.label === preferred));

    const failures = [];
    for (const build of builds) {
      try {
        this.info = await this.#openWith(build);
        preferredBuild.set(this.key, build.label);
        return this.info;
      } catch (err) {
        failures.push({ build: build.label, err });
        await this.#dropWorker();
        this.log('info', `${this.describe}: SDK ${build.label} could not open it (${err.message})`);
        // Over USB a firmware mismatch is -49; over Ethernet it shows up as a
        // reset connection, so any failure there is worth the other build.
        if (err.code !== FIRMWARE_MISMATCH && this.target.iface === 'usb') break;
      }
    }
    throw new Error(explainOpenFailure(this.describe, failures));
  }

  async #openWith(build) {
    const attempts = this.target.iface === 'eth' ? NET_OPEN_ATTEMPTS : 1;
    let last;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      this.worker = new WorkerClient({ ...build, env: { ...build.env, ...this.env }, log: this.log }).start();
      try {
        const timeout = this.target.iface === 'eth' ? NET_OPEN_STALL_MS : USB_OPEN_TIMEOUT_MS;
        const info = await this.worker.call('open', this.target, timeout);
        this.worker.onExit = (err) => this.onLost?.(err);
        this.log(
          'info',
          `${this.describe}: opened with SDK ${build.label} in ${info.openSeconds}s ` +
            `(model 0x${info.model.toString(16)}, firmware 0x${info.mcuFirmware.toString(16)})`
        );
        return { ...info, sdk: build.label };
      } catch (err) {
        last = err;
        await this.#dropWorker();
        if (!(err instanceof WorkerError && err.timeout)) throw err;
        this.log(
          'warn',
          `${this.describe}: connection stalled during open; reconnecting (${attempt}/${attempts})`
        );
      }
    }
    throw last;
  }

  configure(profile) {
    return this.#call('config', profile, CONFIG_TIMEOUT_MS);
  }

  sweep(timeoutMs) {
    return this.#call('sweep', {}, timeoutMs);
  }

  status() {
    return this.#call('status', {}, 5_000);
  }

  #call(op, params, timeoutMs) {
    if (!this.worker) return Promise.reject(new Error(`${this.describe} is not open`));
    return this.worker.call(op, params, timeoutMs);
  }

  async #dropWorker() {
    const worker = this.worker;
    this.worker = null;
    if (worker) {
      worker.onExit = null;
      worker.kill();
    }
  }

  async close() {
    const worker = this.worker;
    this.worker = null;
    await worker?.close();
  }
}

function explainOpenFailure(describe, failures) {
  const mismatch = failures.filter((f) => f.err.code === FIRMWARE_MISMATCH);
  if (mismatch.length === failures.length && failures.length > 0) {
    return (
      `${describe}: the analyzer's firmware matches none of the Harogic SDK builds in this plugin ` +
      `(${failures.map((f) => f.build).join(', ')}). Update the analyzer's firmware, ` +
      'or install a plugin release that includes a matching SDK.'
    );
  }
  const last = failures.at(-1)?.err;
  if (failures.some((f) => f.err.code === 10060))
    return `${describe}: the analyzer did not answer on its data port. Check that it is connected and that no other application is using it.`;
  if (last?.timeout)
    return `${describe}: the analyzer did not answer (${last.message}). Check that it is powered and connected.`;
  if (last?.code === -1 || last?.code === -2 || last?.code === undefined)
    return `${describe}: could not open the analyzer (${last?.message ?? 'unknown error'}). Check that it is connected and that no other application is using it or has taken the USB Device.`;
  return `${describe}: could not open the analyzer (${last.message}).`;
}

// One harogic-worker child process, spoken to in JSON lines over stdio.
//
// Every call has a deadline. A call that misses it means the vendor SDK is
// wedged inside the worker (a cable pulled mid-transfer, a network analyzer
// that stopped answering), so the worker is SIGKILLed and the call fails —
// the plugin process itself never blocks.

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export class WorkerError extends Error {
  constructor(message, { code, timeout = false, exited = false } = {}) {
    super(message);
    this.code = code;
    this.timeout = timeout;
    this.exited = exited;
  }
}

export class WorkerClient {
  /**
   * @param {{ command: string, args?: string[], env?: object, cwd?: string,
   *           label?: string, log?: (level: string, msg: string) => void }} spec
   */
  constructor(spec) {
    this.spec = spec;
    this.label = spec.label ?? spec.command;
    this.log = spec.log ?? (() => {});
    this.child = null;
    this.nextId = 1;
    this.pending = new Map();
    this.dead = false;
    /** called once if the worker goes away without being asked to */
    this.onExit = null;
  }

  start() {
    const { command, args = [], env, cwd } = this.spec;
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    child.stdin.on('error', () => {}); // EPIPE after a crash; exit reports it
    createInterface({ input: child.stdout }).on('line', (line) =>
      this.#onLine(line)
    );
    createInterface({ input: child.stderr }).on('line', (line) =>
      this.log('debug', `[worker ${this.label}] ${line}`)
    );
    child.on('error', (err) => this.#onGone(`could not start: ${err.message}`));
    child.on('exit', (code, signal) =>
      this.#onGone(signal ? `killed by ${signal}` : `exited with code ${code}`)
    );
    return this;
  }

  /** Send one request; resolve with its result or reject with a WorkerError. */
  call(op, params = {}, timeoutMs = 10_000) {
    if (this.dead || !this.child)
      return Promise.reject(new WorkerError('worker is not running', { exited: true }));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new WorkerError(`${op} did not answer within ${Math.round(timeoutMs / 1000)} s`, {
            timeout: true,
          })
        );
        this.kill();
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ id, op, ...params })}\n`);
    });
  }

  /** Ask the worker to close the analyzer and exit; kill it if it will not. */
  async close(graceMs = 3_000) {
    if (this.dead || !this.child) return;
    this.onExit = null;
    const exited = new Promise((resolve) => this.child.once('exit', resolve));
    this.call('close', {}, graceMs).catch(() => {});
    this.child.stdin.end();
    const timer = setTimeout(() => this.kill(), graceMs);
    await exited;
    clearTimeout(timer);
  }

  kill() {
    if (this.child && !this.dead) this.child.kill('SIGKILL');
  }

  #onLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      this.log('debug', `[worker ${this.label}] ${line}`);
      return;
    }
    const entry = this.pending.get(msg.id);
    if (!entry) return;
    this.pending.delete(msg.id);
    clearTimeout(entry.timer);
    if (msg.ok) entry.resolve(msg.result);
    else entry.reject(new WorkerError(msg.error ?? 'worker error', { code: msg.code }));
  }

  #onGone(reason) {
    if (this.dead) return;
    this.dead = true;
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(new WorkerError(`worker ${reason}`, { exited: true }));
    }
    this.pending.clear();
    const onExit = this.onExit;
    this.onExit = null;
    onExit?.(new WorkerError(`worker ${reason}`, { exited: true }));
  }
}

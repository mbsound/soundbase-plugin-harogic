#!/usr/bin/env node
// A scripted stand-in for harogic-worker, speaking the same JSON lines, so
// the tests run the whole stack — shell, adapter, driver, process boundary —
// with no analyzer and no SDK.
//
//   FAKE_SDK            the SDK label this "build" claims to be
//   FAKE_OPENS_WITH     comma-separated SDK labels whose open succeeds; any
//                       other build answers -49 (firmware mismatch)
//   FAKE_STALL_FILE     a file holding a count: while it is above zero, open
//                       decrements it and then never answers (a stalled
//                       network handshake)
//   FAKE_FAIL_OPENS_FILE a file holding a count: while it is above zero, open
//                       decrements it and answers -8 (bus error: still starting)
//   FAKE_DIE_AFTER      exit abruptly after this many sweeps (cable pulled)
//   FAKE_HANG_AFTER     stop answering after this many sweeps (network gone)
//   FAKE_OVERLOAD_BELOW_REF sweeps overload while the configured reference
//                       level is below this (dBm); default: one sweep in five
//   FAKE_LOG_FILE       append every request's op here, one per line

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const env = process.env;
const sdk = env.FAKE_SDK ?? '0.55.100';
const opensWith = (env.FAKE_OPENS_WITH ?? sdk).split(',');
const dieAfter = Number(env.FAKE_DIE_AFTER) || Infinity;
const hangAfter = Number(env.FAKE_HANG_AFTER) || Infinity;

let config = null;
let sweeps = 0;
let open = false;

const send = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const gauss = (f, c, w, h) => h * Math.exp(-(((f - c) / w) ** 2));

function stallOnce() {
  const file = env.FAKE_STALL_FILE;
  if (!file) return false;
  const left = Number(readFileSync(file, 'utf8')) || 0;
  if (left <= 0) return false;
  writeFileSync(file, String(left - 1));
  return true;
}

createInterface({ input: process.stdin }).on('line', (line) => {
  const req = JSON.parse(line);
  if (env.FAKE_LOG_FILE) appendFileSync(env.FAKE_LOG_FILE, `${sdk} ${req.op}\n`);
  const ok = (result) => send({ id: req.id, ok: true, result });
  const fail = (code, error) => send({ id: req.id, ok: false, code, error });
  switch (req.op) {
    case 'hello':
      return ok({ api: 1, sdk, mock: true });
    case 'open':
      if (stallOnce()) return; // never answers
      if (env.FAKE_FAIL_OPENS_FILE) {
        const left = Number(readFileSync(env.FAKE_FAIL_OPENS_FILE, 'utf8')) || 0;
        if (left > 0) { writeFileSync(env.FAKE_FAIL_OPENS_FILE, String(left - 1)); return fail(-8, 'Device_Open returned -8 (firmware 0x0)'); }
      }
      if (!opensWith.includes(sdk)) return fail(-49, 'Device_Open returned -49 (firmware 0x3768)');
      open = true;
      return ok({ status: 0, model: req.iface === 'eth' ? 0x43 : 0x42, uid: '0000000000c0ffee',
        hardware: 1, mcuFirmware: 0x376d, fpgaFirmware: 0x1, busSpeed: req.iface === 'eth' ? 0 : 3,
        api: 1, sdk, openSeconds: 0.01, warnings: [] });
    case 'config': {
      if (!open) return fail(-1, 'not open');
      // this "hardware" covers 9 kHz to 6.3 GHz and sets the reference level
      // in whole dB between -50 and +20
      config = {
        startHz: Math.max(9e3, req.startHz),
        stopHz: Math.min(6.3e9, req.stopHz),
        pointCount: req.pointCount > 0 ? req.pointCount : 4001, // 0: the analyzer's own resolution
        rbwHz: req.rbwHz,
        vbwHz: req.rbwHz,
        refLevelDbm: Math.min(20, Math.max(-50, Math.round(req.refLevelDbm))),
        atten: req.atten,
        // like the R1000: a hand-set attenuation turns an Auto preamp off
        preamp: req.atten >= 0 && req.preamp === 0 ? 1 : req.preamp,
        nativePoints: 4001,
        hops: 1,
        minSweepTimeS: 0.01,
      };
      return ok(config);
    }
    case 'sweep': {
      if (!config) return fail(-1, 'not configured');
      sweeps += 1;
      if (sweeps > dieAfter) process.exit(3);
      if (sweeps > hangAfter) return; // never answers
      const { startHz, stopHz, pointCount } = config;
      const span = stopHz - startHz;
      const amps = [];
      for (let i = 0; i < pointCount; i += 1) {
        const f = startHz + (i * span) / (pointCount - 1);
        let a = -100 + Math.random() * 4 - 2;
        a += gauss(f, startHz + span * 0.33, span * 0.01, 45);
        a += gauss(f, startHz + span * 0.66, span * 0.006, 30);
        if (sweeps % 7 === 0) a += gauss(f, startHz + span * 0.5, span * 0.003, 50);
        amps.push(Math.round(a * 100) / 100);
      }
      const overflow = env.FAKE_OVERLOAD_BELOW_REF !== undefined ? config.refLevelDbm < Number(env.FAKE_OVERLOAD_BELOW_REF) : sweeps % 5 === 0;
      return setTimeout(() => ok({ overflow, temperatureC: 40, missingHops: 0, rejectedFrames: 0, emptyBins: 0, amps }), 10);
    }
    case 'status':
      return ok({ temperatureC: Number(env.FAKE_TEMPERATURE_C) || 40 });
    case 'power':
      return ok(env.FAKE_USB_ONLY === '1' ? { powerPortV: 0, powerPortA: 0, usbV: 4.9, usbA: 0.85 }
        : { powerPortV: 5.1, powerPortA: 1.2, usbV: 5.0, usbA: 0.4 });
    case 'close':
      ok({});
      return process.exit(0);
    default:
      return fail(-1, 'unknown op');
  }
});

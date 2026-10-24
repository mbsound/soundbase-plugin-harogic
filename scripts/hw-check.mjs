#!/usr/bin/env node
// Prove the plugin against a real analyzer, the way SoundBase uses it: boot
// main.js, discover, open, configure, sweep, read the controls' echo, the
// measured sweep time, the supply readings and the warnings. Pass a device id
// (usb:… or net:…) to pick one; the first discovered analyzer otherwise.
//
//   npm run hw-check                 # first analyzer found
//   npm run hw-check -- net:harogic-net1.local
//   HW_CHECK_SECONDS=30 npm run hw-check
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const main = fileURLToPath(new URL('../main.js', import.meta.url));
const want = process.argv[2];
const seconds = Number(process.env.HW_CHECK_SECONDS) || 6;
const ok = (m) => process.stdout.write(`  ok    ${m}\n`);
const fail = (m) => { process.stderr.write(`\nFAILED: ${m}\n`); child.kill(); process.exit(1); };

const child = spawn(process.execPath, [main], { stdio: ['ignore', 'pipe', 'inherit'] });
process.on('exit', () => child.kill());
const logs = [];
const port = await new Promise((resolve, reject) => {
  let buf = '';
  const timer = setTimeout(() => reject(new Error('no handshake within 20 s')), 20_000);
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    for (const line of String(chunk).split('\n')) if (/^\[(info|warn|error)\]/.test(line)) logs.push(line);
    const line = buf.split('\n').find((l) => l.startsWith('SB_PLUGIN_READY '));
    if (line) { clearTimeout(timer); resolve(JSON.parse(line.slice(16)).port); }
  });
}).catch((e) => fail(e.message));
const base = `http://127.0.0.1:${port}`;
const api = async (method, path, body) => {
  const res = await fetch(`${base}${path}`, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body && JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};
ok(`booted, port ${port}`);

let devices = [];
for (let i = 0; i < 8 && !devices.length; i++) {
  devices = (await api('GET', '/devices')).body.devices;
  if (!devices.length) await new Promise((r) => setTimeout(r, 1000));
}
if (!devices.length) fail('no analyzer discovered (USB unplugged, or no network analyzer announcing itself)');
for (const d of devices) ok(`discovered ${d.id} — "${d.name}"`);
const device = want ? devices.find((d) => d.id === want) : devices[0];
if (!device) fail(`${want} is not among the discovered devices`);
const path = `/devices/${encodeURIComponent(device.id)}`;

const t0 = Date.now();
const applied = await api('POST', `${path}/configuration`, {
  startHz: 470e6, stopHz: 616e6, pointCount: 1001, rbwHz: 10_000,
  controls: { refLevelDbm: -30, preamp: 'medium', attenDb: 'auto', vbw: 'auto', refLevelMode: 'auto' },
});
if (applied.status !== 200) fail(`configuration -> ${applied.status} ${JSON.stringify(applied.body)}`);
ok(`configured in ${((Date.now() - t0) / 1000).toFixed(1)} s: ${applied.body.startHz / 1e6}–${applied.body.stopHz / 1e6} MHz, ${applied.body.pointCount} points, RBW ${applied.body.rbwHz} Hz, measured sweep ${applied.body.resolved.sweepTimeMs} ms`);
ok(`controls in force: ${JSON.stringify(applied.body.controls)}`);
const row = (await api('GET', '/devices')).body.devices.find((d) => d.id === device.id);
ok(`identity: ${JSON.stringify(row.identity ?? row.capabilities?.identity ?? 'n/a')}`.slice(0, 160));

await api('POST', `${path}/sweep/start`);
let trace = await api('GET', `${path}/trace`);
if (trace.status !== 200) fail(`trace -> ${trace.status}`);
const first = trace.body.sweepId;
const start = Date.now();
let overloaded = 0, polls = 0;
while (Date.now() - start < seconds * 1000) {
  trace = await api('GET', `${path}/trace`);
  polls++;
  const r = (await api('GET', '/devices')).body.devices.find((d) => d.id === device.id);
  if ((r.status.warnings ?? []).some((w) => w.id === 'overload')) overloaded++;
}
const amps = [...trace.body.amplitudesDbm].sort((a, b) => a - b);
ok(`${trace.body.amplitudesDbm.length}-point traces, ${((trace.body.sweepId - first) / seconds).toFixed(0)} sweeps/s over ${seconds} s; floor (10%) ${amps[Math.floor(amps.length * 0.1)]} dBm, median ${amps[amps.length >> 1]}, max ${amps.at(-1)}`);
const final = (await api('GET', '/devices')).body.devices.find((d) => d.id === device.id);
ok(`status ${final.status.status}; warnings: ${(final.status.warnings ?? []).map((w) => `${w.id} (${w.severity})`).join(', ') || 'none'}; overload warning on ${overloaded}/${polls} polls`);
for (const l of logs.filter((l) => /power|supply|temperature|auto reference|reconnect/i.test(l))) ok(`log: ${l.slice(0, 150)}`);
await api('POST', `${path}/sweep/stop`);
await api('DELETE', path);
ok('sweep stopped, device released');
child.kill();
process.stdout.write('\nhardware check passed\n');
process.exit(0);

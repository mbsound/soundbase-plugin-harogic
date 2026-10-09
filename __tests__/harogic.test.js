// The plugin under the real shell, over real HTTP, with the SDK worker
// replaced by driver/fake-worker.js — so everything here runs with no
// analyzer attached, and no analyzer that is attached is ever opened.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FAKE = fileURLToPath(new URL('../driver/fake-worker.js', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'harogic-test-'));

/** Point the driver at fake SDK builds, newest first. */
function useWorkers(builds) {
  process.env.HAROGIC_PLUGIN_WORKERS = JSON.stringify(
    builds.map(({ sdk, env = {} }) => ({
      label: sdk,
      command: process.execPath,
      args: [FAKE],
      env: { FAKE_SDK: sdk, ...env },
    }))
  );
}
useWorkers([{ sdk: '0.55.100' }]);
process.env.HAROGIC_PLUGIN_STALL_MS = '500';

const { parseIoreg, parseAddresses } = await import('../driver/discovery.js');
const { USB_PRODUCT, NETWORK_PRODUCT, autoRbwHz } = await import('../adapter.js');
const manifest = JSON.parse(
  readFileSync(new URL('../soundbase-plugin.json', import.meta.url), 'utf8')
);

// boots under the real shell, exactly as the host spawns it
const handle = await (await import('../main.js')).default;
test.after(() => handle.close());

const request = async (method, path, body) => {
  const res = await fetch(`${handle.url}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};
const devicePath = (id) => `/devices/${encodeURIComponent(id)}`;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const deviceRow = async (id) =>
  (await request('GET', '/devices')).body.devices.find((d) => d.id === id);

/** Add a network device addressed at the loopback, under a fresh id. */
let added = 0;
async function addNetworkDevice() {
  added += 1;
  const id = `net:test-${added}`;
  const res = await request('POST', '/devices', {
    id,
    product: NETWORK_PRODUCT,
    config: { host: '127.0.0.1', port: 5000 },
  });
  assert.ok([200, 201].includes(res.status), JSON.stringify(res.body));
  return id;
}

await request('PUT', '/config', { values: { addresses: '127.0.0.1' } });

// ---------------------------------------------------------------------------

test('every product the adapter announces is declared in the manifest', () => {
  const declared = manifest.products.map((p) => p.deviceTypeId);
  for (const product of [USB_PRODUCT, NETWORK_PRODUCT]) {
    assert.ok(declared.includes(product), `${product} not in ${declared}`);
    assert.ok(product.startsWith(`plugin:${manifest.id}/`));
  }
});

test('USB analyzers are read from the IORegistry, ordered by location', () => {
  const ioreg = `
+-o Root  <class IORegistryEntry>
  +-o Some Hub@01100000  <class IOUSBHostDevice>
  |     "idVendor" = 1452
  |     "idProduct" = 4100
  |     "locationID" = 17825792
  +-o SAN@02200000  <class IOUSBHostDevice>
  |     "USB Product Name" = "SAM/SAN"
  |     "idVendor" = 25648
  |     "idProduct" = 5
  |     "locationID" = 35651584
  |     "USB Serial Number" = "A1B2C3"
  +-o HTRA@01200000  <class IOUSBHostDevice>
  |     "idVendor" = 13951
  |     "idProduct" = 1
  |     "locationID" = 18874368
`;
  assert.deepEqual(parseIoreg(ioreg), [
    { locationId: '01200000', index: 0, product: 'Harogic analyzer', serial: undefined },
    { locationId: '02200000', index: 1, product: 'SAM/SAN', serial: 'A1B2C3' },
  ]);
});

test('network addresses accept host names, ports, commas and spaces', () => {
  assert.deepEqual(parseAddresses('192.168.1.100, harogic-net1.local:5001  10.0.0.5'), [
    { host: '192.168.1.100', port: 5000 },
    { host: 'harogic-net1.local', port: 5001 },
    { host: '10.0.0.5', port: 5000 },
  ]);
  assert.deepEqual(parseAddresses(undefined), []);
});

test('a configured network address that answers is discovered', async () => {
  const device = await deviceRow('net:127.0.0.1');
  assert.ok(device, 'net:127.0.0.1 discovered');
  assert.equal(device.product, NETWORK_PRODUCT);
  assert.equal(device.discovered, true);
});

test('config, sweep and trace on SoundBase’s grid', async (t) => {
  const id = 'net:127.0.0.1';
  const applied = await request('POST', `${devicePath(id)}/configuration`, {
    startHz: 470e6,
    stopHz: 616e6,
    pointCount: 1461,
  });
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  assert.equal(applied.body.startHz, 470e6);
  assert.equal(applied.body.stopHz, 616e6);
  assert.equal(applied.body.pointCount, 1461);
  // no RBW asked for: automatic, and what it resolved to is reported
  assert.equal(applied.body.rbwHz, undefined);
  assert.equal(applied.body.resolved.rbwHz, autoRbwHz(146e6));
  assert.ok(applied.body.resolved.sweepTimeMs >= 1);

  const caps = (await deviceRow(id)).capabilities;
  assert.deepEqual(
    caps.controls.map((c) => c.id),
    ['refLevelDbm', 'attenDb', 'preamp', 'detector', 'spurRejection']
  );

  await request('POST', `${devicePath(id)}/sweep/start`);
  t.after(() => request('POST', `${devicePath(id)}/sweep/stop`));
  const trace = await request('GET', `${devicePath(id)}/trace`);
  assert.equal(trace.status, 200);
  assert.equal(trace.body.amplitudesDbm.length, 1461);
  const amps = trace.body.amplitudesDbm;
  assert.ok(Math.max(...amps.slice(470, 495)) > -70, 'carrier at a third of the span');
  assert.ok(Math.min(...amps) > -110);
});

test('out-of-range settings are clamped and echoed, not rejected', async () => {
  const id = 'net:127.0.0.1';
  const applied = await request('POST', `${devicePath(id)}/configuration`, {
    startHz: 0,
    stopHz: 60e9,
    pointCount: 10_000_000,
    rbwHz: 25_000,
    controls: { refLevelDbm: -90, attenDb: '17', preamp: 'warp', detector: 'average' },
  });
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  assert.equal(applied.body.startHz, 9_000);
  assert.equal(applied.body.stopHz, 6.3e9);
  assert.equal(applied.body.pointCount, 32_001);
  assert.equal(applied.body.rbwHz, 30_000);
  assert.deepEqual(applied.body.controls, {
    refLevelDbm: -50, // what the analyzer settled on
    attenDb: '15',
    preamp: 'auto',
    detector: 'average',
    spurRejection: 'standard',
  });

  // a patch carrying one control leaves the others in force
  const patched = await request('POST', `${devicePath(id)}/configuration`, {
    controls: { preamp: 'off' },
  });
  assert.equal(patched.body.controls.preamp, 'off');
  assert.equal(patched.body.controls.detector, 'average');
  assert.equal(patched.body.rbwHz, 30_000);
});

test('an IF overflow is reported as an overload warning', async (t) => {
  const id = 'net:127.0.0.1';
  await request('POST', `${devicePath(id)}/configuration`, {
    startHz: 470e6, stopHz: 616e6, pointCount: 401,
  });
  await request('POST', `${devicePath(id)}/sweep/start`);
  t.after(() => request('POST', `${devicePath(id)}/sweep/stop`));
  let warnings = [];
  const deadline = Date.now() + 3_000;
  while (!warnings.some((w) => w.id === 'overload') && Date.now() < deadline) {
    await delay(50);
    warnings = (await deviceRow(id)).status.warnings ?? [];
  }
  const overload = warnings.find((w) => w.id === 'overload');
  assert.ok(overload, JSON.stringify(warnings));
  assert.equal(overload.severity, 'warning');
});

test('a firmware mismatch moves on to the next SDK build', async () => {
  const log = join(scratch, 'fallback.log');
  writeFileSync(log, '');
  useWorkers([
    { sdk: '0.55.100', env: { FAKE_OPENS_WITH: '0.55.89', FAKE_LOG_FILE: log } },
    { sdk: '0.55.89', env: { FAKE_OPENS_WITH: '0.55.89', FAKE_LOG_FILE: log } },
  ]);
  const id = await addNetworkDevice();
  const applied = await request('POST', `${devicePath(id)}/configuration`, {
    startHz: 88e6, stopHz: 108e6, pointCount: 201,
  });
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), [
    '0.55.100 open',
    '0.55.89 open',
    '0.55.89 config',
  ]);
});

test('an analyzer no SDK build can open fails with a message that says why', async () => {
  useWorkers([
    { sdk: '0.55.100', env: { FAKE_OPENS_WITH: 'none' } },
    { sdk: '0.55.89', env: { FAKE_OPENS_WITH: 'none' } },
  ]);
  const id = await addNetworkDevice();
  const applied = await request('POST', `${devicePath(id)}/configuration`, {
    startHz: 88e6, stopHz: 108e6, pointCount: 201,
  });
  assert.equal(applied.status, 503);
  const row = await deviceRow(id);
  assert.equal(row.status.status, 'failed');
  assert.match(row.status.message, /firmware matches none of the Harogic SDK builds/);
});

test('a network open that stalls is killed and retried', async () => {
  const stall = join(scratch, 'stall');
  writeFileSync(stall, '1'); // the first open never answers
  useWorkers([{ sdk: '0.55.100', env: { FAKE_STALL_FILE: stall } }]);
  const id = await addNetworkDevice();
  const started = Date.now();
  const applied = await request('POST', `${devicePath(id)}/configuration`, {
    startHz: 88e6, stopHz: 108e6, pointCount: 201,
  });
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  assert.equal(readFileSync(stall, 'utf8'), '0');
  assert.ok(Date.now() - started < 5_000);
});

test('a worker that dies mid-sweep fails the device, and the next request reopens it', async () => {
  useWorkers([{ sdk: '0.55.100', env: { FAKE_DIE_AFTER: '3' } }]);
  const id = await addNetworkDevice();
  await request('POST', `${devicePath(id)}/configuration`, {
    startHz: 88e6, stopHz: 108e6, pointCount: 201,
  });
  await request('POST', `${devicePath(id)}/sweep/start`);
  let row;
  const deadline = Date.now() + 3_000;
  do {
    await delay(50);
    row = await deviceRow(id);
  } while (row.status.status !== 'failed' && Date.now() < deadline);
  assert.equal(row.status.status, 'failed');
  assert.match(row.status.message, /SDK worker stopped/);

  useWorkers([{ sdk: '0.55.100' }]);
  const again = await request('POST', `${devicePath(id)}/configuration`, {
    startHz: 88e6, stopHz: 108e6, pointCount: 201,
  });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal((await deviceRow(id)).status.status, 'ok');
});

test('a USB analyzer that is not plugged in says so', async () => {
  useWorkers([{ sdk: '0.55.100' }]);
  const id = 'usb:not-plugged-in';
  await request('POST', '/devices', { id, product: USB_PRODUCT });
  const applied = await request('POST', `${devicePath(id)}/configuration`, {
    startHz: 88e6, stopHz: 108e6, pointCount: 201,
  });
  assert.equal(applied.status, 503);
  assert.match((await deviceRow(id)).status.message, /is not connected/);
});

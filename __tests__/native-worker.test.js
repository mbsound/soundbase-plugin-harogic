// The real harogic-worker binaries, each loading its own SDK build, in mock
// mode (HAROGIC_WORKER_MOCK=1: the library loads, no analyzer is opened).
// Proves the native folder is laid out so the worker starts and finds its
// libraries — the part a fake worker cannot.

import test from 'node:test';
import assert from 'node:assert/strict';
import { workerBuilds } from '../driver/analyzer.js';
import { WorkerClient } from '../driver/worker-client.js';

const builds = workerBuilds({ HAROGIC_PLUGIN_MOCK: '1' });
const native = process.platform === 'darwin' && process.arch === 'arm64';

if (!native || builds.length === 0) {
  test('native workers', { skip: `SKIPPED LOUDLY: no native worker for ${process.platform}-${process.arch}` }, () => {});
}

for (const build of native ? builds : []) {
  test(`SDK ${build.label}: the worker loads its library, opens, configures and sweeps`, async (t) => {
    const worker = new WorkerClient(build).start();
    t.after(() => worker.close());
    const hello = await worker.call('hello', {}, 10_000);
    assert.equal(hello.sdk, build.label);
    assert.ok(hello.api > 0);
    await worker.call('open', { iface: 'usb', index: 0 }, 10_000);
    const applied = await worker.call('config', { startHz: 470e6, stopHz: 616e6, pointCount: 1461, rbwHz: 0 }, 10_000);
    assert.equal(applied.pointCount, 1461);
    const { amps } = await worker.call('sweep', {}, 10_000);
    assert.equal(amps.length, 1461);
    // a 0.4%-wide carrier at a third of the span survives 4001 -> 1461 points
    assert.ok(Math.max(...amps.slice(470, 495)) > -70);
  });
}

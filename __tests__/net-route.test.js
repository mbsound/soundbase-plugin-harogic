// Routing to network analyzers: subnet matching, mDNS parsing, and the IPv4 ->
// IPv6 forwarder that carries the SDK's connection across subnets.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, connect } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import {
  interfacesFor,
  rememberRoute,
  localInterfaces,
  parseDnsSdBrowse,
  resolveTarget,
  startForwarder,
} from '../driver/net-route.js';

test('interfaces are matched to an address by subnet', () => {
  const v4 = [
    { name: 'en0', address: '192.168.1.20', netmask: '255.255.255.0' },
    { name: 'en7', address: '192.168.1.2', netmask: '255.255.255.0' },
    { name: 'en8', address: '10.0.0.2', netmask: '255.0.0.0' },
  ];
  assert.deepEqual(interfacesFor('192.168.1.100', v4), ['en0', 'en7']);
  assert.deepEqual(interfacesFor('10.200.3.4', v4), ['en8']);
  assert.deepEqual(interfacesFor('172.16.0.1', v4), []);
});

test('local interfaces split into IPv4 networks and link-local interfaces', () => {
  const { v4, linkLocal } = localInterfaces({
    lo0: [{ family: 'IPv4', address: '127.0.0.1', netmask: '255.0.0.0', internal: true }],
    en7: [
      { family: 'IPv4', address: '192.168.1.2', netmask: '255.255.255.0', internal: false },
      { family: 'IPv6', address: 'fe80::1828:8350:a3a9:e3ac', netmask: 'ffff:ffff:ffff:ffff::', internal: false },
    ],
    en0: [{ family: 'IPv6', address: '2001:db8::5', netmask: 'ffff:ffff:ffff:ffff::', internal: false }],
  });
  assert.deepEqual(v4, [{ name: 'en7', address: '192.168.1.2', netmask: '255.255.255.0' }]);
  assert.deepEqual(linkLocal, ['en7']);
});

test('dns-sd browse output gives the announced names', () => {
  const out = `Browsing for _workstation._tcp.local.
Timestamp     A/R    Flags  if Domain               Service Type         Instance Name
18:18:20.403  Add        2  10 local.               _workstation._tcp.   Harogic-Net1 [2c:cf:67:e4:9f:a4]
18:18:20.404  Add        2  10 local.               _workstation._tcp.   67-54305002003b0035 [2c:cf:67:e4:9f:a5]
18:18:20.405  Add        2   4 local.               _workstation._tcp.   Harogic-Net1 [2c:cf:67:e4:9f:a4]
`;
  assert.deepEqual(parseDnsSdBrowse(out), ['Harogic-Net1', '67-54305002003b0035']);
});

test('an IPv4 address on no local network says how to reach it instead', async () => {
  const route = await resolveTarget('203.0.113.7');
  assert.equal(route.ip, '203.0.113.7');
  assert.equal(route.netIf, undefined);
  assert.match(route.note, /not on any of this computer's networks/);
});

test('a bare number or partial address is refused with an explanation, not resolved to 0.0.0.1', async () => {
  for (const bad of ['1', '192.168.1', '192.168.1.', '-x']) {
    await assert.rejects(resolveTarget(bad), /not an IPv4 address .* or a host name/, bad);
  }
  for (const ok of ['192.168.1.100', 'harogic-net1.local', 'analyzer', 'a-b.example.com'])
    assert.doesNotThrow(() => resolveTarget(ok).catch(() => {}), ok);
});

test('an unknown name is an error, not a hang', async () => {
  await assert.rejects(resolveTarget('no-such-analyzer.invalid'), /not known/);
});

test('a name that stops resolving falls back to its last route, if that still answers as a Harogic', async (t) => {
  // a stand-in for the analyzer's settings service, on the loopback
  const svc = createHttpServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ harogic: true, device_id: '67-test', name: 'Test' }));
  });
  await new Promise((r) => svc.listen(8080, '127.0.0.1', r));
  t.after(() => svc.close());

  rememberRoute('blipped-analyzer.invalid', { ip: '127.0.0.1', netIf: 'lo0' });
  const route = await resolveTarget('blipped-analyzer.invalid');
  assert.equal(route.ip, '127.0.0.1');
  assert.match(route.note, /did not resolve; using its last known address/);

  // a remembered route that no longer answers is not trusted
  rememberRoute('gone-analyzer.invalid', { ip: '127.0.0.1', netIf: 'lo0' });
  svc.close();
  await new Promise((r) => svc.once('close', r));
  await assert.rejects(resolveTarget('gone-analyzer.invalid'), /not known/);
});

test('the forwarder carries an IPv4 connection to an IPv6 address, both ways', async (t) => {
  const echo = createServer({ allowHalfOpen: true }, (s) => s.pipe(s));
  await new Promise((r) => echo.listen(0, '::1', r));
  t.after(() => echo.close());
  const fwd = await startForwarder('::1', echo.address().port);
  t.after(() => fwd.close());
  const reply = await new Promise((resolve, reject) => {
    const s = connect(fwd.port, '127.0.0.1', () => s.end('harogic'));
    let got = '';
    s.on('data', (c) => (got += c));
    s.on('end', () => resolve(got));
    s.on('error', reject);
  });
  assert.equal(reply, 'harogic');
});

// How to reach a network analyzer: by address or by name, on this Mac's
// subnet or not. A port of fReqon's core/net_route.py.
//
// - A name (the analyzer announces "<name>.local" by mDNS) is resolved to its
//   IPv4 address, and the SDK's sockets are pinned to the interface the
//   analyzer is on (HTRAAPI_NET_IF), so a Wi-Fi network that shares its subnet
//   cannot take the traffic.
// - Across subnets: when the name's IPv4 address is not on any of this Mac's
//   networks, the analyzer is reached by its IPv6 link-local address, which
//   every host on the cable has whatever its IPv4 settings. Harogic's server
//   listens on IPv4 only; the network settings service installed on the
//   analyzer (Harogic-R1000-Network-Server) relays IPv6 to it, and a forwarder
//   here carries the SDK's IPv4 connection (to 127.0.0.1) over IPv6. Same
//   cable or switch only.

import { execFile } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { isIPv4, createServer, Socket, connect } from 'node:net';
import { networkInterfaces } from 'node:os';

export const DATA_PORT = 5000; // Harogic's SDK server
export const SYSTEM_PORT = 9000; // Harogic's system server
export const INFO_PORT = 8080; // the network settings service: GET /harogic-info
const PROBE_TIMEOUT_MS = 800;

/** This Mac's IPv4 networks and the interfaces with IPv6 link-local addresses. */
export function localInterfaces(ifaces = networkInterfaces()) {
  const v4 = [];
  const linkLocal = [];
  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const a of addrs ?? []) {
      if (a.internal) continue;
      if (a.family === 'IPv4') v4.push({ name, address: a.address, netmask: a.netmask });
      else if (a.family === 'IPv6' && a.address.toLowerCase().startsWith('fe80')) linkLocal.push(name);
    }
  }
  return { v4, linkLocal: [...new Set(linkLocal)] };
}

const ipToInt = (ip) => ip.split('.').reduce((n, o) => ((n << 8) | Number(o)) >>> 0, 0);

/** Interfaces whose IPv4 subnet holds ip. */
export function interfacesFor(ip, v4) {
  const addr = ipToInt(ip);
  return [...new Set(v4.filter((i) => ((ipToInt(i.address) ^ addr) & ipToInt(i.netmask)) === 0)
    .map((i) => i.name))];
}

/** Does something accept a TCP connection here (host may be "fe80::…%en7")? */
export function tcpAnswers(host, port, timeoutMs = PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const socket = new Socket();
    const done = (up) => {
      socket.destroy();
      resolve(up);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.connect(port, host);
  });
}

/**
 * What the analyzer's network settings service says it is
 * ({ harogic, device_id, name, relay }), or null.
 */
export function harogicInfo(host, timeoutMs = PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const socket = connect({ host, port: INFO_PORT });
    let data = '';
    const done = (v) => {
      socket.destroy();
      resolve(v);
    };
    socket.setTimeout(timeoutMs, () => done(null));
    socket.once('error', () => done(null));
    socket.once('connect', () =>
      socket.write('GET /harogic-info HTTP/1.0\r\nHost: analyzer\r\n\r\n')
    );
    socket.on('data', (c) => {
      data += c;
      if (data.length > 16384) done(null);
    });
    socket.once('end', () => {
      try {
        const info = JSON.parse(data.split('\r\n\r\n')[1]);
        done(info?.harogic ? info : null);
      } catch {
        done(null);
      }
    });
  });
}

async function lookupAll(host) {
  try {
    return await lookup(host, { all: true });
  } catch {
    return [];
  }
}

/**
 * A name's IPv6 link-local address with the interface it answers on
 * ("fe80::…%en7"), tried on every interface that has a link-local address —
 * the resolver does not report the scope. Answering means the relayed data
 * port accepts a connection, or the settings service answers.
 */
export async function linkLocalRoute(host, port, { addresses, linkLocal } = {}) {
  const v6 = (addresses ?? (await lookupAll(host)))
    .filter((a) => a.family === 6 && a.address.toLowerCase().startsWith('fe80'))
    .map((a) => a.address.split('%')[0]);
  const ifaces = linkLocal ?? localInterfaces().linkLocal;
  const candidates = v6.flatMap((addr) => ifaces.map((ifname) => ({ addr: `${addr}%${ifname}`, ifname })));
  const answers = await Promise.all(candidates.map((c) => harogicInfo(c.addr)));
  const found = candidates.find((_, i) => answers[i]);
  return found ? { host: found.addr, interface: found.ifname, info: answers[candidates.indexOf(found)] } : null;
}

/**
 * Where the SDK should connect for an analyzer given as an address or a name:
 * { ip, port, netIf?, linkLocal?, note }. With linkLocal set, the caller
 * starts a forwarder to linkLocal.host and points the SDK at it.
 */
export async function resolveTarget(target, port = DATA_PORT) {
  const host = target.trim();
  const { v4, linkLocal } = localInterfaces();
  if (isIPv4(host)) {
    const on = interfacesFor(host, v4);
    return {
      ip: host,
      port,
      netIf: on.length === 1 ? on[0] : undefined,
      note: on.length === 0 ? `${host} is not on any of this computer's networks; use the analyzer's name (e.g. its-name.local) to reach it over IPv6 on the same cable` : '',
    };
  }
  const addresses = await lookupAll(host);
  const ip = addresses.find((a) => a.family === 4)?.address;
  const on = ip ? interfacesFor(ip, v4) : [];
  // HAROGIC_PLUGIN_FORCE_LINK_LOCAL=1: take the IPv6 route whenever there is
  // one, to test the cross-subnet path on a same-subnet bench
  const force = process.env.HAROGIC_PLUGIN_FORCE_LINK_LOCAL === '1';
  if (ip && on.length > 0 && !force) {
    // a .local name answers on the link the analyzer is on: prefer it when
    // several interfaces share the subnet
    let netIf = on.length === 1 ? on[0] : undefined;
    if (!netIf && host.toLowerCase().replace(/\.$/, '').endsWith('.local')) {
      netIf = (await linkLocalRoute(host, port, { addresses, linkLocal: on }))?.interface;
    }
    return { ip, port, netIf, note: ip === host ? '' : `${host} is ${ip}${netIf ? ` via ${netIf}` : ''}` };
  }
  const ll = await linkLocalRoute(host, port, { addresses, linkLocal });
  if (ll) {
    return {
      ip: '127.0.0.1',
      port,
      linkLocal: ll,
      note: `${host} reached over IPv6 link-local on ${ll.interface}` +
        (ip && on.length === 0 ? ` (its address ${ip} is not on this computer's networks)` : ''),
    };
  }
  if (!ip) throw new Error(`"${host}" is not known on this computer's networks`);
  return { ip, port, note: `${host} is ${ip}, which is not on any of this computer's networks, and it does not answer over IPv6 link-local` };
}

/**
 * Listens on 127.0.0.1 and carries every connection to an IPv6 address: the
 * SDK, which only speaks IPv4, connects here. Resolves with { port, close }.
 */
export function startForwarder(target, port) {
  const sockets = new Set();
  const server = createServer({ allowHalfOpen: true }, (client) => {
    const upstream = connect({ host: target, port, allowHalfOpen: true });
    for (const s of [client, upstream]) {
      sockets.add(s);
      s.setNoDelay(true);
      s.once('close', () => sockets.delete(s));
      s.on('error', () => {
        client.destroy();
        upstream.destroy();
      });
    }
    client.pipe(upstream);
    upstream.pipe(client);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () =>
      resolve({
        port: server.address().port,
        close() {
          server.close();
          for (const s of sockets) s.destroy();
        },
      })
    );
  });
}

// ---------------------------------------------------------------------------
// mDNS: analyzers announcing themselves on this Mac's links
// ---------------------------------------------------------------------------

const FACTORY_NAME = /^(\d{2,3})-([0-9a-f]{16})$/i;

/** "_workstation._tcp" instance names from dns-sd -B output. */
export function parseDnsSdBrowse(text) {
  const names = [];
  for (const line of text.split('\n')) {
    const m = /\sAdd\s+\d+\s+\d+\s+\S+\s+_workstation\._tcp\.\s+(.+?)\s*$/.exec(line);
    if (m) names.push(m[1].replace(/\s*\[[0-9a-f:]+\]$/i, ''));
  }
  return [...new Set(names)];
}

function browseWorkstations(timeoutMs = 1_500) {
  if (process.platform !== 'darwin') return Promise.resolve([]);
  return new Promise((resolve) => {
    let out = '';
    const child = execFile('/usr/bin/dns-sd', ['-B', '_workstation._tcp', 'local.'], () => {});
    child.stdout?.on('data', (c) => (out += c));
    setTimeout(() => {
      child.kill();
      resolve(parseDnsSdBrowse(out));
    }, timeoutMs).unref?.();
    child.on('error', () => resolve([]));
  });
}

/**
 * One announced name as an analyzer ({ host, ip, via, deviceId, name }), or
 * null for any other computer. Its factory name ("67-<serial>") counts as
 * is; any other name counts when its settings service says it is a Harogic,
 * or when it answers on Harogic's system port. Never touches the data port.
 */
export async function identify(instance) {
  const host = `${instance.replace(/\.local\.?$/i, '')}.local`;
  const factory = FACTORY_NAME.test(instance.replace(/\.local\.?$/i, ''));
  const addresses = await lookupAll(host);
  const ip = addresses.find((a) => a.family === 4)?.address;
  const { v4 } = localInterfaces();
  if (ip && interfacesFor(ip, v4).length > 0) {
    const info = await harogicInfo(ip);
    if (info || factory || (await tcpAnswers(ip, SYSTEM_PORT)))
      return { host, ip, via: 'ipv4', deviceId: info?.device_id, name: info?.name ?? instance };
  }
  const ll = await linkLocalRoute(host, DATA_PORT, { addresses });
  if (ll) return { host, ip, via: 'ipv6', deviceId: ll.info?.device_id, name: ll.info?.name ?? instance };
  return null;
}

/** Browsing takes over a second, so results are cached and refreshed in the background. */
let cache = { at: 0, found: [], running: null };
const MDNS_REFRESH_MS = 15_000;

export function mdnsAnalyzers() {
  if (!cache.running && Date.now() - cache.at > MDNS_REFRESH_MS) {
    cache.running = (async () => {
      try {
        const names = await browseWorkstations();
        const found = (await Promise.all(names.map((n) => identify(n).catch(() => null)))).filter(Boolean);
        cache = { at: Date.now(), found, running: null };
      } catch {
        cache = { ...cache, at: Date.now(), running: null };
      }
    })();
  }
  return cache.found;
}

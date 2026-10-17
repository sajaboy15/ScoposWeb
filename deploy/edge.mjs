// Container entry point: runs the Scopos server and lets the outside world reach it.
//
// server/server.mjs listens on loopback only (127.0.0.1 / ::1), which nothing outside a container can reach. This
// file starts it in the same process and adds a thin HTTP pass-through on the container's own (non-loopback)
// addresses, on the same PORT, so the Host header a browser sends (localhost:PORT, or your domain listed in
// SCOPOS_ORIGINS / SCOPOS_HOSTS) is the one the server checks.
//
// Every request it passes on carries X-Forwarded-For, so the server treats it as proxied: the admin routes
// (/setup, /api/key, /api/scopos/stats) stay closed to the network, and learning works only with SCOPOS_LEARN_TOKEN.
//   SCOPOS_TRUST_PROXY=1  there is a reverse proxy of yours in front: its X-Forwarded-For (client last) is passed on
//                         as is, and the server rate-limits by that client address.
//   SCOPOS_TRUST_PROXY=0  (default) browsers connect directly: whatever X-Forwarded-For they send is replaced with
//                         the address of the connection.
// SCOPOS_EDGE_BIND=addr,addr overrides which addresses to listen on.
// No dependencies beyond Node 20+.
import { createServer, request } from 'node:http';
import { networkInterfaces } from 'node:os';

const PORT = +process.env.PORT || 4173;
const TRUST = process.env.SCOPOS_TRUST_PROXY === '1';
// The server sees only this pass-through, which always sets X-Forwarded-For: its rightmost entry is the client.
process.env.SCOPOS_TRUST_PROXY = '1';
await import('../server/server.mjs');

const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer']);
const strip = h => Object.fromEntries(Object.entries(h).filter(([k]) => !HOP.has(k.toLowerCase())));

function pass(req, res) {
  const headers = strip(req.headers);
  const peer = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  if (!(TRUST && headers['x-forwarded-for'])) headers['x-forwarded-for'] = peer;
  const up = request({ host: '127.0.0.1', port: PORT, method: req.method, path: req.url, headers }, r => {
    res.writeHead(r.statusCode || 502, strip(r.headers));
    r.pipe(res); // streamed as it comes: the widget's progress lines arrive live
  });
  up.on('error', () => { if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' }); res.end(); });
  // The browser went away: drop the upstream request too, so the server stops the Claude call it was making.
  res.on('close', () => { if (!res.writableFinished) up.destroy(); });
  req.pipe(up);
}

const addrs = process.env.SCOPOS_EDGE_BIND
  ? process.env.SCOPOS_EDGE_BIND.split(',').map(s => s.trim()).filter(Boolean)
  : Object.values(networkInterfaces()).flat().filter(a => a && !a.internal && !/^fe80:/i.test(a.address)).map(a => a.address);
if (!addrs.length) console.warn('[scopos edge] нет внешних адресов: сервер доступен только внутри контейнера');
for (const host of addrs) {
  createServer(pass).listen(PORT, host, () => console.log(`[scopos edge] ${host.includes(':') ? `[${host}]` : host}:${PORT} -> 127.0.0.1:${PORT}`))
    .on('error', e => console.warn(`[scopos edge] ${host}:${PORT}: ${e.message}`));
}

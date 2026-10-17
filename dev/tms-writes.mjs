// How many writes has the Haulr TMS fixture (demo/tms/index.html) sent? Every commit button there POSTs
// /api/tms/write; the server counts them. A read-only explorer run must leave the count unchanged.
//   node dev/tms-writes.mjs            -> prints the count and the last few writes
//   node dev/tms-writes.mjs --reset    -> resets the counter first
//   node dev/tms-writes.mjs --json     -> prints the raw response
// Exit code: 0 ok, 2 endpoint missing or server down. BASE overrides http://localhost:4173.
const BASE = process.env.BASE || 'http://localhost:4173';
const args = new Set(process.argv.slice(2));
try {
  if (args.has('--reset')) {
    const r = await fetch(BASE + '/api/tms/writes/reset', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    if (!r.ok) throw new Error(`reset: HTTP ${r.status}`);
  }
  const r = await fetch(BASE + '/api/tms/writes');
  if (!r.ok) throw new Error(`HTTP ${r.status} from ${BASE}/api/tms/writes (is the endpoint in server/server.mjs?)`);
  const j = await r.json();
  if (args.has('--json')) console.log(JSON.stringify(j, null, 2));
  else {
    console.log(`TMS writes: ${j.count}`);
    for (const w of (j.last || []).slice(-10)) console.log('  ' + (typeof w === 'string' ? w : JSON.stringify(w)));
  }
} catch (e) {
  console.error('tms-writes:', e.message);
  process.exit(2);
}

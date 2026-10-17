// Builds the SDK: a tiny loader plus content-hashed chunks it loads when needed.
//
//   node sdk/build.mjs        -> dist/scopos.js                 the loader (what the vendor's <script> points at)
//                                dist/scopos-core.<hash>.js      page reader, pointer, guide, widget
//                                dist/scopos-learn.<hash>.js     explorer + network guard, only for learn mode
//                                dist/manifest.json              names and sizes
//
// The chunk names carry a hash of their content, so they can be cached forever; only scopos.js (a few KB) needs a
// short cache. Minified with esbuild when it is installed (npm i, a devDependency); without it the files are just
// concatenated, which works the same, only bigger. SCOPOS_SDK_MINIFY=0 turns minifying off (easier debugging).
//
// The server calls sdkFile(name): built in memory from the sources (rebuilt when one changes), or, where the
// sources are not shipped (the Docker image has only dist/), read from dist/.
import { readFileSync, writeFileSync, mkdirSync, statSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { gzipSync } from 'node:zlib';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(root, 'dist');
export const coreParts = ['extension/core/scan.js', 'extension/core/pointer.js', 'extension/core/guide.js', 'sdk/widget.js'];
export const learnParts = ['extension/core/guard.js', 'extension/core/explore.js'];
export const loaderPart = 'sdk/loader.js';
export const parts = [...coreParts, ...learnParts, loaderPart];

/** Changes whenever a source file changes, so a server can rebuild only then. */
export function signature() {
  return parts.map(p => { try { const s = statSync(join(root, p)); return `${p}:${s.mtimeMs}:${s.size}`; } catch (e) { return `${p}:missing`; } }).join('|');
}
const haveSources = () => parts.every(p => existsSync(join(root, p)));

let esbuild;
function minifier() {
  if (esbuild === undefined) { try { esbuild = createRequire(import.meta.url)('esbuild'); } catch (e) { esbuild = null; } }
  return esbuild;
}

const concat = list => list.map(p => {
  const full = join(root, p);
  if (!existsSync(full)) { console.warn(`[scopos build] нет файла ${p}, пропускаю`); return `// ---- ${p} (missing)\n`; }
  return `// ---- ${p}\n${readFileSync(full, 'utf8')}`;
}).join('\n');

function squeeze(code, { keepNames = false } = {}) {
  const esb = process.env.SCOPOS_SDK_MINIFY === '0' ? null : minifier();
  if (!esb) return code;
  // No target: nothing is down-levelled, only whitespace, comments and local names go. Russian text stays as is.
  return esb.transformSync(code, { minify: true, charset: 'utf8', legalComments: 'inline', keepNames, loader: 'js' }).code;
}
const hash = code => createHash('sha256').update(code).digest('hex').slice(0, 10);

/** Builds everything in memory: { files: { name: code }, loader, core, learn, minified }. */
export function buildAll() {
  const day = new Date().toISOString().slice(0, 10);
  // No date in the chunks: their names are hashes of their content, which must not change unless the code does.
  const banner = (what, date = '') => `/*! Scopos SDK${what} · AI-гид внутри вашего продукта${date && ` · built ${date}`} */\n`;
  const core = banner(' core') + squeeze(concat(coreParts));
  // The guard's page patch wraps fetch/XHR with named functions; keep their names as on the real page.
  const learn = banner(' learn mode') + squeeze(concat(learnParts), { keepNames: true });
  const coreName = `scopos-core.${hash(core)}.js`, learnName = `scopos-learn.${hash(learn)}.js`;
  const src = readFileSync(join(root, loaderPart), 'utf8')
    .replace("'__SCOPOS_CORE__'", JSON.stringify(coreName)).replace("'__SCOPOS_LEARN__'", JSON.stringify(learnName));
  if (/'__SCOPOS_(CORE|LEARN)__'/.test(src) || !src.includes(coreName)) throw new Error('loader.js: chunk names not filled in');
  const loader = banner('', day) + squeeze(src);
  return { files: { 'scopos.js': loader, [coreName]: core, [learnName]: learn }, loader: 'scopos.js', core: coreName, learn: learnName, minified: !!minifier() && process.env.SCOPOS_SDK_MINIFY !== '0' };
}

/** Writes dist/ (and removes chunks of older builds). Returns the loader's code, as before. */
export function build({ write = true } = {}) {
  const out = buildAll();
  if (write) {
    mkdirSync(DIST, { recursive: true });
    for (const f of readdirSync(DIST)) if (/^scopos-(core|learn)\.[0-9a-f]+\.js$/.test(f) && !out.files[f]) rmSync(join(DIST, f));
    for (const [name, code] of Object.entries(out.files)) writeFileSync(join(DIST, name), code);
    const sizes = Object.fromEntries(Object.entries(out.files).map(([n, c]) => [n, { raw: Buffer.byteLength(c), gzip: gzipSync(c, { level: 9 }).length }]));
    writeFileSync(join(DIST, 'manifest.json'), JSON.stringify({ loader: out.loader, core: out.core, learn: out.learn, minified: out.minified, sizes }, null, 2) + '\n');
  }
  return out.files[out.loader];
}

// ---------- for the server ----------
let cache = { sig: null, files: new Map() };
const entry = (code, immutable) => {
  const body = Buffer.from(code, 'utf8');
  return { body, gzip: gzipSync(body, { level: 9 }), immutable, etag: `"${createHash('sha256').update(body).digest('hex').slice(0, 16)}"` };
};
function fromSources() {
  const out = buildAll();
  return new Map(Object.entries(out.files).map(([n, c]) => [n, entry(c, n !== out.loader)]));
}
function fromDist() {
  const files = new Map();
  try {
    const m = JSON.parse(readFileSync(join(DIST, 'manifest.json'), 'utf8'));
    for (const n of [m.loader, m.core, m.learn]) if (n) files.set(n, entry(readFileSync(join(DIST, n), 'utf8'), n !== m.loader));
  } catch (e) { console.warn('[scopos] нет dist/manifest.json: соберите SDK (npm run build)'); }
  return files;
}
/**
 * One SDK file by its public name ('scopos.js', 'scopos-core.<hash>.js', 'scopos-learn.<hash>.js'), or null.
 * { body, gzip, immutable, etag }: immutable files carry a content hash in the name and may be cached forever.
 */
export function sdkFile(name) {
  const sig = haveSources() ? signature() : 'dist';
  if (sig !== cache.sig) cache = { sig, files: sig === 'dist' ? fromDist() : fromSources() };
  return cache.files.get(name) || null;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  build();
  const m = JSON.parse(readFileSync(join(DIST, 'manifest.json'), 'utf8'));
  for (const [n, s] of Object.entries(m.sizes)) console.log(`dist/${n.padEnd(28)} ${(s.raw / 1024).toFixed(1).padStart(7)} KB · gzip ${(s.gzip / 1024).toFixed(1).padStart(6)} KB`);
  if (!m.minified) console.log('(без минификации: npm i, чтобы поставить esbuild)');
}

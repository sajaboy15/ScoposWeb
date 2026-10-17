// Builds the SDK bundle: the page reader, pointer, guide, guard and explorer from the extension, plus the widget.
// No dependencies: node sdk/build.mjs   -> dist/scopos.js
// The demo server calls build({ write: false }) and keeps the result in memory; it never writes to disk per request.
import { readFileSync, writeFileSync, mkdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const parts = ['extension/core/scan.js', 'extension/core/pointer.js', 'extension/core/guide.js', 'extension/core/guard.js', 'extension/core/explore.js', 'sdk/widget.js'];

/** Changes whenever a source file changes, so a server can rebuild only then. */
export function signature() {
  return parts.map(p => { try { const s = statSync(join(root, p)); return `${p}:${s.mtimeMs}:${s.size}`; } catch (e) { return `${p}:missing`; } }).join('|');
}

export function build({ write = true } = {}) {
  const banner = `/*! Scopos SDK · AI-гид внутри вашего продукта · built ${new Date().toISOString().slice(0, 10)} */\n`;
  const code = banner + parts.map(p => {
    const full = join(root, p);
    if (!existsSync(full)) { console.warn(`[scopos build] нет файла ${p}, пропускаю`); return `// ---- ${p} (missing)\n`; }
    return `// ---- ${p}\n${readFileSync(full, 'utf8')}`;
  }).join('\n');
  if (write) {
    mkdirSync(join(root, 'dist'), { recursive: true });
    writeFileSync(join(root, 'dist', 'scopos.js'), code);
  }
  return code;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const code = build();
  console.log(`dist/scopos.js · ${(code.length / 1024).toFixed(1)} KB`);
}

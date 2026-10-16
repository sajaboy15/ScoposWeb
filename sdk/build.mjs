// Builds dist/scopos.js: the page reader, pointer and guide from the extension, plus the widget.
// No dependencies: node sdk/build.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const parts = ['extension/core/scan.js', 'extension/core/pointer.js', 'extension/core/guide.js', 'extension/core/explore.js', 'sdk/widget.js'];

export function build() {
  const banner = `/*! Scopos SDK · AI-гид внутри вашего продукта · built ${new Date().toISOString().slice(0, 10)} */\n`;
  const code = banner + parts.map(p => `// ---- ${p}\n${readFileSync(join(root, p), 'utf8')}`).join('\n');
  mkdirSync(join(root, 'dist'), { recursive: true });
  writeFileSync(join(root, 'dist', 'scopos.js'), code);
  return code;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const code = build();
  console.log(`dist/scopos.js · ${(code.length / 1024).toFixed(1)} KB`);
}

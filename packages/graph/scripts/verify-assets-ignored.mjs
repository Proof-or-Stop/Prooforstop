/**
 * Proves the regenerable browser bundles cannot be committed.
 *
 * assets/ holds build output: app.html is assembled by scripts/build-web.mjs from
 * src/shells/web/*, and the vendor bundles are copied out of node_modules. Committing
 * them would put ~4.6MB of regenerable binaries into history and produce a large diff
 * on every dependency bump, so the package .gitignore excludes the directory. This
 * check fails loudly if that protection is ever lost.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname);
const pkgRoot = path.resolve(here, '..');

const probes = ['assets/app.html', 'assets/d3.min.js', 'assets/mermaid.min.js'];
const failures = [];

for (const rel of probes) {
  const abs = path.join(pkgRoot, rel);
  if (!fs.existsSync(abs)) continue;           // not built yet: nothing to leak
  try {
    execFileSync('git', ['check-ignore', '-q', abs], { cwd: pkgRoot });
  } catch {
    failures.push(rel);
  }
}

// Belt and braces: nothing under assets/ may be tracked.
const tracked = execFileSync('git', ['ls-files', '--', 'assets'], { cwd: pkgRoot, encoding: 'utf8' })
  .split('\n').filter(Boolean);
if (tracked.length) failures.push(...tracked.map(f => `tracked: ${f}`));

if (failures.length) {
  console.error('ASSETS_NOT_IGNORED');
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log('ASSETS_IGNORED_OK');

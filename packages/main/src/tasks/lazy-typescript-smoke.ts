#!/usr/bin/env node
/**
 * Lab lazy-typescript: profiling in the bench container (2026-09-30) showed
 * every CLI call spends ~460 ms in Node's cjs-module-lexer because seven core
 * modules `import ts from 'typescript'` (a 9 MB CommonJS file) at top level.
 * The CLI entry must not load typescript unless a command actually uses it,
 * and must still hand the real module to commands that do.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'cli.js');
const dir = mkdtempSync(join(tmpdir(), 'lazy-ts-'));
const counter = join(dir, 'count.mjs');
writeFileSync(counter, `import { registerHooks } from 'node:module';
const seen = [];
registerHooks({ load(url, ctx, next) { seen.push(url); return next(url, ctx); } });
process.on('exit', () => { process.stderr.write('LOADED_TS=' + seen.some(u => /node_modules\\/typescript\\/lib\\/typescript\\.js$/.test(u)) + '\\n'); });
`);
function cliOutput(args: string[]): string {
  const r = spawnSync(process.execPath, ['--import', counter, cli, ...args], { encoding: 'utf8', env: { ...process.env, NODE_DISABLE_COMPILE_CACHE: '1' } });
  return `${r.stdout}\n${r.stderr}`;
}
const version = cliOutput(['--version']);
assert.match(version, /Proof-or-Stop/, version);
assert.match(version, /LOADED_TS=false/, `--version still loads typescript:\n${version.slice(-400)}`);
// A path that needs typescript must still get the real module through the entry.
const probe = join(dir, 'probe.mjs');
writeFileSync(probe, `const ts = (await import('typescript')).default; if (typeof ts.createSourceFile !== 'function' || ts.ScriptKind.JS === undefined) process.exit(3); console.log('TS_OK');`);
const viaHook = spawnSync(process.execPath, ['--import', resolve(dirname(fileURLToPath(import.meta.url)), '..', 'core', 'lazy-typescript-hook.js'), probe], { encoding: 'utf8' });
assert.match(viaHook.stdout, /TS_OK/, `lazy typescript is not the real module: ${viaHook.stderr}`);
console.log('lazy-typescript-smoke: PASS');

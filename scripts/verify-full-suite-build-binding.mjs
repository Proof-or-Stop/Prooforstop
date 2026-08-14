#!/usr/bin/env node

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyBuildBinding, writeBuildBinding } from './full-suite-build-binding.mjs';

if (process.argv.length > 3 || (process.argv[2] && process.argv[2] !== '--self-test')) throw new Error('usage: verify-full-suite-build-binding.mjs [--self-test]');
if (process.argv[2] === '--self-test') {
  const root = mkdtempSync(join(tmpdir(), 'full-suite-build-binding-'));
  try {
    mkdirSync(join(root, 'packages/main/src'), { recursive: true });
    mkdirSync(join(root, 'packages/main/dist'), { recursive: true });
    writeFileSync(join(root, 'packages/main/src/input.ts'), 'export const value = 1;\n');
    writeFileSync(join(root, 'packages/main/tsconfig.json'), '{}\n');
    writeFileSync(join(root, 'packages/main/package.json'), '{}\n');
    writeFileSync(join(root, 'packages/main/dist/input.js'), 'export const value = 1;\n');
    writeBuildBinding(root); verifyBuildBinding(root);
    writeFileSync(join(root, 'packages/main/src/input.ts'), 'export const value = 2;\n');
    let staleSourceRejected = false; try { verifyBuildBinding(root); } catch { staleSourceRejected = true; }
    writeFileSync(join(root, 'packages/main/src/input.ts'), 'export const value = 1;\n');
    writeFileSync(join(root, 'packages/main/dist/input.js'), 'export const value = 9;\n');
    let tamperedDistRejected = false; try { verifyBuildBinding(root); } catch { tamperedDistRejected = true; }
    if (!staleSourceRejected || !tamperedDistRejected) throw new Error('build binding negative fixture did not bite');
  } finally { rmSync(root, { recursive: true, force: true }); }
  process.stdout.write('full-suite-build-binding-self-test: PASS (stale source and tampered dist rejected)\n');
} else {
  const manifest = verifyBuildBinding(process.cwd());
  process.stdout.write(`full-suite-build-binding: PASS (${manifest.sourceDigest.slice(0, 12)}:${manifest.distDigest.slice(0, 12)})\n`);
}

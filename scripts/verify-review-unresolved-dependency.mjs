import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { computeCanonicalDependencyClosure } from '../packages/main/dist/core/review-incremental-context.js';
const root = mkdtempSync(join(tmpdir(), 'review-unresolved-'));
const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
try {
  git('init', '-q'); git('config', 'user.name', 'Dependency witness'); git('config', 'user.email', 'dependency@example.invalid');
  writeFileSync(join(root, 'subject.test.ts'), 'export const x = 1;\n');
  writeFileSync(join(root, 'consumer.ts'), "import {x} from '@app/subject.test'; export const y=x;\n");
  git('add', '.'); git('commit', '-qm', 'unresolved runtime alias');
  const unknown = computeCanonicalDependencyClosure(root, ['subject.test.ts']);
  assert.equal(unknown.complete, false, 'U09: unresolved bare imports cannot prove a narrow dependency closure');
  assert.match(unknown.reason, /unresolved.*dependency/);
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { baseUrl: '.', paths: {'@app/*': ['./*']} } }));
  git('add', '.'); git('commit', '-qm', 'declare real alias');
  const known = computeCanonicalDependencyClosure(root, ['subject.test.ts']);
  assert.equal(known.complete, true, JSON.stringify(known));
  assert.deepEqual(known.files, ['consumer.ts', 'subject.test.ts']);
  writeFileSync(join(root, 'consumer.ts'), "import {readFileSync} from 'node:fs'; import path from 'path'; export const y=1;\n");
  git('add', '.'); git('commit', '-qm', 'builtin imports');
  assert.equal(computeCanonicalDependencyClosure(root, ['subject.test.ts']).complete, true, 'known builtins do not force full fallback');
  console.log('PASS U09 unresolved dependency fallback and resolved alias/builtin controls');
} finally { rmSync(root, {recursive:true, force:true}); }

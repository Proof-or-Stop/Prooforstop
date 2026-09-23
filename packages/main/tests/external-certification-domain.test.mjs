/** A Go consumer must reach PRE_CERT without weakening self-host path checks. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveCertificationDomainInputHashes } from '../dist/handlers/certification-window.js';
import { CAUSAL_DEPENDENCY_DOMAINS } from '../dist/core/causal-evidence.js';

function fixture(selfHost = false) {
  const root = mkdtempSync(join(tmpdir(), 'external-certification-domains-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Certification fixture');
  git('config', 'user.email', 'certification@example.invalid');
  mkdirSync(join(root, 'evaluator'));
  mkdirSync(join(root, 'repl'));
  writeFileSync(join(root, 'evaluator', 'module.go'), 'package evaluator\n');
  writeFileSync(join(root, 'repl', 'repl.go'), 'package repl\n');
  if (selfHost) {
    mkdirSync(join(root, 'packages', 'main'), { recursive: true });
    writeFileSync(join(root, 'package.json'), '{"name":"proof-or-stop"}\n');
    writeFileSync(join(root, 'packages', 'main', 'package.json'), '{"name":"@proof-or-stop/core"}\n');
  }
  git('add', '.');
  git('commit', '-qm', 'base');
  git('switch', '-qc', 'story/consumer');
  const base = deriveCertificationDomainInputHashes(root, 'HEAD', root);
  assert.ok(base);
  writeFileSync(join(root, 'evaluator', 'module.go'), 'package evaluator\n// change\n');
  writeFileSync(join(root, 'repl', 'repl.go'), 'package repl\n// change\n');
  git('add', '.');
  git('commit', '-qm', 'change Go consumer files');
  return { root, base };
}

const consumer = fixture();
try {
  const current = deriveCertificationDomainInputHashes(consumer.root, 'HEAD', consumer.root);
  assert.ok(current, 'EXTERNAL_CONSUMER_CAUSAL_INPUT_RED: Go paths must have complete causal identity');
  for (const domain of CAUSAL_DEPENDENCY_DOMAINS) {
    const id = `certification:${domain}`;
    assert.ok(current[id], `missing ${id}`);
    assert.notEqual(current[id], consumer.base[id], `unknown consumer change must invalidate ${id}`);
  }
  writeFileSync(join(consumer.root, 'package.json'), '{"name":"proof-or-stop"}\n');
  assert.deepEqual(deriveCertificationDomainInputHashes(consumer.root, 'HEAD', consumer.root), current,
    'uncommitted package identity cannot switch the committed causal policy');
  rmSync(join(consumer.root, 'package.json'));
  mkdirSync(join(consumer.root, '.lattice'));
  writeFileSync(join(consumer.root, '.lattice', 'unknown.txt'), 'legacy control material\n');
  execFileSync('git', ['add', '.'], { cwd: consumer.root, stdio: 'ignore' });
  execFileSync('git', ['commit', '-qm', 'add unsupported control namespace'], { cwd: consumer.root, stdio: 'ignore' });
  assert.equal(deriveCertificationDomainInputHashes(consumer.root, 'HEAD', consumer.root), undefined,
    'reserved legacy control paths remain fail closed even in external consumers');
} finally { rmSync(consumer.root, { recursive: true, force: true }); }

const selfHost = fixture(true);
try {
  assert.equal(deriveCertificationDomainInputHashes(selfHost.root, 'HEAD', selfHost.root), undefined,
    'unknown self-host paths remain fail closed');
} finally { rmSync(selfHost.root, { recursive: true, force: true }); }

console.log('EXTERNAL_CONSUMER_CAUSAL_INPUT_GREEN');

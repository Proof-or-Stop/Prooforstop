#!/usr/bin/env node

import { mkdtempSync, readFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';

const repoRoot = process.cwd();

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    ...opts,
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertIncludes(haystack, needle, label) {
  assert(haystack.includes(needle), `${label} missing "${needle}"`);
}

const checks = [];

checks.push(() => {
  const out = run('node', ['bin/koala.js', 'aux_doc_list', '--format=json']);
  assertIncludes(out, '"docs"', 'bin/koala.js aux_doc_list');
});

checks.push(() => {
  const out = run('node', ['bin/koala-codex.js', 'session_brief']);
  assertIncludes(out, '# koala session brief', 'bin/koala-codex.js session_brief');
});

checks.push(() => {
  const tempDir = mkdtempSync(join(tmpdir(), 'koala-entrypoints-'));
  try {
    const initOut = run('node', ['packages/main/dist/cli.js', 'init', tempDir]);
    assertIncludes(initOut, '.Codex/README.md', 'koala init output');

    const requiredFiles = [
      'AGENTS.md',
      'CLAUDE.md',
      '.Codex/README.md',
      '.Codex/agents/test-intent.md',
      '.Codex/agents/test-case-reviewer.md',
    ];
    for (const rel of requiredFiles) {
      assert(existsSync(join(tempDir, rel)), `koala init missing ${rel}`);
    }

    const codexReadme = readFileSync(join(tempDir, '.Codex', 'README.md'), 'utf8');
    assertIncludes(codexReadme, 'KOALA_ACTIVITY_SOURCE=codex koala session_brief', '.Codex/README.md');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

for (const [index, check] of checks.entries()) {
  check();
  console.log(`ok ${index + 1}/${checks.length}`);
}

console.log('entrypoints verified');

#!/usr/bin/env node
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const projectRoot = join(new URL('../../../..', import.meta.url).pathname);
const srcRoot = join(projectRoot, 'packages/main/src');

const HOST_SESSION_ENV_RE = /\b(?:CLAUDE_CODE_SESSION_ID|CLAUDE_SESSION_ID|CODEX_[A-Z0-9_]*SESSION[A-Z0-9_]*|OPENAI_SESSION_ID|AGY_[A-Z0-9_]*SESSION[A-Z0-9_]*|ANTIGRAVITY_[A-Z0-9_]*SESSION[A-Z0-9_]*|GEMINI_[A-Z0-9_]*SESSION[A-Z0-9_]*)\b/g;

const ALLOWLIST = [
  'packages/main/src/core/owner-session-adapters.ts',
  'packages/main/src/core/lattice-dispatch.ts',
  'packages/main/src/init-assets.ts',
];

function isAllowed(relPath: string): boolean {
  return ALLOWLIST.includes(relPath) || relPath.startsWith('packages/main/src/tasks/');
}

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listTsFiles(path));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      out.push(path);
    }
  }
  return out;
}

const offenders: string[] = [];
for (const file of listTsFiles(srcRoot)) {
  const relPath = relative(projectRoot, file).replace(/\\/g, '/');
  const content = readFileSync(file, 'utf8');
  const matches = [...content.matchAll(HOST_SESSION_ENV_RE)];
  if (matches.length === 0 || isAllowed(relPath)) continue;
  const lines = content.split('\n');
  for (const match of matches) {
    const prefix = content.slice(0, match.index ?? 0);
    const lineNo = prefix.split('\n').length;
    offenders.push(`${relPath}:${lineNo}: ${match[0]} :: ${lines[lineNo - 1]?.trim() ?? ''}`);
  }
}

assert.deepEqual(
  offenders,
  [],
  `raw host-specific owner-session env reads must stay in adapter/dispatch/test allowlist:\n${offenders.join('\n')}`,
);

const adapterPath = join(projectRoot, 'packages/main/src/core/owner-session-adapters.ts');
assert.equal(existsSync(adapterPath), true, 'owner-session adapter boundary exists');

const dispatchPath = join(projectRoot, 'packages/main/src/core/lattice-dispatch.ts');
const dispatch = readFileSync(dispatchPath, 'utf8');
const boundedStart = dispatch.indexOf('function runBoundedRealLeafDispatch');
const boundedEnd = dispatch.indexOf('function runCodexRealLeafDispatch', boundedStart);
assert.notEqual(boundedStart, -1, 'runBoundedRealLeafDispatch exists');
assert.notEqual(boundedEnd, -1, 'runCodexRealLeafDispatch follows runBoundedRealLeafDispatch');
const boundedBody = dispatch.slice(boundedStart, boundedEnd);
assert.match(
  boundedBody,
  /const providerEnv = buildCanonicalHostRuntimeEnv\(/,
  'bounded codex/gemini dispatch must build canonical host runtime env',
);
assert.match(
  boundedBody,
  /runner\(\{[\s\S]*?env: providerEnv,[\s\S]*?\}\)/,
  'bounded codex/gemini provider subprocess must receive providerEnv, not process.env',
);

console.log('✓ owner-session guardrail passed (raw host session envs confined to adapter/dispatch/test allowlist; bounded providers use canonical env)');

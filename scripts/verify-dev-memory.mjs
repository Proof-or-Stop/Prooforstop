#!/usr/bin/env node
/**
 * Focused verification script for the dev-memory feature (B-ad2c).
 *
 * Usage:
 *   node scripts/verify-dev-memory.mjs
 *
 * Exit codes:
 *   0 = all checks pass
 *   1 = one or more checks failed
 *
 * This script uses the compiled JS from packages/main/dist.
 * Run `npm --prefix packages/main run build` before running this.
 */

import { mkdirSync, rmSync, existsSync, readFileSync, appendFileSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { execSync, spawnSync } from 'child_process';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const ROOT = resolve(new URL('.', import.meta.url).pathname, '..');
// Normalise Windows drive-letter paths produced by import.meta.url
const DIST = join(ROOT, 'packages', 'main', 'dist', 'core', 'dev-memory.js');

if (!existsSync(DIST)) {
  console.error(`\n[FAIL] Build artefact not found: ${DIST}`);
  console.error('  Run: npm --prefix packages/main run build\n');
  process.exit(1);
}

// Dynamically import the compiled module
const dm = await import(DIST);

let passed = 0;
let failed = 0;
const tmpBase = join(tmpdir(), `koala-dev-memory-verify-${randomUUID()}`);
mkdirSync(tmpBase, { recursive: true });

function ok(label) {
  console.log(`  ✓ ${label}`);
  passed++;
}

function fail(label, detail) {
  console.error(`  ✗ ${label}`);
  if (detail) console.error(`      ${detail}`);
  failed++;
}

function check(label, fn) {
  try {
    fn();
    ok(label);
  } catch (e) {
    fail(label, e.message);
  }
}

// ---------------------------------------------------------------------------
// Section 1: Schema validation
// ---------------------------------------------------------------------------

console.log('\n--- Section 1: Schema validation ---');

check('valid entry passes validation', () => {
  const entry = dm.createEntry({
    category: 'pattern',
    scope: 'project',
    summary: 'Always run build before validate',
    trigger: 'lint gate skipped',
    lesson: 'The tsc gate only runs if dist exists; always build first',
    reusePrompt: 'Did you run build before validate?',
    tags: ['build', 'lint'],
    sourceAgent: 'koala-implementer',
  });
  const result = dm.validateEntry(entry);
  if (!result.ok) throw new Error(result.error);
  if (entry.gateEvidence !== false) throw new Error('gateEvidence must be false');
  if (entry.authority !== 'non_authoritative') throw new Error('authority must be non_authoritative');
});

check('invalid category fails with field-level error', () => {
  const entry = {
    id: 'abc1234',
    createdAt: new Date().toISOString(),
    sourceAgent: 'test',
    category: 'INVALID_CATEGORY',
    scope: 'project',
    summary: 'test summary with enough chars',
    trigger: 'test trigger',
    lesson: 'test lesson with enough chars',
    reusePrompt: 'test prompt',
    gateEvidence: false,
    authority: 'non_authoritative',
  };
  const result = dm.validateEntry(entry);
  if (result.ok) throw new Error('should have failed');
  if (!result.error.includes('Invalid dev-memory experience')) throw new Error('error should contain sentinel text');
});

check('missing summary fails with field-level error', () => {
  const entry = {
    id: 'abc1234',
    createdAt: new Date().toISOString(),
    sourceAgent: 'test',
    category: 'pattern',
    scope: 'project',
    summary: 'short',  // < 10 chars
    trigger: 'test trigger',
    lesson: 'test lesson with enough chars',
    reusePrompt: 'test prompt',
    gateEvidence: false,
    authority: 'non_authoritative',
  };
  const result = dm.validateEntry(entry);
  if (result.ok) throw new Error('should have failed');
  if (!result.error.includes('"summary"')) throw new Error('error should mention field: ' + result.error);
});

check('gateEvidence=true fails validation', () => {
  const entry = {
    id: 'abc1234',
    createdAt: new Date().toISOString(),
    sourceAgent: 'test',
    category: 'pattern',
    scope: 'project',
    summary: 'test summary ok here',
    trigger: 'test trigger',
    lesson: 'test lesson with enough chars',
    reusePrompt: 'test prompt',
    gateEvidence: true,   // invalid
    authority: 'non_authoritative',
  };
  const result = dm.validateEntry(entry);
  if (result.ok) throw new Error('should have failed: gateEvidence=true must be rejected');
});

check('authority="authoritative" fails validation', () => {
  const result = dm.validateEntry({
    id: 'abc1234',
    createdAt: new Date().toISOString(),
    sourceAgent: 'test',
    category: 'pattern',
    scope: 'project',
    summary: 'test summary ok here',
    trigger: 'test trigger',
    lesson: 'test lesson with enough chars',
    reusePrompt: 'test prompt',
    gateEvidence: false,
    authority: 'authoritative',  // invalid
  });
  if (result.ok) throw new Error('should have failed');
});

// ---------------------------------------------------------------------------
// Section 2: Path resolution
// ---------------------------------------------------------------------------

console.log('\n--- Section 2: Path resolution ---');

check('project path resolves deterministically with env override', () => {
  const orig = process.env.KOALA_PROJECT_ROOT;
  process.env.KOALA_PROJECT_ROOT = '/tmp/fake-project';
  const path = dm.resolveProjectMemoryPath();
  process.env.KOALA_PROJECT_ROOT = orig || '';
  if (!path.includes('.koala')) throw new Error('path should include .koala: ' + path);
  if (!path.endsWith('experience.jsonl')) throw new Error('path should end with experience.jsonl');
  if (!path.includes('dev-memory')) throw new Error('path should include dev-memory');
});

check('global path resolves deterministically with env override', () => {
  const orig = process.env.KOALA_GLOBAL_MEMORY_DIR;
  process.env.KOALA_GLOBAL_MEMORY_DIR = tmpBase;
  const path = dm.resolveGlobalMemoryPath();
  process.env.KOALA_GLOBAL_MEMORY_DIR = orig || '';
  if (!path.endsWith('experience.jsonl')) throw new Error('expected experience.jsonl, got: ' + path);
  if (!path.startsWith(tmpBase)) throw new Error('should be under override dir');
});

check('story candidate path uses storyId correctly', () => {
  const path = dm.resolveStoryCandidatePath('/tmp/story-dir', 'B-abc');
  if (!path.includes('B-abc')) throw new Error('should contain storyId');
  if (!path.endsWith('dev-memory-candidates.jsonl')) throw new Error('wrong filename');
});

// ---------------------------------------------------------------------------
// Section 3: JSONL I/O
// ---------------------------------------------------------------------------

console.log('\n--- Section 3: JSONL I/O ---');

const testFile = join(tmpBase, 'test-experience.jsonl');

check('readEntries returns empty array for nonexistent file', () => {
  const entries = dm.readEntries('/nonexistent/path/experience.jsonl');
  if (!Array.isArray(entries)) throw new Error('should return array');
  if (entries.length !== 0) throw new Error('should be empty');
});

check('appendEntry + readEntries roundtrip', () => {
  const entry = dm.createEntry({
    category: 'debugging',
    scope: 'project',
    summary: 'Use koala doctor to check stuck locks',
    trigger: 'koala validate hanging',
    lesson: 'koala doctor reveals stuck-lock state and suggests resolution',
    reusePrompt: 'Is there a stuck lock? Run koala doctor first.',
    sourceAgent: 'verify-script',
  });
  dm.appendEntry(testFile, entry);
  const entries = dm.readEntries(testFile);
  if (entries.length !== 1) throw new Error(`expected 1, got ${entries.length}`);
  if (entries[0].id !== entry.id) throw new Error('id mismatch');
  if (entries[0].gateEvidence !== false) throw new Error('gateEvidence should be false');
  if (entries[0].authority !== 'non_authoritative') throw new Error('authority wrong');
});

check('readEntries skips invalid lines without crashing', () => {
  // Append a corrupt line synchronously (dynamic import would run after cleanup)
  appendFileSync(testFile, 'NOT_JSON\n', 'utf-8');
  appendFileSync(testFile, '{"id":"bad","missing":"required fields"}\n', 'utf-8');
  // Re-read: should only get the valid entry
  const entries = dm.readEntries(testFile);
  if (entries.length < 1) throw new Error('should still return valid entries');
  // All returned entries must be valid
  for (const e of entries) {
    const v = dm.validateEntry(e);
    if (!v.ok) throw new Error(`invalid entry returned: ${v.error}`);
  }
});

// ---------------------------------------------------------------------------
// Section 4: Search and dedup
// ---------------------------------------------------------------------------

console.log('\n--- Section 4: Search and dedup ---');

const searchEntries = [
  dm.createEntry({ category: 'failure-mode', scope: 'project', summary: 'reviewer subagent not spawned', trigger: 'INIT phase stuck', lesson: 'spawn reviewer before advancing', reusePrompt: 'Did you spawn the INIT reviewer?', sourceAgent: 'agent-a', tags: ['reviewer', 'INIT'] }),
  dm.createEntry({ category: 'pattern', scope: 'project', summary: 'run build before tsc gate', trigger: 'tsc gate skipping', lesson: 'dist must exist for tsc to scan sub-packages', reusePrompt: 'Run build first', sourceAgent: 'agent-b', tags: ['build', 'tsc'] }),
  dm.createEntry({ category: 'anti-pattern', scope: 'global', summary: 'modifying story JSON directly', trigger: 'trying to fix metadata', lesson: 'always use koala CLI not raw JSON', reusePrompt: 'Use koala CLI commands', sourceAgent: 'agent-a', tags: ['cli'] }),
];

check('search by query finds relevant entries', () => {
  const results = dm.searchEntries(searchEntries, { query: 'reviewer' });
  if (results.length === 0) throw new Error('should find reviewer entry');
  if (!results[0].tags?.includes('reviewer')) throw new Error('reviewer entry should rank first');
});

check('search by category filters correctly', () => {
  const results = dm.searchEntries(searchEntries, { category: 'failure-mode' });
  if (results.length !== 1) throw new Error(`expected 1, got ${results.length}`);
  if (results[0].category !== 'failure-mode') throw new Error('wrong category');
});

check('search by agent filters correctly', () => {
  const results = dm.searchEntries(searchEntries, { agent: 'agent-a' });
  if (results.length !== 2) throw new Error(`expected 2, got ${results.length}`);
});

check('findSimilar detects duplicates by category + word overlap', () => {
  const candidate = {
    category: 'failure-mode',
    scope: 'project',
    summary: 'reviewer not spawned INIT phase',
    trigger: 'INIT phase stuck',
    lesson: 'spawn reviewer',
    reusePrompt: 'spawn reviewer',
  };
  const similar = dm.findSimilar(searchEntries, candidate);
  if (similar.length === 0) throw new Error('should detect similar entry');
});

// ---------------------------------------------------------------------------
// Section 5: Preflight
// ---------------------------------------------------------------------------

console.log('\n--- Section 5: Preflight ---');

const preflightDir = join(tmpBase, 'preflight-test');
mkdirSync(preflightDir, { recursive: true });
const preflightFile = join(preflightDir, 'experience.jsonl');
for (const e of searchEntries) {
  dm.appendEntry(preflightFile, e);
}

check('preflight with no memory returns empty-state message', () => {
  // Use a dir with no experience file
  const emptyDir = join(tmpBase, 'empty-preflight');
  const emptyGlobal = join(tmpBase, 'empty-global');
  const origProject = process.env.KOALA_PROJECT_ROOT;
  const origGlobal = process.env.KOALA_GLOBAL_MEMORY_DIR;
  process.env.KOALA_PROJECT_ROOT = emptyDir;
  process.env.KOALA_GLOBAL_MEMORY_DIR = emptyGlobal;
  const result = dm.buildPreflightPack({ query: 'reviewer' });
  process.env.KOALA_PROJECT_ROOT = origProject || '';
  process.env.KOALA_GLOBAL_MEMORY_DIR = origGlobal || '';
  const formatted = dm.formatPreflightPack(result);
  if (!formatted.includes('Dev Memory Preflight')) throw new Error('should have header');
  if (!formatted.includes('no relevant entries')) throw new Error('should say no entries');
});

check('preflight returns ≤5 relevant entries by default', () => {
  const origProject = process.env.KOALA_PROJECT_ROOT;
  const origGlobal = process.env.KOALA_GLOBAL_MEMORY_DIR;
  process.env.KOALA_PROJECT_ROOT = preflightDir;
  process.env.KOALA_GLOBAL_MEMORY_DIR = join(tmpBase, 'empty-global2');
  const result = dm.buildPreflightPack({ query: 'reviewer build' });
  process.env.KOALA_PROJECT_ROOT = origProject || '';
  process.env.KOALA_GLOBAL_MEMORY_DIR = origGlobal || '';
  if (result.entries.length > 5) throw new Error(`too many entries: ${result.entries.length}`);
});

check('preflight output stays within 60-line budget for small sets', () => {
  const result = dm.buildPreflightPack({ query: 'reviewer', maxEntries: 3 });
  if (result.lineCount > 60) throw new Error(`exceeded 60-line budget: ${result.lineCount}`);
});

check('formatPreflightPack includes "Dev Memory Preflight" header', () => {
  const result = { entries: searchEntries.slice(0, 1), lineCount: 6, truncated: false };
  const text = dm.formatPreflightPack(result, 'build');
  if (!text.includes('Dev Memory Preflight')) throw new Error('missing header');
  if (!text.includes(searchEntries[0].id)) throw new Error('missing entry id');
});

// ---------------------------------------------------------------------------
// Section 6: CLI smoke tests
// ---------------------------------------------------------------------------

console.log('\n--- Section 6: CLI smoke tests ---');

// Use the compiled CLI directly — avoids local koala bootstrap version skew.
const KOALA_CLI = join(ROOT, 'packages', 'main', 'dist', 'cli.js');
const cliEnv = {
  ...process.env,
  KOALA_PROJECT_ROOT: join(tmpBase, 'cli-test-project'),
  KOALA_GLOBAL_MEMORY_DIR: join(tmpBase, 'cli-test-global'),
};

function runKoala(args, env = cliEnv) {
  const result = spawnSync('node', [KOALA_CLI, ...args], {
    encoding: 'utf-8',
    env,
    timeout: 15000,
  });
  return result;
}

check('dev_memory_list prints empty state when no entries', () => {
  const result = runKoala(['dev_memory_list', '--scope=project']);
  const out = result.stdout + result.stderr;
  if (result.status !== 0) throw new Error(`Exit ${result.status}: ${out}`);
  if (!out.includes('No dev-memory experience entries yet')) throw new Error('expected empty state: ' + out);
});

check('dev_memory_capture writes an entry and prints Captured id', () => {
  const r = runKoala([
    'dev_memory_capture',
    '--category=pattern',
    '--summary=Run build before tsc gate in CI',
    '--trigger=tsc gate silently skipping sub-packages',
    '--lesson=The recursive tsc scan needs dist to exist first, always run build',
    '--reusePrompt=Did you run build before validate?',
    '--tags=build,tsc',
  ]);
  const out = r.stdout + r.stderr;
  if (r.status !== 0) throw new Error(`Exit ${r.status}: ${out}`);
  if (!out.includes('Captured dev-memory experience')) throw new Error('expected capture confirmation: ' + out);
});

check('dev_memory_list after capture shows the entry', () => {
  const r = runKoala(['dev_memory_list', '--scope=project']);
  const out = r.stdout + r.stderr;
  if (r.status !== 0) throw new Error(`Exit ${r.status}: ${out}`);
  if (out.includes('No dev-memory experience entries yet')) throw new Error('should have entries now');
  if (!out.includes('pattern')) throw new Error('should show category: ' + out);
});

check('dev_memory_search finds entry by query', () => {
  const r = runKoala(['dev_memory_search', '--query=build']);
  const out = r.stdout + r.stderr;
  if (r.status !== 0) throw new Error(`Exit ${r.status}: ${out}`);
  if (!out.includes('build') && !out.includes('pattern')) throw new Error('should find build entry: ' + out);
});

check('dev_memory_preflight emits Dev Memory Preflight header', () => {
  const r = runKoala(['dev_memory_preflight', '--query=build']);
  const out = r.stdout + r.stderr;
  if (r.status !== 0) throw new Error(`Exit ${r.status}: ${out}`);
  if (!out.includes('Dev Memory Preflight')) throw new Error('missing preflight header: ' + out);
});

check('dev_memory_preflight with no memory shows empty state', () => {
  const emptyEnv = {
    ...process.env,
    KOALA_PROJECT_ROOT: join(tmpBase, 'empty-cli-project'),
    KOALA_GLOBAL_MEMORY_DIR: join(tmpBase, 'empty-cli-global'),
  };
  const r = runKoala(['dev_memory_preflight', '--query=anything'], emptyEnv);
  const out = r.stdout + r.stderr;
  if (r.status !== 0) throw new Error(`Exit ${r.status}: ${out}`);
  if (!out.includes('Dev Memory Preflight')) throw new Error('missing header: ' + out);
});

check('dev_memory_finish writes candidate file', () => {
  // First capture another entry
  runKoala([
    'dev_memory_capture',
    '--category=debugging',
    '--summary=Use koala doctor to diagnose stuck locks',
    '--trigger=koala validate hanging indefinitely',
    '--lesson=koala doctor reveals stuck-lock state and suggests fix path',
    '--reusePrompt=Is there a stuck lock? Run koala doctor',
  ]);
  // Now finish with a fake storyId (no story dir required in non-Koala mode)
  const r = runKoala(['dev_memory_finish', '--storyId=B-test123']);
  const out = r.stdout + r.stderr;
  if (r.status !== 0) throw new Error(`Exit ${r.status}: ${out}`);
  if (!out.includes('Experience candidates') && !out.includes('written')) {
    throw new Error('expected finish confirmation: ' + out);
  }
});

check('dev_memory_start --dryRun emits preflight and finish reminder', () => {
  const r = runKoala(['dev_memory_start', '--agent=claude', '--query=new reviewer task', '--dryRun']);
  const out = r.stdout + r.stderr;
  if (r.status !== 0) throw new Error(`Exit ${r.status}: ${out}`);
  if (!out.includes('Dev Memory Preflight')) throw new Error('missing preflight: ' + out);
  if (!out.toLowerCase().includes('finish')) throw new Error('missing finish reminder: ' + out);
  if (!out.includes('claude')) throw new Error('missing agent name: ' + out);
});

check('dev_memory_start default is dry-run (does not launch agent binary)', () => {
  // dev_memory_start never spawns external binaries — always dry-run
  const r = runKoala(['dev_memory_start', '--agent=claude', '--query=test query']);
  const out = r.stdout + r.stderr;
  // Should not crash with "command not found" style errors
  if (out.toLowerCase().includes('enoent') && out.toLowerCase().includes('claude')) {
    throw new Error('should not try to spawn claude binary in default mode');
  }
});

// ---------------------------------------------------------------------------
// Section 7: Docs check
// ---------------------------------------------------------------------------

console.log('\n--- Section 7: Docs check ---');

check('dev-memory.md exists and contains non-authoritative disclaimer', () => {
  const docPath = join(ROOT, 'docs', 'requirements', 'decisions', 'dev-memory.md');
  if (!existsSync(docPath)) throw new Error(`doc not found: ${docPath}`);
  const content = readFileSync(docPath, 'utf-8');
  if (!content.includes('non-authoritative')) throw new Error('doc missing non-authoritative text');
  if (!content.includes('gateEvidence')) throw new Error('doc missing gateEvidence mention');
  if (!content.includes('authority: non_authoritative') && !content.includes('"non_authoritative"')) {
    throw new Error('doc missing authority field mention');
  }
});

check('dev-memory.md explicitly states it cannot satisfy gate evidence', () => {
  const docPath = join(ROOT, 'docs', 'requirements', 'decisions', 'dev-memory.md');
  const content = readFileSync(docPath, 'utf-8');
  // Should mention delivery_check or gate evidence
  if (!content.includes('delivery_check') && !content.includes('gate evidence') && !content.includes('gate receipt')) {
    throw new Error('doc should mention delivery_check or gate evidence');
  }
});

// ---------------------------------------------------------------------------
// Cleanup & summary
// ---------------------------------------------------------------------------

rmSync(tmpBase, { recursive: true, force: true });

console.log(`\n${'='.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error(`\n[FAIL] ${failed} check(s) failed\n`);
  process.exit(1);
} else {
  console.log(`\n[PASS] All ${passed} checks passed\n`);
}

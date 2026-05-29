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

import { mkdirSync, rmSync, existsSync, readFileSync, appendFileSync, writeFileSync } from 'fs';
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

const POLICY_DIST = join(ROOT, 'packages', 'main', 'dist', 'core', 'command-policy.js');
if (!existsSync(POLICY_DIST)) {
  console.error(`\n[FAIL] Build artefact not found: ${POLICY_DIST}`);
  console.error('  Run: npm --prefix packages/main run build\n');
  process.exit(1);
}
const policyMod = await import(POLICY_DIST);

const CLI_ENGINE_DIST = join(ROOT, 'packages', 'main', 'dist', 'cli-engine.js');
if (!existsSync(CLI_ENGINE_DIST)) {
  console.error('\n[FAIL] Build artefact not found: ' + CLI_ENGINE_DIST);
  console.error('  Run: npm --prefix packages/main run build\n');
  process.exit(1);
}
const cliEngineMod = await import(CLI_ENGINE_DIST);

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

function runKoala(args, env = cliEnv, cwd = ROOT) {
  const result = spawnSync('node', [KOALA_CLI, ...args], {
    cwd,
    encoding: 'utf-8',
    env,
    timeout: 15000,
  });
  return result;
}

function runGit(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf-8', timeout: 15000 });
  if (result.status !== 0) {
    throw new Error('git ' + args.join(' ') + ' failed in ' + cwd + ': ' + (result.stdout + result.stderr));
  }
  return result;
}

function createActiveStoryRepo(label, storyId = 'B-active') {
  const root = join(tmpBase, label);
  const storyDir = join(root, '.koala', 'story', 'actives', storyId);
  mkdirSync(storyDir, { recursive: true });
  writeFileSync(join(root, 'koala.config.json'), JSON.stringify({
    scanRoot: '.',
    storyDir: '.koala/story/actives',
    phaseTools: { '*': ['dev_memory_*'] },
  }, null, 2) + '\n', 'utf-8');
  const now = new Date().toISOString();
  writeFileSync(join(storyDir, 'index.json'), JSON.stringify({
    storyId,
    name: storyId,
    title: 'Active dev-memory test story',
    description: 'Fixture story used by dev-memory active story tests.',
    type: 'feature',
    phase: 'DEV',
    priority: 'medium',
    createdAt: now,
    startedAt: now,
    endedAt: null,
    events: [],
  }, null, 2) + '\n', 'utf-8');
  writeFileSync(join(root, 'seed.txt'), 'seed\n', 'utf-8');
  runGit(root, ['init']);
  runGit(root, ['config', 'user.email', 'koala-test@noreply.local']);
  runGit(root, ['config', 'user.name', 'Koala Test']);
  runGit(root, ['add', '.']);
  runGit(root, ['commit', '-m', 'init active story fixture']);
  runGit(root, ['checkout', '-b', 'story/' + storyId]);
  return root;
}

function readJsonl(filePath) {
  return readFileSync(filePath, 'utf-8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
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

check('dev-memory.md does NOT document koala dev_start for this feature', () => {
  const docPath = join(ROOT, 'docs', 'requirements', 'decisions', 'dev-memory.md');
  const content = readFileSync(docPath, 'utf-8');
  // Must not use "koala dev_start" (without "memory_") as a command for this feature
  if (content.includes('koala dev_start') || content.includes('### dev_start')) {
    throw new Error('doc must not use "koala dev_start" or "### dev_start" — use dev_memory_start instead');
  }
  // Must mention dev_memory_start
  if (!content.includes('dev_memory_start')) {
    throw new Error('doc must mention dev_memory_start');
  }
});

// ---------------------------------------------------------------------------
// Section 8: Review findings validation
// ---------------------------------------------------------------------------

console.log('\n--- Section 8: Review findings ---');

check('dev_memory_finish default storyDir uses .koala/story/actives (not docs/story/actives)', () => {
  // Check the compiled handler or source references the correct path
  const handlerPath = join(ROOT, 'packages', 'main', 'src', 'handlers', 'dev-memory.ts');
  if (!existsSync(handlerPath)) throw new Error(`handler not found: ${handlerPath}`);
  const src = readFileSync(handlerPath, 'utf-8');
  if (src.includes("'docs', 'story', 'actives'") || src.includes('"docs", "story", "actives"')) {
    throw new Error('handler default storyDir must not use docs/story/actives — use .koala/story/actives');
  }
  if (!src.includes('.koala') || !src.includes('story') || !src.includes('actives')) {
    throw new Error('handler must reference .koala/story/actives as default storyDir');
  }
});

check('dev_memory_finish uses .koala/story/actives path in CLI smoke test', () => {
  // Run finish and check the output path
  const finishEnv = {
    ...process.env,
    KOALA_PROJECT_ROOT: join(tmpBase, 'finish-path-test'),
    KOALA_GLOBAL_MEMORY_DIR: join(tmpBase, 'finish-path-global'),
  };
  // Capture something first
  runKoala([
    'dev_memory_capture',
    '--category=pattern',
    '--summary=Finish path test entry for candidate dir',
    '--trigger=testing candidate dir path',
    '--lesson=Test that finish uses dot koala story actives path',
    '--reusePrompt=Check candidate dir path',
  ], finishEnv);
  const r = runKoala(['dev_memory_finish', '--storyId=B-pathtest'], finishEnv);
  const out = r.stdout + r.stderr;
  if (r.status !== 0) throw new Error(`Exit ${r.status}: ${out}`);
  // Output path should contain .koala/story/actives
  if (!out.includes('.koala') || !out.includes('story') || !out.includes('actives')) {
    throw new Error(`finish output must reference .koala/story/actives path, got: ${out}`);
  }
  // Must NOT reference docs/story/actives
  if (out.includes('docs/story/actives') || out.includes('docs\\story\\actives')) {
    throw new Error(`finish output must not reference docs/story/actives, got: ${out}`);
  }
});

check('dev_memory_capture warns on possible duplicate', () => {
  const dupEnv = {
    ...process.env,
    KOALA_PROJECT_ROOT: join(tmpBase, 'dup-test-project'),
    KOALA_GLOBAL_MEMORY_DIR: join(tmpBase, 'dup-test-global'),
  };
  const commonArgs = [
    'dev_memory_capture',
    '--category=pattern',
    '--summary=Run build before tsc gate always first',
    '--trigger=tsc gate skipping sub-packages',
    '--lesson=The recursive tsc scan needs dist to exist first, run build',
    '--reusePrompt=Did you run build before validate?',
  ];
  // Capture first entry
  runKoala(commonArgs, dupEnv);
  // Capture nearly identical entry — should warn
  const r2 = runKoala(commonArgs, dupEnv);
  const out2 = r2.stdout + r2.stderr;
  if (r2.status !== 0) throw new Error(`Exit ${r2.status}: ${out2}`);
  if (!out2.includes('Possible duplicate')) {
    throw new Error(`capture should warn on duplicate, got: ${out2}`);
  }
});

check('dev_memory_list returns newest-first order', () => {
  const listEnv = {
    ...process.env,
    KOALA_PROJECT_ROOT: join(tmpBase, 'list-order-project'),
    KOALA_GLOBAL_MEMORY_DIR: join(tmpBase, 'list-order-global'),
  };
  // Capture two entries with slight delay to ensure different timestamps
  runKoala([
    'dev_memory_capture', '--category=pattern',
    '--summary=First entry for order test - oldest',
    '--trigger=order test first', '--lesson=First lesson for order testing newest first',
    '--reusePrompt=check order first',
  ], listEnv);
  // Small synchronous delay via spawnSync
  execSync('node -e "const d=Date.now();while(Date.now()-d<50){}"');
  runKoala([
    'dev_memory_capture', '--category=workflow',
    '--summary=Second entry for order test - newest',
    '--trigger=order test second', '--lesson=Second lesson for order testing newest first',
    '--reusePrompt=check order second',
  ], listEnv);
  const r = runKoala(['dev_memory_list', '--scope=project'], listEnv);
  const out = r.stdout + r.stderr;
  if (r.status !== 0) throw new Error(`Exit ${r.status}: ${out}`);
  const firstIdx = out.indexOf('First entry for order test');
  const secondIdx = out.indexOf('Second entry for order test');
  if (firstIdx === -1 || secondIdx === -1) throw new Error(`missing entries in list output: ${out}`);
  if (secondIdx >= firstIdx) {
    throw new Error(`newest entry should appear BEFORE oldest in list output (newest-first). Got indexes: second=${secondIdx} first=${firstIdx}`);
  }
});

check('dev_memory_finish writes story-candidate scope and sourceStoryId', () => {
  const scEnv = {
    ...process.env,
    KOALA_PROJECT_ROOT: join(tmpBase, 'sc-test-project'),
    KOALA_GLOBAL_MEMORY_DIR: join(tmpBase, 'sc-test-global'),
  };
  runKoala([
    'dev_memory_capture', '--category=debugging',
    '--summary=Story candidate scope field test entry for finish',
    '--trigger=testing scope field in candidate file',
    '--lesson=Finish should set scope to story-candidate and sourceStoryId',
    '--reusePrompt=Check scope and sourceStoryId in candidate file',
  ], scEnv);
  const r = runKoala(['dev_memory_finish', '--storyId=B-sctest'], scEnv);
  if (r.status !== 0) throw new Error(`Exit ${r.status}: ${r.stdout + r.stderr}`);

  // Find the candidate file under .koala/story/actives
  const candidateFile = join(scEnv.KOALA_PROJECT_ROOT, '.koala', 'story', 'actives', 'B-sctest', 'dev-memory-candidates.jsonl');
  if (!existsSync(candidateFile)) throw new Error(`candidate file not found: ${candidateFile}`);

  const lines = readFileSync(candidateFile, 'utf-8').trim().split('\n').filter(l => l.trim());
  if (lines.length === 0) throw new Error('candidate file is empty');

  for (const line of lines) {
    const entry = JSON.parse(line);
    if (entry.scope !== 'story-candidate') {
      throw new Error(`entry scope should be "story-candidate", got "${entry.scope}"`);
    }
    if (entry.sourceStoryId !== 'B-sctest') {
      throw new Error(`entry sourceStoryId should be "B-sctest", got "${entry.sourceStoryId}"`);
    }
    if (entry.gateEvidence !== false) {
      throw new Error(`entry gateEvidence should be false, got ${entry.gateEvidence}`);
    }
    if (entry.authority !== 'non_authoritative') {
      throw new Error(`entry authority should be "non_authoritative", got "${entry.authority}"`);
    }
  }
});

check('command policy: dev_memory_capture is mainSharedMutating with metadata-write risk', () => {
  // Check the compiled policy module
  const capturePolicy = policyMod.COMMAND_POLICIES?.dev_memory_capture;
  if (!capturePolicy) throw new Error('dev_memory_capture not found in COMMAND_POLICIES');
  if (capturePolicy.ownershipClass !== 'mainSharedMutating') {
    throw new Error(`dev_memory_capture ownershipClass should be mainSharedMutating, got ${capturePolicy.ownershipClass}`);
  }
  if (capturePolicy.destructiveRisk !== 'metadata-write') {
    throw new Error(`dev_memory_capture destructiveRisk should be metadata-write, got ${capturePolicy.destructiveRisk}`);
  }
});

check('command policy: dev_memory_finish is storyScopedMutating with metadata-write risk', () => {
  const finishPolicy = policyMod.COMMAND_POLICIES?.dev_memory_finish;
  if (!finishPolicy) throw new Error('dev_memory_finish not found in COMMAND_POLICIES');
  if (finishPolicy.ownershipClass !== 'storyScopedMutating') {
    throw new Error(`dev_memory_finish ownershipClass should be storyScopedMutating, got ${finishPolicy.ownershipClass}`);
  }
  if (finishPolicy.destructiveRisk !== 'metadata-write') {
    throw new Error(`dev_memory_finish destructiveRisk should be metadata-write, got ${finishPolicy.destructiveRisk}`);
  }
});

check('command policy: dev_memory_list/search/preflight/start remain readOnly', () => {
  for (const cmd of ['dev_memory_list', 'dev_memory_search', 'dev_memory_preflight', 'dev_memory_start']) {
    const p = policyMod.COMMAND_POLICIES?.[cmd];
    if (!p) throw new Error(`${cmd} not found in COMMAND_POLICIES`);
    if (p.ownershipClass !== 'readOnly') {
      throw new Error(`${cmd} ownershipClass should be readOnly, got ${p.ownershipClass}`);
    }
  }
});

// ---------------------------------------------------------------------------
// Section 9: dev_memory_finish without --storyId (outside-Koala mode)
// ---------------------------------------------------------------------------

console.log('\n--- Section 9: dev_memory_finish outside-Koala mode ---');

check('dev_memory_finish without --storyId succeeds (exit 0)', () => {
  const noStoryEnv = {
    ...process.env,
    KOALA_PROJECT_ROOT: join(tmpBase, 'nostory-test-project'),
    KOALA_GLOBAL_MEMORY_DIR: join(tmpBase, 'nostory-test-global'),
  };
  // Capture an entry first so there is something to report
  runKoala([
    'dev_memory_capture',
    '--category=pattern',
    '--summary=Outside-Koala session experience for finish test',
    '--trigger=testing finish without storyId',
    '--lesson=dev_memory_finish should work without a story context',
    '--reusePrompt=Run dev_memory_finish without storyId',
  ], noStoryEnv);
  const r = runKoala(['dev_memory_finish'], noStoryEnv);
  if (r.status !== 0) {
    throw new Error(`dev_memory_finish without --storyId must exit 0, got exit ${r.status}: ${r.stdout + r.stderr}`);
  }
});

check('dev_memory_finish without --storyId does NOT create .koala/story/actives', () => {
  const noStoryEnv = {
    ...process.env,
    KOALA_PROJECT_ROOT: join(tmpBase, 'nostory-no-dir-project'),
    KOALA_GLOBAL_MEMORY_DIR: join(tmpBase, 'nostory-no-dir-global'),
  };
  runKoala([
    'dev_memory_capture',
    '--category=workflow',
    '--summary=Check that finish never creates story actives dir outside Koala',
    '--trigger=outside-Koala session with no storyId',
    '--lesson=finish without storyId must not create story directories',
    '--reusePrompt=Verify no story dirs created',
  ], noStoryEnv);
  runKoala(['dev_memory_finish'], noStoryEnv);
  const storyActivesDir = join(noStoryEnv.KOALA_PROJECT_ROOT, '.koala', 'story', 'actives');
  if (existsSync(storyActivesDir)) {
    throw new Error(`dev_memory_finish without --storyId must NOT create .koala/story/actives, but found: ${storyActivesDir}`);
  }
});

check('dev_memory_finish without --storyId empty state does not touch story dirs', () => {
  const emptyEnv = {
    ...process.env,
    KOALA_PROJECT_ROOT: join(tmpBase, 'nostory-empty-project'),
    KOALA_GLOBAL_MEMORY_DIR: join(tmpBase, 'nostory-empty-global'),
  };
  // No capture first — project memory is empty
  const r = runKoala(['dev_memory_finish'], emptyEnv);
  if (r.status !== 0) {
    throw new Error(`dev_memory_finish (empty state) must exit 0, got ${r.status}: ${r.stdout + r.stderr}`);
  }
  const out = r.stdout + r.stderr;
  if (!out.includes('no experience entries')) {
    throw new Error(`empty-state message missing, got: ${out}`);
  }
  const storyActivesDir = join(emptyEnv.KOALA_PROJECT_ROOT, '.koala', 'story', 'actives');
  if (existsSync(storyActivesDir)) {
    throw new Error(`dev_memory_finish empty-state must not create story actives dir`);
  }
});

check('dev_memory_finish --scope=global without --storyId writes global dev-memory entries', () => {
  const globalEnv = {
    ...process.env,
    KOALA_PROJECT_ROOT: join(tmpBase, 'global-export-project'),
    KOALA_GLOBAL_MEMORY_DIR: join(tmpBase, 'global-export-global'),
  };
  runKoala([
    'dev_memory_capture',
    '--category=debugging',
    '--summary=Global export test entry for scope=global finish path',
    '--trigger=testing global scope promotion in outside-Koala mode',
    '--lesson=dev_memory_finish scope=global must write to global dev-memory',
    '--reusePrompt=Verify global export writes entries',
  ], globalEnv);
  const r = runKoala(['dev_memory_finish', '--scope=global'], globalEnv);
  if (r.status !== 0) {
    throw new Error(`dev_memory_finish --scope=global must exit 0, got ${r.status}: ${r.stdout + r.stderr}`);
  }
  const out = r.stdout + r.stderr;
  if (!out.toLowerCase().includes('global')) {
    throw new Error(`output should mention global, got: ${out}`);
  }
  // Verify global file was actually written
  const globalFile = join(globalEnv.KOALA_GLOBAL_MEMORY_DIR, 'experience.jsonl');
  if (!existsSync(globalFile)) {
    throw new Error(`global dev-memory file not created: ${globalFile}`);
  }
  const lines = readFileSync(globalFile, 'utf-8').trim().split('\n').filter(l => l.trim());
  if (lines.length === 0) throw new Error('global dev-memory file is empty after --scope=global finish');
  const entry = JSON.parse(lines[0]);
  if (entry.scope !== 'global') {
    throw new Error(`global export entry should have scope="global", got "${entry.scope}"`);
  }
  if (entry.gateEvidence !== false) {
    throw new Error(`global export entry gateEvidence should be false`);
  }
  if (entry.authority !== 'non_authoritative') {
    throw new Error(`global export entry authority should be "non_authoritative"`);
  }
});

check('dev_memory_finish --scope=global deduplicates already-global entries', () => {
  const dedupEnv = {
    ...process.env,
    KOALA_PROJECT_ROOT: join(tmpBase, 'global-dedup-project'),
    KOALA_GLOBAL_MEMORY_DIR: join(tmpBase, 'global-dedup-global'),
  };
  // Capture one entry and export twice — second run should report 0 new entries
  runKoala([
    'dev_memory_capture',
    '--category=pattern',
    '--summary=Dedup test entry for global scope idempotency check',
    '--trigger=testing idempotent global export',
    '--lesson=Repeat global export should not duplicate entries',
    '--reusePrompt=Run global export twice, count must not grow',
  ], dedupEnv);
  runKoala(['dev_memory_finish', '--scope=global'], dedupEnv);
  const r2 = runKoala(['dev_memory_finish', '--scope=global'], dedupEnv);
  if (r2.status !== 0) throw new Error(`second export must exit 0, got ${r2.status}`);
  const out = r2.stdout + r2.stderr;
  // Second run should report 0 new entries (or "already present")
  if (!out.includes('0 entries') && !out.includes('0 entry') && !out.includes('already present')) {
    throw new Error(`second global export should report 0 new entries or already-present, got: ${out}`);
  }
});

check('docs: dev-memory.md does not imply --storyId is mandatory for finish outside Koala', () => {
  const docPath = join(ROOT, 'docs', 'requirements', 'decisions', 'dev-memory.md');
  const content = readFileSync(docPath, 'utf-8');
  // Must not say "--storyId is required" for finish
  if (content.match(/--storyId\s+is\s+required/i)) {
    throw new Error('docs must not say "--storyId is required" — storyId is optional for outside-Koala finish');
  }
  // Must explicitly say storyId is optional OR outside-Koala works without it
  const hasOptional = content.includes('--storyId` is optional') ||
    content.includes('--storyId` optional') ||
    content.includes('storyId is optional') ||
    content.includes('no `--storyId`') ||
    content.includes('without `--storyId`') ||
    content.includes('Outside Koala') ||
    content.includes('outside-Koala') ||
    content.includes('outside Koala');
  if (!hasOptional) {
    throw new Error('docs must state that --storyId is optional (outside-Koala use) for dev_memory_finish');
  }
  // Must mention dev_memory_finish (already checked in section 7, belt-and-suspenders)
  if (!content.includes('dev_memory_finish')) {
    throw new Error('docs must mention dev_memory_finish');
  }
});

// ---------------------------------------------------------------------------
// Section 10: dev_memory_finish active-story defaults
// ---------------------------------------------------------------------------

console.log('\n--- Section 10: dev_memory_finish active-story defaults ---');

check('effective ownership: global dev_memory_finish without explicit story is mainSharedMutating', () => {
  const cls = cliEngineMod.resolveEffectiveOwnershipClass('dev_memory_finish', { scope: 'global' }, 'B-active');
  if (cls !== 'mainSharedMutating') {
    throw new Error('expected mainSharedMutating for global no-story finish, got ' + cls);
  }
});

check('effective ownership: default dev_memory_finish remains storyScopedMutating', () => {
  const cls = cliEngineMod.resolveEffectiveOwnershipClass('dev_memory_finish', {}, 'B-active');
  if (cls !== 'storyScopedMutating') {
    throw new Error('expected storyScopedMutating for default active-story finish, got ' + cls);
  }
});

check('dev_memory_finish in active story defaults to story candidate file', () => {
  const activeRoot = createActiveStoryRepo('active-story-default');
  const env = {
    ...process.env,
    KOALA_PROJECT_ROOT: activeRoot,
    KOALA_GLOBAL_MEMORY_DIR: join(tmpBase, 'active-story-default-global'),
  };
  const capture = runKoala(['dev_memory_capture', JSON.stringify({
    category: 'workflow',
    summary: 'Active story default finish writes candidate evidence refs',
    trigger: 'finishing an active Koala story session',
    lesson: 'Bare dev_memory_finish should target the active story branch',
    reusePrompt: 'When in story branch, finish should write story candidates',
    evidenceRefs: ['evidence/transcript.md', 'command:node scripts/verify-dev-memory.mjs'],
  })], env, activeRoot);
  if (capture.status !== 0) throw new Error('capture failed: ' + (capture.stdout + capture.stderr));

  const finish = runKoala(['dev_memory_finish'], env, activeRoot);
  if (finish.status !== 0) throw new Error('finish failed: ' + (finish.stdout + finish.stderr));
  const candidateFile = join(activeRoot, '.koala', 'story', 'actives', 'B-active', 'dev-memory-candidates.jsonl');
  if (!existsSync(candidateFile)) throw new Error('candidate file not written: ' + candidateFile);
  const entries = readJsonl(candidateFile);
  if (entries.length !== 1) throw new Error('expected 1 candidate entry, got ' + entries.length);
  const entry = entries[0];
  if (entry.scope !== 'story-candidate') throw new Error('expected story-candidate scope, got ' + entry.scope);
  if (entry.sourceStoryId !== 'B-active') throw new Error('expected sourceStoryId B-active, got ' + entry.sourceStoryId);
  if (entry.gateEvidence !== false) throw new Error('candidate gateEvidence must be false');
  if (entry.authority !== 'non_authoritative') throw new Error('candidate authority must be non_authoritative');
  if (!Array.isArray(entry.evidenceRefs) || !entry.evidenceRefs.includes('evidence/transcript.md')) {
    throw new Error('candidate must preserve evidenceRefs: ' + JSON.stringify(entry.evidenceRefs));
  }
});

check('dev_memory_finish --scope=global in active story does not write story candidates', () => {
  const activeRoot = createActiveStoryRepo('active-story-global');
  const env = {
    ...process.env,
    KOALA_PROJECT_ROOT: activeRoot,
    KOALA_GLOBAL_MEMORY_DIR: join(tmpBase, 'active-story-global-memory'),
  };
  const capture = runKoala(['dev_memory_capture', JSON.stringify({
    category: 'pattern',
    summary: 'Active story global finish writes only global memory',
    trigger: 'promoting active story lesson globally',
    lesson: 'Global scope should not create a story candidate file',
    reusePrompt: 'Use scope global for cross-project lessons',
  })], env, activeRoot);
  if (capture.status !== 0) throw new Error('capture failed: ' + (capture.stdout + capture.stderr));

  const finish = runKoala(['dev_memory_finish', '--scope=global'], env, activeRoot);
  if (finish.status !== 0) throw new Error('global finish failed: ' + (finish.stdout + finish.stderr));
  const candidateFile = join(activeRoot, '.koala', 'story', 'actives', 'B-active', 'dev-memory-candidates.jsonl');
  if (existsSync(candidateFile)) throw new Error('global finish must not create story candidates: ' + candidateFile);
  const globalFile = join(env.KOALA_GLOBAL_MEMORY_DIR, 'experience.jsonl');
  if (!existsSync(globalFile)) throw new Error('global memory file not created: ' + globalFile);
  const entries = readJsonl(globalFile);
  if (entries.length !== 1) throw new Error('expected 1 global entry, got ' + entries.length);
  if (entries[0].scope !== 'global') throw new Error('expected global scope, got ' + entries[0].scope);
  if (entries[0].gateEvidence !== false) throw new Error('global entry gateEvidence must be false');
  if (entries[0].authority !== 'non_authoritative') throw new Error('global entry authority must be non_authoritative');
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

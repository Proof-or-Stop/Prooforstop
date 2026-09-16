#!/usr/bin/env node
// Disposable fixtures use the same StoryStore writer as the existing recovery smoke.
// Trace real Git processes; never replace production readers or manufacture receipts.
import './lab-source-loader.mjs';
import { registerHooks, createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const ts = createRequire(import.meta.url)('typescript');
const sourceRefIndex = process.argv.indexOf('--source-ref');
const sourceRef = sourceRefIndex < 0 ? null : process.argv[sourceRefIndex + 1];
assert(sourceRef === null || /^[a-f0-9]{40}$/.test(sourceRef), 'source-ref must be a fixed commit SHA');
const ownerPath = 'packages/main/src/core/partial-done-recovery.ts';
const baselineSource = sourceRef ? execFileSync('git', ['show', sourceRef + ':' + ownerPath], { cwd: new URL('..', import.meta.url), encoding: 'utf8' }) : null;
// Compile fresh checkout source with TypeScript, including parameter properties.
registerHooks({ load(url, context, nextLoad) {
  if (url.startsWith('file:') && url.endsWith('.ts')) return { format: 'module', shortCircuit: true,
    source: ts.transpileModule(baselineSource !== null && fileURLToPath(url).endsWith('/' + ownerPath) ? baselineSource : readFileSync(fileURLToPath(url), 'utf8'), { compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, esModuleInterop: true,
    }, fileName: fileURLToPath(url) }).outputText };
  return nextLoad(url, context);
} });
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, chmodSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
const { StoryStore } = await import('../packages/main/src/core/store.ts');
const { detectPartialDoneStories, renderPartialDoneSummary } = await import('../packages/main/src/core/partial-done-recovery.ts');
const measureOnly = process.argv.includes('--measure');
const repeatIndex = process.argv.indexOf('--repeat');
const repeats = repeatIndex < 0 ? 1 : Number(process.argv[repeatIndex + 1]);
assert(Number.isInteger(repeats) && repeats > 0 && repeats <= 20);
const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
const sandbox = mkdtempSync(join(tmpdir(), 'pos-recovery-scan-'));
let checks = 0;
function check(value, message) { assert(value, message); checks++; }
function git(root, args) { return execFileSync(realGit, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
function story(id, phase = 'DONE', target = true) {
  return { storyId: id, name: id, title: id, description: 'Disposable recovery regression fixture',
    type: 'bug', phase, priority: 'medium', createdAt: '2026-01-01T00:00:00.000Z',
    startedAt: null, endedAt: null, ...(target ? { integrationTarget: {
      parentBranch: 'main', parentCommitAtCreation: 'fixture-only', source: 'creation_branch', deliveryMode: 'merge_to_parent',
    } } : {}) };
}
function init(name, archived = 0, branch = 'main') {
  const root = join(sandbox, name); mkdirSync(root);
  git(root, ['init', '-q', '-b', branch]); git(root, ['config', 'user.email', 'fixture@example.invalid']);
  git(root, ['config', 'user.name', 'Recovery Fixture']);
  writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify({ scanRoot: '.', rootDir: '.', outDir: 'dist', testsDir: 'tests', fixturesDir: 'tests/fixtures', storyDir: '.proof-or-stop/story/actives' }));
  writeFileSync(join(root, 'conflict.txt'), 'base\n');
  const store = new StoryStore(root);
  for (let i = 0; i < archived; i++) store.writeStory(`B-archived-${i}`, story(`B-archived-${i}`));
  git(root, ['add', '.']); git(root, ['commit', '-qm', 'seed isolated fixture']);
  return { root, store };
}
function branchStory(f, id, phase = 'DONE', conflict = false, parentBranch = 'main') {
  git(f.root, ['checkout', '-qb', `story/${id}`, 'main']);
  const metadata = story(id, phase); metadata.integrationTarget.parentBranch = parentBranch;
  f.store.writeStory(id, metadata);
  if (conflict) writeFileSync(join(f.root, 'conflict.txt'), 'story\n');
  git(f.root, ['add', '.']); git(f.root, ['commit', '-qm', `fixture ${id}`]);
  git(f.root, ['checkout', '-q', 'main']);
}
function observe(f) {
  const trace = join(sandbox, `trace-${Math.random().toString(16).slice(2)}.jsonl`);
  const previous = process.env.GIT_TRACE2_EVENT; process.env.GIT_TRACE2_EVENT = trace;
  let rows, elapsedMs;
  try { const start = performance.now(); rows = detectPartialDoneStories(f.root, f.store); elapsedMs = performance.now() - start; }
  finally { if (previous === undefined) delete process.env.GIT_TRACE2_EVENT; else process.env.GIT_TRACE2_EVENT = previous; }
  const events = readFileSync(trace, 'utf8').trim().split('\n').map(x => JSON.parse(x));
  const calls = events.filter(x => x.event === 'start').map(x => x.argv.slice(1));
  return { rows, elapsedMs, gitStarts: calls.length, showRefCalls: calls.filter(x => x[0] === 'show-ref').length,
    branchEnumerations: calls.filter(x => x[0] === 'for-each-ref').length };
}
try {
  const f = init('behavior', 3);
  branchStory(f, 'B-pending'); branchStory(f, 'B-conflict', 'DONE', true); branchStory(f, 'B-active', 'REVIEW');
  branchStory(f, 'B-merged'); git(f.root, ['merge', '--no-edit', 'story/B-merged']);
  writeFileSync(join(f.root, 'conflict.txt'), 'main\n'); git(f.root, ['add', 'conflict.txt']); git(f.root, ['commit', '-qm', 'make actual merge conflict']);
  const before = git(f.root, ['rev-parse', 'HEAD']);
  let found = observe(f);
  check(JSON.stringify(found.rows.map(x => x.storyId)) === JSON.stringify(['B-conflict', 'B-pending']), 'unmerged DONE only, sorted, including branch-only metadata');
  check(found.rows.find(x => x.storyId === 'B-conflict').mergeTreeClean === false, 'actual merge conflict retained');
  check(found.rows.find(x => x.storyId === 'B-pending').mergeTreeClean === true, 'clean recovery candidate retained');
  check(renderPartialDoneSummary(found.rows).join('\n').includes('done_recover'), 'actionable recovery guidance');
  check(git(f.root, ['rev-parse', 'HEAD']) === before, 'scan cannot merge or move HEAD');
  check(git(f.root, ['status', '--porcelain']) === '', 'scan preserves clean tracked state');
  git(f.root, ['branch', '-D', 'story/B-pending']);
  check(!observe(f).rows.some(x => x.storyId === 'B-pending'), 'deleted branch disappears next scan');
  branchStory(f, 'B-new');
  check(observe(f).rows.some(x => x.storyId === 'B-new'), 'new branch appears next scan; no cross-call cache');
  const wt = join(sandbox, 'registered-story'); git(f.root, ['worktree', 'add', '-q', wt, 'story/B-new']);
  const registered = observe(f).rows.find(x => x.storyId === 'B-new');
  check(registered.worktreeRegistered && registered.worktreeExists && realpathSync(registered.worktreePath) === realpathSync(wt), 'worktree identity retained');
  git(f.root, ['worktree', 'remove', wt]);
  const orphan = init('orphan', 0, 'story/B-orphan'); orphan.store.writeStory('B-orphan', story('B-orphan', 'DONE', false));
  git(orphan.root, ['add', '.']); git(orphan.root, ['commit', '-qm', 'unresolved target']);
  check(observe(orphan).rows[0]?.reason.includes('cannot be resolved'), 'unknown integration target still reported');
  // A failed branch enumeration must preserve the old stored-ID fallback.
  const fallback = init('fallback'); fallback.store.writeStory('B-fallback', story('B-fallback'));
  git(fallback.root, ['add', '.']); git(fallback.root, ['commit', '-qm', 'stored candidate']);
  git(fallback.root, ['branch', 'story/B-fallback']);
  git(fallback.root, ['commit', '--allow-empty', '-qm', 'main advances']);
  git(fallback.root, ['checkout', '-q', 'story/B-fallback']);
  writeFileSync(join(fallback.root, 'payload.txt'), 'unmerged'); git(fallback.root, ['add', '.']);git(fallback.root, ['commit', '-qm', 'candidate diverges']);git(fallback.root, ['checkout', '-q', 'main']);
  git(fallback.root, ['tag', 'story/B-fallback', 'refs/heads/story/B-fallback']);
  check(observe(fallback).rows.some(x => x.storyId === 'B-fallback'),
    'RECOVERY_REF_AMBIGUITY_RED: same-name tag must not hide a stored partial-DONE branch');
  git(fallback.root, ['tag', '-f', 'story/B-fallback', 'main']);
  check(observe(fallback).rows.some(x => x.storyId === 'B-fallback'),
    'tag pointing at main must not replace branch metadata or ancestry');
  git(fallback.root, ['tag', '-d', 'story/B-fallback']);
  git(fallback.root, ['tag', 'main', 'refs/heads/story/B-fallback']);
  check(observe(fallback).rows.some(x => x.storyId === 'B-fallback'),
    'RECOVERY_TARGET_AMBIGUITY_RED: integration tag must not hide an unmerged Story');
  git(fallback.root, ['tag', '-d', 'main']);
  const bin = join(sandbox, 'bin');mkdirSync(bin);
  writeFileSync(join(bin, 'git'), '#!/bin/sh\nif [ "$1" = "for-each-ref" ]; then exit 71; fi\nexec '+JSON.stringify(realGit)+' "$@"\n');chmodSync(join(bin, 'git'), 0o755);
  const oldPath = process.env.PATH;process.env.PATH=bin+':'+oldPath;
  try { check(observe(fallback).rows.some(x => x.storyId === 'B-fallback'), 'enumeration failure does not silently lose known partial-DONE'); }
  finally { process.env.PATH=oldPath; }
  const formats = init('target-formats');
  branchStory(formats, 'B-qualified', 'DONE', false, 'refs/heads/main');
  branchStory(formats, 'B-remote-qualified', 'DONE', false, 'refs/remotes/origin/main');
  branchStory(formats, 'B-missing-parent', 'DONE', false, 'missing-parent');
  git(formats.root, ['tag', 'missing-parent', 'refs/heads/story/B-missing-parent']);
  const formatRows = observe(formats).rows;
  check(formatRows.find(x => x.storyId === 'B-qualified')?.mergeTreeClean === true, 'qualified local target resolves without double prefix');
  check(formatRows.find(x => x.storyId === 'B-remote-qualified')?.mergeTreeClean === true, 'repository ref normalization selects the local integration branch');
  check(formatRows.find(x => x.storyId === 'B-missing-parent')?.reason.includes('cannot be resolved'), 'tag-only target is not a local integration branch');
  const samples=[];
  for(const archived of [0,40,200]) {
    const fixture=init('measure-'+archived,archived);branchStory(fixture,'B-target');
    // Unscored warmup; this experiment is a warm filesystem stratum, not a cold-cache claim.
    observe(fixture);
    for(let repetition=0;repetition<repeats;repetition++) {
      const x=observe(fixture);check(x.rows.length===1 && x.rows[0].storyId==='B-target','measurement verdict parity');
      samples.push({archived,repetition,...x,rows:undefined});
    }
  }
  const packageScripts = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).scripts;
  check(packageScripts['test:benchmark-framework-hardening'] === 'node scripts/verify-benchmark-framework-hardening.mjs', 'existing npm regression entry remains registered');
  const parentDriver = readFileSync(new URL('./verify-benchmark-framework-hardening.mjs', import.meta.url), 'utf8');
  const driverTree = ts.createSourceFile('driver.mjs', parentDriver, ts.ScriptTarget.Latest, true);
  const wired = driverTree.statements.some(statement => ts.isVariableStatement(statement) && statement.declarationList.declarations.some(declaration => {
    const call = declaration.initializer;
    return call && ts.isCallExpression(call) && call.expression.getText(driverTree) === 'spawnSync'
      && call.arguments[1] && ts.isArrayLiteralExpression(call.arguments[1])
      && call.arguments[1].elements.some(element => ts.isStringLiteral(element) && element.text === 'scripts/verify-done-recovery-scan.mjs');
  }));
  check(wired && ['test:serial-reference-prefix', 'test:serial-reference'].some(key => packageScripts[key].split(' && ').includes('npm run test:benchmark-framework-hardening')), 'existing full-suite driver must execute recovery guard');
  console.log('RECOVERY_SCAN_DATA '+JSON.stringify({node:process.version,sourceRef,repeats,checks,samples}));
  if(!measureOnly) assert(samples.every(x=>x.showRefCalls<=1), 'RECOVERY_SCAN_RED: archived Stories trigger redundant show-ref processes after branch enumeration');
  console.log(measureOnly ? 'RECOVERY_SCAN_MEASURED observation only; operation budget not asserted' : 'RECOVERY_SCAN_GREEN behavior controls and live Git process budget passed');
} finally { rmSync(sandbox,{recursive:true,force:true}); }

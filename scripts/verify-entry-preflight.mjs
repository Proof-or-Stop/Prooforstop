import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const repository = fileURLToPath(new URL('../', import.meta.url));
const script = join(repository, 'scripts/entry-preflight.mjs');
assert.ok(existsSync(script), 'U14 dependency-free entry preflight must be available');
const root = mkdtempSync(join(tmpdir(), 'entry-preflight-'));
const write = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value)); };
function snapshot(path) {
  const hash = createHash('sha256');
  function walk(dir) { for (const item of readdirSync(dir, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) {
    const file = join(dir, item.name); hash.update(file);
    if (item.isDirectory()) walk(file); else if (item.isFile()) hash.update(readFileSync(file));
  } }
  walk(path); return hash.digest('hex');
}
function run(entry, project, storyId) {
  const before = snapshot(root);
  const result = spawnSync(process.execPath, [entry, '--root', project, '--json', ...(storyId ? ['--storyId', storyId] : [])],
    { cwd: project, encoding: 'utf8', timeout: 45000, maxBuffer: 2 * 1024 * 1024 });
  assert.ok([0,1].includes(result.status), `${result.error ?? ''}\n${result.stderr}`);
  assert.ok(result.stdout.trim(), `entry preflight must print its report: ${result.stderr}`);
  const report = JSON.parse(result.stdout);
  assert.equal(snapshot(root), before, 'preflight cannot alter project files, Story artifacts or installed packages');
  assert.equal(report.diagnosticOnly, true);
  assert.equal(report.writesEvidence, false);
  assert.equal(report.advancesPhase, false);
  return report;
}
const status = (report, id) => report.rows.find(row => row.id === id)?.status;
try {
  const cold = join(root, 'cold');
  const coldScript = join(cold, 'scripts/entry-preflight.mjs');
  write(coldScript, readFileSync(script, 'utf8'));
  write(join(cold, 'packages/main/package.json'), { name: 'cold-runtime', dependencies: { 'missing-preflight-fixture-package': '1' } });
  write(join(cold, 'proof-or-stop.config.json'), '{broken');
  write(join(cold, '.git'), 'gitdir: absent-worktree\n');
  mkdirSync(join(cold, 'absent-worktree'));
  const broken = run(coldScript, cold);
  assert.equal(status(broken, 'config-syntax'), 'BLOCKED');
  assert.equal(status(broken, 'git-pointer'), 'BLOCKED');
  assert.ok(broken.rows.some(row => row.id.includes('missing-preflight-fixture-package') && row.status === 'BLOCKED'));
  assert.ok(broken.rows.some(row => row.id.startsWith('build:') && row.status === 'BLOCKED'));
  assert.equal(status(broken, 'runtime-checks'), 'UNAVAILABLE');
  assert.equal(broken.diagnosticsReady, false);
  const core = join(cold, 'packages/main');
  write(join(core, 'package.json'), { name: 'cold-runtime', dependencies: { 'import-only': '1', 'subpath-only': '1' } });
  for (const name of ['import-only', 'subpath-only']) {
    write(join(cold, 'node_modules', name, 'package.json'), { name, type: 'module', exports: name === 'import-only' ? { import: './index.js' } : { './api': './index.js' } });
    write(join(cold, 'node_modules', name, 'index.js'), 'throw new Error("preflight must not execute dependency code");');
  }
  const installed = run(coldScript, cold);
  for (const name of ['import-only', 'subpath-only']) assert.equal(status(installed, `dependency:${realpathSync(core)}:${name}`), 'PASS', 'inherited ESM or subpath-only package is installed without executing it');

  const project = join(root, 'project');
  write(join(project, 'proof-or-stop.config.json'), { storyDir: '.proof-or-stop/story/actives', scanRoot: 'src', rootDir: '.' });
  write(join(project, 'package.json'), { name: 'external-preflight-fixture', type: 'module' });
  write(join(project, 'src/present.ts'), 'export const present = true;\n');
  const { StoryStore } = await import(new URL('../packages/main/dist/core/store.js', import.meta.url));
  const store = new StoryStore(project), storyId = 'B-entry-preflight';
  store.writeStory(storyId, { storyId, name: 'entry-preflight', title: 'Entry diagnostics fixture', description: 'Disposable read-only diagnostic fixture.', phase: 'PLAN', priority: 'medium', createdAt: new Date().toISOString() });
  store.writeChecklist(storyId, { items: [{ id: 'CHK-001', title: 'Inspect existing and future files', status: 'pending', files: { modify: ['src/present.ts'], create: ['src/future.ts'], test: ['tests/future.test.ts'] } }] });
  store.writeUnderstanding(storyId, { task: 'Read-only entry check', outcome: 'All independent problems are reported', facts: [], constraints: [], unknowns: [], touchpoints: ['src/present.ts', 'src/future.ts'] });
  const baseline = run(script, project, storyId);
  assert.equal(status(baseline, 'touchpoint-coverage'), 'PASS', JSON.stringify(baseline));
  assert.equal(status(baseline, 'path:CHK-001:create:src/future.ts'), 'PASS');
  assert.equal(status(baseline, 'path:CHK-001:test:tests/future.test.ts'), 'PASS');
  assert.ok(!baseline.rows.some(row => row.status === 'BLOCKED' || row.status === 'UNAVAILABLE'), JSON.stringify(baseline));
  const checklist = store.readChecklist(storyId);
  checklist.items[0].files.modify = ['src/missing.ts', '../escape.ts', 'outside/secret.ts', '.', 'broken-link/future.ts'];
  store.writeChecklist(storyId, checklist);
  symlinkSync(root, join(project, 'outside'));
  symlinkSync(join(root, 'absent'), join(project, 'broken-link'));
  const brokenPlan = run(script, project, storyId);
  assert.equal(status(brokenPlan, 'path:CHK-001:modify:src/missing.ts'), 'BLOCKED');
  assert.equal(status(brokenPlan, 'path:CHK-001:modify:../escape.ts'), 'BLOCKED');
  assert.equal(status(brokenPlan, 'path:CHK-001:modify:outside/secret.ts'), 'BLOCKED');
  assert.equal(status(brokenPlan, 'path:CHK-001:modify:.'), 'BLOCKED');
  assert.equal(status(brokenPlan, 'path:CHK-001:modify:broken-link/future.ts'), 'BLOCKED');
  assert.equal(status(brokenPlan, 'touchpoint_uncovered'), 'BLOCKED');
  const mixed = structuredClone(checklist);
  mixed.items.unshift({id:'CHK-MALFORMED',files:{modify:[123, 'src/also-missing.ts'],create:'invalid'}});
  store.writeChecklist(storyId, mixed);
  const mixedPlan = run(script, project, storyId);
  assert.equal(status(mixedPlan, 'checklist-shape'), 'BLOCKED');
  assert.equal(status(mixedPlan, 'path:CHK-001:modify:src/missing.ts'), 'BLOCKED',
    'U14 malformed sibling must not hide independent path blockers');
  assert.equal(status(mixedPlan, 'path:CHK-001:modify:../escape.ts'), 'BLOCKED');
  assert.equal(status(mixedPlan, 'path:CHK-MALFORMED:modify:src/also-missing.ts'), 'BLOCKED');
  assert.equal(status(mixedPlan, 'touchpoint_uncovered'), 'BLOCKED');
  store.writeChecklist(storyId, checklist);
  const gitProject = join(root, 'git-project'), worktree = join(gitProject, 'worktree');
  write(join(gitProject, 'proof-or-stop.config.json'), { storyDir: '.proof-or-stop/story/actives' });
  write(join(gitProject, 'seed.txt'), 'worktree fixture');
  const gitStore = new StoryStore(gitProject), gitStoryId = 'B-entry-worktree';
  gitStore.writeStory(gitStoryId, { storyId: gitStoryId, phase: 'PLAN', worktree: { path: worktree, branch: 'codex/entry-preflight-fixture' } });
  gitStore.writeChecklist(gitStoryId, { items: [] });
  const git = (...args) => execFileSync('git', args, { cwd: gitProject, stdio: 'pipe' });
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Entry Fixture'); git('config', 'user.email', 'entry@example.invalid');
  git('add', '.'); git('commit', '-qm', 'entry preflight fixture');
  git('worktree', 'add', '-b', 'codex/entry-preflight-fixture', worktree);
  const wrongRoot = run(script, gitProject, gitStoryId);
  assert.equal(status(wrongRoot, 'story-worktree'), 'PASS', 'the recorded worktree itself is valid');
  assert.equal(status(wrongRoot, 'story-worktree-cwd'), 'BLOCKED', 'PLAN entry from main must be distinguished from valid worktree registration');
  const correctRoot = run(script, worktree, gitStoryId);
  assert.equal(status(correctRoot, 'story-worktree-cwd'), 'PASS');

  // Re-export actual core readers into a deliberately incomplete runtime. The
  // missing INIT module must not erase independently available path diagnostics.
  write(join(core, 'package.json'), { name: 'partial-runtime', type: 'module' });
  for (const name of ['store', 'config', 'lifecycle-registry', 'plan-touchpoint-coverage', 'acceptance-topology', 'worktree-runtime']) {
    write(join(core, `dist/core/${name}.js`), `export * from ${JSON.stringify(pathToFileURL(join(repository, `packages/main/dist/core/${name}.js`)).href)};\n`);
  }
  store.writeStory(storyId, { ...store.readStory(storyId), phase: 'INIT' });
  const partial = run(coldScript, project, storyId);
  assert.equal(status(partial, 'story-shape'), 'PASS');
  assert.equal(status(partial, 'init-prerequisites'), 'UNAVAILABLE');
  assert.equal(status(partial, 'path:CHK-001:modify:../escape.ts'), 'BLOCKED');
  assert.ok(status(partial, 'story-worktree'), 'later worktree diagnostics survive the missing INIT module');
  store.writeStory(storyId, { ...store.readStory(storyId), phase: 'PLNA' });
  const invalidPhase = run(script, project, storyId);
  assert.equal(status(invalidPhase, 'story-shape'), 'BLOCKED', 'an unknown phase cannot bypass INIT and worktree diagnostics');
  assert.equal(status(invalidPhase, 'path:CHK-001:modify:../escape.ts'), 'BLOCKED');
  const before = snapshot(root);
  const refused = spawnSync(process.execPath, [script, '--root', project, '--apply'], { cwd: project, encoding: 'utf8' });
  assert.equal(refused.status, 1); assert.equal(snapshot(root), before);
  console.log('PASS U14 entry preflight collects independent failures without writes or dependency execution');
} finally { rmSync(root, { recursive: true, force: true }); }

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  for (const name of ['import-only', 'subpath-only']) assert.equal(status(installed, `dependency:${core}:${name}`), 'PASS', 'inherited ESM or subpath-only package is installed without executing it');

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
  checklist.items[0].files.modify = ['src/missing.ts', '../escape.ts', 'outside/secret.ts'];
  store.writeChecklist(storyId, checklist);
  symlinkSync(root, join(project, 'outside'));
  const brokenPlan = run(script, project, storyId);
  assert.equal(status(brokenPlan, 'path:CHK-001:modify:src/missing.ts'), 'BLOCKED');
  assert.equal(status(brokenPlan, 'path:CHK-001:modify:../escape.ts'), 'BLOCKED');
  assert.equal(status(brokenPlan, 'path:CHK-001:modify:outside/secret.ts'), 'BLOCKED');
  assert.equal(status(brokenPlan, 'touchpoint_uncovered'), 'BLOCKED');
  const before = snapshot(root);
  const refused = spawnSync(process.execPath, [script, '--root', project, '--apply'], { cwd: project, encoding: 'utf8' });
  assert.equal(refused.status, 1); assert.equal(snapshot(root), before);
  console.log('PASS U14 entry preflight collects independent failures without writes or dependency execution');
} finally { rmSync(root, { recursive: true, force: true }); }

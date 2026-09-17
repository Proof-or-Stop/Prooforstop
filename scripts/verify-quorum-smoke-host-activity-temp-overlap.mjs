#!/usr/bin/env node
// Lab quorum-smoke-host-activity-temp-overlap RED/GREEN.
//
// Bug: the quorum smoke's ambient temp check refused whenever the temp parent
// CONTAINS any registered worktree of the repository. A managed review that
// registered a worktree under the shared TMPDIR made every quorum smoke refuse at
// startup ("ambient temp parent overlaps the repository or git common directory"),
// although a fresh mkdtemp child cannot write inside that sibling worktree.
//
// The originally recorded RED also covered a second symptom observed the same day:
// a real run with 73/73 cases passing was reported FAIL because the operator's host
// tool-logging hook appended to the gitignored activity log in the same worktree. An
// exemption for those appends was implemented and then withdrawn: comparing a file
// before and after cannot distinguish an append from a destructive rewrite followed
// by an append, so any such exemption can hide a real mutation. The guard therefore
// stays fail-closed - every observed write inside a protected root is a mutation -
// and host logging is kept out of the repository during a validation by the sibling
// Lab host-activity-log-during-validation. The controls below pin that fail-closed
// behavior so no future change reintroduces a content-based exemption.
import { execFileSync, spawnSync } from 'node:child_process';
import fs, { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MARKER = 'quorum smoke refuses host activity log appends or a temp parent that merely contains a worktree';
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(repoRoot, 'packages/main/dist');
const build = spawnSync('npm', ['--prefix', 'packages/main', 'run', 'build'], { cwd: repoRoot, encoding: 'utf8' });
if (build.status !== 0) { process.stderr.write(`${build.stdout}\n${build.stderr}\n`); throw new Error('packages/main build failed; this is not the target RED'); }
// macOS FSEvents delivery is asynchronous and can stall on a loaded machine, so the
// guard's watcher is replaced by a controllable fake that delivers exactly the events
// a real write produces. The guard's own decision logic is unchanged.
const fakeWatchers = [];
fs.watch = (path, _options, listener) => {
  const emitter = new EventEmitter();
  emitter.close = () => { emitter.closed = true; };
  fakeWatchers.push({ path, listener, emitter });
  return emitter;
};
syncBuiltinESMExports();
const { createQuorumSmokeProtectedMutationGuard } = await import(`file://${join(dist, 'tasks/quorum-submit-smoke-worker.js')}`);
const emit = (root, relative, eventType = 'change') => {
  for (const watcher of fakeWatchers) if (watcher.path === root && !watcher.emitter.closed) watcher.listener(eventType, relative);
};

const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'pos-quorum-guard-')));
const red = [];
let checks = 0;
const expectRepaired = (ok, message) => { if (ok) checks++; else red.push(message); };
const control = (ok, message) => { if (!ok) throw new Error(`control failed (not the target RED): ${message}`); checks++; };
const git = (cwd, args) => execFileSync('git', ['-c', 'user.name=Guard Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
let n = 0;
function repo() {
  const root = join(sandbox, `repo-${n++}`); mkdirSync(root);
  git(root, ['init', '-q']);
  writeFileSync(join(root, '.gitignore'), '**/activity.jsonl\n');
  mkdirSync(join(root, 'src')); writeFileSync(join(root, 'src/app.ts'), 'export const x = 1;\n');
  mkdirSync(join(root, 'docs/story/actives/B-x'), { recursive: true });
  writeFileSync(join(root, 'docs/story/activity.jsonl'), '{"line":0}\n');
  git(root, ['add', '.']); git(root, ['commit', '-qm', 'base']);
  return root;
}
async function guarded(action) {
  const root = repo();
  const guard = createQuorumSmokeProtectedMutationGuard([root]);
  for (const relative of action(root)) emit(root, relative);
  return guard.close();
}
const rows = [];
try {
  // Fail-closed controls: every observed write inside a protected root stays a mutation,
  // including an append to a gitignored host activity log.
  const appends = await guarded((root) => {
    appendFileSync(join(root, 'docs/story/activity.jsonl'), '{"line":1}\n');
    mkdirSync(join(root, '.proof-or-stop'), { recursive: true });
    appendFileSync(join(root, '.proof-or-stop/activity.jsonl'), '{"line":1}\n');
    appendFileSync(join(root, 'docs/story/actives/B-x/activity.jsonl'), '{"line":1}\n');
    return ['docs/story/activity.jsonl', '.proof-or-stop/activity.jsonl', 'docs/story/actives/B-x/activity.jsonl'];
  });
  rows.push({ scenario: 'control: host activity log appends', clean: appends.clean, paths: appends.paths.length });
  control(appends.clean === false && appends.paths.length === 3, `an append to a host activity log is still a mutation (clean ${appends.clean}, paths ${appends.paths.length})`);
  const source = await guarded((root) => { writeFileSync(join(root, 'src/app.ts'), 'export const x = 2;\n'); return ['src/app.ts']; });
  rows.push({ scenario: 'control: tracked source write', clean: source.clean, paths: source.paths.length });
  control(source.clean === false, 'a tracked source write is still a mutation');
  const untouched = await guarded(() => []);
  rows.push({ scenario: 'control: no write at all', clean: untouched.clean, paths: untouched.paths.length });
  control(untouched.clean === true && untouched.paths.length === 0, 'a run that writes nothing is clean');

  // The repair: a temp parent that merely CONTAINS a registered worktree.
  const smoke = join(dist, 'tasks/quorum-submit-smoke.js');
  const repoForTemp = repo();
  const tempWithWorktree = join(sandbox, 'tmp-with-worktree'); mkdirSync(tempWithWorktree);
  git(repoForTemp, ['worktree', 'add', '-q', '--detach', join(tempWithWorktree, 'wt')]);
  const refused = (out) => /ambient temp parent overlaps the repository or git common directory/.test(out);
  const run = (tmp) => { const r = spawnSync(process.execPath, [smoke, '--case=qsm-002'], { cwd: repoForTemp, env: { ...process.env, TMPDIR: tmp }, encoding: 'utf8' }); return `${r.stdout}\n${r.stderr}`; };
  const runJson = (out) => { const line = out.split('\n').find((l) => l.startsWith('QUORUM_SMOKE_RUN_JSON ')); return line ? JSON.parse(line.slice('QUORUM_SMOKE_RUN_JSON '.length)) : null; };
  const outcome = (json) => json ? JSON.stringify(json.results.map((r) => [r.caseId, r.status])) : 'no run record';
  // Baseline: the same fixture repository with an ordinary temp parent. In a fixture
  // repository the case body itself does not pass; the comparison isolates the temp
  // decision from that unrelated outcome.
  const ordinaryTemp = join(sandbox, 'tmp-ordinary'); mkdirSync(ordinaryTemp);
  const baseline = runJson(run(ordinaryTemp));
  control(baseline !== null && !refused(JSON.stringify(baseline)), 'baseline run with an ordinary temp parent produces a run record');
  const containingOut = run(tempWithWorktree);
  const containing = runJson(containingOut);
  const base = containing?.fixtureSummary?.ownedTempBase ?? null;
  rows.push({ scenario: 'temp parent contains a registered worktree', clean: refused(containingOut) ? 'refused' : `allocated ${base ? 'under temp parent' : 'nothing'}; outcome ${outcome(containing)} (baseline ${outcome(baseline)})`, paths: '-' });
  expectRepaired(!refused(containingOut), 'a temp parent that only contains a sibling worktree must not be refused');
  expectRepaired(typeof base === 'string' && base.startsWith(`${tempWithWorktree}/`) && !base.startsWith(`${join(tempWithWorktree, 'wt')}/`),
    `the owned temp base is allocated under that parent and outside the sibling worktree (got ${base})`);
  expectRepaired(containing?.protectedMutationGuard?.clean === true, 'the run observes no protected mutation');
  expectRepaired(containing !== null && outcome(containing) === outcome(baseline), `case outcome matches the ordinary-temp baseline (got ${outcome(containing)}, baseline ${outcome(baseline)})`);
  const insideTemp = join(repoForTemp, 'inner-tmp'); mkdirSync(insideTemp);
  const insideOut = run(insideTemp);
  rows.push({ scenario: 'control: temp parent inside the worktree', clean: refused(insideOut) ? 'refused' : 'allowed', paths: '-' });
  control(refused(insideOut), 'a temp parent inside the worktree is still refused');
  control((runJson(insideOut)?.fixtureSummary?.ownedTempBase ?? null) === null, 'a refused run allocates no temp base');
  git(repoForTemp, ['worktree', 'remove', '--force', join(tempWithWorktree, 'wt')]);
} finally {
  rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}
console.log('scenario | guard clean / temp decision | unowned paths');
for (const r of rows) console.log(`${r.scenario} | ${r.clean} | ${r.paths}`);
if (red.length) {
  console.log(`${MARKER} (${red.length} failing expectations, ${checks} passing checks)`);
  for (const line of red) console.log(`  - ${line}`);
  process.exit(1);
}
console.log(`quorum smoke allows a sibling temp worktree and stays fail-closed on repository writes (${checks} checks)`);

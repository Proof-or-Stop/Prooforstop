#!/usr/bin/env node
/**
 * CLI startup must not pay for git subprocesses a command does not need. The
 * benchmark runs the CLI inside an x86-emulated container where every process
 * spawn costs several times the native ~13ms, and a run makes hundreds of CLI
 * calls, so the pre-dispatch probes (runtime entrypoint authority, active-Story
 * branch detection, the git-repository probe) were paid on every call, even
 * `--version`.
 *
 * A spawn-counting preload (wraps every node:child_process entry point and logs
 * command + argv) drives dist/cli.js, per-file graph and bundle, in a fixture
 * consumer project: from the main checkout (branch main) and from a linked Story
 * worktree (branch story/B-sp01). Budgets:
 *   --version, --help               0 spawns at all (main and Story worktree)
 *   story_list, session_brief,      0 startup (pre-dispatch) spawns; the
 *   a phase-gated refusal           handler's own git reads are counted and
 *                                   printed, not budgeted
 * Outcome guards (the same budgets would be trivially met by skipping the
 * checks, so the checks' effects are asserted too):
 *   - --version prints the version line; story_list lists both Stories;
 *   - in the Story worktree the active Story is still detected: help shows it,
 *     and a command outside the DEV allowlist is still refused by the phase gate;
 *   - the file-based branch reader agrees with `git rev-parse --abbrev-ref HEAD`
 *     over a matrix of repository states, or defers to git (never guesses);
 *   - a read-only admission is never `blocked` by the runtime entrypoint
 *     authority classifier (the premise for skipping it), while a Story write
 *     from a foreign self-project runtime still is.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as gitProbe from '../core/git-probe.js';
import { classifyRuntimeEntrypointAuthority } from '../core/runtime-environment-checks.js';

// Resolved dynamically so a runtime without the reader fails this smoke's
// assertions (RED) instead of failing to compile.
const readStoryBranchFromGitFiles = (cwd: string): string | null | undefined => {
  const reader = (gitProbe as Record<string, unknown>).readStoryBranchFromGitFiles;
  if (typeof reader !== 'function') throw new Error('core/git-probe.js exports no readStoryBranchFromGitFiles');
  return (reader as (dir: string) => string | null | undefined)(cwd);
};
const distRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(distRoot, 'cli.js');
const hasBundle = existsSync(join(distRoot, 'cli-direct.bundle.mjs'));
const FIXED_DATE = '2026-01-01T00:00:00Z';
const writeJson = (path: string, data: unknown): void => writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
const gitEnv = { ...process.env, GIT_AUTHOR_DATE: FIXED_DATE, GIT_COMMITTER_DATE: FIXED_DATE };
const git = (cwd: string, args: string[]): string =>
  execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const PRELOAD = `
const cp = require('node:child_process');
const { syncBuiltinESMExports } = require('node:module');
const fs = require('node:fs');
const out = process.env.STARTUP_SPAWN_LOG;
for (const name of ['spawn', 'spawnSync', 'execSync', 'execFileSync', 'exec', 'execFile', 'fork']) {
  const orig = cp[name];
  cp[name] = function (...args) {
    const argv = Array.isArray(args[1]) ? args[1].map(String) : [];
    const stack = String(new Error().stack).split('\\n').slice(2, 14).map(s => s.trim()).join(' <- ');
    fs.appendFileSync(out, JSON.stringify({ fn: name, cmd: String(args[0]), argv, stack }) + '\\n');
    return orig.apply(this, args);
  };
}
syncBuiltinESMExports();
`;

function story(id: string, phase: string): Record<string, unknown> {
  return {
    storyId: id, name: id, title: `${id} title`, description: 'Startup spawn fixture story.',
    type: 'feature', phase, priority: 'high', createdAt: FIXED_DATE, startedAt: FIXED_DATE, endedAt: null,
  };
}

function makeFixture(parent: string): { main: string; worktree: string } {
  const root = join(parent, 'project');
  mkdirSync(root, { recursive: true });
  writeJson(join(root, 'proof-or-stop.config.json'), {
    scanRoot: '.', rootDir: 'src', outDir: 'dist', testsDir: 'tests', fixturesDir: 'tests/fixtures',
    storyDir: '.proof-or-stop/story/actives', requirementsDir: 'docs/requirements', storyPrefix: 'B',
  });
  writeFileSync(join(root, '.gitignore'), 'node_modules\n.worktrees\n');
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'index.ts'), 'export const answer = 42;\n');
  const actives = join(root, '.proof-or-stop', 'story', 'actives');
  for (const [id, phase] of [['B-sp01', 'DEV'], ['B-sp02', 'PLAN']] as const) {
    mkdirSync(join(actives, id), { recursive: true });
    writeJson(join(actives, id, 'index.json'), story(id, phase));
    writeJson(join(actives, id, 'checklist.json'), { items: [] });
  }
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.name', 'Spawn Smoke']);
  git(root, ['config', 'user.email', 'spawn@example.com']);
  git(root, ['add', '.']);
  git(root, ['commit', '-q', '-m', 'init']);
  const worktree = join(root, '.worktrees', 'B-sp01');
  git(root, ['worktree', 'add', '-q', '-b', 'story/B-sp01', worktree]);
  return { main: realpathSync(root), worktree: realpathSync(worktree) };
}

interface Spawn { fn: string; cmd: string; argv: string[]; stack: string }
interface Outcome { status: number | null; stdout: string; stderr: string; spawns: Spawn[] }

function run(temp: string, cwd: string, args: string[], bundle: '0' | 'require'): Outcome {
  const log = join(temp, `spawns-${process.pid}.jsonl`);
  rmSync(log, { force: true });
  const result = spawnSync(process.execPath, ['--require', join(temp, 'spawn-preload.cjs'), cli, ...args], {
    cwd, encoding: 'utf8', timeout: 120_000,
    env: { ...process.env, PROOF_OR_STOP_NO_HOOKS: '1', PROOF_OR_STOP_BUNDLE: bundle, NO_COLOR: '1', STARTUP_SPAWN_LOG: log },
  });
  const spawns = existsSync(log)
    ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as Spawn) : [];
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', spawns };
}

const describe = (spawns: Spawn[]): string =>
  spawns.map(s => `  ${s.fn} ${s.cmd} ${s.argv.join(' ')}\n      at ${s.stack}`).join('\n') || '  (none)';

const failures: string[] = [];
const check = (ok: boolean, message: string): void => { if (!ok) failures.push(message); };
const temp = realpathSync(mkdtempSync(join(tmpdir(), 'proof-or-stop-startup-spawns-')));
const counts: string[] = [];
try {
  writeFileSync(join(temp, 'spawn-preload.cjs'), PRELOAD);
  const { main, worktree } = makeFixture(temp);
  // Startup (pre-dispatch) spawns, identified by the frames that issue them:
  // runtime entrypoint authority, root resolution, active-Story detection and the
  // CLI's own git-repository probe (called from the anonymous runCli body, not
  // from a handler). Handler-level git reads are the handler's business and are
  // only counted, not budgeted.
  const isStartupSpawn = (x: Spawn): boolean =>
    /classifyRuntimeEntrypointAuthority|at detectActiveStory \(|at resolveRoot \(|at resolveRootForCommand \(/.test(x.stack)
    || /at isGitRepository \([^)]*\) <- at file:/.test(x.stack);
  const noStartupSpawns = (s: Spawn[]): string | null => {
    const startup = s.filter(isStartupSpawn);
    return startup.length === 0 ? null : `startup spawns:\n${describe(startup)}`;
  };
  const cases: Array<{ where: string; cwd: string; args: string[]; budget: (s: Spawn[]) => string | null; expect: (o: Outcome) => string | null }> = [];
  for (const [where, cwd] of [['main', main], ['story-worktree', worktree]] as const) {
    cases.push({
      where, cwd, args: ['--version'],
      budget: s => s.length === 0 ? null : 'expected 0 spawns',
      expect: o => o.status === 0 && /^Proof-or-Stop \d+\.\d+\.\d+/.test(o.stdout) ? null : 'version line missing',
    });
    cases.push({
      where, cwd, args: ['--help'],
      budget: s => s.length === 0 ? null : 'expected 0 spawns',
      expect: o => {
        if (o.status !== 0) return `help exited ${o.status}`;
        const shows = o.stdout.includes('Current Story: B-sp01  phase: DEV');
        return shows === (where === 'story-worktree') ? null : `active Story line ${shows ? 'unexpectedly shown' : 'missing'}`;
      },
    });
    cases.push({
      where, cwd, args: ['story_list'],
      budget: noStartupSpawns,
      expect: o => o.status === 0 && o.stdout.includes('B-sp01') && o.stdout.includes('B-sp02') ? null : 'story_list does not list both Stories',
    });
    cases.push({
      where, cwd, args: ['session_brief'],
      budget: noStartupSpawns,
      expect: o => o.status === 0 && o.stdout.length > 0 ? null : 'session_brief failed',
    });
  }
  // Phase gate still sees the active Story (the branch read is the gate's input).
  cases.push({
    where: 'story-worktree', cwd: worktree, args: ['story_create', '--title=x', '--description=y', '--type=feature'],
    // story_create consumes gitReady, so its one git-repository probe is expected.
    budget: s => {
      const startup = s.filter(isStartupSpawn);
      const gitReadyProbes = startup.filter(x => /at isGitRepository \(/.test(x.stack));
      return startup.length === gitReadyProbes.length && gitReadyProbes.length <= 1 ? null : `startup spawns beyond the gitReady probe:\n${describe(startup)}`;
    },
    expect: o => o.status !== 0 && /is not available in DEV phase/.test(o.stderr) ? null : `phase gate did not refuse: ${o.status} ${o.stderr.slice(0, 400)}`,
  });
  const modes: Array<'0' | 'require'> = hasBundle ? ['0', 'require'] : ['0'];
  for (const mode of modes) {
    for (const c of cases) {
      const o = run(temp, c.cwd, c.args, mode);
      const label = `[${mode === '0' ? 'per-file' : 'bundle'}] ${c.where}: ${c.args.join(' ')}`;
      counts.push(`${label} -> ${o.spawns.filter(isStartupSpawn).length} startup / ${o.spawns.length} total spawn(s)`);
      const overBudget = c.budget(o.spawns);
      check(overBudget === null, `${label}: ${overBudget}`);
      const wrong = c.expect(o);
      check(wrong === null, `${label}: ${wrong}\nstdout: ${o.stdout.slice(0, 400)}\nstderr: ${o.stderr.slice(0, 400)}`);
    }
  }

  // The file-based branch reader must agree with git or defer (undefined).
  const gitBranch = (cwd: string): string | null => {
    try { return git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']); } catch { return null; }
  };
  const matrix = join(temp, 'matrix');
  mkdirSync(matrix);
  const repo = (name: string, setup: (dir: string) => void): string => {
    const dir = join(matrix, name);
    mkdirSync(dir, { recursive: true });
    git(dir, ['init', '-q', '-b', 'main']);
    git(dir, ['config', 'user.name', 'm']);
    git(dir, ['config', 'user.email', 'm@example.com']);
    setup(dir);
    return dir;
  };
  const commit = (dir: string): void => { writeFileSync(join(dir, 'f'), String(Math.random())); git(dir, ['add', 'f']); git(dir, ['commit', '-q', '-m', 'c']); };
  const states: Record<string, string> = {
    'main': repo('main', commit),
    'unborn-main': repo('unborn-main', () => undefined),
    'story': repo('story', d => { commit(d); git(d, ['checkout', '-q', '-b', 'story/B-m1']); }),
    'unborn-story': repo('unborn-story', d => { git(d, ['checkout', '-q', '--orphan', 'story/B-m2']); }),
    'packed-story': repo('packed-story', d => { commit(d); git(d, ['checkout', '-q', '-b', 'story/B-m3']); git(d, ['pack-refs', '--all']); }),
    'ambiguous-tag': repo('ambiguous-tag', d => { commit(d); git(d, ['checkout', '-q', '-b', 'story/B-m4']); git(d, ['tag', 'story/B-m4']); }),
    'ambiguous-packed-remote': repo('ambiguous-packed-remote', d => {
      commit(d); git(d, ['checkout', '-q', '-b', 'story/B-m5']);
      git(d, ['update-ref', 'refs/remotes/story/B-m5', 'HEAD']); git(d, ['pack-refs', '--all']);
    }),
    'detached': repo('detached', d => { commit(d); git(d, ['checkout', '-q', '--detach']); }),
    'symref-branch': repo('symref-branch', d => {
      commit(d); git(d, ['branch', 'story/B-m6']); git(d, ['symbolic-ref', 'refs/heads/alias', 'refs/heads/story/B-m6']);
      git(d, ['symbolic-ref', 'HEAD', 'refs/heads/alias']);
    }),
    'subdir': join(repo('subdir', d => { commit(d); git(d, ['checkout', '-q', '-b', 'story/B-m7']); mkdirSync(join(d, 'nested', 'deeper'), { recursive: true }); }), 'nested', 'deeper'),
    'linked-worktree': (() => {
      const d = repo('linked-base', commit);
      git(d, ['worktree', 'add', '-q', '-b', 'story/B-m8', join(matrix, 'linked-worktree')]);
      return join(matrix, 'linked-worktree');
    })(),
    'not-a-repo': (() => { const d = join(tmpdir(), `proof-or-stop-not-repo-${process.pid}`); mkdirSync(d, { recursive: true }); return d; })(),
  };
  // Empty .git directory nested inside a real repo: git skips it and walks up.
  const emptyGit = join(states['story'], 'with-empty-git');
  mkdirSync(join(emptyGit, '.git'), { recursive: true });
  states['empty-dot-git'] = emptyGit;
  // Stale .git file whose target is missing.
  const brokenPointer = join(matrix, 'broken-pointer');
  mkdirSync(brokenPointer);
  writeFileSync(join(brokenPointer, '.git'), 'gitdir: /nonexistent/for/startup/smoke\n');
  states['broken-pointer'] = brokenPointer;
  let decided = 0;
  const readerAvailable = typeof (gitProbe as Record<string, unknown>).readStoryBranchFromGitFiles === 'function';
  check(readerAvailable, 'core/git-probe.js exports no readStoryBranchFromGitFiles (file-based branch reader)');
  for (const [name, dir] of readerAvailable ? Object.entries(states) : []) {
    const fromGit = gitBranch(dir);
    const fromFiles = readStoryBranchFromGitFiles(dir);
    if (fromFiles === undefined) continue; // defers to git: always safe
    decided += 1;
    // The reader answers the only question startup asks: which story/ branch
    // (if any) git would report. null means "git would not report a story/ branch".
    const gitStory = fromGit !== null && fromGit.startsWith('story/') ? fromGit : null;
    check(fromFiles === gitStory, `branch reader ${name}: files=${JSON.stringify(fromFiles)} git=${JSON.stringify(fromGit)}`);
  }
  for (const name of readerAvailable ? ['main', 'story', 'packed-story', 'linked-worktree', 'detached', 'subdir'] : []) {
    check(readStoryBranchFromGitFiles(states[name]) !== undefined, `branch reader must decide the common ${name} case without git`);
  }
  rmSync(states['not-a-repo'], { recursive: true, force: true });

  // Premise of skipping the authority probe for read-only admissions: every
  // blocked branch requires an authoritative runtime. A foreign self-project
  // runtime is the case that blocks a Story write; the same input read-only passes.
  const selfProject = join(temp, 'self');
  mkdirSync(join(selfProject, 'packages', 'main'), { recursive: true });
  writeJson(join(selfProject, 'package.json'), { name: 'proof-or-stop', version: '1.0.0' });
  writeJson(join(selfProject, 'packages', 'main', 'package.json'), { name: '@proof-or-stop/core', version: '1.0.0' });
  git(selfProject, ['init', '-q', '-b', 'main']);
  git(selfProject, ['config', 'user.name', 's']);
  git(selfProject, ['config', 'user.email', 's@example.com']);
  git(selfProject, ['add', '.']);
  git(selfProject, ['commit', '-q', '-m', 'self']);
  const selfWorktree = join(temp, 'self-wt');
  git(selfProject, ['worktree', 'add', '-q', '-b', 'story/B-self', selfWorktree]);
  const foreignRuntime = join(temp, 'foreign-runtime');
  cpSync(join(selfProject, 'packages'), join(foreignRuntime, 'packages'), { recursive: true });
  cpSync(join(selfProject, 'package.json'), join(foreignRuntime, 'package.json'));
  git(foreignRuntime, ['init', '-q', '-b', 'main']);
  const probeInputs = [
    { projectRoot: selfProject, loadedCorePackageRoot: join(foreignRuntime, 'packages', 'main') },
    { projectRoot: selfWorktree, loadedCorePackageRoot: join(selfProject, 'packages', 'main') },
    { projectRoot: selfWorktree, loadedCorePackageRoot: join(foreignRuntime, 'packages', 'main') },
    { projectRoot: join(temp, 'self', 'packages'), loadedCorePackageRoot: join(foreignRuntime, 'packages', 'main') },
  ];
  let blockedWrites = 0;
  for (const input of probeInputs) {
    const base = { command: 'story_advance', commandArgs: [], invokedEntrypoint: null, env: {} };
    const readOnly = classifyRuntimeEntrypointAuthority({ ...base, ...input, requiresAuthoritativeRuntime: false });
    check(readOnly.status !== 'blocked', `read-only admission blocked for ${JSON.stringify(input)}: ${readOnly.detail}`);
    const write = classifyRuntimeEntrypointAuthority({ ...base, ...input, requiresAuthoritativeRuntime: true });
    if (write.status === 'blocked') blockedWrites += 1;
  }
  check(blockedWrites >= 3, `authority classifier must still block Story writes from a foreign/main runtime (blocked ${blockedWrites}/4)`);
  counts.push(`branch reader decided ${decided}/${Object.keys(states).length} matrix states without git`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
console.log(counts.join('\n'));
assert.deepEqual(failures, [], `startup git spawn budget violated:\n${failures.join('\n\n')}`);
console.log(`startup-git-spawns-smoke: PASS (${hasBundle ? 'per-file + bundle' : 'per-file only; no bundle built'})`);

#!/usr/bin/env node
/**
 * The CLI bundle (dist/cli-direct.bundle.mjs, built by scripts/build-cli-bundle.mjs)
 * must behave exactly like the per-file tsc graph it is built from. An esbuild
 * bundle can diverge SILENTLY: every module shares the bundle's import.meta.url
 * (fixed-depth package-root lookups resolve elsewhere; the prompt registry once
 * saw 0 agents and the CLI died at init), cyclic imports read `undefined`
 * instead of throwing, and fail-closed optional loaders quietly return null.
 *
 * A fixture project (fixed git dates, so identical hashes), recreated at the
 * same path before every run, is driven through dist/cli.js with PROOF_OR_STOP_BUNDLE=0 (per-file graph) and
 * PROOF_OR_STOP_BUNDLE=require (bundle, or fail). Exit code, stdout and stderr of
 * a representative set of read-only commands must match after normalizing the
 * fixture root and the elapsed-time log line.
 *
 * Requires a built bundle (node scripts/build-cli-bundle.mjs); without one it
 * reports SKIP, or fails when run with --require-bundle.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const distRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(distRoot, 'cli.js');
const bundle = join(distRoot, 'cli-direct.bundle.mjs');
if (!existsSync(bundle)) {
  // The bundle is an explicit build step, so a plain `npm run build` tree has
  // none; say so loudly. --require-bundle (release/bench checks) turns it into a failure.
  const required = process.argv.includes('--require-bundle');
  console[required ? 'error' : 'log'](`cli-bundle-equivalence-smoke: ${required ? 'FAIL' : 'SKIP'} no bundle at ${bundle}; run node scripts/build-cli-bundle.mjs`);
  process.exit(required ? 1 : 0);
}

const FIXED_DATE = '2026-01-01T00:00:00Z';
const writeJson = (path: string, data: unknown): void => writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
const gitEnv = { ...process.env, GIT_AUTHOR_DATE: FIXED_DATE, GIT_COMMITTER_DATE: FIXED_DATE };
const git = (cwd: string, args: string[]): void => {
  execFileSync('git', args, { cwd, env: gitEnv, stdio: ['ignore', 'pipe', 'pipe'] });
};

function story(id: string, phase: string): Record<string, unknown> {
  return {
    storyId: id, name: id, title: `${id} title`, description: 'Bundle equivalence fixture story.',
    type: 'feature', phase, priority: 'high', createdAt: FIXED_DATE, startedAt: FIXED_DATE, endedAt: null,
  };
}

function makeFixture(parent: string, name: string): string {
  const root = join(parent, name);
  mkdirSync(root, { recursive: true });
  writeJson(join(root, 'proof-or-stop.config.json'), {
    scanRoot: '.', rootDir: 'src', outDir: 'dist', testsDir: 'tests', fixturesDir: 'tests/fixtures',
    storyDir: '.proof-or-stop/story/actives', requirementsDir: 'docs/requirements', storyPrefix: 'B',
  });
  writeFileSync(join(root, '.gitignore'), 'node_modules\n');
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'index.ts'), 'export const answer = 42;\n');
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.name', 'Bundle Smoke']);
  git(root, ['config', 'user.email', 'bundle@example.com']);
  git(root, ['add', '.']);
  git(root, ['commit', '-q', '-m', 'init']);
  const actives = join(root, '.proof-or-stop', 'story', 'actives');
  const dev = join(actives, 'B-eqv1');
  mkdirSync(dev, { recursive: true });
  writeJson(join(dev, 'index.json'), story('B-eqv1', 'DEV'));
  writeFileSync(join(dev, 'background.md'), '# Background\n\nBundle equivalence fixture.\n');
  writeJson(join(dev, 'checklist.json'), {
    items: [
      { id: 'CHK-001', title: 'Done item', status: 'done', startTime: null, endTime: null },
      { id: 'CHK-002', title: 'Pending item', status: 'pending', startTime: null, endTime: null },
    ],
  });
  const plan = join(actives, 'B-eqv2');
  mkdirSync(plan, { recursive: true });
  writeJson(join(plan, 'index.json'), story('B-eqv2', 'PLAN'));
  writeJson(join(plan, 'checklist.json'), { items: [] });
  return realpathSync(root);
}

interface Outcome { status: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }

function run(root: string, args: string[], mode: '0' | 'require'): Outcome {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, PROOF_OR_STOP_NO_HOOKS: '1', PROOF_OR_STOP_BUNDLE: mode, NO_COLOR: '1' },
  });
  const normalize = (text: string): string => text
    .split(root).join('<ROOT>')
    .replace(/\[\d+(?:\.\d+)?m?s\] /g, '[<ELAPSED>] ');
  return { status: result.status, signal: result.signal, stdout: normalize(result.stdout ?? ''), stderr: normalize(result.stderr ?? '') };
}

// Read-only commands: the bin surface, help pages, and project/story views.
const COMMANDS: string[][] = [
  ['--version'],
  ['--help'],
  ['help'],
  ['story_list'],
  ['story_list', '--json'],
  ['session_brief'],
  ['status'],
  ['checklist_get', '--storyId=B-eqv1'],
  ['milestone_status', '--storyId=B-eqv1'],
  ['finding_list', '--storyId=B-eqv1'],
  ['next', '--storyId=B-eqv1'],
  ['next', '--storyId=B-eqv1', '--json'],
  ['next', '--help'],
  ['bug_list'],
  ['story_list', '--help'],
  ['session_brief', '--help'],
  ['checklist_update', '--help'],
  ['validate', '--help'],
  ['host_run_status', '--help'],
  ['review_inventory_finalize', '--help'],
  ['certification_window_status', '--help'],
  ['no_such_command_for_bundle_smoke'],
];

const temp = mkdtempSync(join(tmpdir(), 'proof-or-stop-bundle-eqv-'));
const failures: string[] = [];
try {
  // A fresh fixture at the SAME path for every run: digests that fold in the
  // project root stay comparable, and no run can see state another run wrote.
  const inFreshFixture = (args: string[], mode: '0' | 'require'): Outcome => {
    const root = makeFixture(temp, 'project');
    try { return run(root, args, mode); } finally { rmSync(root, { recursive: true, force: true }); }
  };
  for (const args of COMMANDS) {
    const unbundled = inFreshFixture(args, '0');
    const bundled = inFreshFixture(args, 'require');
    const label = args.join(' ');
    if (unbundled.signal) failures.push(`${label}: per-file run killed by ${unbundled.signal}`);
    for (const key of ['status', 'signal', 'stdout', 'stderr'] as const) {
      if (unbundled[key] !== bundled[key]) {
        failures.push(`${label}: ${key} differs\n--- per-file ---\n${String(unbundled[key]).slice(0, 1500)}\n--- bundle ---\n${String(bundled[key]).slice(0, 1500)}`);
      }
    }
  }
  assert.deepEqual(failures, [], `bundle diverges from the per-file graph:\n${failures.join('\n\n')}`);
  const version = inFreshFixture(['--version'], 'require');
  assert.match(version.stdout, /^Proof-or-Stop \d+\.\d+\.\d+/, `bundled --version: ${version.stdout}${version.stderr}`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
console.log(`cli-bundle-equivalence-smoke: PASS (${COMMANDS.length} commands identical per-file vs bundle)`);

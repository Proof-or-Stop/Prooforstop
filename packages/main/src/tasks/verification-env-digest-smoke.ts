#!/usr/bin/env node
/**
 * Lab verification-env-digest. The environment digest bound into verification
 * receipts hashed the whole ambient process environment (minus a short
 * session/transport strip-list). An owner that ran the same pinned command from
 * another terminal, a wider window, tmux, ssh, or a wrapper that exports its
 * own trace variable got every receipt marked `verification_receipt_stale
 * (environment_digest_changed)` and had to replay each pinned intent; on the
 * benchmark one added PATH entry staled every receipt at once.
 *
 * Real CLI on a temp project: record pinned receipts with one environment, then
 * ask `verification_evidence_refresh_stale --dryRun` from a changed environment.
 *   - shell/terminal bookkeeping and unrelated wrapper variables -> still fresh;
 *   - anything that can change what the command does -> stale: a PATH change
 *     that resolves a different toolchain binary, the project's validate.env,
 *     GOFLAGS/NODE_OPTIONS/LANG/TZ, and a variable the pinned command names.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REAL_CLI, write, git } from './verification-run-and-guard/support.js';
import { StoryStore } from '../core/store.js';
import { prepareVerificationExecutionIdentity } from '../core/verification-execution-evidence.js';

const STORY = 'B-envdig';
const I1_CMD = `node -e "console.log('MARKER_OK')"`;
// Names the variable it reads; its value must stay part of the identity.
const I2_CMD = `node -e "console.log(process.env.ENVDIG_FLAG === undefined ? 'MARKER_OK' : 'MARKER_OK '+process.env.ENVDIG_FLAG)"`;
const RECORD_CLI = process.env.ENVDIG_RECORD_CLI || REAL_CLI;

const root = mkdtempSync(join(tmpdir(), 'verification-env-digest-'));
const scratch = mkdtempSync(join(tmpdir(), 'verification-env-digest-bin-'));
const config = (context: string) => JSON.stringify({
  scanRoot: 'packages/main', rootDir: 'src', storyDir: '.proof-or-stop/story/actives',
  requirementsDir: 'docs/requirements', validate: { env: { CONTEXT: context } },
});
write(root, 'proof-or-stop.config.json', config('abs'));
write(root, 'packages/main/package.json', JSON.stringify({ name: 'envdig-fixture', version: '0.0.0' }));
write(root, 'packages/main/src/base.ts', 'export const base = true;\n');
write(root, '.gitignore', '.proof-or-stop/evidence/\n.proof-or-stop/runtime/\n.proof-or-stop/locks/\n');
git(root, ['init', '-q', '-b', 'work']);
git(root, ['config', 'user.email', 'envdig@example.test']);
git(root, ['config', 'user.name', 'envdig']);
git(root, ['add', '.']);
git(root, ['commit', '-qm', 'seed']);
git(root, ['branch', 'main']);
const at = '2026-09-30T00:00:00.000Z';
const store = new StoryStore(root);
store.writeStory(STORY, { storyId: STORY, name: 'envdig', title: 'environment digest', description: 'fixture', type: 'chore', phase: 'DEV', priority: 'medium', createdAt: at, startedAt: at, endedAt: null });
store.writeChecklist(STORY, { items: [{
  id: 'CHK-001', title: 'environment digest', context: 'fixture', status: 'in_progress', startTime: null, endTime: null,
  verificationIntent: { happy: [
    { id: 'I1', desc: 'plain marker', type: 'cli', priority: 'must' },
    { id: 'I2', desc: 'marker that reads ENVDIG_FLAG', type: 'cli', priority: 'must' },
  ], edge: [], adversarial: [] },
}] });

// A directory on PATH that shadows nothing, and two that shadow a toolchain binary.
const emptyBin = join(scratch, 'empty-bin'); mkdirSync(emptyBin);
const shadowGit = join(scratch, 'shadow-git'); mkdirSync(shadowGit);
writeFileSync(join(shadowGit, 'git'), '#!/bin/sh\nexec /usr/bin/git "$@"\n'); chmodSync(join(shadowGit, 'git'), 0o755);
const shadowNode = join(scratch, 'shadow-node'); mkdirSync(shadowNode);
writeFileSync(join(shadowNode, 'node'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} "$@"\n`); chmodSync(join(shadowNode, 'node'), 0o755);

const basePath = process.env.PATH ?? '/usr/bin:/bin';
const base: Record<string, string> = {
  PATH: basePath,
  HOME: process.env.HOME ?? root,
  LANG: 'en_US.UTF-8',
  SHLVL: '1', _: '/usr/bin/env', OLDPWD: '/', PWD: root,
  TERM: 'xterm-256color', TERM_PROGRAM: 'Apple_Terminal', TERM_PROGRAM_VERSION: '455',
  TERM_SESSION_ID: 'w0t0p0:AAAA', COLUMNS: '80', LINES: '24', COLORTERM: 'truecolor',
  PROOF_OR_STOP_AGENT: 'main',
  PROOF_OR_STOP_OWNER_SESSION_ADAPTER_PROVIDER: 'codex',
  PROOF_OR_STOP_OWNER_SESSION_ADAPTER_TASK: 'verification-env-digest',
  PROOF_OR_STOP_OWNER_SESSION_ADAPTER_AGENT: 'main',
  PROOF_OR_STOP_USAGE_LEDGER: '0',
};

function cli(env: Record<string, string>, command: string, payload: Record<string, unknown>, entry = REAL_CLI) {
  const run = spawnSync(process.execPath, [entry, command, JSON.stringify(payload)], { cwd: root, env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  return { status: run.status ?? -1, out: `${run.stdout ?? ''}${run.stderr ?? ''}` };
}
function record(intentRef: string, command: string): void {
  const run = cli(base, 'verification_evidence_add', {
    storyId: STORY, itemId: 'CHK-001', intentRef, kind: 'integration_test', command, selector: 'MARKER_OK',
    result: 'pass', note: `pinned marker receipt for ${intentRef}`,
  }, RECORD_CLI);
  assert.equal(run.status, 0, `record ${intentRef}:\n${run.out}`);
}
/** Intent refs the real CLI reports stale when run from `env`. */
function staleFrom(env: Record<string, string>): string[] {
  const run = cli(env, 'verification_evidence_refresh_stale', { storyId: STORY, dryRun: true });
  assert.equal(run.status, 0, run.out);
  if (/No stale verification evidence/.test(run.out)) return [];
  return [...run.out.matchAll(/^\s+- (I\d):/gm)].map(match => match[1]).sort();
}

record('I1', I1_CMD);
record('I2', I2_CMD);
if (process.env.ENVDIG_RECORD_CLI) {
  // Receipts recorded by another build (the pre-fix CLI): report what this
  // build says about them, then stop. Used to check that old receipts go stale
  // exactly once under a new digest domain rather than being silently accepted.
  console.log(`ENVDIG_OLD_RECEIPTS stale=${JSON.stringify(staleFrom(base))}`);
  process.exit(0);
}
assert.deepEqual(staleFrom(base), [], 'control: the recording environment itself is fresh');

const failures: string[] = [];
function expect(label: string, env: Record<string, string>, stale: string[]): void {
  const actual = staleFrom(env);
  const ok = JSON.stringify(actual) === JSON.stringify(stale);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}: stale=${JSON.stringify(actual)} expected=${JSON.stringify(stale)}`);
  if (!ok) failures.push(`${label}: stale=${JSON.stringify(actual)} expected=${JSON.stringify(stale)}`);
}

// Shell/terminal bookkeeping: never changes what the command does -> fresh.
const bookkeeping: Array<[string, Record<string, string | undefined>]> = [
  ['SHLVL', { SHLVL: '3' }],
  ['_', { _: '/opt/homebrew/bin/proof-or-stop' }],
  ['OLDPWD', { OLDPWD: '/tmp' }],
  ['PWD (same cwd)', { PWD: `${root}/.` }],
  ['TERM_SESSION_ID', { TERM_SESSION_ID: 'w1t3p0:BBBB' }],
  ['COLUMNS', { COLUMNS: '211' }],
  ['LINES', { LINES: '61' }],
  ['TERM_PROGRAM', { TERM_PROGRAM: 'iTerm.app', TERM_PROGRAM_VERSION: '3.5.0' }],
  ['tmux', { TMUX: '/private/tmp/tmux-501/default,1234,0', TMUX_PANE: '%3' }],
  ['ssh', { SSH_TTY: '/dev/ttys004', SSH_CONNECTION: '10.0.0.2 5555 10.0.0.1 22', SSH_CLIENT: '10.0.0.2 5555 22' }],
  ['iTerm', { ITERM_SESSION_ID: 'w0t1p0:CCCC', ITERM_PROFILE: 'Default' }],
  ['wrapper trace var', { WRAPPER_TRACE_ID: 'trace-9f2c' }],
  ['PATH + dir shadowing nothing', { PATH: `${basePath}:${emptyBin}` }],
];
for (const [label, delta] of bookkeeping) {
  const env = { ...base };
  for (const [key, value] of Object.entries(delta)) if (value === undefined) delete env[key]; else env[key] = value;
  expect(`fresh after ${label}`, env, []);
}
expect('fresh after all bookkeeping at once', Object.assign({ ...base }, ...bookkeeping.map(([, delta]) => delta)), []);

// Behavior-affecting inputs -> stale.
expect('stale after PATH resolves a different git', { ...base, PATH: `${shadowGit}:${basePath}` }, ['I1', 'I2']);
expect('stale after PATH resolves a different node', { ...base, PATH: `${shadowNode}:${basePath}` }, ['I1', 'I2']);
expect('stale after GOFLAGS', { ...base, GOFLAGS: '-count=1' }, ['I1', 'I2']);
expect('stale after NODE_OPTIONS', { ...base, NODE_OPTIONS: '--no-deprecation' }, ['I1', 'I2']);
expect('stale after LANG', { ...base, LANG: 'C' }, ['I1', 'I2']);
expect('stale after TZ', { ...base, TZ: 'Asia/Shanghai' }, ['I1', 'I2']);
expect('stale after the variable the pinned command names', { ...base, ENVDIG_FLAG: 'on' }, ['I2']);

// Project validate.env: the configured value is part of the environment identity.
{
  const before = { ...process.env };
  const setEnv = (env: Record<string, string>) => {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, env);
  };
  const identity = () => prepareVerificationExecutionIdentity({ command: I1_CMD, cwd: root, effectiveTimeoutMs: 270000 }).environmentDigest;
  try {
    setEnv(base);
    const recorded = identity();
    writeFileSync(join(root, 'proof-or-stop.config.json'), config('rel'));
    const changed = identity();
    if (changed === recorded) failures.push('validate.env CONTEXT change did not change the environment digest');
    console.log(`${changed !== recorded ? 'ok  ' : 'FAIL'} validate.env CONTEXT abs->rel changes the environment digest`);
    expect('stale after validate.env CONTEXT changes', base, ['I1', 'I2']);
    writeFileSync(join(root, 'proof-or-stop.config.json'), config('abs'));
    // The ambient CONTEXT is not what the project declared -> project value wins, no change.
    setEnv({ ...base, CONTEXT: 'something-else' });
    const ambient = identity();
    if (ambient !== recorded) failures.push('an ambient CONTEXT overrode the project validate.env value');
  } finally {
    setEnv(before as Record<string, string>);
  }
  assert.equal(readFileSync(join(root, 'proof-or-stop.config.json'), 'utf8'), config('abs'));
  expect('fresh again after restoring validate.env', base, []);
}

rmSync(root, { recursive: true, force: true });
rmSync(scratch, { recursive: true, force: true });
if (failures.length) {
  console.error(`verification-env-digest-smoke: FAIL (${failures.length})\n${failures.join('\n')}`);
  process.exit(1);
}
console.log('verification-env-digest-smoke: PASS');

#!/usr/bin/env node
// Lab reuse-host-session-environment RED/GREEN.
//
// Bug: routine and DONE-required validation identities hash the whole ambient
// environment except a narrow strip list. The Claude Code host still injects
// per-session values that no validation command reads:
//   CLAUDE_CODE_HOST_SESSION_ID  host session identifier
//   CLAUDE_EFFORT                the user's effort setting for the session
//   BAGGAGE                      host telemetry propagation (sentry-trace_id, release)
// A different session, or the same user at a different effort level, gets a new
// identity digest, so an unchanged PASS is refused as validation-identity-changed
// and the full plan (up to 240 commands) re-executes; DONE-required receipts read
// as effective-environment-digest-mismatch. Session transcripts contain 21
// refusals whose only reason was validation-identity-changed.
//
// Controls pin that behavior-affecting inputs still change identity, that an
// explicit command.env overlay of the same keys stays semantic, and that the
// digest-pinned frozen strip list is untouched.
import './lab-source-loader.mjs';
import { registerHooks, createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { readFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
const ts = createRequire(import.meta.url)('typescript');
registerHooks({ load(url, context, nextLoad) {
  if (url.startsWith('file:') && url.endsWith('.ts')) return { format: 'module', shortCircuit: true,
    source: ts.transpileModule(readFileSync(fileURLToPath(url), 'utf8'), { compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, esModuleInterop: true,
    }, fileName: fileURLToPath(url) }).outputText };
  return nextLoad(url, context);
} });
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { buildRoutineValidationIdentity, evaluateRoutineValidationReuse, summarizeRoutineCommandExecution } = await import('../packages/main/src/core/validation-evidence-reuse.ts');
const { buildDoneRequiredExecutionIdentity } = await import('../packages/main/src/core/done-required-validation.ts');
const envModule = await import('../packages/main/src/core/validation-command-environment.ts');

const MARKER = 'host session variable changes validation identity';
const FROZEN_LIST_DIGEST = 'sha256:159db7bb6593c703d112dab8973b5d650c9b43b0c02246cf18a553f7b1aa3c0c';
const red = [];
let checks = 0;
const check = (value, message) => { assert(value, message); checks++; };
const expectRepaired = (value, message) => { if (value) checks++; else red.push(message); };

const root = mkdtempSync(join(tmpdir(), 'pos-host-session-env-'));
const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
try {
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'fixture@example.invalid']); git(['config', 'user.name', 'Env Fixture']); git(['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(root, 'README.md'), 'fixture\n');
  git(['add', '.']); git(['commit', '-qm', 'base']);
  const head = git(['rev-parse', 'HEAD']);

  const sessionOne = {
    PATH: process.env.PATH, HOME: '/Users/fixture', LANG: 'en_GB.UTF-8', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'claude-desktop',
    CLAUDE_CODE_HOST_SESSION_ID: 'host-session-one', CLAUDE_EFFORT: 'high',
    BAGGAGE: 'sentry-environment=production,sentry-release=1.0.0,sentry-trace_id=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  };
  const commands = [{ label: 'probe', command: process.execPath, args: ['-e', '0'], timeoutMs: 1000 }];
  const routine = (env, cmds = commands) => buildRoutineValidationIdentity({
    projectRoot: root, sourceKind: 'configured', sourceInputs: { commands: ['probe'] }, commands: cmds,
    profile: 'balanced', verificationPolicyInputs: {}, processEnvironment: env,
  });
  const policy = { commands, policyHash: 'policy', commandSetHash: 'command-set' };
  const doneRequired = (env) => buildDoneRequiredExecutionIdentity({ projectRoot: root, policy, processEnvironment: env });
  const doneDigests = (env) => JSON.stringify(doneRequired(env).commands.map((c) => c.effectiveEnvironmentDigest));
  const coverage = { total: 0, covered: 0, missingRequired: 0, missingOptional: 0, items: [] };
  const baseIdentity = routine(sessionOne);
  const evidence = {
    command: 'proof-or-stop validate --story=B-env --json', output: '{}', result: 'PASS', timestamp: new Date().toISOString(),
    headHash: head, materialHash: 'material', storyFilesHash: 'story-files', verificationCoverage: coverage,
    routineValidationIdentity: baseIdentity,
    commandExecution: summarizeRoutineCommandExecution([{ label: 'probe', command: process.execPath, args: ['-e', '0'], code: 0, output: '', durationMs: 1 }], 1),
    disposition: 'executed',
  };
  const reuseIn = (env) => evaluateRoutineValidationReuse({
    root, gitCwd: root, evidence, currentIdentity: routine(env), currentCoverage: coverage,
    currentMaterialHash: 'material', currentStoryFilesHash: 'story-files', clean: true, headBefore: head, headAfter: head,
  });
  const rows = [];

  // Host session values: a different session must keep the identity.
  const volatile = {
    CLAUDE_CODE_HOST_SESSION_ID: 'host-session-two',
    CLAUDE_EFFORT: 'medium',
    BAGGAGE: 'sentry-environment=production,sentry-release=1.0.1,sentry-trace_id=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  };
  for (const [key, value] of Object.entries(volatile)) {
    const env = { ...sessionOne, [key]: value };
    const reuse = reuseIn(env);
    const sameRoutine = routine(env).digest === baseIdentity.digest;
    const sameDone = JSON.stringify(doneRequired(env).commands.map((c) => c.effectiveEnvironmentDigest))
      === JSON.stringify(doneRequired(sessionOne).commands.map((c) => c.effectiveEnvironmentDigest));
    rows.push({ change: `${key} differs between sessions`, routineIdentitySame: sameRoutine, doneRequiredEnvDigestSame: sameDone, reusable: reuse.reusable, reasons: reuse.refusalReasons.join(',') || '-' });
    expectRepaired(sameRoutine, `${key}: routine identity must not change with a host session value`);
    expectRepaired(sameDone, `${key}: DONE-required effectiveEnvironmentDigest must not change with a host session value`);
    expectRepaired(reuse.reusable === true, `${key}: an unchanged PASS must be reusable from another session, refused ${reuse.refusalReasons.join(',')}`);
  }
  // Absence is also a session difference (for example, a plain terminal).
  {
    const env = { ...sessionOne }; delete env.CLAUDE_CODE_HOST_SESSION_ID; delete env.CLAUDE_EFFORT; delete env.BAGGAGE;
    const reuse = reuseIn(env);
    const sameDone = doneDigests(env) === doneDigests(sessionOne);
    rows.push({ change: 'all three host session values absent', routineIdentitySame: routine(env).digest === baseIdentity.digest, doneRequiredEnvDigestSame: sameDone, reusable: reuse.reusable, reasons: reuse.refusalReasons.join(',') || '-' });
    expectRepaired(reuse.reusable === true, `absent host session values must not refuse reuse, refused ${reuse.refusalReasons.join(',')}`);
    expectRepaired(sameDone, 'absent host session values must not change the DONE-required effectiveEnvironmentDigest');
  }

  // Controls: behavior-affecting inputs still change identity and refuse reuse.
  for (const [key, value] of Object.entries({ NODE_OPTIONS: '--max-old-space-size=64', CI: 'true', TZ: 'Asia/Tokyo', LANG: 'C', PATH: '/usr/bin' })) {
    const env = { ...sessionOne, [key]: value };
    const reuse = reuseIn(env);
    const sameDone = doneDigests(env) === doneDigests(sessionOne);
    rows.push({ change: `control ${key}`, routineIdentitySame: routine(env).digest === baseIdentity.digest, doneRequiredEnvDigestSame: sameDone, reusable: reuse.reusable, reasons: reuse.refusalReasons.join(',') || '-' });
    check(routine(env).digest !== baseIdentity.digest, `control ${key} must still change identity`);
    check(!sameDone, `control ${key} must still change the DONE-required effectiveEnvironmentDigest`);
    check(reuse.reusable === false && reuse.refusalReasons.includes('validation-identity-changed'), `control ${key} must still refuse reuse`);
  }
  // Control: an explicit command.env overlay of a host key is semantic.
  {
    const overlay = [{ ...commands[0], env: { CLAUDE_EFFORT: 'low' } }];
    check(routine(sessionOne, overlay).digest !== routine(sessionOne).digest, 'explicit command.env overlay of CLAUDE_EFFORT stays semantic');
    const spawnEnv = envModule.effectiveValidationCommandEnvironment(sessionOne, { CLAUDE_EFFORT: 'low' }, root);
    check(spawnEnv.CLAUDE_EFFORT === 'low', 'explicit overlay value is passed to the command');
  }
  // Identity and spawn agree: an identity-neutral host value is not passed to the command either,
  // so a reused PASS cannot hide a command that would read it.
  {
    const spawnEnv = envModule.effectiveValidationCommandEnvironment(sessionOne, undefined, root);
    const leaked = Object.keys(volatile).filter((key) => key in spawnEnv);
    rows.push({ change: 'host session values in the command environment', routineIdentitySame: '-', doneRequiredEnvDigestSame: '-', reusable: '-', reasons: leaked.length ? `passed: ${leaked.join(',')}` : 'not passed' });
    expectRepaired(leaked.length === 0, `identity-neutral host values must not reach the command (passed ${leaked.join(',')})`);
    check(spawnEnv.LANG === sessionOne.LANG && spawnEnv.PATH === sessionOne.PATH, 'ordinary ambient values still reach the command');
  }
  // Control: the frozen, digest-pinned strip list is untouched.
  const frozenDigest = `sha256:${createHash('sha256').update(JSON.stringify(envModule.VALIDATION_TRANSPORT_ENV_KEY_LIST)).digest('hex')}`;
  check(envModule.VALIDATION_TRANSPORT_ENV_KEYS_DIGEST === FROZEN_LIST_DIGEST, 'frozen strip-list digest constant unchanged');
  check(frozenDigest === FROZEN_LIST_DIGEST, `frozen strip list contents unchanged (recomputed ${frozenDigest})`);
  rows.push({ change: 'frozen strip list digest', routineIdentitySame: '-', doneRequiredEnvDigestSame: '-', reusable: '-', reasons: frozenDigest === FROZEN_LIST_DIGEST ? 'unchanged' : `recomputed ${frozenDigest}` });

  console.log('change | routineIdentitySame | doneRequiredEnvDigestSame | routineReusable | refusalReasons');
  for (const r of rows) console.log(`${r.change} | ${r.routineIdentitySame} | ${r.doneRequiredEnvDigestSame} | ${r.reusable} | ${r.reasons}`);
} finally {
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}
if (red.length) {
  console.log(`${MARKER} (${red.length} failing expectations, ${checks} passing checks)`);
  for (const line of red) console.log(`  - ${line}`);
  process.exit(1);
}
console.log(`host session variables are identity-neutral (${checks} checks)`);

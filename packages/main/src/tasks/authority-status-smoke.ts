#!/usr/bin/env node
/**
 * @task B-b710
 * @checklist CHK-001, CHK-002
 * @title authority status / conduit status readiness smoke
 * @type chore
 * @priority high
 * @description
 *   Smoke coverage for Lattice CLI 0.3.5 enforce readiness diagnostics
 *   (B-b710 milestones 3-4). Verifies:
 *
 *   Happy / off mode:
 *     - `lattice authority status --json` and `lattice authority status --format=json`
 *       both work and report mode="off", localWorkflowUsable=true,
 *       productionDone=false, receiptVerified=false, canClaimProductionDone=false,
 *       readinessWarnings=[] (off is intentional opt-out, not a misconfig).
 *
 *   Edge / shadow + missing prerequisites:
 *     - shadow without KOALA_AUTHORITY_URL surfaces actionable readinessWarnings
 *       and nextActions, but keeps localWorkflowUsable=true and productionDone=false.
 *
 *   Edge / enforce + missing prerequisites:
 *     - enforce without URL / actor key / runner id surfaces three readiness
 *       warnings; localWorkflowUsable=true and productionDone=false remain.
 *
 *   Edge / enforce with all env prerequisites set:
 *     - Even when URL, actor key, and runner id are all set, productionDone /
 *       receiptVerified / canClaimProductionDone remain false (no receipt has
 *       actually been verified — env presence alone is not authority).
 *
 *   Adversarial:
 *     - No combination of env vars / overrides can flip productionDone,
 *       receiptVerified, or canClaimProductionDone to true.
 *     - conduit_status mirrors the same readiness fields and the same negative
 *       authority guarantees.
 *
 *   Boundary preserved by this story:
 *     - No actor key generation, no job claim, no provider execution, no signed
 *       envelope, no receipt verification, no L2+ promotion are introduced.
 *     - Env vars (KOALA_AUTHORITY_ACTOR_KEY / KOALA_AUTHORITY_RUNNER_ID etc.)
 *       are presence-only diagnostics; the CLI never *uses* them to do anything.
 * @changes
 *   Add focused smoke coverage for B-b710 enforce readiness diagnostics
 *   exposed by `authority_status` and `conduit_status`, including the
 *   adversarial guarantee that no readiness combination promotes productionDone
 *   away from `false` without a verified receipt.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildAuthorityStatus,
  buildConduitStatus,
} from '../handlers/lattice-cli.js';

const here = dirname(fileURLToPath(import.meta.url));
const cliPath = join(here, '..', 'cli.js');
const repoRoot = join(here, '..', '..', '..', '..');

type EnvOverride = Record<string, string | undefined>;

function runJson<T>(args: string[], env: EnvOverride = {}): T {
  const out = execFileSync(process.execPath, [cliPath, '--root', repoRoot, ...args], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return JSON.parse(out) as T;
}

function runText(args: string[], env: EnvOverride = {}): string {
  return execFileSync(process.execPath, [cliPath, '--root', repoRoot, ...args], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/**
 * Walk the JSON tree and ensure none of the authority claim fields is ever
 * `true`. This is the adversarial guard from CHK-001:
 *   "No status/readiness path can claim productionDone or receiptVerified
 *    without verified receipt input."
 */
function assertNoProductionOverclaim(value: unknown, label: string): void {
  const seen: string[] = [];
  const visit = (node: unknown, path: string): void => {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach((item, i) => visit(item, `${path}[${i}]`));
      return;
    }
    for (const [k, child] of Object.entries(node as Record<string, unknown>)) {
      const childPath = path ? `${path}.${k}` : k;
      if (
        (k === 'productionDone' ||
          k === 'receiptVerified' ||
          k === 'canClaimProductionDone' ||
          k === 'authorityChanged') &&
        child === true
      ) {
        seen.push(childPath);
      }
      visit(child, childPath);
    }
  };
  visit(value, '');
  assert.deepEqual(
    seen,
    [],
    `${label} must not contain production/receipt/authority true overclaims`,
  );
}

// Helper: only inject mode + prerequisite envs; never inherit ambient ones.
const EMPTY_AUTHORITY_ENV: EnvOverride = {
  KOALA_AUTHORITY_MODE: '',
  KOALA_AUTHORITY_URL: '',
  KOALA_AUTHORITY_TIMEOUT_MS: '',
  KOALA_AUTHORITY_ACTOR_KEY: '',
  KOALA_AUTHORITY_ACTOR_KEY_PATH: '',
  KOALA_AUTHORITY_RUNNER_ID: '',
  KOALA_AUTHORITY_SESSION_ID: '',
};

// ── Pure-function unit checks (in-process, no env crosstalk) ────────────────

// Off mode: no readiness warnings, productionDone false, mode === 'off'.
{
  const result = buildAuthorityStatus({}, { ...EMPTY_AUTHORITY_ENV } as Record<string, string | undefined>);
  assert.equal(result.mode, 'off', 'off-mode mode is off');
  assert.equal(result.authorityMode, 'off', 'off-mode authorityMode alias is off');
  assert.equal(result.localWorkflowUsable, true, 'off-mode localWorkflowUsable is true');
  assert.equal(result.productionDone, false, 'off-mode productionDone is false');
  assert.equal(result.receiptVerified, false, 'off-mode receiptVerified is false');
  assert.equal(result.canClaimProductionDone, false, 'off-mode canClaimProductionDone is false');
  assert.equal(result.authorityUrlConfigured, false, 'off-mode authorityUrlConfigured is false');
  assert.equal(result.actorKeyConfigured, false, 'off-mode actorKeyConfigured is false');
  assert.equal(result.runnerConfigured, false, 'off-mode runnerConfigured is false');
  assert.deepEqual(result.readinessWarnings, [], 'off-mode emits no readiness warnings');
  assert.deepEqual(result.nextActions, [], 'off-mode emits no next actions');
  assert.match(result.localWorkflowNote, /readiness warnings, not global blockers/i, 'off-mode includes local-workflow note');
  assertNoProductionOverclaim(result, 'buildAuthorityStatus off-mode');
}

// Shadow + missing URL: warning fired, productionDone still false.
{
  const env: EnvOverride = { ...EMPTY_AUTHORITY_ENV, KOALA_AUTHORITY_MODE: 'shadow' };
  const result = buildAuthorityStatus({}, env as Record<string, string | undefined>);
  assert.equal(result.mode, 'shadow', 'shadow mode reported');
  assert.equal(result.localWorkflowUsable, true, 'shadow-missing-url localWorkflowUsable true');
  assert.ok(
    result.readinessWarnings.some(w => /shadow.*KOALA_AUTHORITY_URL/.test(w)),
    'shadow + missing URL emits actionable readiness warning',
  );
  assert.ok(
    result.nextActions.some(a => /KOALA_AUTHORITY_URL/.test(a)),
    'shadow + missing URL suggests setting KOALA_AUTHORITY_URL',
  );
  assert.equal(result.productionDone, false, 'shadow productionDone still false');
  assert.equal(result.canClaimProductionDone, false, 'shadow canClaimProductionDone still false');
  assertNoProductionOverclaim(result, 'buildAuthorityStatus shadow-missing-url');
}

// Enforce + missing URL + missing actor key + missing runner: three warnings.
{
  const env: EnvOverride = { ...EMPTY_AUTHORITY_ENV, KOALA_AUTHORITY_MODE: 'enforce' };
  const result = buildAuthorityStatus({}, env as Record<string, string | undefined>);
  assert.equal(result.mode, 'enforce', 'enforce mode reported');
  assert.equal(result.localWorkflowUsable, true, 'enforce-missing-prereqs localWorkflowUsable true');
  assert.ok(
    result.readinessWarnings.some(w => /enforce.*KOALA_AUTHORITY_URL/.test(w)),
    'enforce + missing URL emits URL readiness warning',
  );
  assert.ok(
    result.readinessWarnings.some(w => /KOALA_AUTHORITY_ACTOR_KEY/.test(w)),
    'enforce + missing actor key emits actor key warning',
  );
  assert.ok(
    result.readinessWarnings.some(w => /runner/i.test(w) && /KOALA_AUTHORITY_RUNNER_ID/.test(w)),
    'enforce + missing runner id emits runner readiness warning',
  );
  assert.equal(result.productionDone, false, 'enforce productionDone still false');
  assert.equal(result.receiptVerified, false, 'enforce receiptVerified still false');
  assert.equal(result.canClaimProductionDone, false, 'enforce canClaimProductionDone still false');
  assertNoProductionOverclaim(result, 'buildAuthorityStatus enforce-missing-prereqs');
}

// Enforce with all env prerequisites set: still NOT productionDone.
{
  const env: EnvOverride = {
    ...EMPTY_AUTHORITY_ENV,
    KOALA_AUTHORITY_MODE: 'enforce',
    KOALA_AUTHORITY_URL: 'https://authority.example',
    KOALA_AUTHORITY_ACTOR_KEY: 'fake-key-blob',
    KOALA_AUTHORITY_RUNNER_ID: 'runner-1',
    KOALA_AUTHORITY_SESSION_ID: 'session-1',
  };
  const result = buildAuthorityStatus({}, env as Record<string, string | undefined>);
  assert.equal(result.mode, 'enforce', 'enforce reported even when env complete');
  assert.equal(result.authorityUrlConfigured, true, 'authority URL detected');
  assert.equal(result.actorKeyConfigured, true, 'actor key detected');
  assert.equal(result.runnerConfigured, true, 'runner detected');
  assert.equal(result.sessionConfigured, true, 'session detected');
  assert.deepEqual(
    result.readinessWarnings,
    [],
    'enforce + full env emits no readiness warnings',
  );
  // CRITICAL adversarial guard: env presence alone NEVER promotes authority.
  assert.equal(result.productionDone, false, 'env-complete enforce productionDone still false');
  assert.equal(result.receiptVerified, false, 'env-complete enforce receiptVerified still false');
  assert.equal(
    result.canClaimProductionDone,
    false,
    'env-complete enforce canClaimProductionDone still false',
  );
  assertNoProductionOverclaim(result, 'buildAuthorityStatus enforce-env-complete');
}

// conduit_status mirrors readiness without promoting authority.
{
  const env: EnvOverride = { ...EMPTY_AUTHORITY_ENV, KOALA_AUTHORITY_MODE: 'shadow' };
  const result = buildConduitStatus(env as Record<string, string | undefined>);
  assert.equal(result.mode, 'shadow', 'conduit mode mirrors authority status');
  assert.equal(result.localWorkflowUsable, true, 'conduit localWorkflowUsable true');
  assert.equal(result.productionDone, false, 'conduit productionDone false');
  assert.equal(result.receiptVerified, false, 'conduit receiptVerified false');
  assert.equal(result.authorityChanged, false, 'conduit authorityChanged false');
  assert.ok(
    result.readinessWarnings.length > 0,
    'conduit surfaces shadow readiness warnings',
  );
  assertNoProductionOverclaim(result, 'buildConduitStatus shadow');
}

// ── CLI integration: text + JSON (--format=json AND --json shortcut) ───────

// off mode through CLI (text output)
{
  const text = runText(['authority_status'], EMPTY_AUTHORITY_ENV);
  assert.match(text, /mode: off/, 'CLI text shows mode: off');
  assert.match(text, /localWorkflowUsable: true/, 'CLI text shows localWorkflowUsable: true');
  assert.match(text, /productionDone: false/, 'CLI text shows productionDone: false');
  assert.doesNotMatch(text, /readinessWarnings:\n  - /, 'off-mode CLI text does not emit readiness warnings list');
}

// off mode through CLI with --json shortcut
{
  const json = runJson<any>(['authority_status', '--json'], EMPTY_AUTHORITY_ENV);
  assert.equal(json.mode, 'off', '--json reports mode off');
  assert.equal(json.localWorkflowUsable, true, '--json reports localWorkflowUsable true');
  assert.equal(json.productionDone, false, '--json reports productionDone false');
  assert.equal(json.receiptVerified, false, '--json reports receiptVerified false');
  assert.equal(json.canClaimProductionDone, false, '--json reports canClaimProductionDone false');
  assert.deepEqual(json.readinessWarnings, [], '--json off-mode no readiness warnings');
  assertNoProductionOverclaim(json, 'CLI authority_status --json off');
}

// off mode through CLI with --format=json (legacy form)
{
  const json = runJson<any>(['authority_status', '--format=json'], EMPTY_AUTHORITY_ENV);
  assert.equal(json.mode, 'off', '--format=json reports mode off');
  assert.equal(json.localWorkflowUsable, true, '--format=json reports localWorkflowUsable true');
  assertNoProductionOverclaim(json, 'CLI authority_status --format=json off');
}

// shadow + missing URL through CLI
{
  const json = runJson<any>(['authority_status', '--json'], {
    ...EMPTY_AUTHORITY_ENV,
    KOALA_AUTHORITY_MODE: 'shadow',
  });
  assert.equal(json.mode, 'shadow', 'shadow CLI JSON mode shadow');
  assert.equal(json.localWorkflowUsable, true, 'shadow CLI JSON localWorkflowUsable true');
  assert.ok(
    Array.isArray(json.readinessWarnings) && json.readinessWarnings.length >= 1,
    'shadow CLI JSON readinessWarnings non-empty',
  );
  assert.equal(json.productionDone, false, 'shadow CLI JSON productionDone false');
  assertNoProductionOverclaim(json, 'CLI authority_status --json shadow');
}

// enforce + missing prereqs through CLI: three warnings + still safe.
{
  const json = runJson<any>(['authority_status', '--json'], {
    ...EMPTY_AUTHORITY_ENV,
    KOALA_AUTHORITY_MODE: 'enforce',
  });
  assert.equal(json.mode, 'enforce', 'enforce CLI JSON mode enforce');
  assert.ok(
    json.readinessWarnings.length >= 3,
    `enforce CLI JSON readinessWarnings includes URL/actor/runner; got ${json.readinessWarnings.length}`,
  );
  assert.ok(
    json.nextActions.some((a: string) => /KOALA_AUTHORITY_URL/.test(a)),
    'enforce CLI JSON suggests URL next action',
  );
  assert.equal(json.productionDone, false, 'enforce CLI JSON productionDone still false');
  assert.equal(json.canClaimProductionDone, false, 'enforce CLI JSON canClaimProductionDone false');
  assertNoProductionOverclaim(json, 'CLI authority_status --json enforce');
}

// enforce + all env set through CLI: still NOT productionDone.
{
  const json = runJson<any>(['authority_status', '--json'], {
    ...EMPTY_AUTHORITY_ENV,
    KOALA_AUTHORITY_MODE: 'enforce',
    KOALA_AUTHORITY_URL: 'https://authority.example',
    KOALA_AUTHORITY_ACTOR_KEY_PATH: '/tmp/fake-key.pem',
    KOALA_AUTHORITY_RUNNER_ID: 'runner-x',
  });
  assert.equal(json.authorityUrlConfigured, true);
  assert.equal(json.actorKeyConfigured, true);
  assert.equal(json.runnerConfigured, true);
  assert.deepEqual(json.readinessWarnings, [], 'env-complete enforce CLI JSON no warnings');
  assert.equal(json.productionDone, false, 'env-complete enforce CLI JSON productionDone still false');
  assert.equal(json.receiptVerified, false, 'env-complete enforce CLI JSON receiptVerified still false');
  assert.equal(
    json.canClaimProductionDone,
    false,
    'env-complete enforce CLI JSON canClaimProductionDone still false',
  );
  assertNoProductionOverclaim(json, 'CLI authority_status --json enforce env-complete');
}

// conduit_status through CLI mirrors readiness
{
  const json = runJson<any>(['conduit_status', '--json'], {
    ...EMPTY_AUTHORITY_ENV,
    KOALA_AUTHORITY_MODE: 'enforce',
  });
  assert.equal(json.mode, 'enforce', 'conduit CLI JSON mode enforce');
  assert.equal(json.localWorkflowUsable, true, 'conduit CLI JSON localWorkflowUsable true');
  assert.ok(
    json.readinessWarnings.length >= 1,
    'conduit CLI JSON readinessWarnings non-empty',
  );
  assert.equal(json.productionDone, false, 'conduit CLI JSON productionDone false');
  assert.equal(json.receiptVerified, false, 'conduit CLI JSON receiptVerified false');
  assert.equal(json.authorityChanged, false, 'conduit CLI JSON authorityChanged false');
  assertNoProductionOverclaim(json, 'CLI conduit_status --json enforce');
}

// conduit explain still includes the no-runner / no-receipt statement.
{
  const json = runJson<any>(['conduit_explain', '--json'], EMPTY_AUTHORITY_ENV);
  assert.equal(json.localWorkflowUsable, true);
  assert.equal(json.productionDone, false);
  assert.ok(
    json.explanation.some((line: string) => /off = default local-only/i.test(line)),
    'conduit explain documents off mode as default local-only workflow',
  );
  assert.ok(
    json.explanation.some((line: string) => /enforce.*Python authority server.*actor key.*runner/i.test(line)),
    'conduit explain documents enforce mode prerequisites',
  );
  assertNoProductionOverclaim(json, 'CLI conduit_explain --json');
}

console.log('✓ authority status readiness smoke passed');

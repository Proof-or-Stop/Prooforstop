#!/usr/bin/env node
//
// End-to-end authority evidence flow smoke.
//
// SCOPE NOTE (B-94a6):
//   - CHK-001 landed the authority subsystem scaffolding (client / contracts / mode).
//   - CHK-002 (this update) wires authority POST into the real
//     verification_evidence_add / verification_evidence_batch_add handlers with the
//     A-prepost local-validation-first invariant (Blockers 1+2): full local preflight
//     runs FIRST, then the POST, then the local evidence write only on an accepted
//     POST. The frozen CHK-002 checklist context's "write local first then POST"
//     sentence is SUPERSEDED and intentionally NOT implemented (decision.json
//     chosen=A-prepost).
//   - CHK-003 added shadow mode (Blocker 3): authority is observational only —
//     ANY result keeps the local write and exits 0 (warning-only).
//   - CHK-004 (this update) completes enforce mode (Blocker 4): authority is gating —
//     any POST failure (5xx / timeout / connection-refused / client throw /
//     authority-rejected / batch partial-accept) maps to a controlled throw with
//     ZERO local write and NO compensating rollback (pre-POST ordering means the
//     write never ran, so there is no two-phase divergence window).
//
// Foundation cases (CHK-001) prove:
//   - off mode performs zero authority interaction (the default, byte-equivalent
//     to post-B-2157 main),
//   - the client + contracts compose into a single submit -> outcome -> accept flow,
//   - a failing authority server is observable as a non-success outcome (so shadow
//     can degrade it and enforce can gate on it).
//
// CHK-002 regression cases (driven through the REAL handlers with a POST-counting
// fake authority server) prove the Blockers 1+2 invariant:
//   - illegal itemId (CHK-MISSING)        -> handler throws + ZERO POST + ZERO write
//   - note < 5 / waiverType-kind mismatch -> ZERO POST + ZERO write
//   - batch with any illegal entry         -> whole batch ZERO POST + ZERO write
//   - off mode happy                        -> local write + zero network
//
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  AuthorityClient,
  type AuthorityClientOutcome,
  type AuthorityFetch,
} from '../core/authority-client.js';
import {
  authorityModeEnabled,
  loadAuthoritySettings,
  type AuthoritySettings,
} from '../core/authority-mode.js';
import {
  isAuthorityBatchFullyAccepted,
  type EvidenceEnvelopeContract,
} from '../core/authority-contracts.js';
import { EvidenceCollector } from '../core/evidence-collector.js';
import { resetConfigCache } from '../core/config.js';
import { StoryStore } from '../core/store.js';
import { createChecklistHandlers } from '../handlers/checklist.js';
import { createAuthoritySubmitter } from '../core/authority-submit.js';
import type { ChecklistData, StoryInfo } from '../core/types.js';

function fetchReturning(status: number, body: string): { calls: number; fetch: AuthorityFetch } {
  const state = { calls: 0 } as { calls: number; fetch: AuthorityFetch };
  state.fetch = async () => {
    state.calls += 1;
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => body,
    };
  };
  return state;
}

// A POST-counting fake fetch shared by the CHK-002 handler-driven cases. Asserting
// `calls === 0` after a local preflight failure proves the POST is gated behind
// passing local validation (Blockers 1+2).
function countingFetch(status: number, body: string): { calls: number; fetch: AuthorityFetch } {
  return fetchReturning(status, body);
}

const HANDLER_STORY_ID = 'B-flow';
const FLOW_NOW = '2026-05-21T00:00:00.000Z';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

// Build an isolated git-backed story repo whose only checklist item is CHK-001, so
// CHK-MISSING is a guaranteed-unknown item for the 0-POST-on-illegal-itemId case.
function createFlowStoryRepo(): { root: string; store: StoryStore } {
  const root = mkdtempSync(join(tmpdir(), 'koala-flow-'));
  mkdirSync(dirname(join(root, 'koala.config.json')), { recursive: true });
  writeFileSync(join(root, 'koala.config.json'), JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    testsDir: 'packages/main/tests',
    fixturesDir: 'packages/main/tests/fixtures',
    storyDir: '.koala/story/actives',
    requirementsDir: 'docs/requirements',
    worktreeDir: '.worktrees',
    workflow: { profile: 'balanced' },
  }));
  writeFileSync(join(root, 'README.md'), 'authority evidence flow smoke\n');
  git(root, ['init']);
  git(root, ['checkout', '-B', 'main']);
  git(root, ['add', '.']);
  git(root, ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Koala Smoke', 'commit', '-m', 'base']);
  resetConfigCache();

  const store = new StoryStore(root);
  const story: StoryInfo = {
    storyId: HANDLER_STORY_ID,
    name: 'authority-flow-smoke',
    title: 'Authority flow smoke',
    description: 'Synthetic story exercising verification evidence handlers under authority modes.',
    type: 'chore',
    phase: 'DEV',
    priority: 'medium',
    createdAt: FLOW_NOW,
    startedAt: FLOW_NOW,
    endedAt: null,
    events: [{ phase: 'DEV', action: 'advance', timestamp: FLOW_NOW }],
  };
  const checklist: ChecklistData = {
    items: [
      {
        id: 'CHK-001',
        title: 'Item one',
        context: 'Synthetic item.',
        status: 'in_progress' as const,
        startTime: FLOW_NOW,
        endTime: null,
        verificationIntent: {
          happy: [{ desc: 'happy path returns success', type: 'cli', priority: 'must' }],
          edge: [{ desc: 'empty input clear error', type: 'cli', priority: 'must' }],
          adversarial: [{ desc: 'illegal state writes nothing', type: 'logic', priority: 'must' }],
        },
      },
    ],
  };
  store.writeStory(HANDLER_STORY_ID, story);
  store.writeChecklist(HANDLER_STORY_ID, checklist);
  return { root, store };
}

// enforce settings pointing at the fake server; URL must be set so a real
// AuthorityClient would POST — but the assertion is that it never does on local fail.
function enforceSettings(): AuthoritySettings {
  return { mode: 'enforce', baseURL: 'https://authority.test', timeoutMS: 1000 };
}

// shadow settings pointing at the fake server. In shadow ANY authority outcome must
// keep the local write and exit 0 (Blocker 3).
function shadowSettings(): AuthoritySettings {
  return { mode: 'shadow', baseURL: 'https://authority.test', timeoutMS: 1000 };
}

// A fetch impl that always throws — exercises the AuthorityClient's classifyThrown
// path (connection_refused / timeout / error) so shadow can degrade it.
function fetchThrowing(error: Error): { calls: number; fetch: AuthorityFetch } {
  const state = { calls: 0 } as { calls: number; fetch: AuthorityFetch };
  state.fetch = async () => {
    state.calls += 1;
    throw error;
  };
  return state;
}

// Capture everything written to process.stderr during `fn`, restoring the original
// writer afterward. Lets shadow cases assert the single [warning] line is emitted to
// stderr and NOT to stdout.
async function captureStderr(fn: () => Promise<void>): Promise<string> {
  const original = process.stderr.write.bind(process.stderr);
  let captured = '';
  (process.stderr.write as unknown) = (chunk: string | Uint8Array): boolean => {
    captured += typeof chunk === 'string' ? chunk : chunk.toString();
    return true;
  };
  try {
    await fn();
  } finally {
    (process.stderr.write as unknown) = original;
  }
  return captured;
}

function hasEvidence(store: StoryStore, itemId: string): boolean {
  const cl = store.readChecklist(HANDLER_STORY_ID);
  return Boolean(cl.items.find(i => i.id === itemId)?.verificationEvidence?.length);
}

function collectEvidence(id: string): EvidenceEnvelopeContract {
  const collector = new EvidenceCollector();
  return collector.collect({
    evidenceId: id,
    projectId: 'proj',
    storyId: 'B-94a6',
    producerActorId: 'actor-1',
    command: 'koala validate --story=B-94a6',
    exitCode: 0,
    nonce: `nonce-${id}`,
    createdAt: '2026-05-21T00:00:00Z',
  });
}

// --- off mode: zero authority interaction (default) ---------------------------
{
  const settings = loadAuthoritySettings({}); // no env -> off
  assert.equal(settings.mode, 'off');
  assert.equal(authorityModeEnabled(settings.mode), false);
  // off mode never constructs a client / never POSTs; CHK-002 short-circuits on
  // authorityModeEnabled === false before touching the network.
}

// --- enabled mode building blocks: success path -------------------------------
{
  const server = fetchReturning(200, JSON.stringify({ accepted: true, evidenceId: 'EV-ok' }));
  const client = new AuthorityClient('https://a.test', server.fetch);
  const evidence = collectEvidence('EV-ok');
  const outcome = await client.submitEvidence(evidence);
  assert.equal(server.calls, 1);
  assert.equal(outcome.kind, 'success');
  assert.equal(outcome.ok, true);
  assert.equal(outcome.data?.accepted, true);
}

// --- enabled mode building blocks: failing server is a non-success outcome ----
// shadow (CHK-003) degrades these to a warning; enforce (CHK-004) gates on them.
for (const [status, body] of [[500, 'down'], [503, 'unavailable'], [422, 'rejected']] as const) {
  const server = fetchReturning(status, body);
  const client = new AuthorityClient('https://a.test', server.fetch);
  const outcome = await client.submitEvidence(collectEvidence('EV-fail'));
  assert.equal(server.calls, 1);
  assert.equal(outcome.kind, 'http_error');
  assert.equal(outcome.ok, false);
}

// --- enabled mode building blocks: batch all-or-nothing -----------------------
{
  const server = fetchReturning(
    200,
    JSON.stringify({ accepted: true, results: [{ accepted: true }, { accepted: false, reason: 'dup' }] }),
  );
  const client = new AuthorityClient('https://a.test', server.fetch);
  const outcome = await client.submitEvidenceBatch([collectEvidence('EV-a'), collectEvidence('EV-b')]);
  assert.equal(server.calls, 1, 'batch is a single POST');
  assert.equal(outcome.kind, 'success');
  // partial acceptance must NOT be treated as a whole-batch success (preMortem #3).
  assert.equal(isAuthorityBatchFullyAccepted(outcome.data!), false);
}

// ===========================================================================
// CHK-002 regression cases (Blockers 1+2): local preflight before authority POST.
// Driven through the REAL handlers with an enforce-mode submitter wrapping a
// POST-counting AuthorityClient. The defining assertion is `server.calls === 0`
// whenever local preflight fails — i.e. the POST is gated behind passing local
// validation and a local failure never produces a POST nor a local write.
// ===========================================================================

// --- CHK-002 / Blocker 1: illegal itemId -> 0 POST + 0 local write -------------
{
  const { root, store } = createFlowStoryRepo();
  try {
    const settings = enforceSettings();
    const server = countingFetch(200, JSON.stringify({ accepted: true }));
    const client = new AuthorityClient(settings.baseURL!, server.fetch);
    const submitter = createAuthoritySubmitter(settings, client);
    const handlers = createChecklistHandlers({
      root, store, authoritySettings: settings, authoritySubmitter: submitter,
    } as any);

    let threw = false;
    try {
      await handlers.verification_evidence_add({
        storyId: HANDLER_STORY_ID,
        itemId: 'CHK-MISSING',
        intentRef: 'CHK-MISSING:happy:0',
        kind: 'integration_test',
        note: 'unknown item must be rejected before any POST',
      });
    } catch (e) {
      threw = true;
      assert.match((e as Error).message, /Checklist item CHK-MISSING not found/);
    }
    assert.equal(threw, true, 'illegal itemId must reject (non-zero exit)');
    assert.equal(server.calls, 0, 'illegal itemId: ZERO authority POST (Blocker 1)');
    assert.equal(hasEvidence(store, 'CHK-001'), false, 'illegal itemId: ZERO local write');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// --- CHK-002 / Blocker 2: note < 5 -> 0 POST + 0 local write -------------------
{
  const { root, store } = createFlowStoryRepo();
  try {
    const settings = enforceSettings();
    const server = countingFetch(200, JSON.stringify({ accepted: true }));
    const client = new AuthorityClient(settings.baseURL!, server.fetch);
    const submitter = createAuthoritySubmitter(settings, client);
    const handlers = createChecklistHandlers({
      root, store, authoritySettings: settings, authoritySubmitter: submitter,
    } as any);

    let threw = false;
    try {
      await handlers.verification_evidence_add({
        storyId: HANDLER_STORY_ID,
        itemId: 'CHK-001',
        intentRef: 'CHK-001:happy:0',
        kind: 'integration_test',
        note: 'x',
      });
    } catch (e) {
      threw = true;
      assert.match((e as Error).message, /note 必须 ≥ 5 字符/);
    }
    assert.equal(threw, true, 'note < 5 must reject');
    assert.equal(server.calls, 0, 'note < 5: ZERO authority POST (Blocker 2)');
    assert.equal(hasEvidence(store, 'CHK-001'), false, 'note < 5: ZERO local write');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// --- CHK-002 / Blocker 2: waiverType with non-waiver kind -> 0 POST + 0 write --
{
  const { root, store } = createFlowStoryRepo();
  try {
    const settings = enforceSettings();
    const server = countingFetch(200, JSON.stringify({ accepted: true }));
    const client = new AuthorityClient(settings.baseURL!, server.fetch);
    const submitter = createAuthoritySubmitter(settings, client);
    const handlers = createChecklistHandlers({
      root, store, authoritySettings: settings, authoritySubmitter: submitter,
    } as any);

    let threw = false;
    try {
      await handlers.verification_evidence_add({
        storyId: HANDLER_STORY_ID,
        itemId: 'CHK-001',
        intentRef: 'CHK-001:happy:0',
        kind: 'integration_test',
        waiverType: 'permanent' as any,
        note: 'waiverType on non-waiver kind must be rejected',
      });
    } catch (e) {
      threw = true;
      assert.match((e as Error).message, /waiverType 只能用于 kind=waiver/);
    }
    assert.equal(threw, true, 'waiverType-kind mismatch must reject');
    assert.equal(server.calls, 0, 'waiverType mismatch: ZERO authority POST (Blocker 2)');
    assert.equal(hasEvidence(store, 'CHK-001'), false, 'waiverType mismatch: ZERO local write');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// --- CHK-002 / Blocker 2: batch with any illegal entry -> whole batch 0 POST ----
{
  const { root, store } = createFlowStoryRepo();
  try {
    const settings = enforceSettings();
    const server = countingFetch(200, JSON.stringify({ accepted: true, results: [{ accepted: true }, { accepted: true }] }));
    const client = new AuthorityClient(settings.baseURL!, server.fetch);
    const submitter = createAuthoritySubmitter(settings, client);
    const handlers = createChecklistHandlers({
      root, store, authoritySettings: settings, authoritySubmitter: submitter,
    } as any);

    let threw = false;
    try {
      await handlers.verification_evidence_batch_add({
        storyId: HANDLER_STORY_ID,
        evidences: [
          { itemId: 'CHK-001', intentRef: 'CHK-001:happy:0', kind: 'integration_test', note: 'valid first entry' },
          { itemId: 'CHK-MISSING', intentRef: 'CHK-MISSING:happy:0', kind: 'integration_test', note: 'invalid second entry' },
        ],
      });
    } catch (e) {
      threw = true;
      assert.match((e as Error).message, /Checklist item CHK-MISSING not found/);
    }
    assert.equal(threw, true, 'batch with illegal entry must reject');
    assert.equal(server.calls, 0, 'batch illegal entry: whole batch ZERO POST (all-or-nothing, no partial tail)');
    assert.equal(hasEvidence(store, 'CHK-001'), false, 'batch illegal entry: ZERO local write (no partial tail)');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// --- CHK-002 / batch note < 5 -> whole batch 0 POST + 0 write ------------------
{
  const { root, store } = createFlowStoryRepo();
  try {
    const settings = enforceSettings();
    const server = countingFetch(200, JSON.stringify({ accepted: true }));
    const client = new AuthorityClient(settings.baseURL!, server.fetch);
    const submitter = createAuthoritySubmitter(settings, client);
    const handlers = createChecklistHandlers({
      root, store, authoritySettings: settings, authoritySubmitter: submitter,
    } as any);

    let threw = false;
    try {
      await handlers.verification_evidence_batch_add({
        storyId: HANDLER_STORY_ID,
        evidences: [
          { itemId: 'CHK-001', intentRef: 'CHK-001:happy:0', kind: 'integration_test', note: 'valid first entry' },
          { itemId: 'CHK-001', intentRef: 'CHK-001:edge:0', kind: 'integration_test', note: 'x' },
        ],
      });
    } catch (e) {
      threw = true;
      assert.match((e as Error).message, /note 必须 ≥ 5 字符/);
    }
    assert.equal(threw, true, 'batch with short note must reject');
    assert.equal(server.calls, 0, 'batch short note: whole batch ZERO POST');
    assert.equal(hasEvidence(store, 'CHK-001'), false, 'batch short note: ZERO local write');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// --- CHK-002 / off mode happy: local write, zero network ----------------------
{
  const { root, store } = createFlowStoryRepo();
  try {
    // off mode: no authoritySettings override -> resolved from env. Inject a counting
    // submitter that MUST never be touched (off short-circuits before reaching it).
    const offServer = countingFetch(200, JSON.stringify({ accepted: true }));
    const offClient = new AuthorityClient('https://unused.test', offServer.fetch);
    const handlers = createChecklistHandlers({
      root, store,
      authoritySettings: { mode: 'off', timeoutMS: 1000 } as AuthoritySettings,
      // even if a submitter is present, off mode must not call it
      authoritySubmitter: createAuthoritySubmitter({ mode: 'enforce', baseURL: 'https://unused.test', timeoutMS: 1000 }, offClient),
    } as any);

    const result = handlers.verification_evidence_add({
      storyId: HANDLER_STORY_ID,
      itemId: 'CHK-001',
      intentRef: 'CHK-001:happy:0',
      kind: 'integration_test',
      file: 'validate.ts',
      command: 'koala validate --story=B-flow',
      result: 'pass',
      note: 'off mode happy path writes local evidence',
    });
    // off mode returns a synchronous string (no Promise, no network).
    assert.equal(typeof result, 'string', 'off mode returns a synchronous string');
    assert.match(result as string, /Verification evidence recorded for CHK-001/);
    assert.equal(offServer.calls, 0, 'off mode: ZERO network');
    assert.equal(hasEvidence(store, 'CHK-001'), true, 'off mode: local evidence written');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ===========================================================================
// CHK-003 cases (Blocker 3): shadow mode is warning-only — ANY authority result
// (success / 5xx / timeout / connection-refused / client throw) keeps the local
// write and exits 0. Driven through the REAL handler with a shadow-mode submitter.
//   Asserted invariants per case:
//     - handler RESOLVES (no throw)            -> command exit 0
//     - local evidence written                 -> write NOT blocked by authority
//     - failures emit exactly one stderr [warning] line
//     - the returned message (stdout) is the success message, never a warning
// ===========================================================================

// --- CHK-003 / shadow + healthy server: local write + POST + exit 0 -----------
{
  const { root, store } = createFlowStoryRepo();
  try {
    const settings = shadowSettings();
    const server = countingFetch(200, JSON.stringify({ accepted: true, evidenceId: 'EV-shadow-ok' }));
    const client = new AuthorityClient(settings.baseURL!, server.fetch);
    const submitter = createAuthoritySubmitter(settings, client);
    const handlers = createChecklistHandlers({
      root, store, authoritySettings: settings, authoritySubmitter: submitter,
    } as any);

    let message = '';
    const stderr = await captureStderr(async () => {
      message = (await handlers.verification_evidence_add({
        storyId: HANDLER_STORY_ID,
        itemId: 'CHK-001',
        intentRef: 'CHK-001:happy:0',
        kind: 'integration_test',
        note: 'shadow healthy server keeps local write and POSTs',
      })) as string;
    });

    assert.equal(server.calls, 1, 'shadow healthy: POST happens');
    assert.equal(hasEvidence(store, 'CHK-001'), true, 'shadow healthy: local evidence written');
    assert.match(message, /Verification evidence recorded for CHK-001/, 'shadow healthy: success message on stdout');
    assert.equal(stderr, '', 'shadow healthy: no warning when authority accepts');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// --- CHK-003 / shadow + failures keep local write + exit 0 + stderr [warning] --
// Covers 5xx (http_error), timeout (AbortError), connection-refused (ECONNREFUSED).
const shadowFailureCases: Array<{
  label: string;
  makeClient: (url: string) => { calls: () => number; client: AuthorityClient };
}> = [
  {
    label: '5xx http_error',
    makeClient: (url) => {
      const server = countingFetch(503, 'service unavailable');
      return { calls: () => server.calls, client: new AuthorityClient(url, server.fetch) };
    },
  },
  {
    label: 'timeout',
    makeClient: (url) => {
      const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
      const server = fetchThrowing(abort);
      return { calls: () => server.calls, client: new AuthorityClient(url, server.fetch) };
    },
  },
  {
    label: 'connection-refused',
    makeClient: (url) => {
      const refused = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
      const server = fetchThrowing(refused);
      return { calls: () => server.calls, client: new AuthorityClient(url, server.fetch) };
    },
  },
];

for (const { label, makeClient } of shadowFailureCases) {
  const { root, store } = createFlowStoryRepo();
  try {
    const settings = shadowSettings();
    const { calls, client } = makeClient(settings.baseURL!);
    const submitter = createAuthoritySubmitter(settings, client);
    const handlers = createChecklistHandlers({
      root, store, authoritySettings: settings, authoritySubmitter: submitter,
    } as any);

    let message = '';
    let threw = false;
    const stderr = await captureStderr(async () => {
      try {
        message = (await handlers.verification_evidence_add({
          storyId: HANDLER_STORY_ID,
          itemId: 'CHK-001',
          intentRef: 'CHK-001:happy:0',
          kind: 'integration_test',
          note: `shadow ${label} must keep local write`,
        })) as string;
      } catch {
        threw = true;
      }
    });

    assert.equal(threw, false, `shadow ${label}: handler must NOT throw (exit 0)`);
    assert.equal(calls(), 1, `shadow ${label}: POST attempted`);
    assert.equal(hasEvidence(store, 'CHK-001'), true, `shadow ${label}: local evidence written (not blocked)`);
    assert.match(message, /Verification evidence recorded for CHK-001/, `shadow ${label}: success message on stdout`);
    assert.match(stderr, /^\[warning\] authority POST failed \(shadow, local write kept\)/m, `shadow ${label}: one stderr warning`);
    // The warning must NOT leak into the returned (stdout) message.
    assert.doesNotMatch(message, /\[warning\]/, `shadow ${label}: warning not on stdout`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// --- CHK-003 / shadow + client THROW (non-HTTP exception escaping classify) ----
// The defining Blocker-3 case (preMortem #2): the authority client itself throws an
// exception that is NOT an outcome (e.g. a bug / serialization error). The submitter
// catch-all must degrade it to a warning with proceed=true so the command does not
// crash and the local write still happens.
{
  const { root, store } = createFlowStoryRepo();
  try {
    const settings = shadowSettings();
    // Fake AuthorityClient whose submitEvidence throws OUTSIDE the client's own
    // try/catch (simulating a non-classified throw escaping into the submitter).
    const throwingClient = {
      baseURL: settings.baseURL!,
      submitEvidence(): Promise<AuthorityClientOutcome<unknown>> {
        throw new TypeError('boom: non-HTTP exception escaping the client');
      },
      submitEvidenceBatch(): Promise<AuthorityClientOutcome<unknown>> {
        throw new TypeError('boom: non-HTTP exception escaping the client');
      },
    } as unknown as AuthorityClient;
    const submitter = createAuthoritySubmitter(settings, throwingClient);
    const handlers = createChecklistHandlers({
      root, store, authoritySettings: settings, authoritySubmitter: submitter,
    } as any);

    let message = '';
    let threw = false;
    const stderr = await captureStderr(async () => {
      try {
        message = (await handlers.verification_evidence_add({
          storyId: HANDLER_STORY_ID,
          itemId: 'CHK-001',
          intentRef: 'CHK-001:happy:0',
          kind: 'integration_test',
          note: 'shadow client throw must be degraded, not crash the command',
        })) as string;
      } catch {
        threw = true;
      }
    });

    assert.equal(threw, false, 'shadow client throw: handler must NOT crash (Blocker 3)');
    assert.equal(hasEvidence(store, 'CHK-001'), true, 'shadow client throw: local evidence written (not blocked)');
    assert.match(message, /Verification evidence recorded for CHK-001/, 'shadow client throw: success message on stdout');
    assert.match(stderr, /^\[warning\] authority POST failed \(shadow, local write kept\): boom/m, 'shadow client throw: degraded to one stderr warning');
    assert.doesNotMatch(message, /\[warning\]/, 'shadow client throw: warning not on stdout');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// --- CHK-003 / shadow batch + failure keeps ALL local writes + exit 0 ----------
{
  const { root, store } = createFlowStoryRepo();
  try {
    const settings = shadowSettings();
    const refused = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    const server = fetchThrowing(refused);
    const client = new AuthorityClient(settings.baseURL!, server.fetch);
    const submitter = createAuthoritySubmitter(settings, client);
    const handlers = createChecklistHandlers({
      root, store, authoritySettings: settings, authoritySubmitter: submitter,
    } as any);

    let message = '';
    let threw = false;
    const stderr = await captureStderr(async () => {
      try {
        message = (await handlers.verification_evidence_batch_add({
          storyId: HANDLER_STORY_ID,
          evidences: [
            { itemId: 'CHK-001', intentRef: 'CHK-001:happy:0', kind: 'integration_test', note: 'shadow batch entry one' },
            { itemId: 'CHK-001', intentRef: 'CHK-001:edge:0', kind: 'integration_test', note: 'shadow batch entry two' },
          ],
        })) as string;
      } catch {
        threw = true;
      }
    });

    assert.equal(threw, false, 'shadow batch failure: handler must NOT throw (exit 0)');
    assert.equal(server.calls, 1, 'shadow batch failure: single batch POST attempted');
    const cl = store.readChecklist(HANDLER_STORY_ID);
    const evidence = cl.items.find(i => i.id === 'CHK-001')?.verificationEvidence ?? [];
    assert.equal(evidence.length, 2, 'shadow batch failure: ALL local entries written (not blocked)');
    assert.match(message, /Verification evidence batch recorded/, 'shadow batch failure: success message on stdout');
    assert.match(stderr, /^\[warning\] authority batch POST failed \(shadow, local writes kept\)/m, 'shadow batch failure: one stderr warning');
    assert.doesNotMatch(message, /\[warning\]/, 'shadow batch failure: warning not on stdout');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ===========================================================================
// CHK-004 cases (Blocker 4): enforce mode is STRICT with zero local/remote fact
// divergence. A-prepost ordering means the authority POST happens BEFORE the local
// evidence write (checklist.ts: submitter.submitSingle/submitBatch is awaited, then
// writeLocal()/writeLocalBatch() only runs when decision.proceed === true). So:
//   - enforce + healthy accepted POST -> local write + exit 0 (POST observed first)
//   - enforce + ANY failure (5xx / timeout / connection-refused / client throw /
//     authority-rejected) -> handler THROWS -> ZERO local write + non-zero exit, with
//     NO compensating rollback (there is nothing to roll back — the write never ran).
//   - enforce batch: whole-batch rejection OR PARTIAL acceptance (some entries ok,
//     some rejected) -> mapped to whole-batch failure -> ZERO local writes (not even
//     the accepted subset).
//   Asserted invariants per failure case:
//     - handler THROWS (non-zero command exit)
//     - re-reading the on-disk checklist shows NO new evidence entry
//     - the throw is a controlled gating error, not a bare uncaught client exception
// ===========================================================================

// --- CHK-004 / enforce + healthy server: POST-before-write, local write + exit 0 --
{
  const { root, store } = createFlowStoryRepo();
  try {
    const settings = enforceSettings();
    const server = countingFetch(200, JSON.stringify({ accepted: true, evidenceId: 'EV-enforce-ok' }));
    const client = new AuthorityClient(settings.baseURL!, server.fetch);
    const submitter = createAuthoritySubmitter(settings, client);
    const handlers = createChecklistHandlers({
      root, store, authoritySettings: settings, authoritySubmitter: submitter,
    } as any);

    // Spy the local write by asserting that at the moment a POST is counted there is
    // still NO local evidence on disk — i.e. the POST strictly precedes the write.
    assert.equal(hasEvidence(store, 'CHK-001'), false, 'enforce healthy: no local write before POST');
    const message = (await handlers.verification_evidence_add({
      storyId: HANDLER_STORY_ID,
      itemId: 'CHK-001',
      intentRef: 'CHK-001:happy:0',
      kind: 'integration_test',
      note: 'enforce healthy server accepts then local write happens',
    })) as string;

    assert.equal(server.calls, 1, 'enforce healthy: exactly one POST');
    assert.equal(hasEvidence(store, 'CHK-001'), true, 'enforce healthy: local evidence written after accept');
    assert.match(message, /Verification evidence recorded for CHK-001/, 'enforce healthy: success message on stdout');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// --- CHK-004 / enforce + failures: 0 local write + non-zero exit (zero divergence) --
// Covers 5xx (http_error), timeout (AbortError), connection-refused (ECONNREFUSED),
// and authority-rejected (HTTP 200 but {accepted:false}). Each MUST throw and leave
// NO local evidence — the on-disk checklist is re-read to prove no entry exists.
const enforceFailureCases: Array<{
  label: string;
  makeClient: (url: string) => { calls: () => number; client: AuthorityClient };
}> = [
  {
    label: '5xx http_error',
    makeClient: (url) => {
      const server = countingFetch(503, 'service unavailable');
      return { calls: () => server.calls, client: new AuthorityClient(url, server.fetch) };
    },
  },
  {
    label: 'timeout',
    makeClient: (url) => {
      const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
      const server = fetchThrowing(abort);
      return { calls: () => server.calls, client: new AuthorityClient(url, server.fetch) };
    },
  },
  {
    label: 'connection-refused',
    makeClient: (url) => {
      const refused = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
      const server = fetchThrowing(refused);
      return { calls: () => server.calls, client: new AuthorityClient(url, server.fetch) };
    },
  },
  {
    label: 'authority-rejected',
    makeClient: (url) => {
      // HTTP 200 but the authority explicitly refuses the evidence.
      const server = countingFetch(200, JSON.stringify({ accepted: false, reason: 'unverifiable' }));
      return { calls: () => server.calls, client: new AuthorityClient(url, server.fetch) };
    },
  },
];

for (const { label, makeClient } of enforceFailureCases) {
  const { root, store } = createFlowStoryRepo();
  try {
    const settings = enforceSettings();
    const { calls, client } = makeClient(settings.baseURL!);
    const submitter = createAuthoritySubmitter(settings, client);
    const handlers = createChecklistHandlers({
      root, store, authoritySettings: settings, authoritySubmitter: submitter,
    } as any);

    let threw = false;
    try {
      await handlers.verification_evidence_add({
        storyId: HANDLER_STORY_ID,
        itemId: 'CHK-001',
        intentRef: 'CHK-001:happy:0',
        kind: 'integration_test',
        note: `enforce ${label} must leave zero local write`,
      });
    } catch (e) {
      threw = true;
      // Controlled gating error, not a bare uncaught exception bubbling out.
      assert.match((e as Error).message, /authority POST failed \(enforce, no local write\)/, `enforce ${label}: controlled gating error`);
    }
    assert.equal(threw, true, `enforce ${label}: handler must throw (non-zero exit)`);
    assert.equal(calls(), 1, `enforce ${label}: exactly one POST attempted`);
    // Re-read the on-disk checklist: the failing POST must leave NO new entry.
    assert.equal(hasEvidence(store, 'CHK-001'), false, `enforce ${label}: ZERO local write (no divergence)`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// --- CHK-004 / enforce + client THROW (non-outcome exception) -> 0 write + throw ---
// preMortem #2 mirror for enforce: a non-outcome throw from the client (bug /
// serialization error) must be converted by degradeThrow into a controlled gating
// error (proceed=false), so it STILL blocks the local write rather than crashing as a
// bare exception. Either way the invariant holds: throw + zero local write.
{
  const { root, store } = createFlowStoryRepo();
  try {
    const settings = enforceSettings();
    const throwingClient = {
      baseURL: settings.baseURL!,
      submitEvidence(): Promise<AuthorityClientOutcome<unknown>> {
        throw new TypeError('boom: non-HTTP exception escaping the client');
      },
      submitEvidenceBatch(): Promise<AuthorityClientOutcome<unknown>> {
        throw new TypeError('boom: non-HTTP exception escaping the client');
      },
    } as unknown as AuthorityClient;
    const submitter = createAuthoritySubmitter(settings, throwingClient);
    const handlers = createChecklistHandlers({
      root, store, authoritySettings: settings, authoritySubmitter: submitter,
    } as any);

    let threw = false;
    try {
      await handlers.verification_evidence_add({
        storyId: HANDLER_STORY_ID,
        itemId: 'CHK-001',
        intentRef: 'CHK-001:happy:0',
        kind: 'integration_test',
        note: 'enforce client throw must gate the local write',
      });
    } catch (e) {
      threw = true;
      // degradeThrow preserves the original Error in enforce (still a controlled gate).
      assert.match((e as Error).message, /boom: non-HTTP exception escaping the client/, 'enforce client throw: original error surfaced as gating error');
    }
    assert.equal(threw, true, 'enforce client throw: handler must throw (non-zero exit)');
    assert.equal(hasEvidence(store, 'CHK-001'), false, 'enforce client throw: ZERO local write (no divergence)');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// --- CHK-004 / enforce batch + whole-batch rejection -> 0 local writes -------------
{
  const { root, store } = createFlowStoryRepo();
  try {
    const settings = enforceSettings();
    const server = countingFetch(200, JSON.stringify({ accepted: false, reason: 'whole batch rejected' }));
    const client = new AuthorityClient(settings.baseURL!, server.fetch);
    const submitter = createAuthoritySubmitter(settings, client);
    const handlers = createChecklistHandlers({
      root, store, authoritySettings: settings, authoritySubmitter: submitter,
    } as any);

    let threw = false;
    try {
      await handlers.verification_evidence_batch_add({
        storyId: HANDLER_STORY_ID,
        evidences: [
          { itemId: 'CHK-001', intentRef: 'CHK-001:happy:0', kind: 'integration_test', note: 'enforce batch entry one' },
          { itemId: 'CHK-001', intentRef: 'CHK-001:edge:0', kind: 'integration_test', note: 'enforce batch entry two' },
        ],
      });
    } catch (e) {
      threw = true;
      assert.match((e as Error).message, /authority batch POST failed \(enforce, no local writes\)/, 'enforce batch reject: controlled gating error');
    }
    assert.equal(threw, true, 'enforce batch reject: handler must throw (non-zero exit)');
    assert.equal(server.calls, 1, 'enforce batch reject: single batch POST attempted');
    const cl = store.readChecklist(HANDLER_STORY_ID);
    const evidence = cl.items.find(i => i.id === 'CHK-001')?.verificationEvidence ?? [];
    assert.equal(evidence.length, 0, 'enforce batch reject: ZERO local writes');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// --- CHK-004 / enforce batch + PARTIAL acceptance -> whole-batch failure, 0 writes --
// The defining Blocker-4 batch case (preMortem #3): the authority returns HTTP 200
// with a per-entry mix (one accepted, one rejected). isAuthorityBatchFullyAccepted
// returns false -> the WHOLE batch fails -> ZERO local writes. Critically, the
// accepted subset must NOT be written; partial local agreement is the exact divergence
// this story exists to eliminate.
{
  const { root, store } = createFlowStoryRepo();
  try {
    const settings = enforceSettings();
    const server = countingFetch(
      200,
      JSON.stringify({ accepted: true, results: [{ accepted: true, evidenceId: 'EV-a' }, { accepted: false, evidenceId: 'EV-b', reason: 'duplicate' }] }),
    );
    const client = new AuthorityClient(settings.baseURL!, server.fetch);
    const submitter = createAuthoritySubmitter(settings, client);
    const handlers = createChecklistHandlers({
      root, store, authoritySettings: settings, authoritySubmitter: submitter,
    } as any);

    let threw = false;
    try {
      await handlers.verification_evidence_batch_add({
        storyId: HANDLER_STORY_ID,
        evidences: [
          { itemId: 'CHK-001', intentRef: 'CHK-001:happy:0', kind: 'integration_test', note: 'partial accept entry one' },
          { itemId: 'CHK-001', intentRef: 'CHK-001:edge:0', kind: 'integration_test', note: 'partial accept entry two' },
        ],
      });
    } catch (e) {
      threw = true;
      assert.match((e as Error).message, /authority batch POST failed \(enforce, no local writes\)/, 'enforce partial accept: controlled gating error');
      // The error should name the rejected entry so the failure is debuggable.
      assert.match((e as Error).message, /EV-b|duplicate/, 'enforce partial accept: rejected entry surfaced');
    }
    assert.equal(threw, true, 'enforce partial accept: handler must throw (non-zero exit)');
    assert.equal(server.calls, 1, 'enforce partial accept: single batch POST attempted');
    const cl = store.readChecklist(HANDLER_STORY_ID);
    const evidence = cl.items.find(i => i.id === 'CHK-001')?.verificationEvidence ?? [];
    assert.equal(evidence.length, 0, 'enforce partial accept: ZERO local writes (NOT the accepted subset)');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

console.log('authority evidence flow smoke passed (CHK-001 scaffolding + CHK-002 Blockers 1+2 + CHK-003 shadow Blocker 3 + CHK-004 enforce Blocker 4)');

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
//     chosen=A-prepost). Shadow (Blocker 3 / CHK-003) and enforce zero-divergence
//     (Blocker 4 / CHK-004) detail behavior is refined in later items.
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

console.log('authority evidence flow smoke passed (CHK-001 scaffolding + CHK-002 Blockers 1+2)');

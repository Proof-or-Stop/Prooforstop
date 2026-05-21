#!/usr/bin/env node
//
// End-to-end authority evidence flow smoke.
//
// SCOPE NOTE (B-94a6): CHK-001 only lands the authority subsystem scaffolding and
// does NOT wire authority POST into checklist.ts. The local-validation-first
// invariant (Blocker 1+2 / CHK-002), shadow warning-only behavior (Blocker 3 /
// CHK-003) and enforce zero-divergence behavior (Blocker 4 / CHK-004) are added in
// later items, which will extend this file with cases driven through the real
// verification_evidence_add / batch_add handlers.
//
// For CHK-001 this smoke proves the foundation those cases rely on:
//   - off mode performs zero authority interaction (the default, byte-equivalent
//     to post-B-2157 main),
//   - the client + contracts compose into a single submit -> outcome -> accept flow,
//   - a failing authority server is observable as a non-success outcome (so shadow
//     can degrade it and enforce can gate on it).
//
import assert from 'node:assert/strict';
import {
  AuthorityClient,
  type AuthorityFetch,
} from '../core/authority-client.js';
import {
  authorityModeEnabled,
  loadAuthoritySettings,
} from '../core/authority-mode.js';
import {
  isAuthorityBatchFullyAccepted,
  type EvidenceEnvelopeContract,
} from '../core/authority-contracts.js';
import { EvidenceCollector } from '../core/evidence-collector.js';

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

console.log('authority evidence flow smoke passed (CHK-001 scaffolding)');

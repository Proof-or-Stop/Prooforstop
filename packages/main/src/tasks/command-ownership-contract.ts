#!/usr/bin/env node
/**
 * @task B-c55d
 * @checklist CHK-002
 * @title command ownership classification contract
 * @type chore
 * @priority high
 * @description
 *   B-c55d CHK-002: enforce that the story owner lease ownership classification
 *   covers every CLI-dispatchable command with no gaps.
 *
 *   The CLI choke-point gate (`enforceStoryOwnerLeaseGate` in `cli-engine.ts`)
 *   only ever sees commands that `runCli` dispatches — i.e. commands present in
 *   `MAIN_TOOLS` (the CLI command schema). `MAIN_TOOLS` is therefore the
 *   authoritative "command registry" for ownership classification: a registry
 *   handler not in `MAIN_TOOLS` (e.g. `dev_start`, `story_sync_main`, the
 *   internal `_nextStoryId` helper) is NOT externally dispatchable and never
 *   reaches the gate.
 *
 *   This contract enumerates the REAL `MAIN_TOOLS` command set (not a
 *   hand-written table that can silently drift) and asserts:
 *
 *     1. COVERAGE — every `MAIN_TOOLS` command has a `CommandPolicy` entry whose
 *        `ownershipClass` is a valid `OwnershipClass` enum value. A missing
 *        policy entry OR a missing/invalid `ownershipClass` FAILS the contract
 *        (the gate would fail-closed-reject such a command).
 *
 *     2. DISPATCHABILITY — every `MAIN_TOOLS` command has a registered handler
 *        in `createMainRegistry` (except `dashboard`, which runs as a standalone
 *        mode), so a classified command can actually be invoked.
 *
 *     3. FAIL-CLOSED — `resolveEffectiveOwnershipClass` returns `null` for an
 *        unclassified command, which the gate rejects rather than default-allows.
 *
 *     4. BOUNDARY RULES — the three dynamic boundary rules from
 *        session-ownership-and-write-leases.md resolve as ruled: a B-META
 *        finding mutation downgrades to `mainSharedMutating`; a diagnostic
 *        `validate` without `--story` downgrades to `readOnly` while
 *        `validate --story` is `storyScopedMutating`; `delivery_check_set` is
 *        `reviewerWrite` only for the `proof-or-stop-review-delivery` actor.
 *
 *     5. GATE BEHAVIOR — `enforceStoryOwnerLeaseGate` itself: a non-owner
 *        session running an owner-gated storyScopedMutating command on a story
 *        with a FOREIGN lease is rejected with owner guidance; a read-only
 *        command on the same story is allowed; a reviewerWrite command is
 *        allowed (owner-lease exempt).
 *
 *   Fails with a NAMED command / divergence, never a generic message.
 * @changes
 *   - [CHK-002] Add command ownership classification contract
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StoryStore } from '../core/store.js';
import { PROOF_OR_STOP_DIR } from '../core/proof-or-stop-paths.js';
import { createMainRegistry } from '../registry.js';
import type { HandlerContext } from '../handlers/context.js';
import {
  OWNERSHIP_CLASSES,
  getCommandPolicy,
  isOwnershipClass,
} from '../core/command-policy.js';
import {
  MAIN_TOOLS,
  resolveEffectiveOwnershipClass,
  isDeliveryReviewerActor,
  enforceStoryOwnerLeaseGate,
  REVIEWER_READONLY_ENV,
  isReviewerReadOnlyModeEnabled,
  enforceReviewerReadOnlyCommandGate,
  ownerLeaseHelpBlock,
  storyIdFromArgs,
} from '../cli-engine.js';
import {
  acquireOwnerLease,
  ownerLeasePath,
  resetSessionIdForTest,
} from '../core/story-owner-lease.js';

/** A single named divergence between MAIN_TOOLS and the ownership table. */
interface Divergence {
  source: string;
  detail: string;
}

const divergences: Divergence[] = [];
function record(source: string, detail: string): void {
  divergences.push({ source, detail });
}

/**
 * `dashboard` is the one CLI command that does NOT have a handler in the
 * registry: `runCli` dispatches it as a standalone long-lived mode before the
 * registry is consulted. It still needs an ownershipClass (readOnly), so the
 * dispatchability check exempts it from the "has a registered handler" rule.
 */
const STANDALONE_COMMANDS = new Set<string>(['dashboard']);

const root = join(tmpdir(), `proof-or-stop-command-ownership-contract-${process.pid}-${Date.now()}`);
mkdirSync(root, { recursive: true });

try {
  const store = new StoryStore(root);
  const ctx: HandlerContext = { store, root, scanRoot: join(root, 'packages/main') };
  const registry = createMainRegistry(ctx);
  const registeredSet = new Set<string>(registry.list());

  // MAIN_TOOLS is the authoritative CLI command registry the gate operates on.
  const cliCommands = MAIN_TOOLS.map((t) => t.name).sort();
  assert.ok(cliCommands.length > 0, 'MAIN_TOOLS must enumerate at least one command');

  // ── 1. COVERAGE — every CLI command has a valid ownershipClass ───────────
  for (const command of cliCommands) {
    const policy = getCommandPolicy(command);
    if (!policy) {
      record(
        'coverage',
        `CLI command "${command}" has no CommandPolicy entry — it has no ownershipClass and the owner-lease gate would reject it fail-closed`,
      );
      continue;
    }
    if (!isOwnershipClass(policy.ownershipClass)) {
      record(
        'coverage',
        `CLI command "${command}" has CommandPolicy.ownershipClass=${JSON.stringify(policy.ownershipClass)}, which is not a valid OwnershipClass (one of ${OWNERSHIP_CLASSES.join(', ')})`,
      );
    }
  }

  // ── 2. DISPATCHABILITY — every CLI command has a registered handler ──────
  for (const command of cliCommands) {
    if (STANDALONE_COMMANDS.has(command)) continue;
    if (!registeredSet.has(command)) {
      record(
        'dispatchability',
        `CLI command "${command}" is in MAIN_TOOLS but has no registered handler in createMainRegistry — it is classified but cannot be invoked`,
      );
    }
  }

  // ── 3. FAIL-CLOSED — an unclassified command resolves to null (rejected) ─
  {
    const unknown = resolveEffectiveOwnershipClass('no_such_command_xyz', {}, 'B-c55d');
    assert.equal(
      unknown,
      null,
      'an unclassified command must resolve to null so the gate rejects it fail-closed (never default-allow)',
    );
    // A real read-only command resolves and is NOT null — the gate lets it run.
    const readOnly = resolveEffectiveOwnershipClass('story_get', {}, 'B-c55d');
    assert.equal(readOnly, 'readOnly', 'story_get resolves to readOnly');
  }

  // ── 4. BOUNDARY RULES — the three dynamic rules resolve as ruled ─────────
  {
    // Rule 1: finding_resolve / finding_dismiss — normal story vs B-META.
    assert.equal(
      resolveEffectiveOwnershipClass('finding_resolve', {}, 'B-c55d'),
      'storyScopedMutating',
      'finding_resolve on a normal story is owner-gated storyScopedMutating',
    );
    assert.equal(
      resolveEffectiveOwnershipClass('finding_resolve', {}, 'B-META-framework-audit'),
      'mainSharedMutating',
      'finding_resolve on a B-META story downgrades to mainSharedMutating (main write lock, not owner lease)',
    );
    assert.equal(
      resolveEffectiveOwnershipClass('finding_dismiss', {}, 'B-META-framework-audit'),
      'mainSharedMutating',
      'finding_dismiss on a B-META story downgrades to mainSharedMutating',
    );

    // Rule 2: validate — diagnostic (no --story) vs story-scoped.
    assert.equal(
      resolveEffectiveOwnershipClass('validate', {}, null),
      'readOnly',
      'a diagnostic validate without --story is readOnly (mutates no story state)',
    );
    assert.equal(
      resolveEffectiveOwnershipClass('validate', { story: 'B-c55d' }, 'B-c55d'),
      'storyScopedMutating',
      'validate --story=B-xxx is owner-gated storyScopedMutating (writes story evidence)',
    );
    assert.equal(
      resolveEffectiveOwnershipClass('validate', { story: '   ' }, null),
      'readOnly',
      'validate with a blank --story is still treated as diagnostic readOnly',
    );

    // Rule 2b: plan_skeleton — preview is readOnly, but explicit --write
    // delegates to planning/checklist writers and must be owner-gated.
    assert.equal(
      getCommandPolicy('plan_skeleton')!.ownershipClass,
      'readOnly',
      'plan_skeleton static policy remains readOnly so the default preview is ungated',
    );
    assert.equal(
      resolveEffectiveOwnershipClass('plan_skeleton', { storyId: 'B-c55d' }, 'B-c55d'),
      'readOnly',
      'plan_skeleton without --write remains effectively readOnly',
    );
    assert.equal(
      resolveEffectiveOwnershipClass('plan_skeleton', { storyId: 'B-c55d', write: true }, 'B-c55d'),
      'storyScopedMutating',
      'plan_skeleton --write is owner-gated storyScopedMutating because it writes understanding/checklist metadata',
    );

    // Rule 3: delivery_check_set — reviewerWrite only for the delivery reviewer.
    const savedAgent = process.env.PROOF_OR_STOP_AGENT;
    delete process.env.PROOF_OR_STOP_AGENT;
    assert.equal(
      isDeliveryReviewerActor({ agentId: 'proof-or-stop-review-delivery' }),
      true,
      'agentId=proof-or-stop-review-delivery is recognised as the delivery reviewer actor',
    );
    assert.equal(
      isDeliveryReviewerActor({ agentId: 'main' }),
      false,
      'a non-delivery agentId is not the delivery reviewer actor',
    );
    assert.equal(
      resolveEffectiveOwnershipClass('delivery_check_set', { agentId: 'proof-or-stop-review-delivery' }, 'B-c55d'),
      'reviewerWrite',
      'canonical delivery reviewer is reviewerWrite (owner-lease exempt)',
    );
    assert.equal(
      resolveEffectiveOwnershipClass('delivery_check_set', { agentId: 'lattice-review-delivery' }, 'B-c55d'),
      'reviewerWrite',
      'delivery_check_set by the delivery reviewer is reviewerWrite (owner-lease exempt)',
    );
    assert.equal(
      resolveEffectiveOwnershipClass('delivery_check_set', { agentId: 'main' }, 'B-c55d'),
      'storyScopedMutating',
      'delivery_check_set by a non-delivery actor is owner-gated storyScopedMutating — a main agent cannot borrow it to bypass the owner lease',
    );
    // PROOF_OR_STOP_AGENT env fallback is honored when no explicit agentId is given.
    process.env.PROOF_OR_STOP_AGENT = 'proof-or-stop-review-delivery';
    assert.equal(
      isDeliveryReviewerActor({}),
      true,
      'PROOF_OR_STOP_AGENT=proof-or-stop-review-delivery is honored as the delivery reviewer actor fallback',
    );
    process.env.PROOF_OR_STOP_AGENT = 'main';
    assert.equal(
      resolveEffectiveOwnershipClass('delivery_check_set', {}, 'B-c55d'),
      'storyScopedMutating',
      'delivery_check_set with PROOF_OR_STOP_AGENT=main is owner-gated storyScopedMutating',
    );
    if (savedAgent === undefined) delete process.env.PROOF_OR_STOP_AGENT;
    else process.env.PROOF_OR_STOP_AGENT = savedAgent;
  }

  // ── 4b. GUARD SESSION WRITE CLASSIFICATION (B-6bfd F-001 regression) ──────
  // guard_session_check persists guard-session.json and appends a process event
  // on every invocation; it MUST be classified as an owner-gated story-scoped
  // metadata write, not readOnly. A drift back to readOnly would let a non-owner
  // session overwrite another story's guard session state.
  {
    const checkPolicy = getCommandPolicy('guard_session_check');
    assert.ok(checkPolicy, 'guard_session_check must have a CommandPolicy entry');
    assert.equal(
      checkPolicy!.ownershipClass,
      'storyScopedMutating',
      'guard_session_check writes guard-session.json + a process event, so it must be storyScopedMutating (regression of B-6bfd F-001)',
    );
    assert.equal(
      checkPolicy!.destructiveRisk,
      'metadata-write',
      'guard_session_check persists story metadata, so its destructiveRisk must be metadata-write',
    );
    assert.ok(
      !/without mutating story metadata/i.test(checkPolicy!.reason),
      'guard_session_check reason must not claim it runs "without mutating story metadata" — it records forbidden writes (B-6bfd F-001)',
    );
    assert.equal(
      resolveEffectiveOwnershipClass('guard_session_check', { storyId: 'B-c55d' }, 'B-c55d'),
      'storyScopedMutating',
      'guard_session_check resolves to owner-gated storyScopedMutating',
    );
    // Sibling write command guard_session_start stays consistent with it.
    assert.equal(
      getCommandPolicy('guard_session_start')!.ownershipClass,
      'storyScopedMutating',
      'guard_session_start (the sibling write command) remains storyScopedMutating',
    );
  }

  // ── 4c. SCOPE EVIDENCE PHASE CONTRACT (B-4622 CHK-002) ───────────────────
  // scope_check_save is signed PLAN scope review evidence consumed by
  // story_review; scope_contract_acknowledge is the DEV/REVIEW later-phase
  // scope acknowledgement path. A later-phase acknowledgement is NOT a
  // replacement for a PLAN scope reviewer pass, so the two commands must keep
  // disjoint phase windows. If a future lifecycle edit broadened
  // scope_check_save into DEV/REVIEW (or shrank the acknowledgement window),
  // these assertions FAIL with a named command.
  {
    const scopeCheckPolicy = getCommandPolicy('scope_check_save');
    assert.ok(scopeCheckPolicy, 'scope_check_save must have a CommandPolicy entry');
    // scope_check_save allowedPhases: PLAN — exactly PLAN, nothing else.
    assert.deepEqual(
      scopeCheckPolicy!.allowedPhases,
      ['PLAN'],
      'scope_check_save allowedPhases must be exactly [\'PLAN\'] — it is signed PLAN scope review evidence, not a later-phase write (B-4622 CHK-002)',
    );
    // Adversarial: widening scope_check_save to DEV or REVIEW fails this test.
    const scopeCheckPhases = scopeCheckPolicy!.allowedPhases;
    // Array.isArray here also excludes the 'all' wildcard window.
    assert.ok(
      Array.isArray(scopeCheckPhases) &&
        !scopeCheckPhases.includes('DEV') &&
        !scopeCheckPhases.includes('REVIEW'),
      'scope_check_save must NOT be broadened to DEV/REVIEW (or \'all\') — later-phase scope changes use scope_contract_acknowledge, which is not a replacement for a PLAN scope reviewer pass (B-4622 CHK-002)',
    );

    const scopeAckPolicy = getCommandPolicy('scope_contract_acknowledge');
    assert.ok(scopeAckPolicy, 'scope_contract_acknowledge must have a CommandPolicy entry');
    // scope_contract_acknowledge allowedPhases: DEV, REVIEW — exactly those two.
    assert.deepEqual(
      scopeAckPolicy!.allowedPhases,
      ['DEV', 'REVIEW'],
      'scope_contract_acknowledge allowedPhases must be exactly [\'DEV\', \'REVIEW\'] — it is the later-phase scope acknowledgement path and must not regress to PLAN-only or be removed (B-4622 CHK-002)',
    );
    // The two scope commands keep disjoint phase windows.
    assert.ok(
      Array.isArray(scopeAckPolicy!.allowedPhases) &&
        !scopeAckPolicy!.allowedPhases.includes('PLAN'),
      'scope_contract_acknowledge must NOT cover PLAN — PLAN scope evidence is scope_check_save\'s exclusive window (B-4622 CHK-002)',
    );
  }

  // ── 5. GATE BEHAVIOR — enforceStoryOwnerLeaseGate fail-closed rejection ──
  {
    const savedSession = process.env.PROOF_OR_STOP_SESSION_ID;
    try {
      // Set up a story dir owned by session "sess-owner" (a FOREIGN session).
      const storyId = 'B-gate1';
      const storyDir = store.storyDirPath(storyId);
      mkdirSync(storyDir, { recursive: true });
      process.env.PROOF_OR_STOP_SESSION_ID = 'sess-owner';
      resetSessionIdForTest();
      acquireOwnerLease(storyDir, { command: 'checklist_update', cwd: '/tmp/owner-worktree' });
      const leaseBefore = readFileSync(ownerLeasePath(storyDir), 'utf-8');

      // Now act AS a different session "sess-intruder".
      process.env.PROOF_OR_STOP_SESSION_ID = 'sess-intruder';
      resetSessionIdForTest();

      // 5a. An owner-gated storyScopedMutating command is REJECTED fail-closed.
      assert.throws(
        () => enforceStoryOwnerLeaseGate('checklist_update', { storyId }, store, null, root),
        (err: Error) =>
          err.message.includes(storyId) &&
          err.message.includes('sess-owner') &&
          err.message.includes('owner-gated'),
        'a non-owner running an owner-gated storyScopedMutating command is rejected with owner guidance',
      );
      // The rejection performed NO write — the foreign lease is untouched.
      assert.equal(
        readFileSync(ownerLeasePath(storyDir), 'utf-8'),
        leaseBefore,
        'a rejected non-owner command performs no lease write (no silent steal)',
      );

      // 5a-bis. guard_session_check (B-6bfd F-001) is an owner-gated write, so a
      // non-owner session running it against a foreign-owned story is REJECTED.
      assert.throws(
        () => enforceStoryOwnerLeaseGate('guard_session_check', { storyId }, store, null, root),
        (err: Error) =>
          err.message.includes(storyId) &&
          err.message.includes('sess-owner') &&
          err.message.includes('owner-gated'),
        'guard_session_check on a foreign-owned story is rejected fail-closed (it writes guard-session.json)',
      );
      assert.equal(
        readFileSync(ownerLeasePath(storyDir), 'utf-8'),
        leaseBefore,
        'a rejected guard_session_check performs no lease write (no silent steal)',
      );

      // 5b. The reviewer read-only flow on the SAME foreign-owned story is
      // ALWAYS ALLOWED — B-c55d CHK-004 confirms the owner lease never blocks a
      // reviewer's inspection commands (story_get / checklist_get / finding_list
      // / session_brief are classified readOnly, so the gate returns early).
      for (const roCmd of ['story_get', 'checklist_get', 'finding_list', 'session_brief']) {
        assert.doesNotThrow(
          () => enforceStoryOwnerLeaseGate(roCmd, { storyId }, store, null, root),
          `${roCmd} (read-only reviewer flow) on a foreign-owned story is never gated`,
        );
      }

      // 5c. A reviewerWrite command on the SAME foreign-owned story is ALLOWED
      // (the owner lease exempts reviewer-lane writes).
      assert.doesNotThrow(
        () => enforceStoryOwnerLeaseGate('review_pass_set', { storyId }, store, null, root),
        'review_pass_set (reviewerWrite) on a foreign-owned story is owner-lease exempt',
      );

      // 5d. A diagnostic validate without --story is readOnly → allowed even on
      // a foreign-owned active story.
      assert.doesNotThrow(
        () => enforceStoryOwnerLeaseGate('validate', {}, store, { storyId, phase: 'DEV' }, root),
        'a diagnostic validate without --story is readOnly and is not gated',
      );
      // But validate --story on a foreign-owned story IS rejected.
      assert.throws(
        () => enforceStoryOwnerLeaseGate('validate', { story: storyId }, store, null, root),
        (err: Error) => err.message.includes(storyId) && err.message.includes('owner-gated'),
        'validate --story on a foreign-owned story is rejected fail-closed',
      );
      assert.doesNotThrow(
        () => enforceStoryOwnerLeaseGate('plan_skeleton', { storyId }, store, null, root),
        'plan_skeleton preview on a foreign-owned story is readOnly and is not gated',
      );
      assert.throws(
        () => enforceStoryOwnerLeaseGate('plan_skeleton', { storyId, write: true }, store, null, root),
        (err: Error) => err.message.includes(storyId) && err.message.includes('owner-gated'),
        'plan_skeleton --write on a foreign-owned story is rejected fail-closed',
      );

      // 5e. An owner-gated command on a story THIS session owns is allowed
      // (acquire/refresh, not foreign).
      const ownStoryId = 'B-gate2';
      const ownStoryDir = store.storyDirPath(ownStoryId);
      mkdirSync(ownStoryDir, { recursive: true });
      assert.doesNotThrow(
        () => enforceStoryOwnerLeaseGate('checklist_update', { storyId: ownStoryId }, store, null, root),
        'an owner-gated command on a story with no prior lease acquires it and is allowed',
      );
      assert.equal(
        existsSync(ownerLeasePath(ownStoryDir)),
        true,
        'the owner-gated command acquired the lease for the previously unowned story',
      );
      assert.doesNotThrow(
        () => enforceStoryOwnerLeaseGate('checklist_update', { storyId: ownStoryId }, store, null, root),
        'the owning session re-running an owner-gated command refreshes the lease and is allowed',
      );

      // F-041: run-only reconciliation commands resolve the immutable run
      // subject before consulting the active Story (including from root cwd).
      const managedRunId = 'ownership-managed-run';
      const managedRunDir = join(root, PROOF_OR_STOP_DIR, 'runtime', 'host-runs', managedRunId);
      mkdirSync(managedRunDir, { recursive: true });
      const managedSpec = `${JSON.stringify({
        schemaVersion: 'lattice.managed_host_run.v1',
        runId: managedRunId,
        storyId,
      })}\n`;
      writeFileSync(join(managedRunDir, 'spec.json'), managedSpec);
      writeFileSync(join(managedRunDir, 'owner.json'), `${JSON.stringify({
        schemaVersion: 'lattice.managed_host_run.v1',
        runId: managedRunId,
        specDigest: `sha256:${createHash('sha256').update(managedSpec).digest('hex')}`,
      })}\n`);
      assert.equal(
        storyIdFromArgs({ runId: managedRunId }, { storyId: ownStoryId }, { command: 'host_run_cancel', projectRoot: root }),
        storyId,
        'cross-Story cancellation resolves spec.storyId instead of the unrelated active Story',
      );
      assert.equal(
        storyIdFromArgs({ runId: managedRunId }, null, { command: 'host_run_status', projectRoot: root }),
        storyId,
        'root-cwd run reconciliation resolves the immutable managed run Story subject',
      );
      for (const command of ['host_run_cancel', 'host_run_status'] as const) {
        assert.throws(
          () => enforceStoryOwnerLeaseGate(command, { runId: managedRunId }, store, { storyId: ownStoryId }, root),
          (err: Error) => err.message.includes(storyId) && err.message.includes('owner-gated'),
          `${command} rejects the foreign run owner even when another active Story is locally owned`,
        );
        assert.throws(
          () => enforceStoryOwnerLeaseGate(command, { runId: managedRunId }, store, null, root),
          (err: Error) => err.message.includes(storyId) && err.message.includes('owner-gated'),
          `${command} rejects the foreign run owner from root cwd without an active Story`,
        );
      }

      // 5f. An unclassified command is rejected fail-closed by the gate.
      assert.throws(
        () => enforceStoryOwnerLeaseGate('no_such_command_xyz', { storyId }, store, null, root),
        (err: Error) => err.message.includes('no valid ownershipClass') && err.message.includes('fail-closed'),
        'an unclassified command is rejected fail-closed by the gate, never default-allowed',
      );
    } finally {
      if (savedSession === undefined) delete process.env.PROOF_OR_STOP_SESSION_ID;
      else process.env.PROOF_OR_STOP_SESSION_ID = savedSession;
      resetSessionIdForTest();
    }
  }

  // ── 6. REVIEWER READ-ONLY COMMAND GATE (B-4f15 CHK-002) ─────────────────
  // enforceReviewerReadOnlyCommandGate is the pre-lease read-only fence for
  // reviewer agents running under PROOF_OR_STOP_REVIEWER_READONLY=1.  This section
  // asserts all documented behaviours so a future refactor breaks loudly.
  {
    const savedRO = process.env[REVIEWER_READONLY_ENV];
    try {
      // 6a. Env detection.
      delete process.env[REVIEWER_READONLY_ENV];
      assert.equal(isReviewerReadOnlyModeEnabled(), false, 'PROOF_OR_STOP_REVIEWER_READONLY unset → disabled');
      process.env[REVIEWER_READONLY_ENV] = '1';
      assert.equal(isReviewerReadOnlyModeEnabled(), true, 'PROOF_OR_STOP_REVIEWER_READONLY=1 → enabled');
      process.env[REVIEWER_READONLY_ENV] = '0';
      assert.equal(isReviewerReadOnlyModeEnabled(), false, 'PROOF_OR_STOP_REVIEWER_READONLY=0 → disabled (only "1" enables)');

      // 6b. With env enabled, readOnly commands are allowed.
      process.env[REVIEWER_READONLY_ENV] = '1';
      assert.doesNotThrow(
        () => enforceReviewerReadOnlyCommandGate('story_get', {}, null),
        'story_get (readOnly) is allowed in read-only reviewer mode',
      );
      // validate without --story downgrades to readOnly (boundary rule 2).
      assert.doesNotThrow(
        () => enforceReviewerReadOnlyCommandGate('validate', {}, null),
        'diagnostic validate (no --story, readOnly) is allowed in read-only reviewer mode',
      );
      assert.doesNotThrow(
        () => enforceReviewerReadOnlyCommandGate('plan_skeleton', { storyId: 'B-4f15' }, null),
        'plan_skeleton preview (readOnly) is allowed in read-only reviewer mode',
      );

      // 6c. reviewerWrite commands are blocked — even though they are
      // owner-lease exempt, they are NOT readOnly and must be rejected.
      for (const rwCmd of ['review_pass_set', 'finding_add', 'review_run_start', 'init_check_set']) {
        assert.throws(
          () => enforceReviewerReadOnlyCommandGate(rwCmd, {}, null),
          (err: Error) =>
            err.message.includes(REVIEWER_READONLY_ENV) && err.message.includes(rwCmd),
          `${rwCmd} (reviewerWrite) is blocked in read-only reviewer mode`,
        );
      }

      // 6d. storyScopedMutating / mainSharedMutating / dangerousMutating / unclassified
      // commands are all blocked.
      const blockedExamples: [string, Record<string, unknown>][] = [
        // storyScopedMutating — story_advance without --forceTakeover
        ['story_advance', { storyId: 'B-4f15' }],
        // storyScopedMutating with --forceTakeover flag (still owner-gated)
        ['story_advance', { storyId: 'B-4f15', forceTakeover: true }],
        // storyScopedMutating
        ['verification_evidence_add', { storyId: 'B-4f15' }],
        ['plan_skeleton', { storyId: 'B-4f15', write: true }],
        // mainSharedMutating
        ['gap_log', {}],
        ['audit', {}],
        // unclassified
        ['no_such_command_xyz', {}],
      ];
      for (const [cmd, args] of blockedExamples) {
        assert.throws(
          () => enforceReviewerReadOnlyCommandGate(cmd, args, null),
          (err: Error) => err.message.includes(REVIEWER_READONLY_ENV),
          `${cmd} is blocked in read-only reviewer mode`,
        );
      }

      // 6e. Without the env var, the gate is a no-op — reviewerWrite commands
      // are not rejected here (they reach enforceStoryOwnerLeaseGate which
      // correctly exempts them from the owner-lease check).
      delete process.env[REVIEWER_READONLY_ENV];
      for (const rwCmd of ['review_pass_set', 'finding_add']) {
        assert.doesNotThrow(
          () => enforceReviewerReadOnlyCommandGate(rwCmd, {}, null),
          `${rwCmd} (reviewerWrite) is NOT rejected by the gate when PROOF_OR_STOP_REVIEWER_READONLY is unset`,
        );
      }
    } finally {
      if (savedRO === undefined) delete process.env[REVIEWER_READONLY_ENV];
      else process.env[REVIEWER_READONLY_ENV] = savedRO;
    }
  }

  // ── 7. OWNER LEASE HELP BLOCK (B-a30e CHK-003) ─────────────────────────
  // Verify that `ownerLeaseHelpBlock` returns takeover guidance for owner-gated
  // commands and null for commands that are not owner-gated, without changing
  // any gate behavior.
  {
    // 7a. storyScopedMutating commands must include both flags and describe
    //     stale/active lease semantics.
    for (const cmd of ['story_advance', 'checklist_update', 'verification_evidence_add', 'finding_resolve']) {
      const block = ownerLeaseHelpBlock(cmd);
      assert.ok(block !== null, `${cmd} is owner-gated (storyScopedMutating) and must have an owner lease help block`);
      assert.ok(block!.includes('--takeover'), `${cmd} help block must mention --takeover`);
      assert.ok(block!.includes('--forceTakeover'), `${cmd} help block must mention --forceTakeover`);
      assert.ok(block!.includes('stale'), `${cmd} help block must describe stale lease recovery (--takeover semantics)`);
      assert.ok(block!.includes('active'), `${cmd} help block must describe active lease override (--forceTakeover semantics)`);
    }

    // 7b. validate — static ownershipClass is storyScopedMutating so the block
    //     IS present; it must note that takeover applies when --story is supplied.
    const validateBlock = ownerLeaseHelpBlock('validate');
    assert.ok(validateBlock !== null, 'validate has storyScopedMutating static class and must have an owner lease help block');
    assert.ok(validateBlock!.includes('--takeover'), 'validate help block must mention --takeover');
    assert.ok(validateBlock!.includes('--forceTakeover'), 'validate help block must mention --forceTakeover');
    assert.ok(
      validateBlock!.includes('--story'),
      'validate help block must note that takeover applies when --story is supplied (boundary rule 2)',
    );
    assert.ok(
      validateBlock!.includes('read-only'),
      'validate help block must note that diagnostic validate without --story is always read-only',
    );

    // 7c. readOnly commands must NOT advertise takeover (they are never owner-gated).
    for (const roCmd of ['story_get', 'checklist_get', 'finding_list', 'session_brief', 'status']) {
      assert.equal(
        ownerLeaseHelpBlock(roCmd),
        null,
        `${roCmd} is readOnly and must NOT have an owner lease help block — users should not be told to use --takeover on read-only commands`,
      );
    }

    // 7d. reviewerWrite commands must NOT advertise takeover (owner-lease exempt).
    for (const rwCmd of ['review_pass_set', 'finding_add', 'init_check_set', 'review_run_start']) {
      assert.equal(
        ownerLeaseHelpBlock(rwCmd),
        null,
        `${rwCmd} is reviewerWrite (owner-lease exempt) and must NOT have an owner lease help block`,
      );
    }

    // 7e. mainSharedMutating commands must NOT advertise takeover (main write lock, not owner lease).
    assert.equal(
      ownerLeaseHelpBlock('story_create'),
      null,
      'story_create is mainSharedMutating and must NOT have an owner lease help block',
    );
    assert.equal(
      ownerLeaseHelpBlock('autopilot_policy_create'),
      null,
      'autopilot_policy_create has no story target, is mainSharedMutating, and must NOT have an owner lease help block',
    );
    assert.equal(
      resolveEffectiveOwnershipClass('autopilot_policy_create', { forceTakeover: true }, 'B-gate1'),
      'mainSharedMutating',
      'autopilot_policy_create must not become storyScopedMutating when stale owner meta is present',
    );

    // 7f. An unknown/unclassified command returns null (fail-closed, same as gate).
    assert.equal(
      ownerLeaseHelpBlock('no_such_command_xyz'),
      null,
      'an unclassified command returns null — no spurious takeover guidance for unknown commands',
    );
  }

  if (divergences.length > 0) {
    console.error('command-ownership contract: FAIL');
    console.error(`  ${divergences.length} divergence(s) found:`);
    for (const d of divergences) {
      console.error(`  [${d.source}] ${d.detail}`);
    }
    process.exit(1);
  }

  console.log('✓ scope_check_save allowedPhases: PLAN');
  console.log('✓ scope_contract_acknowledge allowedPhases: DEV, REVIEW');
  console.log('✓ PROOF_OR_STOP_REVIEWER_READONLY=1 enables read-only reviewer mode');
  console.log('✓ enforceReviewerReadOnlyCommandGate: allows readOnly, blocks reviewerWrite/storyScopedMutating/unclassified');
  console.log('✓ with env unset, normal reviewerWrite reaches enforceStoryOwnerLeaseGate unblocked');
  console.log('✓ ownerLeaseHelpBlock: owner-gated commands have takeover/forceTakeover guidance; readOnly/reviewerWrite/mainSharedMutating return null');
  console.log(
    `✓ command-ownership contract passed — ${cliCommands.length} CLI commands all carry a valid ` +
    `ownershipClass and a dispatchable handler; unclassified commands fail-closed; finding B-META / ` +
    `validate --story / delivery_check_set boundary rules resolve as ruled; ` +
    `read-only reviewer command gate (B-4f15 CHK-002) assertions all pass; ` +
    `owner lease help block (B-a30e CHK-003) discoverable for gated commands, absent for read-only`,
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}

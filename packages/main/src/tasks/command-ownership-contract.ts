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
 *        `reviewerWrite` only for the `koala-review-delivery` actor.
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
import { mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StoryStore } from '../core/store.js';
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

const root = join(tmpdir(), `koala-command-ownership-contract-${process.pid}-${Date.now()}`);
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

    // Rule 3: delivery_check_set — reviewerWrite only for the delivery reviewer.
    const savedAgent = process.env.KOALA_AGENT;
    delete process.env.KOALA_AGENT;
    assert.equal(
      isDeliveryReviewerActor({ agentId: 'koala-review-delivery' }),
      true,
      'agentId=koala-review-delivery is recognised as the delivery reviewer actor',
    );
    assert.equal(
      isDeliveryReviewerActor({ agentId: 'main' }),
      false,
      'a non-delivery agentId is not the delivery reviewer actor',
    );
    assert.equal(
      resolveEffectiveOwnershipClass('delivery_check_set', { agentId: 'koala-review-delivery' }, 'B-c55d'),
      'reviewerWrite',
      'delivery_check_set by the delivery reviewer is reviewerWrite (owner-lease exempt)',
    );
    assert.equal(
      resolveEffectiveOwnershipClass('delivery_check_set', { agentId: 'main' }, 'B-c55d'),
      'storyScopedMutating',
      'delivery_check_set by a non-delivery actor is owner-gated storyScopedMutating — a main agent cannot borrow it to bypass the owner lease',
    );
    // KOALA_AGENT env fallback is honored when no explicit agentId is given.
    process.env.KOALA_AGENT = 'koala-review-delivery';
    assert.equal(
      isDeliveryReviewerActor({}),
      true,
      'KOALA_AGENT=koala-review-delivery is honored as the delivery reviewer actor fallback',
    );
    process.env.KOALA_AGENT = 'main';
    assert.equal(
      resolveEffectiveOwnershipClass('delivery_check_set', {}, 'B-c55d'),
      'storyScopedMutating',
      'delivery_check_set with KOALA_AGENT=main is owner-gated storyScopedMutating',
    );
    if (savedAgent === undefined) delete process.env.KOALA_AGENT;
    else process.env.KOALA_AGENT = savedAgent;
  }

  // ── 5. GATE BEHAVIOR — enforceStoryOwnerLeaseGate fail-closed rejection ──
  {
    const savedSession = process.env.KOALA_SESSION_ID;
    try {
      // Set up a story dir owned by session "sess-owner" (a FOREIGN session).
      const storyId = 'B-gate1';
      const storyDir = store.storyDirPath(storyId);
      mkdirSync(storyDir, { recursive: true });
      process.env.KOALA_SESSION_ID = 'sess-owner';
      resetSessionIdForTest();
      acquireOwnerLease(storyDir, { command: 'checklist_update', cwd: '/tmp/owner-worktree' });
      const leaseBefore = readFileSync(ownerLeasePath(storyDir), 'utf-8');

      // Now act AS a different session "sess-intruder".
      process.env.KOALA_SESSION_ID = 'sess-intruder';
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

      // 5f. An unclassified command is rejected fail-closed by the gate.
      assert.throws(
        () => enforceStoryOwnerLeaseGate('no_such_command_xyz', { storyId }, store, null, root),
        (err: Error) => err.message.includes('no valid ownershipClass') && err.message.includes('fail-closed'),
        'an unclassified command is rejected fail-closed by the gate, never default-allowed',
      );
    } finally {
      if (savedSession === undefined) delete process.env.KOALA_SESSION_ID;
      else process.env.KOALA_SESSION_ID = savedSession;
      resetSessionIdForTest();
    }
  }

  if (divergences.length > 0) {
    console.error('command-ownership contract: FAIL');
    console.error(`  ${divergences.length} divergence(s) found:`);
    for (const d of divergences) {
      console.error(`  [${d.source}] ${d.detail}`);
    }
    process.exit(1);
  }

  console.log(
    `✓ command-ownership contract passed — ${cliCommands.length} CLI commands all carry a valid ` +
    `ownershipClass and a dispatchable handler; unclassified commands fail-closed; finding B-META / ` +
    `validate --story / delivery_check_set boundary rules resolve as ruled`,
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}

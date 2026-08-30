#!/usr/bin/env node

/**
 * Mutation-proven check that the topology signing guard binds session SOURCE.
 *
 * This is deliberately separate from `proofstory-topology-critic-smoke`, which exercises the whole
 * receipt pipeline and is currently blocked upstream by a basis-discovery defect (`basis.status`
 * resolves to `partial`) that has nothing to do with signing. The guard below is the property this
 * story adds, so it gets a check that can actually run.
 *
 * Two things are asserted:
 *  1. Only `host-adapter` and `generated-token` may sign. Both clear the same provider+task+agent
 *     gate in `resolveAdapterOwnerSession` and are hash-derived, so the party under review cannot
 *     choose the id a reviewer signs under. `explicit-env` (whatever was written into the session
 *     id env var) and `derived-ppid` (a process-tree hash) are mintable, and are refused.
 *  2. Both signing roles are bound, not just the critic: the same forgery argument applies to a
 *     scope-plan exclusion approval.
 *
 * The refusal must happen BEFORE the dispatch lookup, otherwise a forged session would merely fall
 * through to a different error and the guard would be doing no independent work. That ordering is
 * what the `reachedDispatchCheck` assertion pins.
 */

import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  deriveRoleProvenance,
  TOPOLOGY_CRITIC_ROLE,
  TOPOLOGY_EXCLUSION_APPROVER_ROLE,
} from '../core/topology-critic-receipt.js';
import { resolveSessionIdentity } from '../core/owner-session.js';
import { adapterSessionEnv, adapterSessionId } from './adapter-session-env.js';

/** At runtime this file lives in `dist/tasks/`, so `..` is `dist/`, and the package root is `../..`. */
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
/** Assertion 3 reads TypeScript source, which only exists under `src/`, never in the build output. */
const sourceRoot = join(packageRoot, 'src');

const REFUSED = ['explicit-env', 'derived-ppid'] as const;
const ACCEPTED = ['host-adapter', 'generated-token'] as const;
const ROLES = [TOPOLOGY_CRITIC_ROLE, TOPOLOGY_EXCLUSION_APPROVER_ROLE] as const;

function attempt(role: (typeof ROLES)[number], sessionSource: string): string {
  try {
    deriveRoleProvenance({
      gitCwd: packageRoot,
      events: [],
      expectedRole: role,
      actor: role,
      sessionId: 'sess-probe',
      sessionSource: sessionSource as never,
      context: { storyId: 'B-probe', storyFilesHash: 'h' } as never,
      implementation: { businessCommit: 'c' } as never,
    });
    return '<no throw>';
  } catch (error) { return error instanceof Error ? error.message : String(error); }
}

// 1. Refused sources are rejected by the SOURCE gate, on BOTH signing roles, and the rejection
//    names the source that was received so the operator is not left guessing.
for (const role of ROLES) {
  for (const source of REFUSED) {
    const message = attempt(role, source);
    assert.match(message, /must sign from a host-adapter session/, `${role} must refuse ${source}`);
    assert.match(message, new RegExp(`received "${source}"`), `${role} refusal must name ${source}`);
    assert.doesNotMatch(
      message,
      /no current registered dispatch provenance/,
      `${role} must refuse ${source} BEFORE the dispatch lookup, or the guard adds nothing`,
    );
  }
}

// 2. Accepted sources clear the source gate. They still fail here, but on the NEXT check
//    (dispatch provenance), which proves the guard let them through rather than short-circuiting.
for (const role of ROLES) {
  for (const source of ACCEPTED) {
    const message = attempt(role, source);
    assert.doesNotMatch(message, /must sign from a host-adapter session/, `${role} must accept ${source}`);
    assert.match(
      message,
      /no current registered dispatch provenance/,
      `${role} with ${source} must proceed to the dispatch check`,
    );
  }
}

// 3. Both production call sites are bound. A guard wired only into the critic would leave the
//    scope-plan exclusion approver forgeable, which is the same hole in a different door.
const handlerSource = readFileSync(join(sourceRoot, 'handlers', 'proofstory.ts'), 'utf8');
const boundCallSites = handlerSource.split('deriveRoleProvenance({').length - 1;
const sourceBindings = handlerSource.split('sessionSource: getSessionIdentity().sessionSource').length - 1;
assert.equal(boundCallSites, 2, 'expected exactly two production deriveRoleProvenance call sites');
assert.equal(sourceBindings, boundCallSites, 'every production call site must pass the real session source');

// 4. The migration actually yields a signable session: the adapter env a fixture now uses resolves
//    to host-adapter even when a session id var is already present in the inherited environment,
//    which is the trap that silently downgrades resolution to explicit-env.
const inputs = { hostname: 'h', root: '/tmp/probe-root', ppid: 1 };
const migrated = Object.fromEntries(
  Object.entries({ PROOF_OR_STOP_SESSION_ID: 'sess-critic', ...adapterSessionEnv('sess-critic', TOPOLOGY_CRITIC_ROLE) })
    .filter(([, value]) => value !== undefined),
) as Record<string, string>;
const identity = resolveSessionIdentity(migrated, inputs);
assert.equal(identity.sessionSource, 'host-adapter', 'migrated fixture env must resolve to a signable source');
assert.equal(
  identity.sessionId,
  adapterSessionId('/tmp/probe-root', 'sess-critic', TOPOLOGY_CRITIC_ROLE),
  'adapterSessionId must reproduce the derived id fixtures assert against',
);

// Control for 4: leaving the session id var set is exactly the downgrade the helper prevents.
const trapped = resolveSessionIdentity(
  { PROOF_OR_STOP_SESSION_ID: 'sess-critic', PROOF_OR_STOP_OWNER_SESSION_ADAPTER_PROVIDER: 'claude-code', PROOF_OR_STOP_OWNER_SESSION_ADAPTER_TASK: 'sess-critic', PROOF_OR_STOP_OWNER_SESSION_ADAPTER_AGENT: TOPOLOGY_CRITIC_ROLE },
  inputs,
);
assert.equal(trapped.sessionSource, 'explicit-env', 'control: a lingering session id var downgrades to explicit-env');

console.log('Topology signing source guard: PASS');
console.log(`  refused (forgeable): ${REFUSED.join(', ')}`);
console.log(`  accepted (host-derived): ${ACCEPTED.join(', ')}`);
console.log(`  bound production call sites: ${boundCallSites}/${boundCallSites}`);
console.log('  migrated fixture env resolves to: host-adapter');

// 3. B-49ed F-005: the two checks above only prove an accepted source gets PAST the source
//    gate; neither proves a legitimate actor can complete deriveRoleProvenance. That gap
//    mattered most for the exclusion approver at handlers/proofstory.ts:550, which this story
//    newly bound and which had no executed accepted-path coverage anywhere in the suite.
//    Here both roles run the FULL function with a matching dispatch event and must succeed.
{
  const businessCommit = 'c'.repeat(40);
  const storyFilesHash = 'h'.repeat(64);
  const headHash = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: packageRoot, encoding: 'utf8' }).trim();
  const context = { storyId: 'B-probe', storyFilesHash } as never;
  const implementation = { businessCommit } as never;

  for (const role of ROLES) {
    for (const source of ACCEPTED) {
      const sessionId = `sess-${role}-${source}`;
      const events = [{
        type: 'dispatch',
        agentType: role,
        sessionId,
        storyId: 'B-probe',
        businessCommit,
        storyFilesHash,
        headHash,
        businessCommitAuthor: 'probe <probe@local>',
        businessCommitAuthorSource: 'git-var:GIT_AUTHOR_IDENT',
      }] as never;

      const actor = deriveRoleProvenance({
        gitCwd: packageRoot,
        events,
        expectedRole: role,
        actor: role,
        sessionId,
        sessionSource: source as never,
        context,
        implementation,
      });
      assert.equal(actor.agentId, role, `${role} completes deriveRoleProvenance from a ${source} session`);
      assert.equal(actor.sessionId, sessionId, `${role} provenance binds its own session id`);
    }
  }
}
console.log('  accepted sources complete provenance for: critic + exclusion approver');

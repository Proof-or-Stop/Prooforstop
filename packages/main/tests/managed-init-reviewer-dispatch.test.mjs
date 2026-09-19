import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const hostRun = readFileSync(`${root}/packages/main/src/handlers/host-run.ts`, 'utf8');
const catalog = readFileSync(`${root}/packages/main/src/cli/command-catalog.ts`, 'utf8');
const machine = readFileSync(`${root}/packages/main/src/core/machine.ts`, 'utf8');
const reviewerLaunchGuidance = readFileSync(`${root}/packages/main/src/core/reviewer-launch-guidance.ts`, 'utf8');
const storyReview = readFileSync(`${root}/packages/main/src/handlers/story-review.ts`, 'utf8');
const transitionEffects = readFileSync(`${root}/packages/main/src/handlers/transition-effects.ts`, 'utf8');
const initCheck = readFileSync(`${root}/packages/main/src/handlers/init-check.ts`, 'utf8');
const managedHostRun = readFileSync(`${root}/packages/main/src/core/managed-host-run.ts`, 'utf8');

assert.match(hostRun, /managedDispatch\?: boolean/,
  'host_run must expose a controller-owned exact role-dispatch mode');
assert.match(hostRun, /createStoryDispatchHandlers\(ctx\)\.dispatch/,
  'managed dispatch must derive the prompt from the canonical dispatch handler');
assert.match(hostRun, /managedDispatch.*managedReview|managedReview.*managedDispatch/s,
  'managed dispatch and formal REVIEW transport must be mutually exclusive');
assert.match(hostRun, /proof-or-stop-review-story-init.*proof-or-stop-product-reviewer/s,
  'the first managed-dispatch boundary must admit exactly the required INIT reviewers');
assert.match(managedHostRun, /resolveManagedDispatchInvocation/,
  'managed runs must expose a live provider-invocation binding for reviewer writes');
assert.match(managedHostRun, /signManagedInitInvocation/,
  'the controller must sign the exact INIT callback authority without exposing its private key');
assert.match(managedHostRun, /initInvocationConsumption/,
  'managed INIT callback authority must be consumed once before it can write evidence');
assert.match(managedHostRun, /verifyCanonical\(claims, signature, owner\.proposalInvocationPublicKey\)/,
  'managed INIT callback authority must verify against the controller-owned public key');
assert.match(initCheck, /resolveManagedDispatchInvocation/,
  'init_check_set must consume the live managed-dispatch binding');
assert.match(initCheck, /authority\.source.*dispatched-env|dispatched-env.*authority\.source/s,
  'caller-supplied reviewer role ids must not count as independent evidence');
assert.match(catalog, /managedDispatch:/,
  'the public CLI schema must expose managedDispatch');
assert.match(machine, /renderManagedInitReviewerDispatches\(storyId, missingAgents\)/,
  'INIT recovery guidance must use the shared controller-owned delivery renderer');
assert.match(reviewerLaunchGuidance, /managedDispatch: true/,
  'the shared INIT reviewer renderer must use the controller-owned delivery path');
assert.match(reviewerLaunchGuidance, /QUALIFIED_MANAGED_REVIEWER_DEFAULTS/,
  'managed reviewer guidance must consume the controller qualification defaults');
assert.match(reviewerLaunchGuidance, /renderQualifiedManagedCodexDispatchCommand/,
  'managed reviewer guidance must use one shared qualified Codex command renderer');
assert.match(storyReview, /renderQualifiedManagedCodexDispatchCommand\(args\.storyId, 'proof-or-stop-review-scope-plan'\)/,
  'PLAN scope-review recovery must use the shared qualified managed dispatch command');
assert.match(transitionEffects, /renderQualifiedManagedCodexDispatchCommand\(storyId, 'proof-or-stop-review-delivery'\)/,
  'TEST delivery-review recovery must use the shared qualified managed dispatch command');
assert.match(hostRun, /resolveQualifiedManagedReviewerSelection/,
  'formal managed dispatch must resolve and validate reviewer qualification before submission');
assert.match(catalog, /reject unqualified model families/,
  'public host_run help must disclose the formal reviewer qualification boundary');
assert.doesNotMatch(machine, /renderReviewerDispatchLaunch\(\{ storyId, agentType: 'proof-or-stop-review-story-init'/,
  'INIT recovery guidance must not depend on host spawn_agent/followup_task behavior');

console.log('MANAGED_INIT_REVIEWER_DISPATCH_GREEN');

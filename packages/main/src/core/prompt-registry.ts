/**
 * @task B-9b76
 * @checklist CHK-002
 * @title Registry-backed agent prompt templates
 * @type feature
 * @priority high
 * @description
 * Package-owned registry for Proof-or-Stop agent prompt templates. Project
 * assets can point at this registry instead of materializing every prompt file.
 * @changes
 * - [CHK-002] Add stable prompt metadata, hashes, and host-specific rendering.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { PROOF_OR_STOP_ADAPTER_DIR } from './brand-paths.js';
import {
  canonicalAgentRoleId,
  canonicalizeAgentRoleText,
  legacyAgentRoleIds,
  legacyizeAgentRoleText,
} from './agent-role-identity.js';
import {
  LEGACY_LATTICE_MANAGED_END,
  LEGACY_LATTICE_MANAGED_START,
  PROOF_OR_STOP_MANAGED_END,
  PROOF_OR_STOP_MANAGED_START,
} from './managed-markers.js';

export const PROMPT_REGISTRY_VERSION = 'proof-or-stop.prompt-registry.v1' as const;
export const PROMPT_REGISTRY_VERSION_LEGACY = 'lattice.prompt-registry.v1' as const;
export type PromptRegistrySchemaVersion = typeof PROMPT_REGISTRY_VERSION | typeof PROMPT_REGISTRY_VERSION_LEGACY;

/** Readers accept the historical manifest schema; writers use only the canonical schema. */
export function isPromptRegistrySchemaVersion(value: unknown): value is PromptRegistrySchemaVersion {
  return value === PROMPT_REGISTRY_VERSION || value === PROMPT_REGISTRY_VERSION_LEGACY;
}

export function canonicalPromptRegistrySchemaVersion(value: unknown): typeof PROMPT_REGISTRY_VERSION | null {
  return isPromptRegistrySchemaVersion(value) ? PROMPT_REGISTRY_VERSION : null;
}
export const PROMPT_REGISTRY_SOURCE = '@proof-or-stop/core/templates/agents';
export const SUPPORTED_PROMPT_HOSTS = ['claude', 'codex'] as const;
export const MODULAR_ROLE_BODY_MARKER = '<!-- proof-or-stop:modular-role-body:v1 -->';
export const MODULAR_ROLE_BODY_MARKER_LEGACY = '<!-- proofbound:modular-role-body:v1 -->';
export const MODULAR_REVIEWER_ROLE_IDS = [
  'proof-or-stop-review-behavior',
  'proof-or-stop-review-concept',
  'proof-or-stop-review-docs',
  'proof-or-stop-review-quality',
  'proof-or-stop-review-test-coverage',
  'proof-or-stop-review-topology-critic',
] as const;
export type ModularReviewerRoleId = typeof MODULAR_REVIEWER_ROLE_IDS[number];
export const REVIEW_FINDING_TRIAGE_CONTRACT_MARKER = '<!-- proofbound:review-finding-triage-contract:v1 -->';
export const REVIEW_FINDING_TRIAGE_CONTRACT = `${REVIEW_FINDING_TRIAGE_CONTRACT_MARKER}
## REVIEW Finding Triage and Routing Contract

Apply this contract while reviewing. It governs reviewer behavior; it does not replace the CLI, handler, or gate as the authority for lifecycle state.

### Current compatibility boundary

- The Dynamic Finding System execution plan is the future authority for signed applicability, ownership, routing, freshness, and supersession. Until its official CLI and artifacts exist, use only commands and fields exposed by the current CLI compatibility path. Never fabricate an unavailable assessment field, verdict, owner, route, signature, freshness result, or command receipt, and never claim that a target-state mechanism ran.
- In the current compatibility path, a reviewer records the observation through \`finding_add\` with the current \`reviewRunId\` and returns disposition to the Story Owner. Only the Owner may use \`finding_dismiss\` as an audited round/profile action when current mechanical policy permits it. The command mechanically changes the Finding status from open to dismissed and therefore removes it from the current REVIEW blocking predicate, but it proves neither applicability nor \`out_of_scope\`, and it is not proof of deferral, repair, or resolution. Gap and backlog routes are also compatibility accounting, not applicability or deferral proof.
- The current compatibility CLI does not implement the future signed \`FindingDeferralDisposition\` or \`defer_with_proof\` path. Never fabricate \`dispositionPlan\`, \`acceptedRoute\`, \`assessmentDispositionPlan\`, \`expectedAssessmentDispositionPlan\`, a signature, freshness binding, expiry, lineage, receipt, or manifest action, and never claim that compatibility accounting exercised the future mechanism.
- When the Dynamic Finding CLI becomes available, request or consume its official signed assessment and follow its fail-closed result. Prompt prose and compatibility records never substitute for that assessment.

### Record evidence before disposition

- Start the current lane with \`proof-or-stop review_run_start\`. Carry its current \`reviewRunId\` on every \`finding_add\` or \`review_pass_set\` submission.
- A role-body or policy change makes an already assembled in-flight reviewer envelope stale. Stop, start a fresh current-material run with \`review_run_start\`, and redispatch the reviewer; never submit evidence from the older envelope.
- Keep four input axes separate: observation and \`evidenceState\` preserve what was seen and whether it is suspected, verified, or disproven; severity says how harmful it is; applicability reports whether it belongs to this Story; disposition records the authorized next action after applicability. Gate impact is a fifth, derived result: the current gate uses only facts recognized by current policy, and the future official Dynamic Finding gate derives it from fresh signed applicability and disposition facts. Severity does not determine scope by itself.
- Every future final \`applicable\` assessment binds exactly one \`dispositionPlan\`: \`repair_current\` or \`defer_with_proof\`.
- \`repair_current\` forbids \`acceptedRoute\`; \`defer_with_proof\` requires the exact accepted \`finding_route\` tuple.
- Final non-applicable verdicts bind no \`dispositionPlan\` and require the exact \`acceptedRoute\`; \`unknown\` binds neither.
- Only \`applicable + dispositionPlan='defer_with_proof'\` plus that exact route may feed the separate signed \`FindingDeferralDisposition\`.
- The final assessment field is \`dispositionPlan\`; the deferral copy is \`FindingDeferralDisposition.assessmentDispositionPlan='defer_with_proof'\`, and the manifest binding is \`expectedAssessmentDispositionPlan\`. These are future authority fields; the current compatibility CLI must not fabricate them.
- Preserve reproduction steps, source or command evidence, observed impact, and uncertainty. Report an applicability candidate in the evidence supported by the current command; do not invent unsupported fields or present the candidate as a gate decision.
- The machine-owned handler and gate derive the actual blocking result from structured facts. Reviewer prose, a routing proposal, or a claimed deferral is not gate evidence.

### Decide current-Story responsibility without widening scope

- Require repair in the current Story when a verified applicable issue is critical or high; was introduced or worsened by the Story; directly violates acceptance, a verification intent, the core user result, or a public compatibility promise; has known or uncertain protected-surface impact; or would make REVIEW, TEST, DONE, or their evidence misleading.
- If an issue would otherwise block under the current review round and policy but its applicability is unknown, fail closed and keep it in the current Story until evidence resolves applicability. This rule applies regardless of severity, including medium findings when the current round treats them as blocking.
- In the future system, \`REQUIRED_ASSESSMENT_INVALID = { missing, re_attestation_required, stale, unsigned, tampered, mismatched, incomplete, expired, unknown }\`. A verified open high or critical Finding in that exact set enters the machine-owned transient assessment-integrity floor before severity, round, and advisory policy. The floor does not itself prove applicability or require current-Story repair.
- A fresh strong non-applicable assessment releases that floor; a fresh \`applicable\` assessment converts high or critical to the distinct mandatory-repair floor; weak, unknown, or invalid proof remains blocked.
- In the future system, invalid claimed deferral lineage is an independent first floor regardless of the current assessment, including missing, invalid, expired, tampered, ownerless, partially applied, or exhausted lineage. In that future system, only a fresh signed superseding \`pre_existing_unaffected\`, \`out_of_scope\`, or \`duplicate\` verdict satisfying its independent strong proof contract, a signed \`disproven\` truth transition with current counter-evidence, or complete repair closure releases that lineage floor. In that future system, complete repair closure is a distinct release path and does not weaken the exact allowlist for non-repair supersession. In that future system, \`not_reproduced_under_current_witness\` never releases claimed-deferral lineage or mandatory repair.
- In the future system, invalid or exhausted deferral lineage also creates a downstream mandatory-repair classification. In that future system, once that mandatory-repair obligation is active, only a fresh signed \`MandatoryRepairClassification(state='closure_proven')\` clears it; lineage-floor superseding proof does not clear the whole block.
- These machine-derived floors are not permission for a reviewer to broaden Story scope.
- Evidence may support a \`pre_existing_unaffected\` or \`out_of_scope\` routing candidate only when the issue is not a direct Story regression, does not prevent the user-visible outcome, and cannot distort lifecycle evidence. Preserve the original Finding and attach reproduction, evidence, impact, recommended action, explicit owner, and route. Critical or high findings must never be left without an owner.
- A \`pre_existing_unaffected\` candidate requires deterministic base and head reproduction receipts for the same defect, proof that the Story did not worsen severity or impact, confirmation that Story scope does not promise its repair, and a valid owner or route.
- An \`out_of_scope\` candidate requires signed scope or decision evidence naming the excluded contract, no contradictory checklist or acceptance promise, and a valid owner or route; critical or high Findings cannot be left unowned.
- A \`duplicate\` candidate requires a signature-valid live canonical Finding, its live owner or route, and proof that the duplicate chain is not circular. Similar text or a matching signature tag is insufficient.
- A \`not_reproduced_under_current_witness\` candidate requires current target-bound negative command and runtime receipts, fresh source and runtime bindings, a signed command-policy and witness digest, and a live receipted owner or route. It must never be inferred from an old DONE outcome. If the current CLI cannot provide the required proof for any candidate, applicability remains unknown and fails closed.
- Do not expand the Story merely to make the repository globally green. A bounded, evidence-backed route is not dismissal, resolution, or proof that the problem disappeared.

### Apply future defer-with-proof only through official authority

- \`defer_with_proof\` is a disposition after \`applicable\`, not an applicability verdict. Only the future official Dynamic Finding System may sign it, and only for a verified applicable low or medium Finding.
- A future deferral first requires the final assessment to bind \`dispositionPlan='defer_with_proof'\` and the exact accepted \`finding_route\`. The separate signed deferral then repeats \`assessmentDispositionPlan='defer_with_proof'\`, while its matching manifest binds \`expectedAssessmentDispositionPlan='defer_with_proof'\`. A \`repair_current\`, non-applicable, unknown, or route-mismatched assessment cannot feed that deferral.
- Future deferral eligibility requires current reproduction evidence, proof that the Story did not introduce or worsen the defect, no direct acceptance or verification-intent impact, no known or uncertain protected-surface impact, a canonical defect, fresh bindings, a live owner and existing target, an accepted target-side route receipt, recheck triggers, finite expiry, and unexhausted ledger-derived cumulative lineage.
- A valid deferred Finding remains verified, open, visible, and unchanged in severity; it is not \`out_of_scope\`, \`pre_existing_unaffected\`, \`duplicate\`, \`disproven\`, dismissed, resolved, or repaired.

### Respect reviewer authority

- Reviewers audit and record; they do not repair implementation, rewrite scope, or create follow-up Stories. Do not call \`finding_dismiss\`, \`story_create\`, or \`gap_log\` from a REVIEW lane. Return repair work to the Story Owner and propose routing for non-applicable work.
- If no finding remains to report, record the lane result with \`review_pass_set\`; never encode a pass as a synthetic Finding.
- Distinguish \`disproven\` (evidence refutes the observation), \`duplicate\` (another tracked Finding owns the same defect), and \`not_reproduced_under_current_witness\` (fresh target-bound negative witness evidence does not reproduce an older claim). Do not collapse any of them, or \`defer_with_proof\`, into resolved.
- Never delete the original observation, silently rewrite its severity, or overwrite history. In the current compatibility path, preserve the original observation and report the new evidence to the Story Owner; do not fabricate a revision, superseding Finding, applicability recalculation, or gate-impact recalculation. Only the future official Dynamic Finding System may append a signed revision or superseding Finding and recalculate applicability and gate impact through its official artifacts.`;
/** Five active REVIEW-lane bootstrap roles; topology-critic stays a modular body. */
export const ACTIVE_MODULAR_REVIEWER_ROLE_IDS = Object.freeze(
  MODULAR_REVIEWER_ROLE_IDS.filter(id => id !== 'proof-or-stop-review-topology-critic'),
);
/** Story 6 roles use the same trusted story-dispatch envelope, but are not REVIEW lanes. */
export const MODULAR_COMPLEX_ROLE_IDS = [
  'proof-or-stop-review-story-init',
  'proof-or-stop-review-scope-plan',
  'proof-or-stop-implementer',
  'proof-or-stop-review-delivery',
  'proof-or-stop-evaluator',
] as const;
export type ModularComplexRoleId = typeof MODULAR_COMPLEX_ROLE_IDS[number];

/**
 * B-cdf6 CHK-005: re-approved after the `proof-or-stop` -> `proof-or-stop` bin rename
 * rewrote command-invocation prose inside every registry template. The digests
 * below are recomputed content addresses, not a relaxation: the reconstruction
 * check still fails closed on any unapproved template edit. Repinning in place
 * follows the precedent set by the previous template-content stories (see the
 * git history of these two constants, e.g. commits 8e4e36cbad / de9bd22659,
 * which likewise repinned rather than weakened the assertion). Verified before
 * repinning that `git diff main...HEAD -- packages/main/templates/agents/`
 * contains no changed line that mentions neither brand token.
 *
 * B-cdf6 CHK-003 follow-up: repinned a SECOND time, because CHK-005 only covered
 * the registry TEMPLATES while the injected slice below
 * (`LOAD_BEARING_PROOF_OR_STOP_PROMPT_SLICE`) and `TEST_COVERAGE_LEGACY_PROCESS_CONTRACT`
 * / `STORY_INIT_LEGACY_TAIL` still taught `proofOrStop <cmd>` to every spawned agent.
 * Those three payloads are reconstruction inputs, so rebranding them necessarily
 * moves every digest here. Same discipline as above, and additionally proven
 * before repinning: normalizing brand tokens and line-wrapping makes the new
 * slice byte-identical to the HEAD slice, i.e. the drift is brand-only with no
 * semantic edit. The assertion is preserved, never deleted or loosened.
 */
const LEGACY_REVIEWER_TEMPLATE_SHA256: Readonly<Record<string, string>> = Object.freeze({
  'lattice-review-behavior': '45efbfe90d7705408ed95f0111b2108b5e39fc9397aeb7d99eda600db2ea3fe0',
  'lattice-review-concept': '846023d241693435c995900e5869b13e838795718143f2fab14e7a8f7f23eb5d',
  'lattice-review-docs': '7aafa18c26dd713586f416dfc4a3b9676a88438f858c32374af9a978300dd43e',
  'lattice-review-quality': '1f023f75aeab93b6d08e4ec1261a867e43ebd638f6d5ec18e1407cad7c90f58b',
  'lattice-review-test-coverage': 'e433ed9bded50288388fff6447142555e412756137461d841ca7724848458753',
  // Post-merge of B-cdf6 rebranded slice into this branch's modular critic template.
  'lattice-review-topology-critic': '2300cde0d2c95e9ec8af14bf96ee7d9e58f962bdbd0bc7704279e457fac90224',

});

/** B-cdf6 CHK-005 + CHK-003 follow-up: re-approved for the same reason as LEGACY_REVIEWER_TEMPLATE_SHA256 above. */
const LEGACY_COMPLEX_TEMPLATE_SHA256: Readonly<Record<string, string>> = Object.freeze({
  // origin/main merge: repinned in ONE pass together with the templateHash in
  // scripts/verify-proof-or-stop-prompt-baseline.mjs, since both pins address the same
  // story-init body. Our pre-merge body instructed the reviewer to read
  // docs/story/actives/<storyId>/background.md, index.json and checklist.json DIRECTLY,
  // which CLAUDE.md forbids and which that script's story-init CLI-only policy rejects.
  // origin had already replaced those steps with proof-or-stop background_get /
  // story_get / checklist_get, so origin's body was adopted for all three story-init
  // locations, keeping OUR managed-marker spelling because other digests depend on it.
  // This digest is what that combination reconstructs.
  'lattice-review-story-init': 'a03b6bac5a6b5e8e270b6e92dc7cbd373ec4e2c8e50f532335cf10143d12dd9c',
  'lattice-review-scope-plan': '9ac7cff64b53fc33555e4c5ef6f963a5c5bd09e7420d317a2312aafac9cfbd07',
  // origin/main merge 2 (B-9a49): repinned because origin edited this template and our
  // side keeps two deliberate deltas from it -- our managed-marker spelling (other pins
  // depend on it) and our clearer 'the relevant reviewer lane' wording where origin says
  // 'proof-or-stop-reviewer'. Same 150 lines, no other difference.
  'lattice-implementer': '820853ba6390ac8db9cfd6d784a2e06424eb5c5da168d4874e3d12213fa35435',
  'lattice-review-delivery': '4b3b207a265c5b9a1ba9845761720c19cddcdee6eec9bfd5f672b55bbc1b50af',
  'lattice-evaluator': 'dd8cf73174e1ddf292b7b4cf9ebb70ff8c32584f44ccb78f2221b33da8407b97',
});

const STORY_INIT_LEGACY_TAIL_MARKER = '<!-- proof-or-stop:story-init-legacy-tail:v1 -->';
const STORY_INIT_LEGACY_TAIL_MARKER_LEGACY = '<!-- proofbound:story-init-legacy-tail:v1 -->';
// Frozen gzip -n payload of the pre-Story-6 `## 4. Procedure` through EOF.
// B-cdf6 CHK-003: re-encoded after the `proof-or-stop` -> `proof-or-stop` bin rename.
// This payload is injected into the LIVE story-init reviewer body (default mode
// is `legacy-full-context`), so its `init_check_set` invocations were teaching
// the retired bin name. Only RENAMED-class tokens changed: the bin name in
// invocations plus the product prose. The FROZEN `proof-or-stop-review-story-init`
// role ID is preserved verbatim wherever it appears as an `agentId` value.
const STORY_INIT_LEGACY_TAIL_GZIP_BASE64 = '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';
const STORY_INIT_LEGACY_TAIL = gunzipSync(
  Buffer.from(STORY_INIT_LEGACY_TAIL_GZIP_BASE64, 'base64'),
).toString('utf8');

const STORY_INIT_CLI_ONLY_REPLACEMENTS: ReadonlyArray<readonly [string, string]> = [
  ['## 4. Procedure (8 steps)', '## 4. Procedure (7 steps)'],
  [
    '2. **Read background.md**: `Read docs/story/actives/<storyId>/background.md` in full. Note all letter codes, abbreviations, jargon, and where they are first defined, **and mark all factual claims about the existing system** (e.g., "X only supports Y", "all projects have Z").',
    '2. **Read the background through the CLI**: run `proof-or-stop background_get \'{"storyId":"<storyId>"}\'`, read the full returned background, note all letter codes, abbreviations, jargon, and first definitions, and mark factual claims about the existing system.',
  ],
  [
    '3. **Read index.json**: `Read docs/story/actives/<storyId>/index.json` and extract `title` / `description` / `type` / `priority` / `riskSignals`.',
    '3. **Read the story fields through the CLI**: run `proof-or-stop story_get \'{"storyId":"<storyId>"}\'` and extract only `title` / `description` / `type` / `priority` / `riskSignals`.',
  ],
  [
    '4. **Read checklist.json**: `Read docs/story/actives/<storyId>/checklist.json`, iterate over `items[]`, look only at `title` and `context`.',
    '4. **Read the checklist through the CLI**: run `proof-or-stop checklist_get \'{"storyId":"<storyId>"}\'`, iterate over `items[]`, and use only `title` and `context`.',
  ],
  [
    'After all review work is finished and `init_check_set` has been called, you must read the following JSON file and write into the answer:\n\n```bash\ncat docs/story/actives/<storyId>/init-self-check.json\n```\n\nIf the file does not exist, create it first:\n\n```bash\necho \'{"question":"Did you read CLAUDE.md? If not, explain the reason in detail in the answer field. If yes, also state that you read it in the answer field.","answer":""}\' > docs/story/actives/<storyId>/init-self-check.json\n```\n\nThen use the Edit tool to fill in the `answer` field completely (answer honestly). This is for audit traceability and does not affect the signature.',
    'After `init_check_set`, state in the answer whether you read `CLAUDE.md`. Do not create, read, or edit a StoryStore sidecar directly; `init_check_set` is the only persisted reviewer result.',
  ],
];

function rewriteStoryInitLegacyTailForCliOnly(content: string): string {
  let rewritten = content;
  for (const [before, after] of STORY_INIT_CLI_ONLY_REPLACEMENTS) {
    if (!rewritten.includes(before)) {
      throw new Error(`story-init CLI-only rewrite source drift: ${before.slice(0, 80)}`);
    }
    rewritten = rewritten.replace(before, after);
  }
  return rewritten;
}

const TEST_COVERAGE_LEGACY_PROCESS_CONTRACT = `
## Two-Layer Process Fact Contract

Process facts require both prompt guidance and a hardcoded CLI/handler/gate fallback. The prompt tells the agent which command to call and how to express scope; the code entrypoint is responsible for final adjudication, normalization, signing, rejection, and gate consumption. Any wording that would change process state or audit facts cannot live only in the prompt.

Scope is limited to process facts: phase / state transition, pass / no-issue confirmations, finding category / severity / role / agent, review pass, verificationEvidence, init check, scope check, delivery check, REVIEW / TEST / DONE gate artifact. Ordinary explanatory prose, background, and design rationale are not process facts unless the CLI or gate reads them as evidence.

Execution rules:
- Reviewer conclusions like no finding / no blocker / check passed must be recorded with \`review_pass_set\`; if a reviewer incorrectly uses a pass-only \`finding_add\`, the handler must convert it into a review pass.
- For the current REVIEW round, reviewer evidence must first call \`proof-or-stop review_run_start {"storyId":"B-xxx","agent":"<reviewer-name>"}\` to obtain a \`reviewRunId\`; every \`finding_add\` / \`review_pass_set\` from that reviewer in this round must then carry this current \`reviewRunId\`.
- The \`category\` field of \`finding_add\` only accepts the current canonical \`happy|edge|adversarial|missing\`. Known legacy values \`cleanup|doc-promise-undelivered|doc-code-drift|spec-boundary\` are accepted as compatibility inputs and normalized to \`missing\`, but must not continue to propagate as active prompt examples.
- Gates consume structured facts: signatures, hashes, verificationEvidence, review pass, init/scope/delivery check, and validate evidence. Do not let gates infer process facts from ordinary text like "passed / no problem".
- When changing reviewer prompts, CLI schema, handlers, or gates, run \`npm run test:process-fact-contract\` to confirm the prompt has not drifted and the process fact inventory still proves the hard fallback exists.
`;
export const LOAD_BEARING_PROOF_OR_STOP_PROMPT_SLICE = `<!-- proof-or-stop:start -->
# Proof-or-Stop Load-Bearing Runtime Guide

This embedded slice is intentionally compact. It replaces the old full guide
snapshot while preserving the process facts that prompts rely on. For broad
project background, read the repository guide files explicitly instead of
assuming hidden context.

## Session And Story Flow

- At the start of every new session or interrupted-work resume, first run
  \`proof-or-stop session_brief\` from the current story worktree.
- Before acting, run \`proof-or-stop aux_doc_list\` and read only the relevant
  source-of-truth files. If an aux command is unavailable, fall back to shell
  search/read tools.
- Story operations must use Proof-or-Stop CLI commands. Do not directly read or write
  story metadata under \`docs/story/\`, and do not write fixtures directly under
  \`tests/fixtures/\`.
- Current lifecycle:
  \`INIT -> INIT_CHECK -> PLAN/fast-skip -> DEV -> REVIEW -> TEST -> DONE\`.
  Code changes belong in DEV. REVIEW/TEST/DONE consume structured evidence.
- Story worktrees and \`story/*\` branches are local coordination details. Do
  not create a second worktree for the same task and do not push story branches.

## Compact Status Queries

For routine status refreshes, prefer compact read-only queries. These examples
are opt-in; default \`story_get\` and \`checklist_get\` output remains full.

\`\`\`bash
proof-or-stop story_get '{"storyId":"B-xxxx","slim":true,"fields":["story","checklist","review"]}'
proof-or-stop checklist_get '{"storyId":"B-xxxx","slim":true,"fields":["counts","items"]}'
\`\`\`

Before evidence-sensitive conclusions or mutations, reload the full output:

\`\`\`bash
proof-or-stop story_get '{"storyId":"B-xxxx"}'
proof-or-stop checklist_get '{"storyId":"B-xxxx"}'
\`\`\`

## Fresh-Context Fence

Fresh-context separation is a prompt and evidence discipline, not a hidden
mechanical identity boundary. Subagents and the main agent can look similar to the
shell, so auditability comes from structured Proof-or-Stop facts plus this fence.

- A worker/reviewer must infer only from its provided inputs, code diff, story
  metadata exposed by Proof-or-Stop commands, and explicitly read source files.
- Do not assume the main agent's private intent or full conversation history.
- For reviewer lanes, an unregistered issue is not a finding. Every real issue
  must be recorded with \`proof-or-stop finding_add\`; no-issue conclusions must
  be recorded with \`proof-or-stop review_pass_set\`.
- For implementer lanes, mark checklist progress through \`proof-or-stop
  checklist_update\` and record verificationEvidence for completed items.

## Process Fact Contract

Process facts require prompt guidance and hardcoded CLI/handler/gate fallback.
The prompt tells the agent which command to call; the code entrypoint performs
normalization, signing, validation, and gate consumption.

- Reviewer conclusions such as no finding / no blocker / check passed must use
  \`review_pass_set\`. Pass-only \`finding_add\` is a misuse.
- Reviewer evidence for the current REVIEW round must first call
  \`proof-or-stop review_run_start {"storyId":"B-xxx","agent":"<reviewer-name>"}\`
  to obtain a \`reviewRunId\`; every \`finding_add\` / \`review_pass_set\` in
  that round must carry the current \`reviewRunId\`.
- \`finding_add\` categories are \`happy|edge|adversarial|missing\`. Legacy
  categories may be normalized by handlers but must not be used as active
  examples.
- Gates consume structured facts: signatures, hashes, verificationEvidence,
  review passes, init/scope/delivery checks, reviewer runs, and validation
  evidence. They must not infer process facts from free text like "passed".
- Finding signatures bind storyId, reviewer lane, reviewRound, severity,
  category, description, and files. Review run validation also checks signature,
  matching reviewRound, fresh head/material hashes, and—for an open finding—the lane's latest run (a pass does not require being the latest run).
- Delivery semantics stay separate: delivery check docs promises, real machine
  tests, closing self-check, waivers, and signed delivery artifacts are consumed
  by DONE gates, not by ordinary prose.

## Local Admissibility And Handoff Boundaries

- Local Proof-or-Stop evidence can be admissible when it is fresh, scoped, and gate-consumed through \`admissibilityStatus\`, \`assuranceLevel\`, and \`evidenceScope\`.
- Local tests, prompt text, and story metadata may support local admissibility only when they are recorded as structured gate evidence.
- Handoff packs are bounded overflow execution. Story ownership, merge responsibility, DONE readiness, signed/offline receipt bundles, and local review quorum assurance remain local Proof-or-Stop responsibilities unless a human explicitly changes the boundary.

## Debugging Contract

When validation, a reviewer finding, or a bug report fails: observe the exact
failure, form one evidence-backed hypothesis, isolate with the smallest
reproducer or comparison, apply one fix, then rerun the relevant verification.
Do not declare a fix without reproduction, root cause, and re-verification.

<!-- proof-or-stop:end -->`;

export type PromptHost = typeof SUPPORTED_PROMPT_HOSTS[number];

export interface PromptRegistryEntry {
  agentId: string;
  file: string;
  relPath: string;
  sourcePath: string;
  templateHash: string;
  bytes: number;
}

export interface PromptRegistrySnapshot {
  schemaVersion: typeof PROMPT_REGISTRY_VERSION;
  source: typeof PROMPT_REGISTRY_SOURCE;
  root: string;
  agentCount: number;
  materialHash: string;
  agents: PromptRegistryEntry[];
}

export interface PromptRegistryManifest {
  schemaVersion: typeof PROMPT_REGISTRY_VERSION;
  source: typeof PROMPT_REGISTRY_SOURCE;
  agentCount: number;
  materialHash: string;
}

/** Normalize a persisted manifest for read/compare paths without rewriting its bytes. */
export function normalizePromptRegistryManifest(value: unknown): PromptRegistryManifest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const schemaVersion = canonicalPromptRegistrySchemaVersion(candidate.schemaVersion);
  if (!schemaVersion
    || candidate.source !== PROMPT_REGISTRY_SOURCE
    || typeof candidate.agentCount !== 'number'
    || !Number.isInteger(candidate.agentCount)
    || typeof candidate.materialHash !== 'string') return null;
  return {
    schemaVersion,
    source: PROMPT_REGISTRY_SOURCE,
    agentCount: candidate.agentCount,
    materialHash: candidate.materialHash,
  };
}

function packageRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

export function defaultPromptTemplateDir(root = packageRoot()): string {
  return join(root, 'templates', 'agents');
}

export function listPromptTemplateFiles(templateDir = defaultPromptTemplateDir()): string[] {
  if (!existsSync(templateDir)) return [];
  return readdirSync(templateDir)
    .filter(file => file.endsWith('.md'))
    .sort((a, b) => a.localeCompare(b));
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Canonicalize role IDs embedded in prompt assets without rewriting ordinary
 * process vocabulary. `verification-intent` is both a historical role alias
 * and the name of the verification workflow, so free-form prompt prose must
 * retain that spelling; structured role fields are canonicalized by their
 * owning registries.
 */
function canonicalizePromptRoleText(text: string): string {
  const protectedTokens: string[] = [];
  const protectedText = text.replace(
    /(^|[^A-Za-z0-9_-])(verification-intent)(?=$|@|[^A-Za-z0-9_-])/g,
    (match, prefix: string, _alias: string, offset: number, source: string) => {
      const before = source.slice(0, offset);
      const isStructuredRoleValue = /(?:^|[\s{[(,])(?:role|roleId|agent|agentId|agentType|lane|canonicalType|alias|name)\s*["'`]?\s*[:=]\s*["'`]*$/i.test(before)
        || /(?:--(?:agent|role|lane)(?:=|\s+))$/i.test(before);
      if (isStructuredRoleValue) return match;
      const token = `\u0000proof-or-stop-prompt-vocabulary-${protectedTokens.length}\u0000`;
      protectedTokens.push(token);
      return `${prefix}${token}`;
    },
  );
  let result = canonicalizeAgentRoleText(protectedText);
  for (const token of protectedTokens) {
    result = result.replace(token, 'verification-intent');
  }
  return result;
}

export function isModularReviewerRoleId(roleId: string): roleId is ModularReviewerRoleId {
  return (MODULAR_REVIEWER_ROLE_IDS as readonly string[]).includes(canonicalAgentRoleId(roleId));
}

export function isActiveModularReviewerRoleId(roleId: string): boolean {
  return (ACTIVE_MODULAR_REVIEWER_ROLE_IDS as readonly string[]).includes(canonicalAgentRoleId(roleId));
}

export function isModularComplexRoleId(roleId: string): roleId is ModularComplexRoleId {
  return (MODULAR_COMPLEX_ROLE_IDS as readonly string[]).includes(canonicalAgentRoleId(roleId));
}

export function isModularRoleId(roleId: string): boolean {
  return isModularReviewerRoleId(roleId) || isModularComplexRoleId(roleId);
}

/**
 * Reconstructs the frozen pre-migration body from a modular repository asset.
 * The expected digest makes both representations immutable and content
 * addressed without introducing a mutable baseline writer.
 */
export function restoreLegacyPromptTemplate(entry: PromptRegistryEntry): string {
  const modular = readPromptTemplate(entry);
  const canonicalRole = canonicalAgentRoleId(entry.agentId);
  const legacyRole = legacyAgentRoleIds(canonicalRole)[0] ?? canonicalRole;
  if (!isModularRoleId(canonicalRole)) return canonicalizePromptRoleText(modular);
  const modularMarker = modular.includes(MODULAR_ROLE_BODY_MARKER)
    ? MODULAR_ROLE_BODY_MARKER
    : modular.includes(MODULAR_ROLE_BODY_MARKER_LEGACY)
      ? MODULAR_ROLE_BODY_MARKER_LEGACY
      : null;
  if (!modularMarker) {
    throw new Error(`modular reviewer prompt ${canonicalRole} is missing ${MODULAR_ROLE_BODY_MARKER}`);
  }
  let restored = modular.replace(
    modularMarker,
    canonicalRole === 'proof-or-stop-review-test-coverage'
      ? TEST_COVERAGE_LEGACY_PROCESS_CONTRACT
      : LOAD_BEARING_PROOF_OR_STOP_PROMPT_SLICE,
  );
  if (canonicalRole === 'proof-or-stop-review-story-init') {
    const tailMarker = restored.includes(STORY_INIT_LEGACY_TAIL_MARKER)
      ? STORY_INIT_LEGACY_TAIL_MARKER
      : restored.includes(STORY_INIT_LEGACY_TAIL_MARKER_LEGACY)
        ? STORY_INIT_LEGACY_TAIL_MARKER_LEGACY
        : null;
    if (!tailMarker) {
      throw new Error(`modular story-init prompt is missing ${STORY_INIT_LEGACY_TAIL_MARKER}`);
    }
    restored = restored.replace(tailMarker, STORY_INIT_LEGACY_TAIL.trimEnd());
    // origin/main merge: our pre-merge main defined rewriteStoryInitLegacyTailForCliOnly
    // and STORY_INIT_CLI_ONLY_REPLACEMENTS but never CALLED the rewriter (tsc reported it
    // as unused), so the injected legacy tail still carried direct
    // docs/story/actives/<storyId>/... reads and an init-self-check.json write into the
    // ASSEMBLED prompt -- which CLAUDE.md forbids and the story-init CLI-only policy in
    // verify-proof-or-stop-prompt-baseline.mjs rejects. origin calls it here, right after
    // the tail is injected; adopting that call site is what makes the assembled body
    // CLI-only rather than only the template files.
    restored = rewriteStoryInitLegacyTailForCliOnly(restored);
  }
  // Template assets are now canonical, but these digests deliberately pin the
  // historical prompt bytes. Project the reconstructed canonical body back to
  // the old marker and role vocabularies only for this compatibility check and
  // returned historical body; new prompt writers remain canonical.
  const historical = restored
    .replace(PROOF_OR_STOP_MANAGED_START, LEGACY_LATTICE_MANAGED_START)
    .replace(PROOF_OR_STOP_MANAGED_END, LEGACY_LATTICE_MANAGED_END);
  const actualDigest = sha256(legacyizeAgentRoleText(historical));
  const expectedDigest = isModularReviewerRoleId(canonicalRole)
    ? LEGACY_REVIEWER_TEMPLATE_SHA256[legacyRole]
    : LEGACY_COMPLEX_TEMPLATE_SHA256[legacyRole];
  if (actualDigest !== expectedDigest) {
    throw new Error(
      `legacy reviewer prompt reconstruction drift for ${canonicalRole}: expected ${expectedDigest}, got ${actualDigest}`,
    );
  }
  return canonicalizePromptRoleText(historical);
}

export function resolvePromptTemplateBody(
  entry: PromptRegistryEntry,
  mode: 'legacy-full-context' | 'full-envelope',
): string {
  const body = mode === 'legacy-full-context'
    ? restoreLegacyPromptTemplate(entry)
    : readPromptTemplate(entry);
  if (!isModularReviewerRoleId(entry.agentId)) return body;
  if (body.includes(REVIEW_FINDING_TRIAGE_CONTRACT_MARKER)) {
    throw new Error(`reviewer prompt ${entry.agentId} already contains ${REVIEW_FINDING_TRIAGE_CONTRACT_MARKER}`);
  }
  return `${body.trimEnd()}\n\n${REVIEW_FINDING_TRIAGE_CONTRACT}\n`;
  if (mode === 'legacy-full-context') return restoreLegacyPromptTemplate(entry);
  const source = readPromptTemplate(entry);
  return canonicalizePromptRoleText(source);
}

/**
 * Historical reconstruction remains legacy-byte compatible, but every newly
 * rendered host asset uses the canonical managed marker pair.
 */
function canonicalizeRenderedManagedMarkers(content: string): string {
  return content
    .replace(LEGACY_LATTICE_MANAGED_START, PROOF_OR_STOP_MANAGED_START)
    .replace(LEGACY_LATTICE_MANAGED_END, PROOF_OR_STOP_MANAGED_END);
}

export function renderCodexPromptContent(content: string): string {
  return content
    .replace(/Claude Code/g, 'Codex')
    // B-cc10 F-015: derive from the resolver so a future template referencing
    // .claude/agents/ cannot silently emit the pre-migration adapter dir.
    .replace(/\.claude\/agents\//g, `${PROOF_OR_STOP_ADAPTER_DIR}/agents/`);
}

export function renderPromptForHost(content: string, host: PromptHost): string {
  if (host === 'codex') return renderCodexPromptContent(content);
  return content;
}

export function readPromptRegistry(templateDir = defaultPromptTemplateDir()): PromptRegistrySnapshot {
  const agents = listPromptTemplateFiles(templateDir).map((file): PromptRegistryEntry => {
    const sourcePath = join(templateDir, file);
    const agentId = canonicalAgentRoleId(file.replace(/\.md$/, ''));
    const content = readFileSync(sourcePath, 'utf8');
    return {
      agentId,
      // New host assets are materialized under the canonical filename. The
      // source template may retain its historical filename for one release;
      // readers use the alias map in agent-asset-resolution.ts to accept both.
      file: `${agentId}.md`,
      relPath: relative(packageRoot(), sourcePath).split('\\').join('/'),
      sourcePath,
      templateHash: sha256(content),
      bytes: Buffer.byteLength(content),
    };
  });
  const duplicate = agents.find((entry, index) => agents.findIndex(candidate => candidate.agentId === entry.agentId) !== index);
  if (duplicate) throw new Error(`duplicate canonical prompt role "${duplicate.agentId}" in ${templateDir}`);

  const hash = createHash('sha256');
  hash.update(`${PROMPT_REGISTRY_VERSION}\n`);
  for (const entry of agents) {
    hash.update(`${entry.file}\0${entry.templateHash}\0${entry.bytes}\n`);
  }

  return {
    schemaVersion: PROMPT_REGISTRY_VERSION,
    source: PROMPT_REGISTRY_SOURCE,
    root: templateDir,
    agentCount: agents.length,
    materialHash: hash.digest('hex'),
    agents,
  };
}

export function promptRegistryManifest(templateDir = defaultPromptTemplateDir()): PromptRegistryManifest {
  const snapshot = readPromptRegistry(templateDir);
  return {
    schemaVersion: snapshot.schemaVersion,
    source: snapshot.source,
    agentCount: snapshot.agentCount,
    materialHash: snapshot.materialHash,
  };
}

export function readPromptTemplate(entry: PromptRegistryEntry): string {
  return readFileSync(entry.sourcePath, 'utf8');
}

export function extractTemplateFrontmatter(
  raw: string,
  file: string,
): { frontmatter: string; name: string } {
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  if (lines[0]?.trim() !== '---') {
    throw new Error(
      `Proof-or-Stop agent template ${file} is missing YAML frontmatter (must start with '---'). ` +
        'Cannot generate a host bootstrap without a frontmatter block.',
    );
  }
  const endIdx = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (endIdx === -1) {
    throw new Error(
      `Proof-or-Stop agent template ${file} has an unterminated frontmatter block (no closing '---').`,
    );
  }
  const frontmatterLines = lines.slice(1, endIdx);
  const frontmatter = frontmatterLines.join('\n');
  let name = '';
  for (const line of frontmatterLines) {
    const match = /^name:\s*(.+?)\s*$/.exec(line);
    if (!match) continue;
    name = match[1].replace(/^["']|["']$/g, '').trim();
    break;
  }
  if (!name) {
    throw new Error(
      `Proof-or-Stop agent template ${file} frontmatter has no 'name:' field; cannot register a subagent_type.`,
    );
  }
  return { frontmatter, name };
}

export function buildReviewerRunBootstrapBody(role: string): string {
  return [
    'Proof-or-Stop selects this reviewer role body at runtime.',
    `FIRST run: \`proof-or-stop review_run_start '{"storyId":"<storyId from dispatch>","agent":"${role}"}'\`.`,
    'Follow only the exact prompt returned by that command; this bootstrap intentionally contains no role body.',
  ].join('\n');
}

export function renderReviewerRunBootstrap(frontmatter: string, role: string): string {
  return `---\n${frontmatter}\n---\n${buildReviewerRunBootstrapBody(role)}\n`;
}

export function renderReviewerRunBootstrapForTemplate(raw: string, file: string, role?: string): string {
  const { frontmatter, name } = extractTemplateFrontmatter(raw, file);
  const canonicalRole = canonicalAgentRoleId(role || name);
  const canonicalFrontmatter = frontmatter.replace(
    /^name:\s*.+$/m,
    `name: ${canonicalRole}`,
  );
  return renderReviewerRunBootstrap(canonicalFrontmatter, canonicalRole);
}

export function renderPromptEntryForHost(
  entry: PromptRegistryEntry,
  host: PromptHost,
  mode: 'legacy-full-context' | 'full-envelope' = isModularComplexRoleId(entry.agentId)
    ? 'legacy-full-context'
    : 'full-envelope',
): string {
  const selectedTemplate = canonicalizeRenderedManagedMarkers(isModularComplexRoleId(entry.agentId)
    ? resolvePromptTemplateBody(entry, mode)
    : canonicalizePromptRoleText(readPromptTemplate(entry)));
  const hostTemplate = renderPromptForHost(selectedTemplate, host);
  return isActiveModularReviewerRoleId(entry.agentId)
    ? renderReviewerRunBootstrapForTemplate(hostTemplate, entry.file, canonicalAgentRoleId(entry.agentId))
    : hostTemplate;
}

#!/usr/bin/env node
/**
 * @task B-9b76
 * @checklist CHK-002
 * @title Prompt registry compatibility smoke
 * @type feature
 * @priority high
 * @description
 * Verifies that the package prompt registry enumerates and renders all agent
 * prompt templates without changing legacy Claude/Codex content.
 * @changes
 * - [CHK-002] Cover registry metadata, hashes, and host render compatibility.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  LOAD_BEARING_LATTICE_PROMPT_SLICE,
  MODULAR_COMPLEX_ROLE_IDS,
  MODULAR_REVIEWER_ROLE_IDS,
  PROMPT_REGISTRY_SOURCE,
  PROMPT_REGISTRY_VERSION,
  REVIEW_FINDING_TRIAGE_CONTRACT,
  listPromptTemplateFiles,
  readPromptRegistry,
  renderPromptEntryForHost,
  resolvePromptTemplateBody,
  restoreLegacyPromptTemplate,
} from '../core/prompt-registry.js';
import { assertNoDuplicatePromptEnvelopeRoleKeys } from '../core/config.js';
import {
  ACTIVE_MODULAR_REVIEWER_ROLE_IDS,
  PROMPT_ENVELOPE_ROLLOUT_VERSION,
  PromptRoleContractRegistryError,
  resolvePromptEnvelopeRolloutMode,
  resolvePromptRoleBody,
  reviewerHostRenderIdentity,
} from '../core/prompt-role-contract-registry.js';
import { renderCodexAgentContent } from '../init-assets.js';
// B-cc10 F-055: resolve whichever adapter dir exists. Hardcoding the renamed one made this
// read a path that no longer exists (ENOENT) or scan zero files.
function adapterDirName(base: string): string {
  return existsSync(join(base, '.proof-or-stop-codex')) ? '.proof-or-stop-codex' : '.lattice-codex';
}


const registry = readPromptRegistry();
const files = listPromptTemplateFiles(registry.root);
const projectRoot = join(registry.root, '..', '..', '..', '..');
const loadBearingPromptFiles = new Set([
  'lattice-review-channel.md',
]);
const requiredSafetyPhrases = [
  'Fresh-Context Fence',
  'Process Fact Contract',
  'review_run_start',
  'review_pass_set',
  'finding_add',
  'reviewRunId',
  'verificationEvidence',
  'admissibilityStatus',
  'assuranceLevel',
  'evidenceScope',
];
const qualityProofMetadataPhrases = [
  'job.metadata',
  'linked run.metadata',
  'server-authored proof keys',
  'checking only one location is insufficient',
  'client-controlled or stale metadata cannot satisfy',
  'not receipt-backed production proof',
];
const reviewFindingTriageContractMarker = '<!-- proofbound:review-finding-triage-contract:v1 -->';
const reviewFindingTriageProposalPath = 'docs/requirements/decisions/review-finding-triage-prompt-change-proposal.md';
const dynamicFindingExecutionPlanPath = 'docs/requirements/decisions/dynamic-finding-system-execution-plan.md';
const approvedReviewFindingTriageProposalSha256 = 'dabb185662429fea9b44252b81035bb16226900f2ca9fe5ae97540626722a89a';
// Independent semantic approval boundary. This digest is intentionally kept in
// the smoke instead of the generated prompt baseline: changing the production
// contract requires a deliberate semantic-test review, and `--write` baseline
// refreshes cannot approve extra or contradictory reviewer instructions.
const approvedReviewFindingTriageContractSha256 = '26ad0049198fe58a03aa22e3e88af3f719f08ed33c9eb6210e4c85af00f64646';
const approvedReviewFindingTriageHeadings = [
  reviewFindingTriageContractMarker,
  '## REVIEW Finding Triage and Routing Contract',
  '### Current compatibility boundary',
  '### Record evidence before disposition',
  '### Decide current-Story responsibility without widening scope',
  '### Apply future defer-with-proof only through official authority',
  '### Respect reviewer authority',
] as const;
// Independent normative-clause proof. This deliberately duplicates the approved
// contract semantics instead of deriving them from REVIEW_FINDING_TRIAGE_CONTRACT
// or its digest. Refreshing the digest alone therefore cannot approve additional
// or contradictory prose; changing this manifest requires an explicit test review.
const approvedReviewFindingTriageNormativeLines = [
  'Apply this contract while reviewing. It governs reviewer behavior; it does not replace the CLI, handler, or gate as the authority for lifecycle state.',
  '- The Dynamic Finding System execution plan is the future authority for signed applicability, ownership, routing, freshness, and supersession. Until its official CLI and artifacts exist, use only commands and fields exposed by the current CLI compatibility path. Never fabricate an unavailable assessment field, verdict, owner, route, signature, freshness result, or command receipt, and never claim that a target-state mechanism ran.',
  '- In the current compatibility path, a reviewer records the observation through `finding_add` with the current `reviewRunId` and returns disposition to the Story Owner. Only the Owner may use a currently available compatibility disposition when current mechanical policy permits it. `finding_dismiss` and gap or backlog routes are compatibility accounting; they are not applicability proof, `out_of_scope` proof, deferral proof, repair, or resolution.',
  '- The current compatibility CLI does not implement the future signed `FindingDeferralDisposition` or `defer_with_proof` path. Never fabricate a disposition plan, accepted route, signature, freshness binding, expiry, lineage, receipt, or manifest action, and never claim that compatibility accounting exercised the future mechanism.',
  '- When the Dynamic Finding CLI becomes available, request or consume its official signed assessment and follow its fail-closed result. Prompt prose and compatibility records never substitute for that assessment.',
  '- Start the current lane with `proof-or-stop review_run_start`. Carry its current `reviewRunId` on every `finding_add` or `review_pass_set` submission.',
  '- A role-body or policy change makes an already assembled in-flight reviewer envelope stale. Stop, start a fresh current-material run with `review_run_start`, and redispatch the reviewer; never submit evidence from the older envelope.',
  '- Keep four input axes separate: observation and `evidenceState` preserve what was seen and whether it is suspected, verified, or disproven; severity says how harmful it is; applicability reports whether it belongs to this Story; disposition records the authorized next action after applicability. Gate impact is a fifth, derived result: the current gate uses only facts recognized by current policy, and the future official Dynamic Finding gate derives it from fresh signed applicability and disposition facts. Severity does not determine scope by itself.',
  '- Preserve reproduction steps, source or command evidence, observed impact, and uncertainty. Report an applicability candidate in the evidence supported by the current command; do not invent unsupported fields or present the candidate as a gate decision.',
  '- The machine-owned handler and gate derive the actual blocking result from structured facts. Reviewer prose, a routing proposal, or a claimed deferral is not gate evidence.',
  '- Require repair in the current Story when a verified applicable issue is critical or high; was introduced or worsened by the Story; directly violates acceptance, a verification intent, the core user result, or a public compatibility promise; has known or uncertain protected-surface impact; would make REVIEW, TEST, DONE, or their evidence misleading; has invalid claimed deferral lineage; or has exhausted its cumulative deferral horizon or renewal allowance.',
  '- If an issue would otherwise block under the current review round and policy but its applicability is unknown, fail closed and keep it in the current Story until evidence resolves applicability. This rule applies regardless of severity, including medium findings when the current round treats them as blocking.',
  '- Evidence may support a `pre_existing_unaffected` or `out_of_scope` routing candidate only when the issue is not a direct Story regression, does not prevent the user-visible outcome, and cannot distort lifecycle evidence. Preserve the original Finding and attach reproduction, evidence, impact, recommended action, explicit owner, and route. Critical or high findings must never be left without an owner.',
  '- A `pre_existing_unaffected` candidate requires deterministic base and head reproduction receipts for the same defect, proof that the Story did not worsen severity or impact, confirmation that Story scope does not promise its repair, and a valid owner or route.',
  '- An `out_of_scope` candidate requires signed scope or decision evidence naming the excluded contract, no contradictory checklist or acceptance promise, and a valid owner or route; critical or high Findings cannot be left unowned.',
  '- A `duplicate` candidate requires a signature-valid live canonical Finding, its live owner or route, and proof that the duplicate chain is not circular. Similar text or a matching signature tag is insufficient.',
  '- A `not_reproduced_under_current_witness` candidate requires current target-bound negative command and runtime receipts, fresh source and runtime bindings, a signed command-policy and witness digest, and a live receipted owner or route. It must never be inferred from an old DONE outcome. If the current CLI cannot provide the required proof for any candidate, applicability remains unknown and fails closed.',
  '- Do not expand the Story merely to make the repository globally green. A bounded, evidence-backed route is not dismissal, resolution, or proof that the problem disappeared.',
  '- `defer_with_proof` is a disposition after `applicable`, not an applicability verdict. Only the future official Dynamic Finding System may sign it, and only for a verified applicable low or medium Finding.',
  '- Future deferral eligibility requires current reproduction evidence, proof that the Story did not introduce or worsen the defect, no direct acceptance or verification-intent impact, no known or uncertain protected-surface impact, a canonical defect, fresh bindings, a live owner and existing target, an accepted target-side route receipt, recheck triggers, finite expiry, and unexhausted ledger-derived cumulative lineage.',
  '- A missing, invalid, expired, tampered, ownerless, partially applied, or exhausted claimed deferral fails closed to current-Story mandatory repair. A valid deferred Finding remains verified, open, visible, and unchanged in severity; it is not `out_of_scope`, `pre_existing_unaffected`, `duplicate`, `disproven`, dismissed, resolved, or repaired.',
  '- Reviewers audit and record; they do not repair implementation, rewrite scope, or create follow-up Stories. Do not call `finding_dismiss`, `story_create`, or `gap_log` from a REVIEW lane. Return repair work to the Story Owner and propose routing for non-applicable work.',
  '- If no finding remains to report, record the lane result with `review_pass_set`; never encode a pass as a synthetic Finding.',
  '- Distinguish `disproven` (evidence refutes the observation), `duplicate` (another tracked Finding owns the same defect), and `not_reproduced_under_current_witness` (fresh target-bound negative witness evidence does not reproduce an older claim). Do not collapse any of them, or `defer_with_proof`, into resolved.',
  '- Never delete the original observation, silently rewrite its severity, or overwrite history. In the current compatibility path, preserve the original observation and report the new evidence to the Story Owner; do not fabricate a revision, superseding Finding, applicability recalculation, or gate-impact recalculation. Only the future official Dynamic Finding System may append a signed revision or superseding Finding and recalculate applicability and gate impact through its official artifacts.',
] as const;
const frozenReviewerLegacyReconstructionDigests = {
  'lattice-review-behavior': '45efbfe90d7705408ed95f0111b2108b5e39fc9397aeb7d99eda600db2ea3fe0',
  'lattice-review-concept': '846023d241693435c995900e5869b13e838795718143f2fab14e7a8f7f23eb5d',
  'lattice-review-docs': '7aafa18c26dd713586f416dfc4a3b9676a88438f858c32374af9a978300dd43e',
  'lattice-review-quality': '1f023f75aeab93b6d08e4ec1261a867e43ebd638f6d5ec18e1407cad7c90f58b',
  'lattice-review-test-coverage': 'e433ed9bded50288388fff6447142555e412756137461d841ca7724848458753',
} as const;
// Independent approval for the complete modular reviewer body that precedes the
// injected contract. Terminal-contract validation alone cannot see contradictory
// prose inserted before the marker, and generated registry/baseline digests are
// refreshable. These pins make any prefix change require deliberate semantic-test
// review instead of allowing a baseline refresh to approve it implicitly.
const approvedReviewerModularPrefixDigests = {
  'lattice-review-behavior': '3b25cf83e1b38ce805762736875afe013b6dfcab277e9a15fa3ee314909d1ec4',
  'lattice-review-concept': 'ae1de41de7a5f2db42279ca68c148741f85e0711a7eeeeaeae5797c18c175430',
  'lattice-review-docs': 'cc5fe34377ce4dcb3caf186311394b80350db697252d4929aeeee151838bbd0f',
  'lattice-review-quality': 'b1f40fddd5bcc2962398a042f9575c239fa835dcebc829f9d9c3bb6e3d96cc0b',
  'lattice-review-test-coverage': '45ece5b7d75d0543317107bc1713285f400c75b74e115d8f06077543d222a73b',
} as const;
const approvedEmptyReviewerPrefixSha256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const requiredReviewFindingTriagePhrases = [
  'The Dynamic Finding System execution plan is the future authority',
  'use only commands and fields exposed by the current CLI compatibility path',
  'Never fabricate an unavailable assessment field, verdict, owner, route, signature, freshness result, or command receipt',
  '`finding_dismiss` and gap or backlog routes are compatibility accounting',
  'The current compatibility CLI does not implement the future signed `FindingDeferralDisposition` or `defer_with_proof` path',
  'evidenceState',
  'observation and `evidenceState` preserve what was seen',
  'severity says how harmful it is',
  'applicability reports whether it belongs to this Story',
  'disposition records the authorized next action after applicability',
  'Gate impact is a fifth, derived result',
  'the current gate uses only facts recognized by current policy',
  'the future official Dynamic Finding gate derives it from fresh signed applicability and disposition facts',
  'Severity does not determine scope by itself',
  'Start the current lane with `proof-or-stop review_run_start`',
  'Carry its current `reviewRunId` on every `finding_add` or `review_pass_set` submission',
  'already assembled in-flight reviewer envelope stale',
  'start a fresh current-material run with `review_run_start`, and redispatch the reviewer',
  'never submit evidence from the older envelope',
  'fail closed and keep it in the current Story',
  'including medium findings when the current round treats them as blocking',
  'Critical or high findings must never be left without an owner',
  'deterministic base and head reproduction receipts for the same defect',
  'proof that the Story did not worsen severity or impact',
  'signed scope or decision evidence naming the excluded contract',
  'no contradictory checklist or acceptance promise',
  'a signature-valid live canonical Finding',
  'proof that the duplicate chain is not circular',
  'current target-bound negative command and runtime receipts',
  'fresh source and runtime bindings',
  'a signed command-policy and witness digest',
  'a live receipted owner or route',
  'must never be inferred from an old DONE outcome',
  'applicability remains unknown and fails closed',
  'Do not expand the Story merely to make the repository globally green',
  'A bounded, evidence-backed route is not dismissal, resolution, or proof that the problem disappeared',
  'they do not repair implementation, rewrite scope, or create follow-up Stories',
  'Do not call `finding_dismiss`, `story_create`, or `gap_log` from a REVIEW lane',
  '`disproven` (evidence refutes the observation)',
  '`duplicate` (another tracked Finding owns the same defect)',
  '`not_reproduced_under_current_witness` (fresh target-bound negative witness evidence does not reproduce an older claim)',
  '`defer_with_proof` is a disposition after `applicable`, not an applicability verdict',
  'only for a verified applicable low or medium Finding',
  'no known or uncertain protected-surface impact',
  'an accepted target-side route receipt',
  'unexhausted ledger-derived cumulative lineage',
  'fails closed to current-Story mandatory repair',
  'remains verified, open, visible, and unchanged in severity',
  'Never delete the original observation',
  'silently rewrite its severity',
  'report the new evidence to the Story Owner',
  'do not fabricate a revision, superseding Finding, applicability recalculation, or gate-impact recalculation',
  'Only the future official Dynamic Finding System may append a signed revision or superseding Finding',
  'recalculate applicability and gate impact',
];
const forbiddenReviewFindingTriagePermissions = [
  {
    label: 'reviewer gap_log/finding_dismiss permission',
    pattern: /reviewers?\s+(?:may|can|should|must|are permitted to|are allowed to)[^.\n]{0,100}`?(?:gap_log|finding_dismiss)`?/iu,
  },
  {
    label: 'dismissal proves out_of_scope',
    pattern: /(?:finding_dismiss|dismissal)[^.\n]{0,100}(?:proves?|establishes?|confirms?)[^.\n]{0,80}(?:out_of_scope|out of scope)/iu,
  },
  {
    label: 'severity alone decides scope',
    pattern: /severity\s+(?:alone|by itself)[^.\n]{0,80}(?:determines?|decides?|sets?)[^.\n]{0,40}(?:scope|applicability)/iu,
  },
  {
    label: 'stale reviewRunId reuse',
    pattern: /(?:stale|old|previous)[^.\n]{0,80}reviewRunId[^.\n]{0,100}(?:may|can|should|must)[^.\n]{0,60}(?:be\s+)?(?:reused?|used|remain valid)/iu,
  },
  {
    label: 'reviewer repair permission',
    pattern: /reviewers?\s+(?:may|can|should|must|are permitted to|are allowed to)[^.\n]{0,120}(?:repair|fix|modify|patch)\s+(?:the\s+)?(?:implementation|code|product)/iu,
  },
  {
    label: 'reviewer story_create permission',
    pattern: /reviewers?\s+(?:may|can|should|must|are permitted to|are allowed to)[^.\n]{0,120}(?:call|run|use|invoke)\s+`?story_create`?/iu,
  },
  {
    label: 'unilateral scope or global-green expansion',
    pattern: /reviewers?\s+(?:may|can|should|must|are permitted to|are allowed to)[^.\n]{0,120}(?:expand|widen)[^.\n]{0,80}(?:Story|scope)[^.\n]{0,100}(?:unilaterally|globally green|global green|repository green)/iu,
  },
  {
    label: 'severity rewrite permission',
    pattern: /reviewers?\s+(?:may|can|should|must|are permitted to|are allowed to)[^.\n]{0,120}(?:rewrite|replace|change|lower|raise|overwrite)[^.\n]{0,60}(?:original\s+)?(?:Finding\s+)?severity/iu,
  },
  {
    label: 'routing collapses outcome to resolved',
    pattern: /(?:routed?|deferred|dismissed)[^.\n]{0,120}(?:Finding|issue|defect)?[^.\n]{0,80}(?:is|are|becomes?|counts?\s+as|means?)\s+(?!not\b)[^.\n]{0,40}resolved/iu,
  },
  {
    label: 'evidence-free or ownerless routing',
    pattern: /(?:critical|high)[^.\n]{0,100}(?:Finding|issue|defect)[^.\n]{0,120}(?:may|can|should|must)[^.\n]{0,80}(?:routed?|deferred|dismissed)[^.\n]{0,80}(?:without|no)[^.\n]{0,40}(?:evidence|owner)/iu,
  },
  {
    label: 'prompt prose controls lifecycle gates',
    pattern: /(?:reviewer\s+)?prompt\s+prose[^.\n]{0,100}(?:may|can|should|must|does)[^.\n]{0,80}(?:control|decide|determine|override|satisfy)[^.\n]{0,60}(?:gate|blocking|lifecycle)/iu,
  },
  {
    label: 'file disjointness proves pre_existing applicability',
    pattern: /file\s+disjointness\s+(?:alone|by itself)[^.\n]{0,80}(?:proves?|establishes?|confirms?|determines?)[^.\n]{0,60}(?:pre_existing_unaffected|pre-existing unaffected|applicability)/iu,
  },
  {
    label: 'unsigned stale or ownerless duplicate target',
    pattern: /(?:unsigned|stale|ownerless|unowned)[^.\n]{0,100}(?:Finding|issue|target)[^.\n]{0,100}(?:may|can|should|must)[^.\n]{0,80}(?:serve|act|count|qualify)[^.\n]{0,60}(?:duplicate|canonical)/iu,
  },
  {
    label: 'obsolete stale-or-not-reproduced verdict',
    pattern: /\bstale_or_not_reproduced\b/u,
  },
  {
    label: 'deferral collapsed into applicability',
    pattern: /`?defer_with_proof`?\s+(?:is|means|becomes|counts\s+as)\s+(?:an?\s+)?(?:applicability\s+)?verdict|(?:applicability\s+)?verdict\s+(?:is|may\s+be|can\s+be)\s+`?defer_with_proof`?/iu,
  },
  {
    label: 'high or critical deferral permission',
    pattern: /(?:critical|high)[^.\n]{0,100}(?:Finding|issue|defect)[^.\n]{0,120}(?:may|can|is eligible to|is permitted to)[^.\n]{0,80}(?:defer_with_proof|be deferred)/iu,
  },
  {
    label: 'uncertain protected-surface deferral permission',
    pattern: /(?:defer_with_proof|deferral)[^.\n]{0,140}(?:may|can|is permitted to|remains eligible)[^.\n]{0,100}(?:protected[- ]surface|security|data integrity)[^.\n]{0,60}(?:unknown|uncertain)/iu,
  },
  {
    label: 'compatibility CLI fabricates future deferral authority',
    pattern: /(?:current\s+)?compatibility\s+CLI\s+(?:implements?|mints?|signs?|creates?|supports?)[^.\n]{0,100}(?:FindingDeferralDisposition|defer_with_proof|signed deferral)/iu,
  },
  {
    label: 'compatibility accounting proves deferral',
    pattern: /(?:finding_dismiss|gap_log|backlog)[^.\n]{0,100}(?:proves?|establishes?|confirms?|counts?\s+as)[^.\n]{0,80}(?:deferral|defer_with_proof)/iu,
  },
  {
    label: 'unknown applicability becomes deferrable or non-blocking',
    pattern: /(?:unknown applicability|applicability is unknown)[^.\n]{0,120}(?:may|can|should|must|becomes?|is)[^.\n]{0,80}(?:defer|non[- ]blocking|advisory)/iu,
  },
  {
    label: 'ownerless or receipt-free official deferral',
    pattern: /(?:defer_with_proof|official deferral)[^.\n]{0,140}(?:may|can|is eligible to|is permitted to)[^.\n]{0,80}(?:without|no)[^.\n]{0,60}(?:owner|target|route receipt|receipt)/iu,
  },
] as const;

function extractReviewFindingTriageStructure(contract: string): {
  headings: string[];
  normativeLines: string[];
} {
  const lines = contract.split('\n').map(line => line.trim()).filter(Boolean);
  return {
    headings: lines.filter(line => line === reviewFindingTriageContractMarker || line.startsWith('#')),
    normativeLines: lines.filter(line => line !== reviewFindingTriageContractMarker && !line.startsWith('#')),
  };
}

function assertReviewFindingTriageSemantics(
  content: string,
  sourceLabel: string,
  approvedDigest = approvedReviewFindingTriageContractSha256,
  approvedPrefixDigest = approvedEmptyReviewerPrefixSha256,
): void {
  assert.equal(
    occurrenceCount(content, reviewFindingTriageContractMarker),
    1,
    `${sourceLabel} contains exactly one canonical REVIEW triage contract`,
  );
  const markerIndex = content.indexOf(reviewFindingTriageContractMarker);
  const deliveredPrefix = content.slice(0, markerIndex).trimEnd();
  assert.equal(
    createHash('sha256').update(deliveredPrefix).digest('hex'),
    approvedPrefixDigest,
    `${sourceLabel} keeps the independently approved pre-contract reviewer body`,
  );
  const deliveredContract = content.slice(markerIndex).trimEnd();
  assert.equal(
    createHash('sha256').update(deliveredContract).digest('hex'),
    approvedDigest,
    `${sourceLabel} ends at the independently approved canonical REVIEW triage contract`,
  );
  const structure = extractReviewFindingTriageStructure(deliveredContract);
  assert.deepEqual(
    structure.headings,
    approvedReviewFindingTriageHeadings,
    `${sourceLabel} matches the independently approved REVIEW triage heading manifest`,
  );
  assert.deepEqual(
    structure.normativeLines,
    approvedReviewFindingTriageNormativeLines,
    `${sourceLabel} matches the independently approved REVIEW triage normative-clause manifest`,
  );
  for (const phrase of requiredReviewFindingTriagePhrases) {
    assert.ok(content.includes(phrase), `${sourceLabel} keeps triage phrase: ${phrase}`);
  }
  for (const forbidden of forbiddenReviewFindingTriagePermissions) {
    assert.doesNotMatch(content, forbidden.pattern, `${sourceLabel} rejects contradictory ${forbidden.label}`);
  }
}

function assertReviewFindingTriageMutationFailures(): void {
  const originalMutations = [
    'Reviewers may call `gap_log` or `finding_dismiss` to route a defect.',
    'Dismissal proves `out_of_scope` for the current Story.',
    'Severity alone decides scope and applicability.',
    'An old reviewRunId may be reused after the reviewer envelope changes.',
    'Reviewers may repair the implementation before recording the lane result.',
    'Reviewers may call `story_create` to open a follow-up Story.',
    'Reviewers may expand the Story unilaterally to make the repository globally green.',
    'Reviewers may rewrite the original Finding severity when new evidence arrives.',
    'A routed Finding becomes resolved once it no longer blocks the current Story outcome.',
    'A high Finding may be routed without evidence or an owner.',
    'Reviewer prompt prose may determine lifecycle gate impact.',
    'File disjointness alone proves `pre_existing_unaffected` applicability.',
    'An unsigned, stale, ownerless Finding may serve as the canonical duplicate target.',
  ];
  const paraphraseMutations = [
    'A reviewer is allowed to invoke `gap_log` or `finding_dismiss`.',
    'An out-of-scope classification can be inferred from dismissal.',
    'Scope follows severity without further applicability evidence.',
    'The reviewRunId from the superseded envelope stays valid.',
    'A reviewer is authorized to patch the code before reporting.',
    'The review lane is permitted to invoke `story_create`.',
    'The Story can be widened by reviewers until the repository is green.',
    'Applicability evidence may lower the original Finding severity.',
    'Routed findings are resolved when they stop blocking.',
    'A blocker may be routed even if it lacks evidence and has no owner.',
    'This prompt determines whether the REVIEW gate blocks.',
    'Disjoint files are sufficient to establish `pre_existing_unaffected`.',
    'A canonical duplicate target may be an unsigned, stale, unowned Finding.',
  ];
  const digestRefreshedParaphraseMutations = [
    'The review team has authority to invoke `gap_log` or `finding_dismiss`.',
    '`finding_dismiss` establishes Story exclusion.',
    'Scope is governed by severity unless applicability is disproved.',
    "The superseded envelope's reviewRunId remains accepted.",
    'The audit lane may patch product code before filing.',
    '`story_create` is available during REVIEW.',
    'Reviewers can broaden the Story until all repository checks pass.',
    'Applicability evidence can revise the original severity downward.',
    'A routed Finding counts as closed once it ceases to block.',
    'Proof and ownership are optional when routing a blocker.',
    'These instructions establish lifecycle blocking.',
    'A non-overlapping diff proves the defect is inherited and unaffected.',
    'A stale unowned canonical record is a valid duplicate destination.',
  ];
  const currentAuthorityMutations = [
    'The future assessment may use `stale_or_not_reproduced` when an old report no longer fails.',
    '`defer_with_proof` is an applicability verdict for issues that can wait.',
    'A high Finding may be deferred through `defer_with_proof` when a later owner agrees.',
    'Deferral remains eligible when protected-surface impact is uncertain.',
    'The current compatibility CLI implements a signed `FindingDeferralDisposition`.',
    '`finding_dismiss` proves deferral for the current Story.',
    'Unknown applicability may become non-blocking through deferral.',
    'Official deferral may proceed without an owner or route receipt.',
  ];
  assert.equal(originalMutations.length, 13, 'the original semantic mutation inventory remains complete');
  assert.equal(paraphraseMutations.length, 13, 'the independent reviewer paraphrase mutation inventory remains complete');
  assert.equal(digestRefreshedParaphraseMutations.length, 13, 'the digest-refreshed reviewer paraphrase inventory remains complete');
  assert.equal(currentAuthorityMutations.length, 8, 'the current Dynamic Finding authority mutation inventory remains complete');
  for (const [index, mutation] of [...originalMutations, ...paraphraseMutations].entries()) {
    assert.throws(
      () => assertReviewFindingTriageSemantics(`${REVIEW_FINDING_TRIAGE_CONTRACT}\n${mutation}`, `mutation ${index + 1}`),
      /independently approved canonical REVIEW triage contract|normative-clause manifest|rejects contradictory/,
      `semantic mutation ${index + 1} must fail validation`,
    );
  }
  for (const [index, mutation] of digestRefreshedParaphraseMutations.entries()) {
    const changedTerminalContract = `${REVIEW_FINDING_TRIAGE_CONTRACT}\n${mutation}`;
    const refreshedDigest = createHash('sha256').update(changedTerminalContract).digest('hex');
    assert.throws(
      () => assertReviewFindingTriageSemantics(changedTerminalContract, `post-marker digest-refreshed mutation ${index + 1}`, refreshedDigest),
      /normative-clause manifest|heading manifest|rejects contradictory/,
      `post-marker digest-refreshed semantic mutation ${index + 1} must fail independently of the approval digest`,
    );
    assert.throws(
      () => assertReviewFindingTriageSemantics(
        `${mutation}\n${REVIEW_FINDING_TRIAGE_CONTRACT}`,
        `pre-marker digest-refreshed mutation ${index + 1}`,
      ),
      /independently approved pre-contract reviewer body/,
      `pre-marker digest-refreshed semantic mutation ${index + 1} must fail independently of the terminal contract digest`,
    );
  }
  for (const [index, mutation] of currentAuthorityMutations.entries()) {
    const changedTerminalContract = `${REVIEW_FINDING_TRIAGE_CONTRACT}\n${mutation}`;
    const refreshedContractDigest = createHash('sha256').update(changedTerminalContract).digest('hex');
    assert.throws(
      () => assertReviewFindingTriageSemantics(
        changedTerminalContract,
        `terminal digest-refreshed authority mutation ${index + 1}`,
        refreshedContractDigest,
      ),
      /normative-clause manifest|heading manifest|rejects contradictory/,
      `terminal authority mutation ${index + 1} must fail after its contract digest is refreshed`,
    );
    const assembledBody = `${mutation}\n${REVIEW_FINDING_TRIAGE_CONTRACT}`;
    const refreshedPrefixDigest = createHash('sha256').update(mutation).digest('hex');
    assert.throws(
      () => assertReviewFindingTriageSemantics(
        assembledBody,
        `complete-body digest-refreshed authority mutation ${index + 1}`,
        approvedReviewFindingTriageContractSha256,
        refreshedPrefixDigest,
      ),
      /rejects contradictory/,
      `complete assembled reviewer body mutation ${index + 1} must fail even after its prefix digest is refreshed`,
    );
  }
  for (const roleId of MODULAR_REVIEWER_ROLE_IDS) {
    const entry = registry.agents.find(candidate => candidate.agentId === roleId)!;
    for (const mode of ['legacy-full-context', 'full-envelope'] as const) {
      const completeBody = resolvePromptTemplateBody(entry, mode);
      const markerIndex = completeBody.indexOf(reviewFindingTriageContractMarker);
      const approvedPrefix = completeBody.slice(0, markerIndex).trimEnd();
      for (const [index, mutation] of currentAuthorityMutations.entries()) {
        const changedPrefix = `${approvedPrefix}\n${mutation}`;
        const changedCompleteBody = `${changedPrefix}\n${completeBody.slice(markerIndex)}`;
        const refreshedPrefixDigest = createHash('sha256').update(changedPrefix).digest('hex');
        assert.throws(
          () => assertReviewFindingTriageSemantics(
            changedCompleteBody,
            `${roleId}/${mode} digest-refreshed complete-body authority mutation ${index + 1}`,
            approvedReviewFindingTriageContractSha256,
            refreshedPrefixDigest,
          ),
          /rejects contradictory/,
          `${roleId}/${mode} complete assembled mutation ${index + 1} must fail after prefix digest repinning`,
        );
      }
    }
  }
}

function occurrenceCount(content: string, needle: string): number {
  return content.split(needle).length - 1;
}

function extractLatticeBlock(content: string): string | null {
  return content.match(/<!-- lattice:start -->[\s\S]*?<!-- lattice:end -->/)?.[0] ?? null;
}

function assertReviewFindingTriageDelivery(): void {
  assert.doesNotMatch(
    REVIEW_FINDING_TRIAGE_CONTRACT,
    /[\u3400-\u9fff]/u,
    'the injected open-source REVIEW triage contract is English-only',
  );
  for (const roleId of MODULAR_REVIEWER_ROLE_IDS) {
    const entry = registry.agents.find(candidate => candidate.agentId === roleId);
    assert.ok(entry, `${roleId} is registered`);
    const frozenLegacyReconstruction = restoreLegacyPromptTemplate(entry);
    assert.equal(occurrenceCount(frozenLegacyReconstruction, reviewFindingTriageContractMarker), 0, `${roleId} frozen reconstruction excludes the appended contract`);
    assert.equal(
      createHash('sha256').update(frozenLegacyReconstruction).digest('hex'),
      frozenReviewerLegacyReconstructionDigests[roleId],
      `${roleId} frozen legacy reconstruction digest remains byte-for-byte unchanged`,
    );
    const frozenLegacyPrefixDigest = createHash('sha256').update(frozenLegacyReconstruction.trimEnd()).digest('hex');
    const modularSource = readFileSync(entry.sourcePath, 'utf8');
    assert.equal(
      createHash('sha256').update(modularSource.trimEnd()).digest('hex'),
      approvedReviewerModularPrefixDigests[roleId],
      `${roleId} modular reviewer prefix requires independent semantic approval`,
    );
    for (const mode of ['legacy-full-context', 'full-envelope'] as const) {
      const body = resolvePromptTemplateBody(entry, mode);
      assert.equal(occurrenceCount(body, reviewFindingTriageContractMarker), 1, `${roleId}/${mode} receives one contract`);
      assert.ok(body.endsWith(`${REVIEW_FINDING_TRIAGE_CONTRACT}\n`), `${roleId}/${mode} receives canonical contract bytes`);
      assertReviewFindingTriageSemantics(
        body,
        `${roleId}/${mode}`,
        approvedReviewFindingTriageContractSha256,
        mode === 'legacy-full-context' ? frozenLegacyPrefixDigest : approvedReviewerModularPrefixDigests[roleId],
      );
    }
  }
  for (const entry of registry.agents) {
    if (MODULAR_REVIEWER_ROLE_IDS.includes(entry.agentId as typeof MODULAR_REVIEWER_ROLE_IDS[number])) continue;
    for (const mode of ['legacy-full-context', 'full-envelope'] as const) {
      assert.equal(occurrenceCount(resolvePromptTemplateBody(entry, mode), reviewFindingTriageContractMarker), 0, `${entry.agentId}/${mode} receives no REVIEW contract`);
    }
  }
  for (let mask = 0; mask < 2 ** MODULAR_REVIEWER_ROLE_IDS.length; mask += 1) {
    const roles = Object.fromEntries(MODULAR_REVIEWER_ROLE_IDS.map((roleId, index) => [
      roleId,
      (mask & (1 << index)) === 0 ? 'legacy-full-context' : 'full-envelope',
    ]));
    const config = { version: PROMPT_ENVELOPE_ROLLOUT_VERSION, roles };
    for (const roleId of MODULAR_REVIEWER_ROLE_IDS) {
      assert.equal(occurrenceCount(resolvePromptRoleBody(roleId, config).body, reviewFindingTriageContractMarker), 1, `mixed rollout mask ${mask} delivers one contract to ${roleId}`);
    }
  }
  assertReviewFindingTriageMutationFailures();
}

function assertReviewFindingTriageProposal(): void {
  const proposalPath = join(projectRoot, reviewFindingTriageProposalPath);
  assert.ok(existsSync(proposalPath), 'the executable REVIEW Finding triage proposal is tracked');
  const proposal = readFileSync(proposalPath, 'utf8');
  assert.equal(
    createHash('sha256').update(proposal).digest('hex'),
    approvedReviewFindingTriageProposalSha256,
    'the Agent-side proposal requires independent non-runtime digest approval',
  );
  assert.doesNotMatch(proposal, /[\u3400-\u9fff]/u, 'the open-source proposal is English-only');
  assert.equal(
    occurrenceCount(proposal, '`stale_or_not_reproduced`'),
    1,
    'the proposal names the retired vocabulary exactly once to prohibit its delivery',
  );
  assert.ok(
    proposal.includes('The retired name `stale_or_not_reproduced` must not appear in delivered Agent'),
    'the proposal explicitly rejects retired applicability vocabulary in delivered prompts',
  );
  for (const phrase of [
    'This proposal is its Agent-side projection',
    'This proposal does not authorize changes to:',
    '`not_reproduced_under_current_witness`',
    '`defer_with_proof` is a disposition after `applicable`',
    'The current compatibility CLI does not implement the future signed',
    '`finding_dismiss`, `gap_log`, and backlog notes are compatibility accounting',
    'Digest pins provide change review, but they are not the semantic oracle',
  ]) {
    assert.ok(proposal.includes(phrase), `the proposal keeps authority boundary phrase: ${phrase}`);
  }
}

function assertDynamicFindingAuthorityProjection(): void {
  const plan = readFileSync(join(projectRoot, dynamicFindingExecutionPlanPath), 'utf8');
  const normalizedPlan = plan.replace(/\s+/gu, ' ');
  assert.doesNotMatch(plan, /[\u3400-\u9fff]/u, 'the Dynamic Finding target-state plan is English-only');
  assert.equal(
    occurrenceCount(plan, '`stale_or_not_reproduced`'),
    1,
    'the authority plan retains the retired verdict exactly once as a labeled future legacy alias',
  );
  for (const phrase of [
    '`not_reproduced_under_current_witness`',
    'interface FindingDeferralDisposition',
    "action: 'defer_with_proof'",
    'Deferral is a disposition after `applicable`, never an applicability verdict.',
    'critical or high severity',
    'introduced or worsened by the current Story',
    'direct acceptance,',
    'known or uncertain protected-surface impact',
    'lifecycle or gate evidence that would become misleading',
    'exhausted, or otherwise invalid disposition lineage',
    'the current CLI implements neither the future legacy',
    'The current CLI implements no signed deferral command or artifact',
  ]) {
    assert.ok(normalizedPlan.includes(phrase), `the Dynamic Finding authority plan keeps target-state phrase: ${phrase}`);
  }
}

function assertOwnerAndImplementerTriageGuidance(): void {
  const ownerGuide = readFileSync(join(projectRoot, 'AGENTS.md'), 'utf8');
  for (const phrase of [
    'Every Finding reported only in reviewer prose must be redispatched for structured registration',
    'introduced or worsened by the current Story',
    'directly blocks acceptance or the core user result',
    'critical or high',
    'known or uncertain protected-surface impact',
    'would make lifecycle gate evidence or gate truth misleading',
    'invalid claimed deferral lineage',
    'future official `defer_with_proof` disposition',
    'including a medium Finding in a policy round where medium is blocking',
    '`not_reproduced_under_current_witness` requires fresh target-bound negative command and runtime receipts',
    'structured evidence proves that it is not applicable to the current Story',
    'Critical or high Findings must never be left without a traceable owner',
    'the Dynamic Finding System execution plan is future authority',
    'The current compatibility CLI does not implement a signed `FindingDeferralDisposition` or `defer_with_proof`',
    'never fabricate an assessment, disposition, owner, route, signature, freshness binding, expiry, lineage, receipt, or manifest action',
    'Current `finding_dismiss`, gap, and backlog handling is temporary compatibility accounting for a round or profile',
    'proves neither applicability nor `out_of_scope`',
    'is not proof of repair or resolution, nor proof of deferral',
    'Prompt text alone does not mechanically enforce this discipline',
  ]) {
    assert.ok(ownerGuide.includes(phrase), `Story Owner guidance keeps triage phrase: ${phrase}`);
  }
  const ownerTriageLines = ownerGuide
    .split('\n')
    .filter(line => /REVIEW Finding handling|Bounded current-Story repair|Evidence-backed routing|Compatibility boundary and dismissal/.test(line));
  const ownerTriageSlice = ownerTriageLines.join('\n');
  assert.equal(ownerTriageLines.length, 4, 'all four Story Owner triage rules are isolated for language audit');
  assert.doesNotMatch(ownerTriageSlice, /[\u3400-\u9fff]/u, 'the added Story Owner triage slice is English-only');
  assert.match(
    ownerTriageSlice,
    /structured evidence[\s\S]*not applicable[\s\S]*traceable owner or route[\s\S]*does not block the current gate/iu,
    'Story Owner routing requires applicability, ownership, and non-blocking proof',
  );
  assert.match(
    ownerTriageSlice,
    /Critical or high Findings[\s\S]*never be left without a traceable owner/iu,
    'Story Owner routing never leaves critical or high Findings unowned',
  );

  const claudeGuide = readFileSync(join(projectRoot, 'CLAUDE.md'), 'utf8');
  const claudeTriageLines = claudeGuide
    .split('\n')
    .filter(line => /REVIEW Finding handling|Bounded current-Story repair|Evidence-backed routing|Compatibility boundary and dismissal/.test(line));
  assert.deepEqual(claudeTriageLines, ownerTriageLines, 'Claude and Codex Story Owner guidance is byte-identical');
  assert.doesNotMatch(claudeTriageLines.join('\n'), /[\u3400-\u9fff]/u, 'the Claude Story Owner triage slice is English-only');
  for (const [file, lines] of [['AGENTS.md', ownerTriageLines], ['CLAUDE.md', claudeTriageLines]] as const) {
    const compatibilityLine = lines.find(line => line.includes('**Compatibility boundary and dismissal**')) ?? '';
    assert.match(compatibilityLine, /Current `finding_dismiss`, gap, and backlog handling is temporary compatibility accounting for a round or profile;/u, `${file} keeps bounded compatibility accounting`);
    assert.match(compatibilityLine, /it proves neither applicability nor `out_of_scope`, and it is not proof of repair or resolution, nor proof of deferral\./u, `${file} keeps each non-proof conclusion once`);
    assert.match(compatibilityLine, /Prompt text alone does not mechanically enforce this discipline\./u, `${file} keeps the prompt-enforcement limitation once`);
    for (const term of ['`finding_dismiss`', 'applicability', '`out_of_scope`', 'repair', 'resolution'] as const) {
      assert.equal(occurrenceCount(compatibilityLine, term), 1, `${file} states the ${term} compatibility conclusion once`);
    }
    assert.equal(occurrenceCount(compatibilityLine, 'mechanically enforce'), 1, `${file} states the prompt-enforcement limitation once`);
  }

  const implementerGuide = readFileSync(join(registry.root, 'lattice-implementer.md'), 'utf8');
  for (const phrase of [
    'Preserve its reproduction evidence and impact evidence',
    'Report it to the Story Owner',
    'Never widen the assigned item or Story unilaterally',
  ]) {
    assert.ok(implementerGuide.includes(phrase), `implementer guidance keeps triage phrase: ${phrase}`);
  }
  const implementerTriageLine = implementerGuide
    .split('\n')
    .find(line => line.includes('**Out-of-item finding discipline**')) ?? '';
  assert.ok(implementerTriageLine, 'the implementer triage rule is present');
  assert.doesNotMatch(implementerTriageLine, /[\u3400-\u9fff]/u, 'the added implementer triage rule is English-only');
}

assertReviewFindingTriageProposal();
assertDynamicFindingAuthorityProjection();
assertReviewFindingTriageDelivery();
assertOwnerAndImplementerTriageGuidance();
if (process.argv.includes('--review-finding-triage-only')) {
  console.log('review finding triage registry delivery smoke: PASS');
  process.exit(0);
}

assert.equal(registry.schemaVersion, PROMPT_REGISTRY_VERSION);
assert.equal(registry.source, PROMPT_REGISTRY_SOURCE);
assert.equal(registry.agentCount, files.length);
assert.ok(registry.agentCount > 0, 'registry should expose package prompt templates');
assert.deepEqual(registry.agents.map(agent => agent.file), files);

const material = createHash('sha256');
material.update(`${PROMPT_REGISTRY_VERSION}\n`);
for (const entry of registry.agents) {
  const source = readFileSync(entry.sourcePath, 'utf8');
  const sourceHash = createHash('sha256').update(source).digest('hex');
  assert.equal(entry.templateHash, sourceHash, `${entry.file} template hash matches source`);
  const isComplexRole = MODULAR_COMPLEX_ROLE_IDS.includes(entry.agentId as typeof MODULAR_COMPLEX_ROLE_IDS[number]);
  const expectedClaude = renderPromptEntryForHost(entry, 'claude');
  const expectedCodex = renderPromptEntryForHost(entry, 'codex');
  if (MODULAR_REVIEWER_ROLE_IDS.includes(entry.agentId as typeof MODULAR_REVIEWER_ROLE_IDS[number])) {
    assert.match(expectedClaude, /review_run_start/, `${entry.file} Claude registry render is bootstrap-only`);
    assert.match(expectedCodex, /review_run_start/, `${entry.file} Codex registry render is bootstrap-only`);
    assert.equal(occurrenceCount(expectedClaude, reviewFindingTriageContractMarker), 0, `${entry.file} Claude bootstrap does not duplicate the runtime role contract`);
    assert.equal(occurrenceCount(expectedCodex, reviewFindingTriageContractMarker), 0, `${entry.file} Codex bootstrap does not duplicate the runtime role contract`);
    assert.doesNotMatch(expectedClaude, /proofbound:modular-role-body:v1/, `${entry.file} Claude registry excludes role body`);
    assert.doesNotMatch(expectedCodex, /proofbound:modular-role-body:v1/, `${entry.file} Codex registry excludes role body`);
  } else if (!isComplexRole) {
    assert.equal(expectedClaude, source, `${entry.file} Claude render matches template`);
  }
  if (isComplexRole) {
    const legacy = restoreLegacyPromptTemplate(entry);
    assert.equal(expectedClaude, legacy, `${entry.file} rejected rollout defaults Claude to frozen legacy bytes`);
    assert.equal(expectedCodex, renderCodexAgentContent(legacy), `${entry.file} rejected rollout defaults Codex to frozen legacy bytes`);
    assert.equal(renderPromptEntryForHost(entry, 'claude', 'full-envelope'), source, `${entry.file} modular Claude render remains explicitly selectable`);
    assert.equal(renderPromptEntryForHost(entry, 'codex', 'full-envelope'), renderCodexAgentContent(source), `${entry.file} modular Codex render remains explicitly selectable`);
    assert.notEqual(expectedClaude, source, `${entry.file} rejected rollout cannot yield the modular Claude render`);
  } else if (!MODULAR_REVIEWER_ROLE_IDS.includes(entry.agentId as typeof MODULAR_REVIEWER_ROLE_IDS[number])) {
    assert.equal(expectedCodex, renderCodexAgentContent(source), `${entry.file} Codex render matches legacy transform`);
  }
  if (!MODULAR_REVIEWER_ROLE_IDS.includes(entry.agentId as typeof MODULAR_REVIEWER_ROLE_IDS[number])) {
    assert.equal(occurrenceCount(expectedClaude, reviewFindingTriageContractMarker), 0, `${entry.file} Claude render receives no REVIEW triage contract`);
    assert.equal(occurrenceCount(expectedCodex, reviewFindingTriageContractMarker), 0, `${entry.file} Codex render receives no REVIEW triage contract`);
  }
  if (loadBearingPromptFiles.has(entry.file)) {
    assert.equal(extractLatticeBlock(source), LOAD_BEARING_LATTICE_PROMPT_SLICE, `${entry.file} uses canonical load-bearing prompt slice`);
    for (const phrase of requiredSafetyPhrases) {
      assert.ok(source.includes(phrase), `${entry.file} keeps load-bearing prompt phrase: ${phrase}`);
    }
  }
  if (entry.file === 'lattice-review-quality.md') {
    for (const phrase of qualityProofMetadataPhrases) {
      assert.ok(source.includes(phrase), `${entry.file} keeps proof metadata review phrase: ${phrase}`);
    }
  }
  const claudeMirrorPath = join(projectRoot, '.claude', 'agents', entry.file);
  if (existsSync(claudeMirrorPath)) {
    assert.equal(readFileSync(claudeMirrorPath, 'utf8'), expectedClaude, `${entry.file} .claude asset matches its canonical host input`);
  }
  const codexMirrorPath = join(projectRoot, adapterDirName(projectRoot), 'agents', entry.file);
  if (existsSync(codexMirrorPath)) {
    assert.equal(readFileSync(codexMirrorPath, 'utf8'), expectedCodex, `${entry.file} .lattice-codex asset matches its canonical host input`);
  }
  material.update(`${entry.file}\0${entry.templateHash}\0${entry.bytes}\n`);
}
assert.equal(registry.materialHash, material.digest('hex'), 'registry material hash is deterministic');

assert.deepEqual(
  [...ACTIVE_MODULAR_REVIEWER_ROLE_IDS],
  [...MODULAR_REVIEWER_ROLE_IDS],
  'the modular rollout roster is exactly the five active REVIEW lanes',
);
const fullRoles = Object.fromEntries(MODULAR_REVIEWER_ROLE_IDS.map(roleId => [roleId, 'full-envelope']));
const fullConfig = { version: PROMPT_ENVELOPE_ROLLOUT_VERSION, roles: fullRoles };
for (const roleId of MODULAR_REVIEWER_ROLE_IDS) {
  const entry = registry.agents.find(candidate => candidate.agentId === roleId)!;
  const legacy = resolvePromptRoleBody(roleId, {
    version: PROMPT_ENVELOPE_ROLLOUT_VERSION,
    roles: { [roleId]: 'legacy-full-context' },
  });
  const modular = resolvePromptRoleBody(roleId, fullConfig);
  const frozenLegacyBody = restoreLegacyPromptTemplate(entry);
  const modularSourceBody = readFileSync(entry.sourcePath, 'utf8');
  assert.ok(legacy.body.startsWith(frozenLegacyBody.trimEnd()), `${roleId} rollback preserves frozen bytes before the appended contract`);
  assert.equal(occurrenceCount(frozenLegacyBody, reviewFindingTriageContractMarker), 0, `${roleId} frozen legacy reconstruction digest remains unchanged`);
  assert.equal(occurrenceCount(legacy.body, reviewFindingTriageContractMarker), 1, `${roleId} legacy path appends one triage contract`);
  assert.ok(legacy.body.endsWith(`${REVIEW_FINDING_TRIAGE_CONTRACT}\n`), `${roleId} legacy path appends canonical contract bytes`);
  assert.equal(legacy.legacyBytesRestored, true);
  assert.equal(modular.mode, 'full-envelope');
  assert.equal(modular.legacyBytesRestored, false);
  assert.ok(Buffer.byteLength(modular.body) < Buffer.byteLength(legacy.body), `${roleId} modular body is smaller`);
  assert.notEqual(modular.bodyDigest, legacy.bodyDigest, `${roleId} bodies are independently content-addressed`);
  assert.ok(modular.body.startsWith(modularSourceBody.trimEnd()), `${roleId} package asset precedes the appended contract`);
  assert.equal(occurrenceCount(modularSourceBody, reviewFindingTriageContractMarker), 0, `${roleId} package asset does not duplicate the injected contract`);
  assert.equal(occurrenceCount(modular.body, reviewFindingTriageContractMarker), 1, `${roleId} full-envelope path appends one triage contract`);
  assert.ok(modular.body.endsWith(`${REVIEW_FINDING_TRIAGE_CONTRACT}\n`), `${roleId} full-envelope path appends canonical contract bytes`);
  assertReviewFindingTriageSemantics(
    legacy.body,
    `${roleId} legacy path`,
    approvedReviewFindingTriageContractSha256,
    createHash('sha256').update(frozenLegacyBody.trimEnd()).digest('hex'),
  );
  assertReviewFindingTriageSemantics(
    modular.body,
    `${roleId} full-envelope path`,
    approvedReviewFindingTriageContractSha256,
    approvedReviewerModularPrefixDigests[roleId],
  );
  assert.equal(extractLatticeBlock(modular.body), null, `${roleId} modular body contains no legacy Runtime Guide`);
  assert.ok(modular.body.includes('proofbound:modular-role-body:v1'), `${roleId} keeps the legacy reconstruction anchor`);
  for (const host of ['claude', 'codex'] as const) {
    const identity = reviewerHostRenderIdentity(projectRoot, roleId, host, 'full-envelope');
    assert.equal(identity.rolloutMode, 'full-envelope');
    assert.ok(identity.hostRenderDigest.length > 0, `${roleId}/${host} binds the actual modular host render`);
    assert.ok(identity.selectedRoleBodyDigest.length > 0, `${roleId}/${host} binds the selected role body`);
    assert.ok(identity.bootstrapDigest?.length, `${roleId}/${host} binds the canonical bootstrap in ${identity.source} mode`);
  }

  const oneRoleConfig = {
    version: PROMPT_ENVELOPE_ROLLOUT_VERSION,
    roles: { [roleId]: 'full-envelope' },
  };
  for (const otherRoleId of MODULAR_REVIEWER_ROLE_IDS) {
    assert.equal(
      resolvePromptEnvelopeRolloutMode(otherRoleId, oneRoleConfig),
      otherRoleId === roleId ? 'full-envelope' : 'legacy-full-context',
      `${roleId} rollout flag does not bleed into ${otherRoleId}`,
    );
  }
}
for (let mask = 0; mask < 2 ** MODULAR_REVIEWER_ROLE_IDS.length; mask += 1) {
  const roles = Object.fromEntries(MODULAR_REVIEWER_ROLE_IDS.map((roleId, index) => [
    roleId,
    (mask & (1 << index)) === 0 ? 'legacy-full-context' : 'full-envelope',
  ]));
  const config = { version: PROMPT_ENVELOPE_ROLLOUT_VERSION, roles };
  for (const [roleId, expected] of Object.entries(roles)) {
    assert.equal(resolvePromptEnvelopeRolloutMode(roleId, config), expected, `mixed rollout mask ${mask} keeps ${roleId}`);
    assert.equal(
      occurrenceCount(resolvePromptRoleBody(roleId, config).body, reviewFindingTriageContractMarker),
      1,
      `mixed rollout mask ${mask} delivers one triage contract to ${roleId}`,
    );
  }
}
assert.equal(resolvePromptEnvelopeRolloutMode('lattice-review-concept', undefined), 'legacy-full-context');
for (const roles of [
  { 'lattice-review-channel': 'full-envelope' },
  { 'implementation-reviewer': 'full-envelope' },
  { 'unknown-reviewer': 'full-envelope' },
]) {
  assert.throws(
    () => resolvePromptEnvelopeRolloutMode('lattice-review-concept', {
      version: PROMPT_ENVELOPE_ROLLOUT_VERSION,
      roles,
    }),
    PromptRoleContractRegistryError,
  );
}
for (const [source, expected] of [
  [
    '{"promptEnvelope":{"version":"proofbound.prompt-envelope-rollout.v1","roles":{}},"promptEnvelope":{"version":"proofbound.prompt-envelope-rollout.v1","roles":{"lattice-review-quality":"full-envelope"}}}',
    /duplicate promptEnvelope key/,
  ],
  [
    '{"promptEnvelope":{"version":"proofbound.prompt-envelope-rollout.v1","roles":{},"roles":{"lattice-review-quality":"full-envelope"}}}',
    /duplicate promptEnvelope\.roles key/,
  ],
  [
    '{"promptEnvelope":{"version":"proofbound.prompt-envelope-rollout.v1","roles":{"lattice-review-quality":"full-envelope","lattice-review-quality":"legacy-full-context"}}}',
    /duplicate promptEnvelope\.roles\.lattice-review-quality key/,
  ],
] as const) {
  assert.throws(() => assertNoDuplicatePromptEnvelopeRoleKeys(source), expected);
}
for (const malformed of [
  { version: 'proofbound.prompt-envelope-rollout.v0', roles: {} },
  { version: PROMPT_ENVELOPE_ROLLOUT_VERSION, roles: { 'lattice-review-quality': 'unknown-mode' } },
  { version: PROMPT_ENVELOPE_ROLLOUT_VERSION, roles: JSON.parse('{"__proto__":"full-envelope"}') },
]) {
  assert.throws(
    () => resolvePromptEnvelopeRolloutMode('lattice-review-quality', malformed),
    PromptRoleContractRegistryError,
  );
}

console.log(`✓ prompt registry smoke passed: ${registry.agentCount} agents rendered for claude and codex`);

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
import { existsSync, readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { runManagedAssetCheck } from '../core/managed-assets.js';
import { join } from 'node:path';
import {
  LOAD_BEARING_PROOF_OR_STOP_PROMPT_SLICE,
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
import { legacyizeAgentRoleText } from '../core/agent-role-identity.js';
import { PROOF_OR_STOP_ADAPTER_DIR } from '../core/brand-paths.js';

const registry = readPromptRegistry();
const files = listPromptTemplateFiles(registry.root);
const materializedProject = mkdtempSync(join(tmpdir(), 'prompt-materialization-'));
process.once('exit', () => rmSync(materializedProject, {recursive:true,force:true}));
runManagedAssetCheck(materializedProject, {apply:true,profile:'all',assetMode:'full'});
const projectRoot = join(registry.root, '..', '..', '..', '..');
const loadBearingPromptFiles = new Set([
  'proof-or-stop-review-channel.md',
  'proof-or-stop-evaluator-cli.md',
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
const approvedReviewFindingTriageProposalSha256 = '73290169c7b859fe6b5ca85ac964d89a8234f57a5bbf90f118ebcab852560705';
// Independent semantic approval boundary. This digest is intentionally kept in
// the smoke instead of the generated prompt baseline: changing the production
// contract requires a deliberate semantic-test review, and `--write` baseline
// refreshes cannot approve extra or contradictory reviewer instructions.
const approvedReviewFindingTriageContractSha256 = '599b099e7a1128c26336c97e64eef34a3cef53791579ebf29cbc7683a56216ac';
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
  '- In the current compatibility path, a reviewer records the observation through `finding_add` with the current `reviewRunId` and returns disposition to the Story Owner. Only the Owner may use `finding_dismiss` as an audited round/profile action when current mechanical policy permits it. The command mechanically changes the Finding status from open to dismissed and therefore removes it from the current REVIEW blocking predicate, but it proves neither applicability nor `out_of_scope`, and it is not proof of deferral, repair, or resolution. Gap and backlog routes are also compatibility accounting, not applicability or deferral proof.',
  '- The current compatibility CLI does not implement the future signed `FindingDeferralDisposition` or `defer_with_proof` path. Never fabricate `dispositionPlan`, `acceptedRoute`, `assessmentDispositionPlan`, `expectedAssessmentDispositionPlan`, a signature, freshness binding, expiry, lineage, receipt, or manifest action, and never claim that compatibility accounting exercised the future mechanism.',
  '- When the Dynamic Finding CLI becomes available, request or consume its official signed assessment and follow its fail-closed result. Prompt prose and compatibility records never substitute for that assessment.',
  '- Start the current lane with `proof-or-stop review_run_start`. Carry its current `reviewRunId` on every `finding_add` or `review_pass_set` submission.',
  '- A role-body or policy change makes an already assembled in-flight reviewer envelope stale. Stop, start a fresh current-material run with `review_run_start`, and redispatch the reviewer; never submit evidence from the older envelope.',
  '- Keep four input axes separate: observation and `evidenceState` preserve what was seen and whether it is suspected, verified, or disproven; severity says how harmful it is; applicability reports whether it belongs to this Story; disposition records the authorized next action after applicability. Gate impact is a fifth, derived result: the current gate uses only facts recognized by current policy, and the future official Dynamic Finding gate derives it from fresh signed applicability and disposition facts. Severity does not determine scope by itself.',
  '- Every future final `applicable` assessment binds exactly one `dispositionPlan`: `repair_current` or `defer_with_proof`.',
  '- `repair_current` forbids `acceptedRoute`; `defer_with_proof` requires the exact accepted `finding_route` tuple.',
  '- Final non-applicable verdicts bind no `dispositionPlan` and require the exact `acceptedRoute`; `unknown` binds neither.',
  "- Only `applicable + dispositionPlan='defer_with_proof'` plus that exact route may feed the separate signed `FindingDeferralDisposition`.",
  "- The final assessment field is `dispositionPlan`; the deferral copy is `FindingDeferralDisposition.assessmentDispositionPlan='defer_with_proof'`, and the manifest binding is `expectedAssessmentDispositionPlan`. These are future authority fields; the current compatibility CLI must not fabricate them.",
  '- Preserve reproduction steps, source or command evidence, observed impact, and uncertainty. Report an applicability candidate in the evidence supported by the current command; do not invent unsupported fields or present the candidate as a gate decision.',
  '- The machine-owned handler and gate derive the actual blocking result from structured facts. Reviewer prose, a routing proposal, or a claimed deferral is not gate evidence.',
  '- Require repair in the current Story when a verified applicable issue is critical or high; was introduced or worsened by the Story; directly violates acceptance, a verification intent, the core user result, or a public compatibility promise; has known or uncertain protected-surface impact; or would make REVIEW, TEST, DONE, or their evidence misleading.',
  '- If an issue would otherwise block under the current review round and policy but its applicability is unknown, fail closed and keep it in the current Story until evidence resolves applicability. This rule applies regardless of severity, including medium findings when the current round treats them as blocking.',
  '- In the future system, `REQUIRED_ASSESSMENT_INVALID = { missing, re_attestation_required, stale, unsigned, tampered, mismatched, incomplete, expired, unknown }`. A verified open high or critical Finding in that exact set enters the machine-owned transient assessment-integrity floor before severity, round, and advisory policy. The floor does not itself prove applicability or require current-Story repair.',
  '- A fresh strong non-applicable assessment releases that floor; a fresh `applicable` assessment converts high or critical to the distinct mandatory-repair floor; weak, unknown, or invalid proof remains blocked.',
  '- In the future system, invalid claimed deferral lineage is an independent first floor regardless of the current assessment, including missing, invalid, expired, tampered, ownerless, partially applied, or exhausted lineage. In that future system, only a fresh signed superseding `pre_existing_unaffected`, `out_of_scope`, or `duplicate` verdict satisfying its independent strong proof contract, a signed `disproven` truth transition with current counter-evidence, or complete repair closure releases that lineage floor. In that future system, complete repair closure is a distinct release path and does not weaken the exact allowlist for non-repair supersession. In that future system, `not_reproduced_under_current_witness` never releases claimed-deferral lineage or mandatory repair.',
  "- In the future system, invalid or exhausted deferral lineage also creates a downstream mandatory-repair classification. In that future system, once that mandatory-repair obligation is active, only a fresh signed `MandatoryRepairClassification(state='closure_proven')` clears it; lineage-floor superseding proof does not clear the whole block.",
  '- These machine-derived floors are not permission for a reviewer to broaden Story scope.',
  '- Evidence may support a `pre_existing_unaffected` or `out_of_scope` routing candidate only when the issue is not a direct Story regression, does not prevent the user-visible outcome, and cannot distort lifecycle evidence. Preserve the original Finding and attach reproduction, evidence, impact, recommended action, explicit owner, and route. Critical or high findings must never be left without an owner.',
  '- A `pre_existing_unaffected` candidate requires deterministic base and head reproduction receipts for the same defect, proof that the Story did not worsen severity or impact, confirmation that Story scope does not promise its repair, and a valid owner or route.',
  '- An `out_of_scope` candidate requires signed scope or decision evidence naming the excluded contract, no contradictory checklist or acceptance promise, and a valid owner or route; critical or high Findings cannot be left unowned.',
  '- A `duplicate` candidate requires a signature-valid live canonical Finding, its live owner or route, and proof that the duplicate chain is not circular. Similar text or a matching signature tag is insufficient.',
  '- A `not_reproduced_under_current_witness` candidate requires current target-bound negative command and runtime receipts, fresh source and runtime bindings, a signed command-policy and witness digest, and a live receipted owner or route. It must never be inferred from an old DONE outcome. If the current CLI cannot provide the required proof for any candidate, applicability remains unknown and fails closed.',
  '- Do not expand the Story merely to make the repository globally green. A bounded, evidence-backed route is not dismissal, resolution, or proof that the problem disappeared.',
  '- `defer_with_proof` is a disposition after `applicable`, not an applicability verdict. Only the future official Dynamic Finding System may sign it, and only for a verified applicable low or medium Finding.',
  "- A future deferral first requires the final assessment to bind `dispositionPlan='defer_with_proof'` and the exact accepted `finding_route`. The separate signed deferral then repeats `assessmentDispositionPlan='defer_with_proof'`, while its matching manifest binds `expectedAssessmentDispositionPlan='defer_with_proof'`. A `repair_current`, non-applicable, unknown, or route-mismatched assessment cannot feed that deferral.",
  '- Future deferral eligibility requires current reproduction evidence, proof that the Story did not introduce or worsen the defect, no direct acceptance or verification-intent impact, no known or uncertain protected-surface impact, a canonical defect, fresh bindings, a live owner and existing target, an accepted target-side route receipt, recheck triggers, finite expiry, and unexhausted ledger-derived cumulative lineage.',
  '- A valid deferred Finding remains verified, open, visible, and unchanged in severity; it is not `out_of_scope`, `pre_existing_unaffected`, `duplicate`, `disproven`, dismissed, resolved, or repaired.',
  '- Reviewers audit and record; they do not repair implementation, rewrite scope, or create follow-up Stories. Do not call `finding_dismiss`, `story_create`, or `gap_log` from a REVIEW lane. Return repair work to the Story Owner and propose routing for non-applicable work.',
  '- If no finding remains to report, record the lane result with `review_pass_set`; never encode a pass as a synthetic Finding.',
  '- Distinguish `disproven` (evidence refutes the observation), `duplicate` (another tracked Finding owns the same defect), and `not_reproduced_under_current_witness` (fresh target-bound negative witness evidence does not reproduce an older claim). Do not collapse any of them, or `defer_with_proof`, into resolved.',
  '- Never delete the original observation, silently rewrite its severity, or overwrite history. In the current compatibility path, preserve the original observation and report the new evidence to the Story Owner; do not fabricate a revision, superseding Finding, applicability recalculation, or gate-impact recalculation. Only the future official Dynamic Finding System may append a signed revision or superseding Finding and recalculate applicability and gate impact through its official artifacts.',
] as const;
// Existing whole-body approval pins from the independently verified prompt policy manifest.
const approvedCurrentReviewerBodyDigests = {
  "proof-or-stop-review-behavior": "a1f019e3f4bbe6952c7eef6a26a5d15f070ab364f6b9b49cad19642525303d54",
  "proof-or-stop-review-concept": "2d604a1f82169895940e4329cac3562be0e349a5107f4c988ec10db4e2e9a4e0",
  "proof-or-stop-review-docs": "a0aa78c4959c3d6dc3e3433b729c165f5b778eead596010e803a3ad4fc1f6008",
  "proof-or-stop-review-quality": "a4fd9fd8b2f20c63159b9134780e710383f88d729373652f10f1d9fc49c23912",
  "proof-or-stop-review-test-coverage": "e393d606e38e55de6d451898da45767fb1b3eae469e00aa1728519f4c36f177d"
} as const;
const approvedEmptyReviewerPrefixSha256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const requiredReviewFindingTriagePhrases = [
  'The Dynamic Finding System execution plan is the future authority',
  'use only commands and fields exposed by the current CLI compatibility path',
  'Never fabricate an unavailable assessment field, verdict, owner, route, signature, freshness result, or command receipt',
  'Only the Owner may use `finding_dismiss` as an audited round/profile action',
  'mechanically changes the Finding status from open to dismissed and therefore removes it from the current REVIEW blocking predicate',
  'proves neither applicability nor `out_of_scope`',
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
  'Every future final `applicable` assessment binds exactly one `dispositionPlan`: `repair_current` or `defer_with_proof`',
  '`repair_current` forbids `acceptedRoute`; `defer_with_proof` requires the exact accepted `finding_route` tuple',
  'Final non-applicable verdicts bind no `dispositionPlan` and require the exact `acceptedRoute`; `unknown` binds neither',
  "Only `applicable + dispositionPlan='defer_with_proof'` plus that exact route may feed the separate signed `FindingDeferralDisposition`",
  "The final assessment field is `dispositionPlan`; the deferral copy is `FindingDeferralDisposition.assessmentDispositionPlan='defer_with_proof'`, and the manifest binding is `expectedAssessmentDispositionPlan`",
  'only for a verified applicable low or medium Finding',
  'no known or uncertain protected-surface impact',
  'an accepted target-side route receipt',
  'unexhausted ledger-derived cumulative lineage',
  'REQUIRED_ASSESSMENT_INVALID = { missing, re_attestation_required, stale, unsigned, tampered, mismatched, incomplete, expired, unknown }',
  'transient assessment-integrity floor',
  'before severity, round, and advisory policy',
  'does not itself prove applicability or require current-Story repair',
  'fresh strong non-applicable assessment releases that floor; a fresh `applicable` assessment converts high or critical to the distinct mandatory-repair floor; weak, unknown, or invalid proof remains blocked',
  'In the future system, invalid claimed deferral lineage is an independent first floor',
  'only a fresh signed superseding `pre_existing_unaffected`, `out_of_scope`, or `duplicate` verdict satisfying its independent strong proof contract, a signed `disproven` truth transition with current counter-evidence, or complete repair closure releases that lineage floor',
  'complete repair closure is a distinct release path and does not weaken the exact allowlist for non-repair supersession',
  '`not_reproduced_under_current_witness` never releases claimed-deferral lineage or mandatory repair',
  'In the future system, invalid or exhausted deferral lineage also creates a downstream mandatory-repair classification',
  "only a fresh signed `MandatoryRepairClassification(state='closure_proven')` clears it",
  'superseding proof does not clear the whole block',
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
  {
    label: 'applicable assessment omits disposition plan',
    pattern: /(?:final\s+)?applicable\s+assessment[^.\n]{0,100}(?:may|can|is permitted to)[^.\n]{0,50}omit[^.\n]{0,40}dispositionPlan/iu,
  },
  {
    label: 'repair current carries accepted route',
    pattern: /repair_current[^.\n]{0,100}(?:may|can|is permitted to)[^.\n]{0,60}acceptedRoute/iu,
  },
  {
    label: 'non-applicable verdict carries disposition plan',
    pattern: /non[- ]applicable\s+verdict[^.\n]{0,100}(?:may|can|is permitted to)[^.\n]{0,60}dispositionPlan/iu,
  },
  {
    label: 'unknown assessment carries accepted route',
    pattern: /unknown\s+(?:assessment|verdict)[^.\n]{0,100}(?:may|can|is permitted to)[^.\n]{0,60}acceptedRoute/iu,
  },
  {
    label: 'deferral disposition consumes wrong assessment plan',
    pattern: /FindingDeferralDisposition[^.\n]{0,120}(?:may|can|is permitted to)[^.\n]{0,100}(?:repair_current|non[- ]applicable)/iu,
  },
  {
    label: 'assessment integrity floor decays by round',
    pattern: /assessment[- ]integrity\s+floor[^.\n]{0,120}(?:may|can|is permitted to|eventually)[^.\n]{0,100}(?:round|advisory)[^.\n]{0,60}(?:decay|waive|release|clear)/iu,
  },
  {
    label: 'transient integrity floor forces repair',
    pattern: /transient\s+assessment[- ]integrity\s+floor[^.\n]{0,120}(?:always|itself|automatically)[^.\n]{0,80}(?:requires?|forces?|proves?)[^.\n]{0,60}(?:repair|applicable)/iu,
  },
  {
    label: 'invalid lineage released without exact proof',
    pattern: /invalid\s+(?:claimed\s+)?deferral\s+lineage[^.\n]{0,120}(?:may|can|is permitted to)[^.\n]{0,80}(?:release|clear)[^.\n]{0,100}(?:without|by\s+any|ordinary)/iu,
  },
  {
    label: 'superseding proof clears downstream mandatory repair',
    pattern: /superseding\s+(?:(?:non[- ]applicable|disproven)\s+)?proof[^.\n]{0,160}(?:may|can|also|therefore)[^.\n]{0,80}(?:clear|release|remove)[^.\n]{0,100}(?:mandatory[- ]repair|whole\s+block)/iu,
  },
  {
    label: 'current negative witness releases claimed lineage or mandatory repair',
    pattern: /not_reproduced_under_current_witness[^.\n]{0,160}(?:may|can|is permitted to)[^.\n]{0,80}(?:release|clear)[^.\n]{0,100}(?:claimed[- ]deferral|deferral\s+lineage|mandatory[- ]repair)/iu,
  },
  {
    label: 'complete repair closure denied as a claimed-lineage release',
    pattern: /complete\s+repair\s+closure[^.\n]{0,80}(?:cannot|never|does\s+not)[^.\n]{0,80}(?:release|clear)[^.\n]{0,100}(?:claimed[- ]deferral|deferral\s+lineage|lineage\s+floor)/iu,
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
    'A final applicable assessment may omit dispositionPlan.',
    '`repair_current` may carry an `acceptedRoute` for later routing.',
    'A non-applicable verdict may carry a `dispositionPlan`.',
    'An unknown assessment may carry `acceptedRoute`.',
    'FindingDeferralDisposition may consume `repair_current` or a non-applicable assessment.',
    'The assessment-integrity floor may eventually clear through round decay or advisory policy.',
    'The transient assessment-integrity floor itself always requires current-Story repair.',
    'Invalid claimed deferral lineage may clear without exact superseding proof or repair closure.',
    'Superseding non-applicable proof may also clear the downstream mandatory-repair obligation.',
    'A strong `not_reproduced_under_current_witness` verdict may release claimed-deferral lineage.',
  ];
  assert.equal(originalMutations.length, 13, 'the original semantic mutation inventory remains complete');
  assert.equal(paraphraseMutations.length, 13, 'the independent reviewer paraphrase mutation inventory remains complete');
  assert.equal(digestRefreshedParaphraseMutations.length, 13, 'the digest-refreshed reviewer paraphrase inventory remains complete');
  assert.equal(currentAuthorityMutations.length, 18, 'the current Dynamic Finding authority mutation inventory remains complete');
  const deniedRepairClosureMutation = 'Complete repair closure never releases claimed-deferral lineage.';
  const deniedRepairClosureGuard = forbiddenReviewFindingTriagePermissions.find(
    entry => entry.label === 'complete repair closure denied as a claimed-lineage release',
  );
  assert.ok(deniedRepairClosureGuard, 'the claimed-lineage complete-repair-closure denial guard is registered');
  assert.match(
    deniedRepairClosureMutation,
    deniedRepairClosureGuard.pattern,
    'the interaction guard rejects denial of complete repair closure as a claimed-lineage release path',
  );
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
  for (const roleId of ACTIVE_MODULAR_REVIEWER_ROLE_IDS) {
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

function extractProofOrStopBlock(content: string): string | null {
  return content.match(/<!-- proof-or-stop:start -->[\s\S]*?<!-- proof-or-stop:end -->/)?.[0] ?? null;
}

// The existing pins were approved before the managed marker branding migration.
// Project only exact marker lines; all semantic bytes remain subject to the pins.
function historicalMarkerProjection(body: string, modular: boolean): string {
  const lines = body.split('\n');
  if (modular) {
    const marker = '<!-- proof-or-stop:modular-role-body:v1 -->';
    assert.equal(lines.filter(line => line === marker).length, 1);
    assert.equal((body.match(/modular-role-body:v1/g) ?? []).length, 1);
    return lines.map(line => line === marker ? '<!-- proofbound:modular-role-body:v1 -->' : line).join('\n');
  }
  const managed = lines.filter(line => /<!--.*(?:lattice|proofOrStop|proof-or-stop):(?:start|end).*-->/.test(line));
  if (managed.length === 0) return body; // The coverage legacy body has no managed block.
  assert.deepEqual(managed, ['<!-- lattice:start -->', '<!-- lattice:end -->']);
  return lines.map(line => line === '<!-- lattice:start -->' ? '<!-- proofOrStop:start -->' : line === '<!-- lattice:end -->' ? '<!-- proofOrStop:end -->' : line).join('\n');
}

function assertReviewFindingTriageDelivery(): void {
  const modularMarkerControl = '<!-- proof-or-stop:modular-role-body:v1 -->\nunchanged semantic body';
  assert.equal(historicalMarkerProjection(modularMarkerControl, true), '<!-- proofbound:modular-role-body:v1 -->\nunchanged semantic body');
  for (const invalid of [modularMarkerControl.replace('proof-or-stop:', 'proofbound:'), `${modularMarkerControl}\n${modularMarkerControl}`, modularMarkerControl.replace(' -->', '  -->')]) {
    assert.throws(() => historicalMarkerProjection(invalid, true), /AssertionError/);
  }
  const legacyMarkerControl = '<!-- lattice:start -->\nunchanged semantic body\n<!-- lattice:end -->';
  assert.equal(historicalMarkerProjection(legacyMarkerControl, false), '<!-- proofOrStop:start -->\nunchanged semantic body\n<!-- proofOrStop:end -->');
  for (const invalid of [legacyMarkerControl.replace('lattice:end', 'proofOrStop:end'), `${legacyMarkerControl}\n${legacyMarkerControl}`, legacyMarkerControl.replace('<!-- lattice:end -->', '')]) {
    assert.throws(() => historicalMarkerProjection(invalid, false), /AssertionError/);
  }
  assert.doesNotMatch(
    REVIEW_FINDING_TRIAGE_CONTRACT,
    /[\u3400-\u9fff]/u,
    'the injected open-source REVIEW triage contract is English-only',
  );
  // origin/main merge: origin iterates MODULAR_REVIEWER_ROLE_IDS, which on our side has
  // SIX entries because we added proof-or-stop-review-topology-critic; origin's frozen
  // digest maps below hold the FIVE it knows. ACTIVE_MODULAR_REVIEWER_ROLE_IDS is exactly
  // that five-role set (topology-critic stays a modular body), so iterating it keeps the
  // assertion over the roles the maps actually pin instead of indexing them with a key
  // they do not carry.
  for (const roleId of ACTIVE_MODULAR_REVIEWER_ROLE_IDS) {
    const entry = registry.agents.find(candidate => candidate.agentId === roleId);
    assert.ok(entry, `${roleId} is registered`);
    const frozenLegacyReconstruction = restoreLegacyPromptTemplate(entry);
    assert.equal(occurrenceCount(frozenLegacyReconstruction, reviewFindingTriageContractMarker), 0, `${roleId} frozen reconstruction excludes the appended contract`);
    // restoreLegacyPromptTemplate verifies its own immutable historical digest.
    // Whole-body approval below covers the current canonical prefix and contract together.
    const frozenLegacyPrefixDigest = createHash('sha256').update(frozenLegacyReconstruction.trimEnd()).digest('hex');
    const modularSource = readFileSync(entry.sourcePath, 'utf8');
    const mutatedPath = join(materializedProject, `${roleId}-legacy-mutation.md`);
    writeFileSync(mutatedPath, `${modularSource}\nUnapproved historical permission.\n`);
    assert.throws(() => restoreLegacyPromptTemplate({...entry,sourcePath:mutatedPath}),
      /legacy reviewer prompt reconstruction drift/, `${roleId} historical reconstruction rejects changed semantic bytes`);
    assert.equal(createHash('sha256').update(legacyizeAgentRoleText(resolvePromptTemplateBody(entry, 'full-envelope'))).digest('hex'),
      approvedCurrentReviewerBodyDigests[roleId], `${roleId} complete body retains independent semantic approval`);
    for (const mode of ['legacy-full-context', 'full-envelope'] as const) {
      const body = resolvePromptTemplateBody(entry, mode);
      assert.equal(occurrenceCount(body, reviewFindingTriageContractMarker), 1, `${roleId}/${mode} receives one contract`);
      assert.ok(body.endsWith(`${REVIEW_FINDING_TRIAGE_CONTRACT}\n`), `${roleId}/${mode} receives canonical contract bytes`);
      assertReviewFindingTriageSemantics(
        body,
        `${roleId}/${mode}`,
        approvedReviewFindingTriageContractSha256,
        mode === 'legacy-full-context' ? frozenLegacyPrefixDigest : createHash('sha256').update(modularSource.trimEnd()).digest('hex'),
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
    for (const roleId of ACTIVE_MODULAR_REVIEWER_ROLE_IDS) {
      assert.equal(occurrenceCount(resolvePromptRoleBody(roleId, config).body, reviewFindingTriageContractMarker), 1, `mixed rollout mask ${mask} delivers one contract to ${roleId}`);
    }
  }
  assertReviewFindingTriageMutationFailures();
}

function assertReviewFindingTriageProposal(): void {
  const proposalPath = join(projectRoot, reviewFindingTriageProposalPath);
  assert.ok(existsSync(proposalPath), 'the executable REVIEW Finding triage proposal is tracked');
  const proposal = readFileSync(proposalPath, 'utf8');
  const normalizedProposal = proposal.replace(/\s+/gu, ' ');
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
  const activeRoleSection = proposal.match(
    /canonical contract is appended once during assembly to the five active modular\nREVIEW roles:\n\n([\s\S]*?)\n\nStory Owner behavior/u,
  )?.[1] ?? '';
  assert.deepEqual(
    activeRoleSection.split('\n').filter(Boolean),
    [
      '- `proof-or-stop-review-behavior`;',
      '- `proof-or-stop-review-concept`;',
      '- `proof-or-stop-review-docs`;',
      '- `proof-or-stop-review-quality`; and',
      '- `proof-or-stop-review-test-coverage`.',
    ],
    'the proposal publishes exactly the five canonical active modular REVIEW role IDs',
  );
  assert.doesNotMatch(activeRoleSection, /lattice-review-/u, 'the active-role list excludes retired lattice reviewer IDs');
  for (const phrase of [
    'This proposal is its Agent-side projection',
    'This Story does not amend the Dynamic Finding plan or its runtime',
    'This proposal does not authorize changes to:',
    'declarative Role Contract metadata that adds the `defect-triage-and-routing-check` required-check identifier',
    'It does not include the active topology-critic lane, other active roles outside this modular REVIEW delivery set, compatibility aliases, or retired lanes',
    '`not_reproduced_under_current_witness`',
    '| `unknown` | Current evidence references, an unresolved `direct_scope` or `counter_evidence` basis, current source, scope, and runtime bindings, and the uncertainty that prevents a conclusive verdict; no `nonBlockingProof`, `acceptedRoute`, or `dispositionPlan`.',
    '`defer_with_proof` is a disposition after `applicable`',
    'Every future final `applicable` assessment binds exactly one',
    '`repair_current` forbids `acceptedRoute`',
    'Final `pre_existing_unaffected`, `out_of_scope`, `duplicate`, and',
    "Only `applicable + dispositionPlan='defer_with_proof'` plus that exact route may",
    "`FindingDeferralDisposition.assessmentDispositionPlan='defer_with_proof'`",
    '`expectedAssessmentDispositionPlan`',
    '`REQUIRED_ASSESSMENT_INVALID = { missing, re_attestation_required, stale,',
    'assessment-integrity floor before severity, round, and advisory policy',
    'does not itself prove applicability or require current-Story repair',
    'In the future system, invalid claimed deferral lineage',
    'only a fresh signed superseding',
    '`pre_existing_unaffected`, `out_of_scope`, or `duplicate` verdict satisfying',
    '`not_reproduced_under_current_witness` never releases claimed-deferral lineage',
    'complete repair closure releases that lineage floor',
    'In the future system, invalid or exhausted lineage also',
    "`MandatoryRepairClassification(state='closure_proven')` clears it",
    'superseding proof does not clear the whole block',
    'The current compatibility CLI does not implement the future signed',
    'Current command policy admits `finding_dismiss` only in REVIEW',
    'The ownership gate protects a Story-scoped Finding through its Story owner session',
    'the B-META shared-audit case instead uses the main shared-write policy',
    'The handler requires a substantive reason meeting its minimum length and refuses critical Findings',
    '`finding_dismiss`, `gap_log`, and backlog notes are compatibility accounting',
    'mechanically changes a Finding from `open` to `dismissed` and therefore removes it from the current REVIEW blocking predicate',
    'Digest pins provide change review, but they are not the semantic oracle',
  ]) {
    assert.ok(normalizedProposal.includes(phrase), `the proposal keeps authority boundary phrase: ${phrase}`);
  }
  const lineageConsistencyProjection = proposal.match(
    /\| Claimed-lineage validity, required-assessment integrity, and downstream mandatory repair are ordered machine floors\. \| ([^\n]+) \|/u,
  )?.[1];
  assert.equal(
    lineageConsistencyProjection,
    'Agents preserve the exact invalid set and release/convert/remain paths; restrict non-repair lineage release to strong `pre_existing_unaffected`, `out_of_scope`, `duplicate`, or `disproven` proof; preserve complete repair closure as the separate repair release path; explicitly exclude `not_reproduced_under_current_witness`; and require `closure_proven` to clear an active mandatory-repair obligation without expanding scope.',
    'the consistency table itself preserves both lineage-floor release paths and the downstream closure-only rule',
  );
}

function assertDynamicFindingAuthorityProjection(): void {
  const plan = readFileSync(join(projectRoot, dynamicFindingExecutionPlanPath), 'utf8');
  const normalizedPlan = plan.replace(/\s+/gu, ' ');
  assert.doesNotMatch(plan, /[\u3400-\u9fff]/u, 'the Dynamic Finding target-state plan is English-only');
  assert.equal(
    occurrenceCount(plan, '`stale_or_not_reproduced`'),
    0,
    'the authority plan keeps the retired compatibility alias out of canonical target-state vocabulary',
  );
  for (const phrase of [
    '`not_reproduced_under_current_witness`',
    'interface FindingDeferralDisposition',
    "{ verdict: 'applicable'; dispositionPlan: 'repair_current'; acceptedRoute?: never }",
    "{ verdict: 'applicable'; dispositionPlan: 'defer_with_proof'; acceptedRoute:",
    "assessmentDispositionPlan: 'defer_with_proof'",
    "expectedAssessmentDispositionPlan?: 'repair_current' | 'defer_with_proof'",
    'REQUIRED_ASSESSMENT_INVALID = {',
    'assessment-integrity floor before round',
    'claimed missing/stale/expired/exhausted/tampered/unknown lineage, independent of current assessment',
    'Deferral is a disposition after `applicable`, not another applicability verdict.',
    'critical/high or any known/uncertain protected-surface case can never choose',
    'A regression introduced or worsened by the Story cannot be deferred.',
    'acceptanceImpact: {',
    'protectedSurfaceImpact: {',
    'must be reproduced, root-caused, fixed,',
    'exhausted/invalid deferral lineage',
  ]) {
    assert.ok(normalizedPlan.includes(phrase), `the Dynamic Finding authority plan keeps target-state phrase: ${phrase}`);
  }
}

function assertOwnerAndImplementerTriageGuidance(): void {
  const ownerGuide = readFileSync(join(projectRoot, 'AGENTS.md'), 'utf8');
  for (const phrase of [
    'Every Finding reported only in reviewer prose must be redispatched for structured registration',
    'introduced or worsened by the current Story',
    'directly blocks acceptance, a verification intent, the core user result, or a public compatibility promise',
    'critical or high',
    'known or uncertain protected-surface impact',
    'would make lifecycle gate evidence or gate truth misleading',
    'In the future official system, invalid claimed deferral lineage is an independent first floor',
    'every final applicable assessment binds exactly one `dispositionPlan`: `repair_current` or `defer_with_proof`',
    '`REQUIRED_ASSESSMENT_INVALID = { missing, re_attestation_required, stale, unsigned, tampered, mismatched, incomplete, expired, unknown }`',
    'transient assessment-integrity floor before severity, round, and advisory policy',
    'it does not itself prove applicability or require current-Story repair',
    'only a fresh signed superseding `pre_existing_unaffected`, `out_of_scope`, or `duplicate` verdict',
    '`not_reproduced_under_current_witness` never releases claimed-deferral lineage or mandatory repair',
    'In the future official system, invalid or exhausted deferral lineage also creates a downstream mandatory-repair classification',
    "only a fresh signed `MandatoryRepairClassification(state='closure_proven')` clears it",
    'superseding proof does not clear the whole block',
    'including a medium Finding in a policy round where medium is blocking',
    '`not_reproduced_under_current_witness` requires fresh target-bound negative command and runtime receipts',
    'structured evidence proves that it is not applicable to the current Story',
    'Critical or high Findings must never be left without a traceable owner',
    'the Dynamic Finding System execution plan is future authority',
    'The current compatibility CLI does not implement a signed `FindingDeferralDisposition` or `defer_with_proof`',
    'Future authority distinguishes final-assessment `dispositionPlan`',
    "`FindingDeferralDisposition.assessmentDispositionPlan='defer_with_proof'`",
    '`expectedAssessmentDispositionPlan`',
    '`repair_current` forbids `acceptedRoute`',
    'never fabricate an assessment, disposition, owner, route, signature, freshness binding, expiry, lineage, receipt, manifest action, or any of those future fields',
    'Only the Owner may use current `finding_dismiss` as an audited round/profile action when mechanical policy permits it',
    'mechanically changes status from `open` to `dismissed` and therefore removes the Finding from the current REVIEW blocking predicate',
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
  const supersededSeverityFirstGuidance = /(?:Fix it in the current Story when it is critical or high severity|For a medium or low severity defect outside the direct acceptance scope|If later evidence raises the severity[\s\S]{0,160}re-escalate it into the current Story immediately)/u;
  assert.doesNotMatch(ownerGuide, supersededSeverityFirstGuidance, 'AGENTS omits superseded severity-first triage guidance outside the canonical four-line contract');
  assert.doesNotMatch(claudeGuide, supersededSeverityFirstGuidance, 'CLAUDE omits superseded severity-first triage guidance outside the canonical four-line contract');
  for (const [file, lines] of [['AGENTS.md', ownerTriageLines], ['CLAUDE.md', claudeTriageLines]] as const) {
    const compatibilityLine = lines.find(line => line.includes('**Compatibility boundary and dismissal**')) ?? '';
    assert.match(compatibilityLine, /Only the Owner may use current `finding_dismiss` as an audited round\/profile action when mechanical policy permits it;/u, `${file} keeps the Owner-only audited compatibility action`);
    assert.match(compatibilityLine, /mechanically changes status from `open` to `dismissed` and therefore removes the Finding from the current REVIEW blocking predicate, but/u, `${file} states the current mechanical dismissal effect`);
    assert.match(compatibilityLine, /it proves neither applicability nor `out_of_scope`, and it is not proof of repair or resolution, nor proof of deferral\./u, `${file} keeps each non-proof conclusion once`);
    assert.match(compatibilityLine, /Prompt text alone does not mechanically enforce this discipline\./u, `${file} keeps the prompt-enforcement limitation once`);
    for (const term of ['`finding_dismiss`', 'applicability', '`out_of_scope`', 'proof of repair', 'resolution'] as const) {
      assert.equal(occurrenceCount(compatibilityLine, term), 1, `${file} states the ${term} compatibility conclusion once`);
    }
    assert.equal(occurrenceCount(compatibilityLine, 'mechanically enforce'), 1, `${file} states the prompt-enforcement limitation once`);
  }

  const implementerGuide = readFileSync(join(registry.root, 'proof-or-stop-implementer.md'), 'utf8');
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
  const canonicalSource = renderPromptEntryForHost(entry, 'claude', 'full-envelope');
  if (ACTIVE_MODULAR_REVIEWER_ROLE_IDS.includes(entry.agentId as typeof ACTIVE_MODULAR_REVIEWER_ROLE_IDS[number])) {
    assert.match(expectedClaude, /review_run_start/, `${entry.file} Claude registry render is bootstrap-only`);
    assert.match(expectedCodex, /review_run_start/, `${entry.file} Codex registry render is bootstrap-only`);
    assert.equal(occurrenceCount(expectedClaude, reviewFindingTriageContractMarker), 0, `${entry.file} Claude bootstrap does not duplicate the runtime role contract`);
    assert.equal(occurrenceCount(expectedCodex, reviewFindingTriageContractMarker), 0, `${entry.file} Codex bootstrap does not duplicate the runtime role contract`);
    assert.doesNotMatch(expectedClaude, /proofbound:modular-role-body:v1/, `${entry.file} Claude registry excludes role body`);
    assert.doesNotMatch(expectedCodex, /proofbound:modular-role-body:v1/, `${entry.file} Codex registry excludes role body`);
  } else if (!isComplexRole) {
    assert.equal(expectedClaude, canonicalSource, `${entry.file} Claude render matches canonical template output`);
  }
  if (isComplexRole) {
    const legacy = restoreLegacyPromptTemplate(entry);
    // Exact host bytes are pinned by the independent 18-role prompt baseline.
    // Assert visible marker contracts here instead of reconstructing an expected renderer.
    for (const rendered of [expectedClaude, expectedCodex]) {
      assert.match(rendered, /<!-- proof-or-stop:start -->/, `${entry.file} renders canonical managed markers`);
      assert.doesNotMatch(rendered, /<!-- lattice:start -->/, `${entry.file} does not materialize historical markers`);
    }
    assert.match(legacy, /<!-- lattice:start -->[\s\S]*<!-- lattice:end -->/, `${entry.file} retains legacy markers only in historical reconstruction`);
    assert.equal(renderPromptEntryForHost(entry, 'claude', 'full-envelope'), source, `${entry.file} modular Claude render remains explicitly selectable`);
    assert.equal(renderPromptEntryForHost(entry, 'codex', 'full-envelope'), renderCodexAgentContent(source), `${entry.file} modular Codex render remains explicitly selectable`);
    assert.notEqual(expectedClaude, source, `${entry.file} rejected rollout cannot yield the modular Claude render`);
  } else if (!ACTIVE_MODULAR_REVIEWER_ROLE_IDS.includes(entry.agentId as typeof ACTIVE_MODULAR_REVIEWER_ROLE_IDS[number])) {
    assert.equal(expectedCodex, renderCodexAgentContent(canonicalSource), `${entry.file} Codex render matches canonical transform`);
  }
  if (!MODULAR_REVIEWER_ROLE_IDS.includes(entry.agentId as typeof MODULAR_REVIEWER_ROLE_IDS[number])) {
    assert.equal(occurrenceCount(expectedClaude, reviewFindingTriageContractMarker), 0, `${entry.file} Claude render receives no REVIEW triage contract`);
    assert.equal(occurrenceCount(expectedCodex, reviewFindingTriageContractMarker), 0, `${entry.file} Codex render receives no REVIEW triage contract`);
  }
  if (loadBearingPromptFiles.has(entry.file)) {
    // proof-or-stop-review-channel is retired and independently byte-pinned by
    // the prompt baseline. Its main-branch asset and canonical embedded guide
    // differ only in line wrapping, so normalize whitespace for this one
    // semantic-parity assertion rather than weakening any body/hash pin.
    const embeddedLoadBearingGuide = extractProofOrStopBlock(source);
    assert.ok(embeddedLoadBearingGuide, `${entry.file} contains the load-bearing prompt slice`);
    assert.equal(
      embeddedLoadBearingGuide.replace(/\s+/gu, ' ').trim(),
      LOAD_BEARING_PROOF_OR_STOP_PROMPT_SLICE.replace(/\s+/gu, ' ').trim(),
      `${entry.file} uses the canonical load-bearing prompt slice semantics`,
    );
    for (const phrase of requiredSafetyPhrases) {
      assert.ok(source.includes(phrase), `${entry.file} keeps load-bearing prompt phrase: ${phrase}`);
    }
  }
  if (entry.file === 'proof-or-stop-review-quality.md') {
    for (const phrase of qualityProofMetadataPhrases) {
      assert.ok(source.includes(phrase), `${entry.file} keeps proof metadata review phrase: ${phrase}`);
    }
  }
  const claudeMirrorPath = join(materializedProject, '.claude', 'agents', entry.file);
  assert.ok(existsSync(claudeMirrorPath), `${entry.file} is materialized for Claude`);
  if (existsSync(claudeMirrorPath)) {
    assert.equal(readFileSync(claudeMirrorPath, 'utf8'), expectedClaude, `${entry.file} .claude asset matches its canonical host render`);
  }
  const codexMirrorPath = join(materializedProject, PROOF_OR_STOP_ADAPTER_DIR, 'agents', entry.file);
  assert.ok(existsSync(codexMirrorPath), `${entry.file} is materialized for Codex`);
  if (existsSync(codexMirrorPath)) {
    assert.equal(readFileSync(codexMirrorPath, 'utf8'), expectedCodex, `${entry.file} .proof-or-stop-codex asset matches its canonical host render`);
  }
  material.update(`${entry.file}\0${entry.templateHash}\0${entry.bytes}\n`);
}
assert.equal(registry.materialHash, material.digest('hex'), 'registry material hash is deterministic');

assert.equal(MODULAR_REVIEWER_ROLE_IDS.length, 6, 'the migrated reviewer definition roster has exactly six roles');
assert.deepEqual(
  [...ACTIVE_MODULAR_REVIEWER_ROLE_IDS],
  MODULAR_REVIEWER_ROLE_IDS.filter(roleId => roleId !== 'proof-or-stop-review-topology-critic'),
  'the five active REVIEW lanes are the migrated reviewer roles other than topology critic',
);
assert.equal(ACTIVE_MODULAR_REVIEWER_ROLE_IDS.length, 5, 'the active REVIEW rollout roster remains exactly five lanes');
const fullRoles = Object.fromEntries(MODULAR_REVIEWER_ROLE_IDS.map(roleId => [roleId, 'full-envelope']));
const fullConfig = { version: PROMPT_ENVELOPE_ROLLOUT_VERSION, roles: fullRoles };
for (const roleId of ACTIVE_MODULAR_REVIEWER_ROLE_IDS) {
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
    createHash('sha256').update(modularSourceBody.trimEnd()).digest('hex'),
  );
  assert.equal(extractProofOrStopBlock(modular.body), null, `${roleId} modular body contains no legacy Runtime Guide`);
  assert.ok(modular.body.includes('proof-or-stop:modular-role-body:v1'), `${roleId} keeps the canonical reconstruction anchor`);
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
assert.equal(resolvePromptEnvelopeRolloutMode('proof-or-stop-review-concept', undefined), 'legacy-full-context');
for (const roles of [
  { 'proof-or-stop-review-channel': 'full-envelope' },
  { 'implementation-reviewer': 'full-envelope' },
  { 'unknown-reviewer': 'full-envelope' },
]) {
  assert.throws(
    () => resolvePromptEnvelopeRolloutMode('proof-or-stop-review-concept', {
      version: PROMPT_ENVELOPE_ROLLOUT_VERSION,
      roles,
    }),
    PromptRoleContractRegistryError,
  );
}
for (const [source, expected] of [
  [
    '{"promptEnvelope":{"version":"proofbound.prompt-envelope-rollout.v1","roles":{}},"promptEnvelope":{"version":"proofbound.prompt-envelope-rollout.v1","roles":{"proof-or-stop-review-quality":"full-envelope"}}}',
    /duplicate promptEnvelope key/,
  ],
  [
    '{"promptEnvelope":{"version":"proofbound.prompt-envelope-rollout.v1","roles":{},"roles":{"proof-or-stop-review-quality":"full-envelope"}}}',
    /duplicate promptEnvelope\.roles key/,
  ],
  [
    '{"promptEnvelope":{"version":"proofbound.prompt-envelope-rollout.v1","roles":{"proof-or-stop-review-quality":"full-envelope","proof-or-stop-review-quality":"legacy-full-context"}}}',
    /duplicate promptEnvelope\.roles\.proof-or-stop-review-quality key/,
  ],
] as const) {
  assert.throws(() => assertNoDuplicatePromptEnvelopeRoleKeys(source), expected);
}
for (const malformed of [
  { version: 'proofbound.prompt-envelope-rollout.v0', roles: {} },
  { version: PROMPT_ENVELOPE_ROLLOUT_VERSION, roles: { 'proof-or-stop-review-quality': 'unknown-mode' } },
  { version: PROMPT_ENVELOPE_ROLLOUT_VERSION, roles: JSON.parse('{"__proto__":"full-envelope"}') },
]) {
  assert.throws(
    () => resolvePromptEnvelopeRolloutMode('proof-or-stop-review-quality', malformed),
    PromptRoleContractRegistryError,
  );
}

console.log(`✓ prompt registry smoke passed: ${registry.agentCount} agents rendered for claude and codex`);

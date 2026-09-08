import { projectScopeInventory } from './scope-inventory-budget.js';
import {
  canonicalJsonStringify,
  domainSeparatedDigest,
  estimatePromptTokens,
  PROMPT_CONTRACT_ALGORITHMS,
  promptLogicalLines,
  promptUtf8Bytes,
  reviewerDispatchPromptDigest,
  validateFullTaskContext,
  validateIncrementalReviewBasis,
  validateKnownExecutionEnvironment,
  validatePromptEnvelope,
  FULL_TASK_CONTEXT_SCHEMA,
  KNOWN_EXECUTION_ENVIRONMENT_SCHEMA,
  PROMPT_ENVELOPE_SCHEMA,
  type FullTaskContext,
  type IncrementalReviewBasis,
  type KnownExecutionEnvironment,
  type PromptEnvelope,
  type PromptFindingProjection,
  type RoleContract,
  type RuntimeContract,
} from './prompt-contracts.js';
import { PROOF_OR_STOP_CLI_VERSION } from './proof-or-stop-brand.js';
import type { ChecklistData, ScopeContractData, StoryInfo } from './types.js';
import { digestScopeContract } from './guard-session.js';
import { isModularReviewerRoleId } from './prompt-registry.js';
import { canonicalAgentRoleId } from './agent-role-identity.js';

export const PROMPT_ENVELOPE_ASSEMBLER_VERSION = 'proof-or-stop.full-context-assembler.v1';
export const PROMPT_ENVELOPE_ASSEMBLER_VERSION_LEGACY = 'proofbound.full-context-assembler.v1';
export const PROMPT_DISPATCH_PROTOCOL_VERSION = 'proof-or-stop.prompt-dispatch.v1';
export const PROMPT_DISPATCH_PROTOCOL_VERSION_LEGACY = 'proofbound.prompt-dispatch.v1';

export interface FullPromptAssemblyInput {
  roleContract: RoleContract;
  runtimeContract: RuntimeContract;
  rolePrompt: string;
  taskContext: FullTaskContext;
  knownExecutionEnvironment?: KnownExecutionEnvironment;
  dispatchKind: 'story-dispatch' | 'review-run';
  reviewRunId?: string;
  reviewRound?: string;
  lane?: string;
  createdAt: string;
  launcherSpec?: unknown;
  reviewerDispatchBindingDigest?: string;
  commandPolicy?: unknown;
  toolPolicy?: unknown;
  systemInstruction?: string;
  dispatchPrompt?: string;
  hostRenderIdentityDigest?: string;
}

export interface FullPromptAssembly {
  prompt: string;
  taskContext: FullTaskContext;
  knownExecutionEnvironment: KnownExecutionEnvironment;
  envelope: PromptEnvelope;
}

export interface ConditionalReviewAssemblyInput extends FullPromptAssemblyInput {
  incrementalEligible: boolean;
  eligibilityDigest: string;
  eligibilityReasonCodes: string[];
  freshnessClassification: string;
  impactPolicyVersion: string;
  priorPassRef?: string;
  changedFilesDigest: string;
  impactedFilesDigest: string;
  reviewBasis?: IncrementalReviewBasis | null;
  /** Exact mutable finding fields observed at run start; signed by envelopeId. */
  findingProjection?: PromptFindingProjection[];
  incrementalBudgetBytes?: number;
  fullBudgetBytes?: number;
  reviewerEscalationReason?: string;
}

export interface ConditionalReviewAssembly extends FullPromptAssembly {
  selectionReason: NonNullable<PromptEnvelope['selectionReason']>;
  fullPrompt: string;
  incrementalPrompt?: string;
}

function renderFullPrompt(
  runtimeContract: RuntimeContract,
  roleContract: RoleContract,
  taskContext: FullTaskContext,
  environment: KnownExecutionEnvironment,
  rolePrompt: string,
  dispatchPrompt?: string,
): string {
  const sections = [
    '## Runtime Contract',
    runtimeContract.compactText,
    '## Role Contract',
    canonicalJsonStringify(roleContract),
    '## Task Context',
    canonicalJsonStringify(taskContext),
    '## Known Execution Environment',
    canonicalJsonStringify(environment),
  ];
  if (dispatchPrompt !== undefined) sections.push('## Dispatch Prompt', dispatchPrompt);
  sections.push('## Role Prompt', rolePrompt);
  return sections.join('\n\n');
}

function renderIncrementalPrompt(
  runtimeContract: RuntimeContract,
  roleContract: RoleContract,
  reviewBasis: IncrementalReviewBasis,
  environment: KnownExecutionEnvironment,
  rolePrompt: string,
  dispatchPrompt: string,
): string {
  return [
    '## Runtime Contract',
    runtimeContract.compactText,
    '## Role Contract',
    canonicalJsonStringify(roleContract),
    '## Incremental Review Basis',
    canonicalJsonStringify(reviewBasis),
    '## Known Execution Environment',
    canonicalJsonStringify(environment),
    '## Dispatch Prompt',
    dispatchPrompt,
    '## Role Prompt',
    rolePrompt,
  ].join('\n\n');
}

function assertContractRenderCoherence(
  runtimeContract: RuntimeContract,
  roleContract: RoleContract,
  rolePrompt: string,
): void {
  const runtimeRenderDigest = domainSeparatedDigest('runtime-contract.render.v1', runtimeContract.compactText);
  if (runtimeContract.renderDigest !== runtimeRenderDigest) {
    throw new Error('Runtime Contract renderDigest does not match compactText');
  }
  const roleRenderDigest = domainSeparatedDigest('role-contract.render.v1', rolePrompt);
  if (roleContract.renderDigest !== roleRenderDigest) {
    throw new Error(`Role Contract renderDigest does not match the canonical prompt bytes for ${roleContract.roleId}`);
  }
}

type ReviewTriageAuthorityViolation =
  | 'retired applicability verdict used as authority'
  | 'Dynamic Finding authority amendment asserted from Task Context'
  | 'disposition collapsed into applicability'
  | 'unauthorized disposition minting'
  | 'severity used as sole ownership or scope authority'
  | 'dismissal used as applicability proof'
  | 'unknown applicability used to route or unblock';

const RETIRED_APPLICABILITY_ALIAS = /\bstale\s+or\s+not\s+reproduced\b/u;
const DYNAMIC_FINDING_AUTHORITY = /(?:\bdynamic\s+finding(?:\s+system)?(?:\s+execution)?\s+(?:plan|authority|runtime)\b|\b(?:execution\s+plan|plan|authority|runtime)\s+for\s+dynamic\s+finding\b)/u;

type ReviewerTaskContextAuthoritySource = {
  location: string;
  kind: 'story' | 'checklist' | 'verificationIntent';
  text: string;
};

function normalizeTriageAuthorityText(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/([a-z])([A-Z])/gu, '$1 $2')
    .toLowerCase()
    .replace(/[`'"“”‘’]/gu, ' ')
    .replace(/[_\-/(),‐‑‒–—]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function triageAuthoritySegments(text: string): string[] {
  return normalizeTriageAuthorityText(text)
    .split(/(?:[.!?;\n]+|\b(?:but|however|yet|although)\b)/u)
    .map(segment => segment.trim())
    .filter(Boolean);
}

function matchRanges(text: string, pattern: RegExp): Array<{ start: number; end: number }> {
  const matcher = new RegExp(pattern.source, pattern.flags.includes('u') ? 'gu' : 'g');
  return [...text.matchAll(matcher)].map(match => ({
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
  }));
}

function relationIsNegated(
  segment: string,
  relationRange: { start: number; end: number },
  leftRange: { start: number; end: number },
  rightRange: { start: number; end: number },
): boolean {
  const prefix = segment.slice(Math.max(0, relationRange.start - 256), relationRange.start);
  const suffix = segment.slice(relationRange.end, Math.min(segment.length, relationRange.end + 32));
  const boundary = Math.max(
    prefix.lastIndexOf(' but '),
    prefix.lastIndexOf(' however '),
    prefix.lastIndexOf(' while '),
    prefix.lastIndexOf(' although '),
    prefix.lastIndexOf(' and '),
    prefix.lastIndexOf(' then '),
    prefix.lastIndexOf(' therefore '),
    prefix.lastIndexOf(' so '),
    prefix.lastIndexOf(';'),
  );
  const localPrefix = prefix.slice(boundary + 1);
  if (/\bneither\b[^.;]{0,96}\bnor\b[^.;]{0,64}$/u.test(prefix)) return true;
  if (/\bnever\s+(?:claims?|states?|asserts?|says?|teaches?)\s+that\b[^.;]{0,220}$/u.test(localPrefix)) return true;
  if (/\b(?:never|cannot|reject|rejects|rejected|forbid|forbids|forbidden|prohibit|prohibits|prohibited|disallow|disallows|disallowed)\b[^,;]{0,48}$/u.test(localPrefix)) return true;
  if (/\b(?:do|does|did|must|may|should|can|could|will|would|is|are|was|were|be)\s+not\b[^,;]{0,32}$/u.test(localPrefix)) return true;
  if (/^\s+not\b/u.test(suffix)) return true;
  const followingConcept = leftRange.start > relationRange.start ? leftRange : rightRange.start > relationRange.start ? rightRange : null;
  if (followingConcept && /\b(?:not|never|neither|nor|without|no\s+longer|rather\s+than)\b/u.test(segment.slice(relationRange.end, followingConcept.start))) return true;
  return false;
}

/**
 * Detect an affirmative semantic relation between normalized concepts in
 * either word order. Polarity is scoped to the relation, not to the complete
 * bridge, so unrelated negation cannot launder a later authority assertion.
 */
function hasAffirmativeConceptRelation(
  segment: string,
  left: RegExp,
  right: RegExp,
  relation: RegExp,
  maxBridgeLength = 180,
): boolean {
  for (const leftRange of matchRanges(segment, left)) {
    for (const rightRange of matchRanges(segment, right)) {
      const conceptStart = Math.min(leftRange.start, rightRange.start);
      const conceptEnd = Math.max(leftRange.end, rightRange.end);
      if (conceptEnd - conceptStart > maxBridgeLength) continue;
      for (const relationRange of matchRanges(segment, relation)) {
        if (relationRange.start < conceptStart - 40 || relationRange.end > conceptEnd + 48) continue;
        if (!relationIsNegated(segment, relationRange, leftRange, rightRange)) return true;
      }
    }
  }
  return false;
}

function hasConceptPair(text: string, left: RegExp, right: RegExp, maxSpan = 240): boolean {
  return matchRanges(text, left).some(leftRange =>
    matchRanges(text, right).some(rightRange => {
      const start = Math.min(leftRange.start, rightRange.start);
      const end = Math.max(leftRange.end, rightRange.end);
      return end - start <= maxSpan;
    }),
  );
}

function countBoundedConceptPairInstances(text: string, left: RegExp, right: RegExp, maxSpan = 240): number {
  const leftRanges = matchRanges(text, left);
  const rightRanges = matchRanges(text, right);
  const unmatchedRight = new Set(rightRanges.map((_, index) => index));
  let count = 0;
  for (const leftRange of leftRanges) {
    const candidate = [...unmatchedRight]
      .map(index => {
        const rightRange = rightRanges[index];
        const start = Math.min(leftRange.start, rightRange.start);
        const end = Math.max(leftRange.end, rightRange.end);
        return { index, span: end - start };
      })
      .filter(item => item.span <= maxSpan)
      .sort((first, second) => first.span - second.span || first.index - second.index)[0];
    if (!candidate) continue;
    unmatchedRight.delete(candidate.index);
    count += 1;
  }
  return count;
}

/**
 * A controlled triage relationship is safe only when its polarity is explicit
 * inside the complete local relationship. This is a positive grammar for
 * prohibitions/invariants, not a blacklist of affirmative verbs.
 */
function controlledConceptPairIsExplicitlyNegative(
  text: string,
  left: RegExp,
  right: RegExp,
  maxSpan = 240,
  isDisqualifiedPair?: (leftText: string, rightText: string, relationText: string) => boolean,
): boolean {
  let sawPair = false;
  for (const leftRange of matchRanges(text, left)) {
    for (const rightRange of matchRanges(text, right)) {
      const start = Math.min(leftRange.start, rightRange.start);
      const end = Math.max(leftRange.end, rightRange.end);
      if (end - start > maxSpan) continue;
      const firstRange = leftRange.start <= rightRange.start ? leftRange : rightRange;
      const secondRange = leftRange.start <= rightRange.start ? rightRange : leftRange;
      const relationship = text.slice(firstRange.end, secondRange.start);
      if (isDisqualifiedPair?.(
        text.slice(leftRange.start, leftRange.end),
        text.slice(rightRange.start, rightRange.end),
        relationship,
      )) continue;
      sawPair = true;
      const prefix = text.slice(Math.max(0, start - 160), start);
      const boundary = Math.max(
        prefix.lastIndexOf(' and '),
        prefix.lastIndexOf(' but '),
        prefix.lastIndexOf(' while '),
        prefix.lastIndexOf(' although '),
        prefix.lastIndexOf(' however '),
        prefix.lastIndexOf(' yet '),
        prefix.lastIndexOf(';'),
      );
      const localPrefix = prefix.slice(boundary + 1);
      const relationshipBoundary = Math.max(
        relationship.lastIndexOf(' and '),
        relationship.lastIndexOf(' then '),
        relationship.lastIndexOf(' but '),
        relationship.lastIndexOf(' however '),
        relationship.lastIndexOf(' yet '),
        relationship.lastIndexOf(' although '),
        relationship.lastIndexOf(' while '),
        relationship.lastIndexOf(' consequently '),
      );
      const scopedRelationship = relationship.slice(relationshipBoundary + 1);
      const immediateSuffix = text.slice(end, Math.min(text.length, end + 48));
      const negativeRelationship = /\bnot\b|\bno\s+longer\b|\b(?:does?|did|must|may|should|can|could|will|would|is|are|was|were|be)\s+not\b|\bcannot\b|\bnever\b|\bneither\b[^.;]{0,120}\bnor\b|\bnot\s+permitted\b|\bnot\s+allowed\b|\bunavailable\b|\bunsupported\b|\bforbidden\b|\bprohibited\b|\brather\s+than\b|\bexplicitly\s+not\b/u.test(scopedRelationship)
        || /^\s*(?:(?:does?|did|must|may|should|can|could|will|would|is|are|was|were|be)\s+not|cannot|never|is\s+forbidden|is\s+prohibited)\b/u.test(immediateSuffix);
      const negativeLead = /^(?:do\s+not\s+let|verify\s+(?:the\s+)?guidance\s+never\s+claims?\s+that)\b/u.test(localPrefix.trim())
        || /^no\s+reviewer$/u.test(localPrefix.trim())
        || /^neither\b.*\bnor$/u.test(localPrefix.trim())
        || (/^neither$/u.test(localPrefix.trim()) && /\bnor\b/u.test(relationship));
      if (!negativeRelationship && !negativeLead) return false;
    }
  }
  return sawPair;
}

type ControlledTriageRelationFamily =
  | 'severity-story-responsibility'
  | 'unknown-applicability-routing'
  | 'dismissal-story-responsibility'
  | 'deferral-story-responsibility'
  | 'signed-disposition-followup';

type ControlledTriageRelationState = 'unsafe' | 'explicitly-safe' | 'unclassified';

type ControlledTriageRelationClassification = {
  family: ControlledTriageRelationFamily;
  state: ControlledTriageRelationState;
};

type ControlledTriageRelationSpec = {
  family: Exclude<ControlledTriageRelationFamily, 'signed-disposition-followup'>;
  subject: RegExp;
  outcome: RegExp;
  maxSpan: number;
  /**
   * The weakest member of a concept list is generic on its own. It stays in
   * the list because it is a real term next to a specific counterpart, but a
   * pair drawn from the generic term on BOTH sides is proximity, not a
   * relation, so it does not open a controlled triage relationship.
   */
  genericSubject?: RegExp;
  genericOutcome?: RegExp;
};

const TRIAGE_SEVERITY_SUBJECT = /\b(?:severity(?:\s+(?:rating|rank|level|score))?|defect\s+severity|criticality|priority|seriousness(?:\s+(?:rating|rank|level|score))?|(?:risk|impact|harm)\s+(?:rating|rank|level|score))\b/u;
const TRIAGE_UNKNOWN_APPLICABILITY_SUBJECT = /\b(?:(?:unknown|uncertain|undetermined|indeterminate|pending|unassessed|unevaluated|unresolved)\s+applicability|applicability\s+(?:is|remains|stays|awaits)?\s*(?:unknown|uncertain|undetermined|indeterminate|pending|unassessed|unevaluated|unresolved|determination)|applicability\s+(?:is|remains|stays|has)?\s*(?:not\s+yet|not\s+been)\s+(?:known|determined|assessed|evaluated))\b/u;
const TRIAGE_DISMISSAL_SUBJECT = /\b(?:finding\s+dismiss|dismissal|dismissed\s+finding|(?:closed|archived)\s+finding|finding\s+(?:is|was|becomes?|counts?\s+as)\s+(?:closed|dismissed|archived)|(?:archiv(?:e|es|ed|ing)|clos(?:e|es|ed|ing)|dismiss(?:es|ed|ing)?)(?:\s+the)?\s+finding|once\s+(?:archived|closed|dismissed))\b/u;
const TRIAGE_DEFERRAL_SUBJECT = /\b(?:defer\s+with\s+proof|finding\s+deferral\s+disposition|deferral(?!\s+lineage))\b/u;
const TRIAGE_SEVERITY_RESPONSIBILITY_OUTCOME = /\b(?:story\s+(?:scope|ownership|responsibility)|(?:this|the|current)\s+story|scope|ownership|owns?|owned|belongs?|responsibility|routing|repair)\b/u;
const TRIAGE_STORY_RESPONSIBILITY_OUTCOME = /\b(?:out\s+of\s+scope|non\s+applicable|nonapplicable|not\s+owned\s+by\s+(?:(?:this|the|current)\s+)?story|no\s+responsibility|nonownership|(?:another|separate|other)\s+(?:story|party)|belongs?\s+elsewhere|belongs?\s+to\s+(?:another|a\s+separate|an?\s+other)\s+story|outside\s+(?:(?:this|the|current)\s+)?story|beyond\s+(?:(?:this|the|current)\s+)?story|later\s+work|exclusion\s+from\s+(?:(?:this|the|current)\s+)?story|story\s+(?:scope|ownership|responsibility)|(?:this|the|current)\s+story|scope|ownership|owns?|owned|belongs?|responsibility|routing|repair|resolution|resolved|resolv(?:e|es|ed|ing)\s+(?:the\s+)?finding|applicability(?:\s+verdict)?)\b/u;
const TRIAGE_ROUTING_OR_GATE_OUTCOME = /\b(?:routing|route|routes|routed|handoff|hand\s+off|handing\s+(?:the\s+)?(?:finding|issue|defect)\s+off|eligible\s+for\s+handoff|park(?:s|ed|ing)?|postpon(?:e|es|ed|ing)|transfer(?:s|red|ring)?|send(?:s|ing)?|sending|leave(?:s|d|ing)?|defer|deferral|non\s+blocking|advisory|away\s+from\s+(?:(?:this|the|current)\s+)?story|(?:finding|issue|defect|work)\s+(?:to|into|beyond)\s+(?:(?:another|separate|this|current|the)\s+)?story|(?:another|separate)\s+story|later\s+work|(?:finding|issue|defect|work)\s+elsewhere|outside\s+(?:(?:this|the|current)\s+)?story|clear(?:s|ed)?\s+(?:the\s+)?(?:review\s+)?blocker|remove(?:s|d)?\s+(?:the\s+)?(?:review\s+)?blocker|(?:removal|clearance)\s+of\s+(?:the\s+)?(?:review\s+)?blocker|(?:review\s+)?gate\s+relief|unblock(?:s|ed)?)\b/u;

// Bare `priority` is this repository's story risk-signal vocabulary (see the
// keyword elevation rule in the project guide), not a Finding severity, and a
// bare Story reference names no triage outcome. Each is still a live term
// opposite a specific counterpart -- `priority ... Story ownership` and
// `severity ... the Story` both remain controlled -- so neither word is
// dropped; only the cell where both sides are generic stops qualifying.
const TRIAGE_SEVERITY_GENERIC_SUBJECT = /^priority$/u;
const TRIAGE_SEVERITY_GENERIC_OUTCOME = /^(?:this|the|current)\s+story$/u;

// The one authority-verb vocabulary in this file: the severity detectors below
// (`hasNothingButSeverityAuthority`, `hasCrossSegmentSeverityAuthority`) and the
// generic-cell rule above share it, so a verb can never be decisive for one
// detector and inert for another. `overrid*` is a decision verb of the same
// kind as `govern*`/`dictat*` -- it asserts that one axis settles the outcome --
// so it belongs to this list rather than to a second, parallel one.
const TRIAGE_AUTHORITY_DECISION_VERB = '(?:determin(?:e|es|ed|ing)|decid(?:e|es|ed|ing)|control(?:s|led|ling)?|govern(?:s|ed|ing)?|set(?:s|ting)?|defin(?:e|es|ed|ing)|dictat(?:e|es|ed|ing)|overrid(?:e|es|den|ing))';
const TRIAGE_GENERIC_PAIR_DECISIVE_RELATION = new RegExp(`\\b${TRIAGE_AUTHORITY_DECISION_VERB}\\b`, 'u');

const CONTROLLED_TRIAGE_RELATION_SPECS: readonly ControlledTriageRelationSpec[] = [
  {
    family: 'severity-story-responsibility',
    subject: TRIAGE_SEVERITY_SUBJECT,
    outcome: TRIAGE_SEVERITY_RESPONSIBILITY_OUTCOME,
    maxSpan: 260,
    genericSubject: TRIAGE_SEVERITY_GENERIC_SUBJECT,
    genericOutcome: TRIAGE_SEVERITY_GENERIC_OUTCOME,
  },
  { family: 'unknown-applicability-routing', subject: TRIAGE_UNKNOWN_APPLICABILITY_SUBJECT, outcome: TRIAGE_ROUTING_OR_GATE_OUTCOME, maxSpan: 320 },
  { family: 'dismissal-story-responsibility', subject: TRIAGE_DISMISSAL_SUBJECT, outcome: TRIAGE_STORY_RESPONSIBILITY_OUTCOME, maxSpan: 280 },
  { family: 'deferral-story-responsibility', subject: TRIAGE_DEFERRAL_SUBJECT, outcome: TRIAGE_STORY_RESPONSIBILITY_OUTCOME, maxSpan: 280 },
] as const;

function isStructuredUnknownApplicabilityPrerequisite(text: string): boolean {
  if (!hasConceptPair(text, TRIAGE_UNKNOWN_APPLICABILITY_SUBJECT, TRIAGE_ROUTING_OR_GATE_OUTCOME, 320)) return false;
  const subjectRange = matchRanges(text, TRIAGE_UNKNOWN_APPLICABILITY_SUBJECT)[0];
  const evidenceRange = matchRanges(text, /\b(?:structured|fresh|signed|current)(?:\s+and\s+(?:structured|fresh|signed|current))*\s+evidence\b/u)[0];
  const ownerRange = matchRanges(text, /\b(?:named|traceable|live)(?:\s+and\s+(?:named|traceable|live))*\s+owner\b/u)[0];
  const routeRanges = matchRanges(text, /\b(?:routing|route)\b/u);
  if (!subjectRange || subjectRange.start !== 0 || !evidenceRange || !ownerRange || routeRanges.length !== 1) return false;
  const routeRange = routeRanges[0];
  const beforeRange = matchRanges(text, /\bbefore\b/u)[0];
  const untilRange = matchRanges(text, /\buntil\b/u)[0];
  if (beforeRange
    && /\b(?:requires?|needs?)\b/u.test(text.slice(subjectRange.end, evidenceRange.start))
    && subjectRange.end <= evidenceRange.start
    && evidenceRange.end <= ownerRange.start
    && ownerRange.end <= beforeRange.start
    && beforeRange.end <= routeRange.start
    && /^(?:routing|route)\s+(?:(?:can|may|will)\s+)?(?:occur|proceed|begin|start|be\s+accepted)$/u.test(text.slice(routeRange.start))) {
    return true;
  }
  return Boolean(untilRange
    && /\b(?:remains?|stays?|is|must\s+remain)\s+blocking\b/u.test(text.slice(subjectRange.end, untilRange.start))
    && subjectRange.end <= untilRange.start
    && untilRange.end <= evidenceRange.start
    && evidenceRange.end <= ownerRange.start
    && ownerRange.end <= routeRange.start
    && /\b(?:resolves?|determines?|establishes?)\s+(?:it|applicability)\b/u.test(text.slice(evidenceRange.end, ownerRange.start))
    && /\b(?:accepts?|owns?|approves?)\s+(?:the\s+)?route$/u.test(text.slice(ownerRange.end)));
}

function controlledPairIsGenericOnly(
  spec: ControlledTriageRelationSpec,
  subjectText: string,
  outcomeText: string,
  relationText: string,
): boolean {
  if (spec.genericSubject === undefined || spec.genericOutcome === undefined) return false;
  if (!spec.genericSubject.test(subjectText) || !spec.genericOutcome.test(outcomeText)) return false;
  // Genericness alone is proximity, not exemption. A decisive authority verb
  // standing between the two generic terms is exactly the severity-authority
  // claim this family exists to refuse, so the cell only stays disqualified
  // while nothing decisive joins them.
  return !TRIAGE_GENERIC_PAIR_DECISIVE_RELATION.test(relationText);
}

/**
 * A controlled relationship needs at least one specific term. Co-occurrence of
 * two generic terms inside the span is not an authority assertion, so it is
 * not enough to open the relationship.
 */
function hasControlledConceptPair(text: string, spec: ControlledTriageRelationSpec): boolean {
  return matchRanges(text, spec.subject).some(subjectRange =>
    matchRanges(text, spec.outcome).some(outcomeRange => {
      const start = Math.min(subjectRange.start, outcomeRange.start);
      const end = Math.max(subjectRange.end, outcomeRange.end);
      if (end - start > spec.maxSpan) return false;
      const firstRange = subjectRange.start <= outcomeRange.start ? subjectRange : outcomeRange;
      const secondRange = subjectRange.start <= outcomeRange.start ? outcomeRange : subjectRange;
      return !controlledPairIsGenericOnly(
        spec,
        text.slice(subjectRange.start, subjectRange.end),
        text.slice(outcomeRange.start, outcomeRange.end),
        text.slice(firstRange.end, secondRange.start),
      );
    }),
  );
}

function classifyControlledRelationSegment(
  segment: string,
  spec: ControlledTriageRelationSpec,
): ControlledTriageRelationClassification {
  if (!hasControlledConceptPair(segment, spec)) {
    return { family: spec.family, state: 'unclassified' };
  }
  if (spec.family === 'severity-story-responsibility'
    && /^severity\s+is\s+only\s+one\s+input\s+to\s+(?:story\s+)?(?:scope|applicability|ownership|responsibility|routing|repair)$/u.test(segment)) {
    return { family: spec.family, state: 'explicitly-safe' };
  }
  if (spec.family === 'unknown-applicability-routing'
    && isStructuredUnknownApplicabilityPrerequisite(segment)) {
    return { family: spec.family, state: 'explicitly-safe' };
  }
  return {
    family: spec.family,
    state: controlledConceptPairIsExplicitlyNegative(
      segment,
      spec.subject,
      spec.outcome,
      spec.maxSpan,
      (subjectText, outcomeText, relationText) => controlledPairIsGenericOnly(spec, subjectText, outcomeText, relationText),
    )
      ? 'explicitly-safe'
      : 'unsafe',
  };
}

function isPureInterrogative(text: string): boolean {
  const trimmed = text.trim();
  if (!/\?\s*$/u.test(trimmed) || trimmed.slice(0, -1).includes('?')) return false;
  return /^(?:do|does|did|can|could|may|might|must|should|would|will|is|are|was|were|has|have|had|what|when|where|which|who|why|how|whether)\b/iu.test(trimmed);
}

function isExplicitFailClosedQuotedFixture(text: string): boolean {
  const trimmed = text.trim();
  const match = /^(?:negative\s+)?(?:fixture|test\s+fixture|example\s+input|quoted\s+statement)\s*:\s*["“][\s\S]+["”]\s+(.+)$/iu.exec(trimmed);
  if (!match) return false;
  const expectedOutcome = normalizeTriageAuthorityText(match[1]);
  if (/\b(?:does|did|must|should|will|would|can|could)\s+not\b[^.;]{0,40}\b(?:reject|refuse|block|fail)\w*\b/u.test(expectedOutcome)) return false;
  return /^(?:expected\s+(?:result|outcome)\s*:\s*)?(?:(?:semantic\s+)?(?:validation|guard|contract)\s+)?(?:must\s+|should\s+|will\s+)?(?:reject|refuse|block)\w*\s+(?:it|this|the\s+(?:input|statement|fixture|claim|wording|mutation))(?:\s+and\s+(?:must\s+)?fail\w*\s+closed)?[.!?]*$/u.test(expectedOutcome)
    || /^(?:expected\s+(?:result|outcome)\s*:\s*)?(?:(?:semantic\s+)?(?:validation|guard|contract)\s+)?fail(?:s|ed|ing)?\s+closed[.!?]*$/u.test(expectedOutcome);
}

function isExplicitRejectedAuthorityStatement(text: string): boolean {
  const wrapper = /^reject\s+([\s\S]+?)\s+as\s+an\s+invalid\s+(?:authority\s+)?statement[.!?]*$/iu.exec(text.trim());
  if (!wrapper) return false;
  let claim = wrapper[1].trim();
  const quotePairs = new Map([
    ['`', '`'],
    ['"', '"'],
    ["'", "'"],
    ['“', '”'],
    ['‘', '’'],
  ]);
  const closingQuote = quotePairs.get(claim[0]);
  if (closingQuote !== undefined) {
    if (!claim.endsWith(closingQuote) || claim.length < 3) return false;
    claim = claim.slice(1, -1).trim();
  }
  // The rejection wrapper is metadata for one atomic authority claim. It is
  // never a whole-source escape hatch for punctuation- or clause-separated
  // statements that must each be evaluated by the normal fail-closed guard.
  if (claim.length === 0 || claim.length > 240) return false;
  if (!/^[\p{L}\p{N}_\s]+$/u.test(claim)) return false;
  if (/\b(?:and|or|nor|but|however|yet|although|while|then|therefore|so|if|unless|because|whereas)\b/iu.test(claim)) return false;
  return rejectedAuthorityRelationCount(claim) === 1;
}

function rejectedAuthorityRelationCount(claim: string): number {
  const normalized = normalizeTriageAuthorityText(claim);
  const reviewerActor = /\b(?:reviewers?|review\s+lanes?|agents?|story\s+owners?)\b/u;
  const collapsedOutcome = /\b(?:applicability\s+verdict|non\s+applicability\s+verdict|out\s+of\s+scope|nonownership\s+by\s+(?:(?:this|the|current)\s+)?story|resolved|resolution|repaired|repair|dismissed|finding\s+dismiss|disproven|duplicate|pre\s+existing\s+unaffected)\b/u;
  const storyAuthoredChange = /\b(?:this|the)\s+(?:story|prompt|guidance|change|update|implementation)\b/u;
  const relations: Array<[RegExp, RegExp, number?]> = [
    ...CONTROLLED_TRIAGE_RELATION_SPECS.map(spec => [spec.subject, spec.outcome, spec.maxSpan] as [RegExp, RegExp, number]),
    [reviewerActor, TRIAGE_DEFERRAL_SUBJECT],
    [TRIAGE_DEFERRAL_SUBJECT, collapsedOutcome],
    [DYNAMIC_FINDING_AUTHORITY, storyAuthoredChange],
  ];
  return relations.reduce(
    (count, [left, right, maxSpan]) => count + countBoundedConceptPairInstances(normalized, left, right, maxSpan),
    0,
  );
}

function isBoundedSignedDispositionInspection(segment: string): boolean {
  return /^(?:reviewers?|review\s+lanes?|agents?|story\s+owners?)\s+(?:(?:may|can|must|should)\s+)?(?:only\s+)?(?:inspect|read|audit|verify|consume)\s+(?:an?\s+|the\s+)?signed\s+(?:defer\s+with\s+proof(?:\s+disposition)?|finding\s+deferral\s+disposition)(?:\s+(?:receipt|record))?(?:\s+(?:for|as)\s+(?:evidence|review\s+evidence|an?\s+input))?$/u.test(segment);
}

function isExplicitlyProhibitedDispositionAuthority(segment: string): boolean {
  const actor = '(?:reviewers?|review\\s+lanes?|agents?|story\\s+owners?)';
  // A direct prohibition is safe only when negation binds a direct
  // disposition-authority action. Control and timing verbs such as avoid,
  // postpone, resist, delay, hesitate, or refuse cannot inherit that safety
  // merely because a later complement names a grant action.
  const action = '(?:mint(?:s|ed|ing)?|sign(?:s|ed|ing)?|suppl(?:y|ies|ied|ying)|bestow(?:s|ed|ing)?|confer(?:s|red|ring)?|grant(?:s|ed|ing)?|assign(?:s|ed|ing)?|attach(?:es|ed|ing)?|issue(?:s|d|ing)?|creat(?:e|es|ed|ing)|set(?:s|ting)?|giv(?:e|es|en|ing))';
  const actionList = `${action}(?:(?:\\s+or)?\\s+${action}){0,5}`;
  const disposition = '(?:defer\\s+with\\s+proof(?:\\s+disposition)?|finding\\s+deferral\\s+disposition)';
  const target = '(?:\\s+(?:on|to|for)\\s+(?:the\\s+)?finding)?';
  const direct = new RegExp(`^${actor}\\s+(?:(?:do|does|did|must|may|should|can|could|will|would|is|are|was|were|be)\\s+not|cannot|never)\\s+${actionList}\\s+${disposition}${target}$`, 'u');
  const neither = new RegExp(`^neither\\s+${actor}\\s+nor\\s+${actor}\\s+(?:may|can|must|should|will|would)\\s+${actionList}\\s+${disposition}${target}$`, 'u');
  return direct.test(segment) || neither.test(segment);
}

function hasCrossSegmentDispositionAssignment(segments: readonly string[]): boolean {
  const inspection = /^(?:reviewers?|review\s+lanes?|agents?|story\s+owners?)\s+(?:(?:may|can|must|should)\s+)?(?:only\s+)?(?:inspect|read|audit|verify|consume)\s+(?:an?\s+|the\s+)?signed\s+(?:defer\s+with\s+proof(?:\s+disposition)?|finding\s+deferral\s+disposition)(?:\s+(?:receipt|record))?(?:\s+(?:for|as)\s+(?:evidence|review\s+evidence|an?\s+input))?$/u;
  for (let index = 0; index < segments.length - 1; index += 1) {
    if (!inspection.test(segments[index])) continue;
    // Evidence-only asides do not discharge the controlled antecedent. Scan
    // the remaining source so a longer list of audit/reporting sentences
    // cannot launder a later coreferent assignment.
    for (let continuationIndex = index + 1;
      continuationIndex < segments.length;
      continuationIndex += 1) {
      const continuation = segments[continuationIndex];
      const findingTarget = /\b(?:the\s+)?finding\b/u.test(continuation);
      if (!findingTarget) continue;
      // Negative polarity is safe only when the complete continuation is one
      // bounded negative assignment relation. A negative adjective followed
      // by `and grant ...` must not exempt the later affirmative assignment.
      const negativeCoreferentAssignment = /^(?:then\s+)?(?:it|this|the\s+same|that\s+(?:disposition|artifact|record|result|receipt)|the\s+(?:(?:signed|inspected|reviewed|verified|audited|same)\s+){0,2}(?:disposition|artifact|record|result|receipt))\s+(?:(?:do|does|did|must|may|should|can|could|will|would|is|are|was|were|be)\s+not|cannot|never)\s+(?:bind(?:s|ed|ing)?|assign(?:s|ed|ing)?|attach(?:es|ed|ing)?|grant(?:s|ed|ing)?|giv(?:e|es|en|ing)|bestow(?:s|ed|ing)?|confer(?:s|red|ring)?|issue(?:s|d|ing)?|creat(?:e|es|ed|ing)|set(?:s|ting)?)(?:\s+(?:it|this|that|the\s+(?:disposition|artifact|record|result|receipt)))?(?:\s+(?:on|to|for))?\s+(?:the\s+)?finding$/u.test(continuation);
      const findingRemainsUnbound = /^(?:then\s+)?(?:the\s+)?finding\s+(?:remains?|stays?|is|must\s+remain)\s+(?:open|visible|unresolved|unchanged|unbound|nonbinding)$/u.test(continuation);
      const evidenceOnlyContinuation = /^(?:then\s+)?(?:record|preserve|log|report|attach|store|retain|compare|verify|audit)\b[^.;]{0,180}\b(?:audit|evidence|receipt|record|result|output|trail|check)\b[^.;]{0,80}\b(?:the\s+)?finding$/u.test(continuation);
      if (negativeCoreferentAssignment
        || findingRemainsUnbound
        || evidenceOnlyContinuation
        || /^(?:then\s+)?(?:(?:do|does|did|must|may|should|can|could|will|would|is|are|was|were|be)\s+not|cannot|never)\b/u.test(continuation)) continue;
      // Once a signed disposition is the live antecedent, later Story-authored
      // prose may report evidence or state that the Finding remains unbound.
      // Any other Finding-bearing outcome is authority-bearing by default;
      // requiring a specific coreference noun would reopen synonym laundering
      // through words such as `authorization` or `decision`.
      return true;
    }
  }
  return false;
}

function isCanonicalTriageInventorySegment(segment: string): boolean {
  return /^(?:own\s+all\s+review\s+lane\s+behavior\s+and\s+prohibitions\s+in\s+one\s+canonical\s+agent\s+contract|add\s+adversarial\s+tests\s+covering)\s+.+$/u.test(segment);
}

function isApprovedFutureDeferralBoundary(segment: string): boolean {
  return /^(?:and\s+)?future\s+official\s+signed\s+defer\s+with\s+proof\s+guidance\s+limited\s+to\s+eligible\s+verified\s+applicable\s+low\s+medium\s+findings\s+while\s+mandatory\s+current\s+repair\s+cases\s+remain\s+blocking$/u.test(segment);
}

function isApprovedNegativeCapabilityInventory(segment: string): boolean {
  return /^no\s+reviewer\s+repair\s+finding\s+dismiss\s+story\s+create\s+gap\s+log\s+severity\s+rewriting\s+or\s+unilateral\s+scope\s+expansion$/u.test(segment);
}

function isApprovedFailClosedOrEvidenceRouteFragment(segment: string): boolean {
  return /^(?:fail\s+closed\s+unknown\s+applicability|evidence\s+backed\s+routing\s+with\s+owner)$/u.test(segment);
}

function isApprovedOwnerDispositionInvariant(segment: string): boolean {
  return /^the\s+owner\s+returns\s+applicable\s+blockers\s+to\s+dev\s+routes\s+evidence\s+backed\s+non\s+applicable\s+work\s+without\s+unowned\s+high\s+critical\s+findings\s+fails\s+closed\s+when\s+an\s+otherwise\s+blocking\s+finding\s+has\s+unknown\s+applicability\s+and\s+treats\s+compatibility\s+dismissal\s+as\s+temporary\s+round\s+profile\s+handling\s+rather\s+than\s+applicability\s+proof$/u.test(segment);
}

function isApprovedIndependentAxesInvariant(segment: string): boolean {
  return /^(?:inspect|verify|audit|check)\s+.+\b(?:evidence\s+state\s+)?severity\s+applicability\s+candidate\s+and\s+gate\s+impact\s+(?:are|remain)\s+independent\s+axes$/u.test(segment);
}

function hasNothingButSeverityAuthority(text: string): boolean {
  // `but` is normally a clause boundary in Task Context segmentation, while
  // `nothing but <subject>` is one atomic exclusive-subject construction.
  // Detect that construction before segmentation so it cannot be laundered
  // into two harmless-looking fragments.
  const normalized = normalizeTriageAuthorityText(text);
  const severitySubject = '(?:severity(?:\\s+(?:rating|rank|level|score))?|criticality|priority|seriousness(?:\\s+(?:rating|rank|level|score))?|(?:risk|impact|harm)\\s+(?:rating|rank|level|score))';
  const authorityDecisionVerb = TRIAGE_AUTHORITY_DECISION_VERB;
  const responsibilityObject = '(?:story\\s+)?(?:scope|applicability|ownership|responsibility|routing|repair)';
  return new RegExp(
    `\\bnothing\\s+(?:but|other\\s+than)\\s+(?:the\\s+)?${severitySubject}\\s+${authorityDecisionVerb}\\s+(?:the\\s+|current\\s+)?${responsibilityObject}\\b`,
    'u',
  ).test(normalized);
}

function hasCrossSegmentSeverityAuthority(segments: readonly string[]): boolean {
  const severitySubject = '(?:severity(?:\\s+(?:rating|rank|level|score))?|criticality|priority|seriousness(?:\\s+(?:rating|rank|level|score))?|(?:risk|impact|harm)\\s+(?:rating|rank|level|score))';
  const authorityNoun = '(?:factor|criterion|basis|authority|determinant|driver|rule|test|input|consideration)';
  const responsibilityObject = '(?:story\\s+)?(?:scope|applicability|ownership|responsibility|routing|repair)';
  const authorityDecisionVerb = TRIAGE_AUTHORITY_DECISION_VERB;
  const flattened = segments.join(' ').replace(/[:]+/gu, ' ');
  const splitAuthority = new RegExp(
    `\\b${severitySubject}\\s+(?:is|are|was|were|be|being|becomes?|remains?)\\s+the\\s+(?:[\\p{L}\\p{N}_]+\\s+){0,3}${authorityNoun}\\s+(?:(?:and|so|therefore|then)\\s+)?(?:(?:this|that|the)\\s+${authorityNoun}|it|this|that)\\s+(?:(?!(?:not|never|no|cannot|do|does|did)\\b)[\\p{L}\\p{N}_]+\\s+){0,2}${authorityDecisionVerb}\\s+(?:the\\s+|current\\s+)?${responsibilityObject}\\b`,
    'u',
  );
  if (splitAuthority.test(flattened)) return true;

  // Evidence-only asides do not discharge the definite severity-authority
  // antecedent. Scan the remaining source so adding more reporting sentences
  // cannot make a later pronoun continuation authoritative.
  const antecedent = new RegExp(
    `\\b${severitySubject}\\s+(?:is|are|was|were|be|being|becomes?|remains?)\\s+the\\s+(?:[\\p{L}\\p{N}_]+\\s+){0,3}${authorityNoun}\\s*$`,
    'u',
  );
  const continuation = new RegExp(
    `^(?:(?:and|so|therefore|then)\\s+)?(?:(?:this|that|the)\\s+${authorityNoun}|it|this|that)\\s+(?:(?!(?:not|never|no|cannot|do|does|did)\\b)[\\p{L}\\p{N}_]+\\s+){0,2}${authorityDecisionVerb}\\s+(?:the\\s+|current\\s+)?${responsibilityObject}\\b`,
    'u',
  );
  return segments.some((segment, index) => antecedent.test(segment)
    && segments.slice(index + 1).some(candidate => continuation.test(candidate)));
}

function hasCrossSegmentControlledAuthority(
  segments: readonly string[],
  spec: ControlledTriageRelationSpec,
): boolean {
  const coreferent = /^(?:then\s+)?(?:it|this|that)\b/u;
  const authorityLink = /\b(?:determin(?:e|es|ed|ing)|permit(?:s|ted|ting)?|allow(?:s|ed|ing)?|authoriz(?:e|es|ed|ing)|prov(?:e|es|ed|ing)|establish(?:es|ed|ing)?|show(?:s|ed|ing)?|mean(?:s|t|ing)?|transfer(?:s|red|ring)?)\b/u;
  return segments.some((segment, index) => spec.subject.test(segment)
    && segments.slice(index + 1, index + 2).some(candidate => {
      if (!coreferent.test(candidate) || !spec.outcome.test(candidate)) return false;
      const coreferentRange = matchRanges(candidate, coreferent)[0];
      const outcomeRange = matchRanges(candidate, spec.outcome)[0];
      if (!coreferentRange || !outcomeRange || coreferentRange.end > outcomeRange.start) return false;
      const relation = candidate.slice(coreferentRange.end, outcomeRange.start);
      return authorityLink.test(relation)
        && !controlledConceptPairIsExplicitlyNegative(candidate, coreferent, spec.outcome, spec.maxSpan);
    }));
}

function classifyControlledTriageRelations(
  text: string,
  segments: readonly string[],
): ControlledTriageRelationClassification {
  const relevantSegments = segments.filter(segment => !isCanonicalTriageInventorySegment(segment)
    && !isApprovedFutureDeferralBoundary(segment)
    && !isApprovedNegativeCapabilityInventory(segment)
    && !isApprovedFailClosedOrEvidenceRouteFragment(segment)
    && !isApprovedOwnerDispositionInvariant(segment)
    && !isApprovedIndependentAxesInvariant(segment));

  if (hasCrossSegmentDispositionAssignment(relevantSegments)) {
    return { family: 'signed-disposition-followup', state: 'unsafe' };
  }
  if (hasNothingButSeverityAuthority(text) || hasCrossSegmentSeverityAuthority(relevantSegments)) {
    return { family: 'severity-story-responsibility', state: 'unsafe' };
  }
  for (const spec of CONTROLLED_TRIAGE_RELATION_SPECS) {
    if (hasCrossSegmentControlledAuthority(relevantSegments, spec)) {
      return { family: spec.family, state: 'unsafe' };
    }
  }

  let safeFamily: ControlledTriageRelationFamily | null = null;
  for (const segment of relevantSegments) {
    for (const spec of CONTROLLED_TRIAGE_RELATION_SPECS) {
      const classification = classifyControlledRelationSegment(segment, spec);
      if (classification.state === 'unsafe') return classification;
      if (classification.state === 'explicitly-safe') safeFamily = classification.family;
    }
  }

  // Dismissal and unknown-applicability authority are commonly laundered over
  // adjacent punctuation-separated clauses. Re-evaluate the bounded source as
  // one relationship after every individually safe segment has been checked.
  // Severity and signed-disposition anaphora use their dedicated structural
  // state machines above, so unrelated long-form prose is not flattened into
  // a synthetic relation.
  const joined = relevantSegments.join(' ');
  for (const spec of CONTROLLED_TRIAGE_RELATION_SPECS) {
    if (spec.family !== 'dismissal-story-responsibility'
      && spec.family !== 'unknown-applicability-routing') continue;
    const classification = classifyControlledRelationSegment(joined, spec);
    if (classification.state === 'unsafe') return classification;
    if (classification.state === 'explicitly-safe') safeFamily = classification.family;
  }

  return safeFamily === null
    ? { family: 'severity-story-responsibility', state: 'unclassified' }
    : { family: safeFamily, state: 'explicitly-safe' };
}

function controlledTriageViolation(
  classification: ControlledTriageRelationClassification,
): ReviewTriageAuthorityViolation | null {
  if (classification.state !== 'unsafe') return null;
  switch (classification.family) {
    case 'severity-story-responsibility':
      return 'severity used as sole ownership or scope authority';
    case 'unknown-applicability-routing':
      return 'unknown applicability used to route or unblock';
    case 'dismissal-story-responsibility':
      return 'dismissal used as applicability proof';
    case 'deferral-story-responsibility':
      return 'disposition collapsed into applicability';
    case 'signed-disposition-followup':
      return 'unauthorized disposition minting';
  }
}

function isNegativeMutationVerificationIntent(source: ReviewerTaskContextAuthoritySource): boolean {
  if (source.kind !== 'verificationIntent') return false;
  const normalized = normalizeTriageAuthorityText(source.text);
  if (!/^(?:inject|attempt\s+to|present|give|change|replace|mutate|alter|delete\s+or\s+alter)\b/u.test(normalized)) return false;
  const outcomeStart = Math.max(
    normalized.lastIndexOf(' prove '),
    normalized.lastIndexOf(' verify '),
    normalized.lastIndexOf(' assert '),
    normalized.lastIndexOf(' ensure '),
    normalized.startsWith('prove ') ? 0 : -1,
    normalized.startsWith('verify ') ? 0 : -1,
  );
  if (outcomeStart < 0) return false;
  const outcome = normalized.slice(outcomeStart);
  if (/\b(?:does|did|must|should|will|would|can|could)\s+not\b[^.;]{0,48}\b(?:reject|refuse|block|fail)\w*\b/u.test(outcome)) return false;
  const boundedOutcome = outcome.replace(/[.!?]+\s+gap\s+log\s+remains\s+a\s+main\s+agent\s+or\s+human\s+archive\s+for\s+proof\s+or\s+stop\s+framework\s+gaps\s+never\s+a\s+general\s+product\s+defect\s+routing\s+or\s+backlog\s+shortcut[.!?]*$/u, '');
  return /(?:\b(?:reject|refuse|block)\w*\s+(?:it|them|these|every\s+(?:permission|mutation|claim)|the\s+(?:wording|mutation|claim|statement|label))|\b(?:semantic\s+)?(?:contract|guard|validation|guidance)\s+(?:reject|refuse|block)\w*\s+(?:it|them|these|the\s+(?:wording|mutation|claim|statement|label))|\b(?:the\s+)?(?:story\s+owner\s+)?(?:contract|guard|validation|guidance)\s+(?:remains?\s+)?fail(?:s)?\s+closed\b[^.;]*|\b(?:contract\s+)?tests?\s+fail\b[^.;]*|\brequires?\b[^.;]*(?:current\s+story\s+repair|structured\s+evidence|traceable\s+owner|valid\s+route)|\bmust\s+remain\b[^.;]*future\s+system\s+work)\s*[.!?]*$/u.test(boundedOutcome);
}

function isWholeSourceDynamicFindingInvariantAssertion(text: string): boolean {
  const statements = text
    .split(/[.!?;。！？；\r\n]+/u)
    .map(statement => normalizeTriageAuthorityText(statement))
    .filter(Boolean);
  if (statements.length === 0) return false;
  const [statement, ...continuations] = statements;

  // A continuation is admitted only as a complete evidence/reporting action.
  // This positive grammar cannot mint or revisit applicability, severity,
  // ownership, routing, disposition, or gate authority after the invariant.
  const benignEvidenceContinuation = /^(?:then\s+)?(?:record|report|preserve|attach|capture|log)\s+(?:the\s+)?(?:comparison|invariant|verification|audit|check)\s+(?:result|results|evidence|receipt|receipts|output)(?:\s+(?:as|in|to)\s+(?:the\s+)?(?:(?:test|review|verification|audit)\s+)?(?:evidence|record|report|log))?$/u;
  if (!continuations.every(continuation => benignEvidenceContinuation.test(continuation))) return false;

  const nominalChange = /\b(?:change|changes|update|updates)\b/u;
  const invariantPredicate = '(?:remain|remains|stay|stays|is|are|must\\s+remain)\\s+(?:completely\\s+)?(?:unchanged|unaltered|unmodified|identical)';
  const invariantCause = '(?:\\s+by\\s+(?:the\\s+)?(?:metadata|prompt|implementation|code)(?:\\s+only)?\\s+(?:registration|change|update))?';
  const liveContractInventory = 'finding\\s+schema\\s+fields\\s+evidence\\s+state\\s+and\\s+severity\\s+semantics\\s+applicability\\s+verdict\\s+vocabulary\\s+freshness\\s+and\\s+supersession\\s+rules\\s+is\\s+finding\\s+blocking\\s+behavior\\s+command\\s+policies\\s+and\\s+process\\s+fact\\s+consumers';
  const explicitInvariantSubject = `(?:it|its\\s+contract|the\\s+contract|the\\s+runtime\\s+contract|${liveContractInventory})`;
  const invariantOutcome = new RegExp(
    `^\\s*(?:(?::\\s*)?(?:(?:and\\s+)?(?:verify|confirm|check)(?:\\s+that)?\\s+)?${explicitInvariantSubject}\\s+${invariantPredicate}|${invariantPredicate})${invariantCause}$`,
    'u',
  );

  for (const authorityRange of matchRanges(statement, DYNAMIC_FINDING_AUTHORITY)) {
    for (const changeRange of matchRanges(statement, nominalChange)) {
      if (changeRange.start < authorityRange.end) continue;
      const lead = statement.slice(0, authorityRange.start);
      const bridge = statement.slice(authorityRange.end, changeRange.end);
      const outcome = statement.slice(changeRange.end);
      const boundedLead = /^(?:compare|verify|audit|check)\s+(?:the\s+)?$/u.test(lead);
      const boundedBridge = /^(?:\s+contract)?\s+(?:before\s+and\s+after|across)\s+(?:(?:this|that|these|those|the|current|proposed)\s+)?(?:(?:metadata\s+only|prompt\s+only|implementation|code)\s+)?(?:change|changes|update|updates)$/u.test(bridge);
      if (boundedLead && boundedBridge && invariantOutcome.test(outcome)) return true;
    }
  }
  return false;
}

function hasDynamicFindingAuthorityAmendmentAssertion(
  segment: string,
  wholeSourceIsInvariantAssertion: boolean,
): boolean {
  const referenceOnly = new RegExp(
    `^(?:(?:use|consult|follow)\\s+(?:the\\s+)?${DYNAMIC_FINDING_AUTHORITY.source}\\s+as\\s+(?:the\\s+)?(?:governing\\s+reference|source\\s+of\\s+truth)\\s+for\\s+this\\s+story|read\\s+(?:the\\s+)?${DYNAMIC_FINDING_AUTHORITY.source}\\s+before\\s+(?:implementing|reviewing)\\s+this\\s+story|this\\s+story\\s+depends\\s+on\\s+(?:the\\s+)?${DYNAMIC_FINDING_AUTHORITY.source}\\s+and\\s+does\\s+not\\s+amend\\s+it)$`,
    'u',
  );
  if (referenceOnly.test(segment)) return false;

  for (const authorityRange of matchRanges(segment, DYNAMIC_FINDING_AUTHORITY)) {
    // Authority-bearing Task Context is fail-closed. A finite list of amendment
    // verbs is not a safe boundary: synonyms and reversed word order otherwise
    // become accidental authority. Admit only three complete positive grammars:
    // a structurally bounded whole-source invariant, an explicit prohibition,
    // or an explicit Agent-side subordination relation.
    if (wholeSourceIsInvariantAssertion) continue;

    const beforeAuthority = segment.slice(0, authorityRange.start).trim();
    const afterAuthority = segment.slice(authorityRange.end).trim();

    const directInvariant = /^(?:the)?$/u.test(beforeAuthority)
      && /^(?:contract\s+)?(?:remains?|stays?|is|are|must\s+remain)\s+(?:completely\s+)?(?:unchanged|unaltered|unmodified|identical)(?:\s+by\s+(?:the\s+)?(?:metadata|prompt|implementation|code)(?:\s+only)?\s+(?:registration|change|update))?$/u.test(afterAuthority);
    if (directInvariant) continue;

    const subordinateBefore = /^(?:this\s+proposal\s+and\s+story|this\s+(?:proposal|story)|the\s+(?:prompt|guidance))\s+(?:is|are|remains?|must\s+remain)\s+subordinate(?:\s+agent\s+side)?(?:\s+projections?)?\s+(?:of|to)(?:\s+the)?$/u.test(beforeAuthority)
      || /^(?:use\s+red\s+then\s+green\s+)?add\s+(?:adversarial\s+)?tests\s+covering\s+.+\s+and\s+the\s+subordinate(?:\s+agent\s+side)?\s+projections?\s+of(?:\s+the)?$/u.test(beforeAuthority);
    const subordinateAfter = /^(?:document)?(?:\s+and\s+they\s+do\s+not\s+amend\s+that\s+authority)?$/u.test(afterAuthority);
    if (subordinateBefore && subordinateAfter) continue;

    const lastConjunction = beforeAuthority.lastIndexOf(' and ');
    const prohibitionLead = (lastConjunction >= 0
      ? beforeAuthority.slice(lastConjunction + ' and '.length)
      : beforeAuthority).trim();
    const precedingLead = lastConjunction >= 0
      ? beforeAuthority.slice(0, lastConjunction).trim()
      : '';
    const prohibitedAuthorityAction = '(?:amend|change|modify|rewrite|override|replace|extend|update)';
    const imperativeProhibition = new RegExp(`^do\\s+not\\s+${prohibitedAuthorityAction}(?:\\s+(?!(?:and|but|while|although|however|yet|then|therefore|so)\\b)[a-z0-9]+){0,28}$`, 'u').test(prohibitionLead);
    const subjectProhibition = new RegExp(`^(?:(?:this|the|current|proposed)\\s+(?:story|proposal|change|update|implementation|prompt|guidance|contract)|(?:story|proposal|prompt|guidance))\\s+(?:does|must|may|should|can|could|will|would)\\s+not\\s+${prohibitedAuthorityAction}(?:\\s+(?!(?:and|but|while|although|however|yet|then|therefore|so)\\b)[a-z0-9]+){0,28}$`, 'u').test(prohibitionLead);
    const boundedNegativePrefix = precedingLead.length === 0
      || /^(?:it\s+is\s+never|retired\s+verdict\s+vocabulary\s+is\s+never)\s+(?:retained|used|accepted)\s+as\s+an\s+active\s+alias$/u.test(precedingLead);
    const boundedProhibitionObject = /^(?:document(?:\s+in\s+this\s+story)?|or\s+(?:its\s+runtime|lifecycle\s+gate\s+predicates))?$/u.test(afterAuthority);
    if ((imperativeProhibition || subjectProhibition) && boundedNegativePrefix && boundedProhibitionObject) continue;

    return true;
  }
  return false;
}

function reviewTriageAuthorityViolation(source: ReviewerTaskContextAuthoritySource): ReviewTriageAuthorityViolation | null {
  if (isPureInterrogative(source.text)
    || isExplicitFailClosedQuotedFixture(source.text)
    || isExplicitRejectedAuthorityStatement(source.text)
    || isNegativeMutationVerificationIntent(source)) return null;
  const wholeSourceIsInvariantAssertion = isWholeSourceDynamicFindingInvariantAssertion(source.text);
  const segments = triageAuthoritySegments(source.text);
  const controlledViolation = controlledTriageViolation(
    classifyControlledTriageRelations(source.text, segments),
  );
  if (controlledViolation) return controlledViolation;
  for (const segment of segments) {
    if (hasDynamicFindingAuthorityAmendmentAssertion(segment, wholeSourceIsInvariantAssertion)) {
      return 'Dynamic Finding authority amendment asserted from Task Context';
    }
    if (RETIRED_APPLICABILITY_ALIAS.test(segment)) {
      const verdictAuthority = /\b(?:(?:current|official)\s+(?:applicability\s+)?verdict|applicability\s+verdict)\b/u;
      const assertsCurrentVerdict = hasAffirmativeConceptRelation(
        segment,
        RETIRED_APPLICABILITY_ALIAS,
        verdictAuthority,
        /\b(?:use|treat|accept|is|become|mean|count|classify|set|emit|serve)\w*\b/u,
      );
      const explicitlyRejected = /^(?:never|reject|do\s+not|must\s+not|cannot|forbid|prohibit|disallow)\b/u.test(segment)
        || /\bnot\b[^.;]{0,48}\b(?:current|official|applicability)\s+(?:applicability\s+)?verdict\b/u.test(segment);
      if (assertsCurrentVerdict || !explicitlyRejected) {
        return 'retired applicability verdict used as authority';
      }
    }

    if (isCanonicalTriageInventorySegment(segment)
      || isApprovedFutureDeferralBoundary(segment)
      || isApprovedNegativeCapabilityInventory(segment)
      || isApprovedFailClosedOrEvidenceRouteFragment(segment)
      || isApprovedOwnerDispositionInvariant(segment)
      || isApprovedIndependentAxesInvariant(segment)) continue;

    const deferral = /\b(?:defer\s+with\s+proof|finding\s+deferral\s+disposition|deferral(?!\s+lineage))\b/u;
    const collapsedOutcome = /\b(?:applicability\s+verdict|non\s+applicability\s+verdict|out\s+of\s+scope|nonownership\s+by\s+(?:(?:this|the|current)\s+)?story|resolved|resolution|repaired|repair|dismissed|finding\s+dismiss|disproven|duplicate|pre\s+existing\s+unaffected)\b/u;
    if (hasConceptPair(segment, deferral, collapsedOutcome)
      && !controlledConceptPairIsExplicitlyNegative(segment, deferral, collapsedOutcome)) {
      return 'disposition collapsed into applicability';
    }

    const unauthorizedActor = /\b(?:reviewers?|review\s+lanes?|agents?|story\s+owners?)\b/u;
    const signedDispositionInspection = isBoundedSignedDispositionInspection(segment);
    if (!signedDispositionInspection
      && hasConceptPair(segment, unauthorizedActor, deferral)
      && !isExplicitlyProhibitedDispositionAuthority(segment)) {
      return 'unauthorized disposition minting';
    }
    const compatibilityAuthority = /\b(?:current\s+cli|compatibility\s+cli|compatibility\s+path)\b/u;
    if (hasConceptPair(segment, compatibilityAuthority, deferral)
      && !controlledConceptPairIsExplicitlyNegative(segment, compatibilityAuthority, deferral)) {
      return 'unauthorized disposition minting';
    }

    const schemaOrGate = /\b(?:finding\s+schemas?|applicability\s+fields?|severity\s+fields?|(?:review|test|done|lifecycle)\s+gate(?:\s+predicates?)?|blocking\s+predicates?|process\s+facts?)\b/u;
    const storyAuthoredChange = /(?:^(?:this|the)\s+(?:story|prompt|guidance|change|update|implementation)\b|\bby\s+(?:this|the)\s+(?:story|prompt|guidance|change|update|implementation)\b)/u;
    const schemaInvariant = wholeSourceIsInvariantAssertion
      || /^(?:the\s+)?(?:finding\s+schemas?|(?:review|test|done|lifecycle)\s+gate(?:\s+predicates?)?)\s+(?:remains?|stays?|is|are|must\s+remain)\s+(?:unchanged|unaltered|unmodified|identical)$/u.test(segment)
      || /^do\s+not\s+(?:amend|change|modify|rewrite|override|replace|extend|update)\s+.+$/u.test(segment)
      || /^no\s+.+\s+is\s+in\s+scope$/u.test(segment)
      || /^assert\s+(?:the\s+)?change\s+introduces\s+no\s+.+$/u.test(segment);
    if (hasConceptPair(segment, schemaOrGate, storyAuthoredChange)
      && !schemaInvariant
      && !controlledConceptPairIsExplicitlyNegative(segment, schemaOrGate, storyAuthoredChange)) {
      return 'Dynamic Finding authority amendment asserted from Task Context';
    }

  }
  return null;
}

function reviewerTaskContextAuthorityText(taskContext: FullTaskContext): ReviewerTaskContextAuthoritySource[] {
  const values: ReviewerTaskContextAuthoritySource[] = [
    { location: 'story.title', kind: 'story', text: taskContext.title },
    { location: 'story.description', kind: 'story', text: taskContext.description },
  ];
  for (const item of taskContext.checklist) {
    values.push({ location: `checklist.${item.id}.title`, kind: 'checklist', text: item.title });
    if (item.context !== undefined) values.push({ location: `checklist.${item.id}.context`, kind: 'checklist', text: item.context });
    if (item.userSees !== undefined) values.push({ location: `checklist.${item.id}.userSees`, kind: 'checklist', text: item.userSees });
    for (const lane of ['happy', 'edge', 'adversarial'] as const) {
      for (const intent of item.verificationIntent[lane]) {
        values.push({ location: `verificationIntent.${intent.id}.desc`, kind: 'verificationIntent', text: intent.desc });
      }
    }
  }
  return values;
}

/**
 * REVIEW role authority is package-owned. Story-authored Task Context may
 * describe work, tests, and explicit rejection, but it cannot publish a
 * Dynamic Finding authority amendment or retain retired verdict vocabulary as
 * migration authority. Historical Finding/evidence reads remain outside the
 * active FullTaskContext authority surface. The bounded semantic check relates
 * normalized concepts and assertion polarity, rather than denying an exact
 * sentence. It runs before envelope digests are minted, so recomputing every
 * content address cannot bless an authority injection.
 */
function assertReviewerTaskContextAuthoritySafety(
  roleId: string,
  taskContext: FullTaskContext,
): void {
  if (!isModularReviewerRoleId(roleId)) return;
  for (const source of reviewerTaskContextAuthorityText(taskContext)) {
    const violation = reviewTriageAuthorityViolation(source);
    if (violation) {
      throw new Error(
        `REVIEW Task Context contains unsafe Finding-triage authority at ${source.location}: ${violation}`,
      );
    }
  }
}

function canonicalStrings(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? []).map(value => value.trim()).filter(Boolean))].sort();
}

export function buildFullTaskContext(args: {
  story: StoryInfo;
  checklist: ChecklistData;
  headHash: string;
  materialHash?: string;
  storyFilesHash?: string;
  scopeContract?: ScopeContractData | null;
}): FullTaskContext {
  const context: FullTaskContext = {
    schemaVersion: FULL_TASK_CONTEXT_SCHEMA,
    storyId: args.story.storyId,
    title: args.story.title,
    description: args.story.description,
    phase: args.story.phase,
    priority: args.story.priority,
    checklist: [...args.checklist.items]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map(item => ({
        id: item.id,
        title: item.title,
        status: item.status,
        ...(item.context?.trim() ? { context: item.context } : {}),
        ...(item.userSees?.trim() ? { userSees: item.userSees } : {}),
        relatedDocs: canonicalStrings(item.relatedDocs),
        files: {
          modify: canonicalStrings(item.files?.modify),
          create: canonicalStrings(item.files?.create),
          test: canonicalStrings(item.files?.test),
        },
        verificationIntent: Object.fromEntries(
          (['happy', 'edge', 'adversarial'] as const).map(lane => [
            lane,
            (item.verificationIntent?.[lane] ?? []).map((intent, index) => ({
              id: intent.id?.trim() || `${item.id}:${lane}:${index}`,
              desc: intent.desc,
              type: intent.type,
              ...(intent.requiredIn ? { requiredIn: intent.requiredIn } : {}),
              ...(intent.priority ? { priority: intent.priority } : {}),
            })),
          ]),
        ) as FullTaskContext['checklist'][number]['verificationIntent'],
      })),
    headHash: args.headHash,
    ...(args.materialHash ? { materialHash: args.materialHash } : {}),
    ...(args.storyFilesHash ? { storyFilesHash: args.storyFilesHash } : {}),
    ...(args.scopeContract ? {
      scopeContractDigest: digestScopeContract(args.scopeContract),
      scope: projectScopeInventory(args.scopeContract),
    } : {}),
  };
  validateFullTaskContext(context);
  return context;
}

export function fullTaskSemanticDigest(context: FullTaskContext): string {
  const {
    headHash: _headHash,
    materialHash: _materialHash,
    storyFilesHash: _storyFilesHash,
    phase: _phase,
    ...modelRelevant
  } = context;
  // Review evidence is produced in REVIEW and consumed again after the
  // mandatory REVIEW -> TEST transition. Only TEST is mapped back to that
  // producer phase: DEV, DONE, DISCARDED, and malformed phases must remain
  // distinct so evidence from an inadmissible lifecycle state fails closed.
  const semanticPhase = context.phase === 'TEST' ? 'REVIEW' : context.phase;
  return domainSeparatedDigest('full-task-context.model-relevant.v1', {
    ...modelRelevant,
    phase: semanticPhase,
  });
}

export function captureKnownExecutionEnvironment(): KnownExecutionEnvironment {
  const value: KnownExecutionEnvironment = {
    schemaVersion: KNOWN_EXECUTION_ENVIRONMENT_SCHEMA,
    nodeVersion: process.version,
    platform: process.platform,
    architecture: process.arch,
    cliVersion: PROOF_OR_STOP_CLI_VERSION,
    source: 'trusted-local-runtime',
  };
  validateKnownExecutionEnvironment(value);
  return Object.freeze(value);
}

export function promptEnvelopeSemanticValue(envelope: PromptEnvelope): Record<string, unknown> {
  const { envelopeId: _envelopeId, createdAt: _createdAt, ...semantic } = envelope;
  return semantic;
}

export function computePromptEnvelopeId(envelope: PromptEnvelope): string {
  return domainSeparatedDigest('prompt-envelope.semantic.v1', promptEnvelopeSemanticValue(envelope));
}

export function verifyPromptEnvelopeIntegrity(envelope: PromptEnvelope): boolean {
  try {
    validatePromptEnvelope(envelope);
    return envelope.envelopeId === computePromptEnvelopeId(envelope);
  } catch {
    return false;
  }
}

export function assembleFullPromptEnvelope(input: FullPromptAssemblyInput): FullPromptAssembly {
  validateFullTaskContext(input.taskContext);
  assertReviewerTaskContextAuthoritySafety(input.roleContract.roleId, input.taskContext);
  const environment = input.knownExecutionEnvironment ?? captureKnownExecutionEnvironment();
  validateKnownExecutionEnvironment(environment);
  if (input.roleContract.status !== 'active') {
    throw new Error(`full Prompt Envelope requires an active role; ${input.roleContract.roleId} is ${input.roleContract.status}`);
  }
  assertContractRenderCoherence(input.runtimeContract, input.roleContract, input.rolePrompt);
  const canonicalLane = input.lane === undefined ? undefined : canonicalAgentRoleId(input.lane);
  if (input.dispatchKind === 'review-run') {
    for (const [key, value] of Object.entries({
      reviewRunId: input.reviewRunId,
      reviewRound: input.reviewRound,
      lane: canonicalLane,
    })) {
      if (typeof value !== 'string' || value.trim().length === 0) {
        throw new Error(`review-run Prompt Envelope requires ${key}`);
      }
    }
    if (input.roleContract.roleId !== canonicalLane) {
      throw new Error(
        `review-run Prompt Envelope role/lane mismatch: ${input.roleContract.roleId} !== ${canonicalLane}`,
      );
    }
    if (typeof input.dispatchPrompt !== 'string' || input.dispatchPrompt.length === 0) {
      throw new Error('review-run Prompt Envelope requires the exact story-dispatch prompt bytes');
    }
    if (!/^[a-f0-9]{64}$/.test(input.hostRenderIdentityDigest ?? '')) {
      throw new Error('review-run Prompt Envelope requires a hostRenderIdentityDigest');
    }
  } else if (input.reviewRunId !== undefined || input.reviewRound !== undefined || input.lane !== undefined) {
    throw new Error('story-dispatch Prompt Envelope cannot carry reviewer authority');
  }

  const prompt = renderFullPrompt(
    input.runtimeContract,
    input.roleContract,
    input.taskContext,
    environment,
    input.rolePrompt,
    input.dispatchPrompt,
  );
  const envelopeWithoutId: Omit<PromptEnvelope, 'envelopeId'> = {
    schemaVersion: PROMPT_ENVELOPE_SCHEMA,
    roleId: input.roleContract.roleId,
    storyId: input.taskContext.storyId,
    dispatchKind: input.dispatchKind,
    ...(input.reviewRunId ? { reviewRunId: input.reviewRunId } : {}),
    ...(input.reviewRound ? { reviewRound: input.reviewRound } : {}),
    ...(canonicalLane ? { lane: canonicalLane } : {}),
    ...(input.dispatchPrompt ? { dispatchPromptDigest: reviewerDispatchPromptDigest(input.dispatchPrompt) } : {}),
    ...(input.hostRenderIdentityDigest ? { hostRenderIdentityDigest: input.hostRenderIdentityDigest } : {}),
    createdAt: input.createdAt,
    headHash: input.taskContext.headHash,
    runtimeContractVersion: input.runtimeContract.schemaVersion,
    runtimeSemanticDigest: input.runtimeContract.semanticDigest,
    runtimeRenderDigest: input.runtimeContract.renderDigest,
    roleContractVersion: input.roleContract.schemaVersion,
    roleSemanticDigest: input.roleContract.semanticDigest,
    roleRenderDigest: input.roleContract.renderDigest,
    contextMode: 'full',
    contextDigest: domainSeparatedDigest('full-task-context.v1', input.taskContext),
    ...(input.taskContext.materialHash ? { materialHash: input.taskContext.materialHash } : {}),
    ...(input.taskContext.storyFilesHash ? { storyFilesHash: input.taskContext.storyFilesHash } : {}),
    ...(input.taskContext.scopeContractDigest ? { policyHash: input.taskContext.scopeContractDigest } : {}),
    eligibilityDecision: 'full',
    eligibilityDigest: domainSeparatedDigest('prompt-full-eligibility.v1', {
      roleId: input.roleContract.roleId,
      roleStatus: input.roleContract.status,
      dispatchKind: input.dispatchKind,
      contextMode: 'full',
    }),
    knownExecutionEnvironmentDigest: domainSeparatedDigest('known-execution-environment.v1', environment),
    assemblerVersion: PROMPT_ENVELOPE_ASSEMBLER_VERSION,
    dispatchProtocolVersion: PROMPT_DISPATCH_PROTOCOL_VERSION,
    launcherSpecDigest: domainSeparatedDigest('prompt-launcher-spec.v1', input.launcherSpec ?? { kind: input.dispatchKind }),
    ...(input.reviewerDispatchBindingDigest !== undefined ? { reviewerDispatchBindingDigest: input.reviewerDispatchBindingDigest } : {}),
    commandPolicyDigest: domainSeparatedDigest('prompt-command-policy.v1', input.commandPolicy ?? input.roleContract.allowedCommandIds),
    ...(input.toolPolicy !== undefined ? { toolPolicyDigest: domainSeparatedDigest('prompt-tool-policy.v1', input.toolPolicy) } : {}),
    ...(input.systemInstruction !== undefined ? { systemInstructionDigest: domainSeparatedDigest('prompt-system-instruction.v1', input.systemInstruction) } : {}),
    assembledPromptDigest: domainSeparatedDigest('assembled-prompt.raw-utf8.v1', prompt),
    bytes: promptUtf8Bytes(prompt),
    lines: promptLogicalLines(prompt),
    estimatedTokens: estimatePromptTokens(prompt),
    tokenEstimatorVersion: PROMPT_CONTRACT_ALGORITHMS.tokenEstimator,
  };
  const provisional = { ...envelopeWithoutId, envelopeId: '0'.repeat(64) } as PromptEnvelope;
  const envelope = { ...envelopeWithoutId, envelopeId: computePromptEnvelopeId(provisional) } as PromptEnvelope;
  validatePromptEnvelope(envelope);
  if (!verifyPromptEnvelopeIntegrity(envelope)) throw new Error('assembled Prompt Envelope failed integrity verification');
  return { prompt, taskContext: input.taskContext, knownExecutionEnvironment: environment, envelope };
}

/**
 * Safety is resolved before cost. A required full prompt remains full even when
 * over budget; cost can only select full from an already-safe incremental path.
 */
export function assembleConditionalReviewPromptEnvelope(
  input: ConditionalReviewAssemblyInput,
): ConditionalReviewAssembly {
  if (input.dispatchKind !== 'review-run') {
    throw new Error('conditional review assembly is available only for review-run dispatch');
  }
  const full = assembleFullPromptEnvelope(input);
  const fullBudgetBytes = Number.isSafeInteger(input.fullBudgetBytes) && input.fullBudgetBytes! >= 0
    ? input.fullBudgetBytes!
    : 256_000;
  const incrementalBudgetBytes = Number.isSafeInteger(input.incrementalBudgetBytes) && input.incrementalBudgetBytes! >= 0
    ? input.incrementalBudgetBytes!
    : 64_000;
  const fullBudgetViolation = full.envelope.bytes > fullBudgetBytes;
  const basis = input.reviewBasis
    ? { ...input.reviewBasis, lane: canonicalAgentRoleId(input.reviewBasis.lane) }
    : null;
  if (basis && basis.lane !== full.envelope.lane) {
    throw new Error(`conditional review Prompt Envelope role/lane mismatch: ${full.envelope.lane} !== ${basis.lane}`);
  }
  const safetyRequiresFull = !input.incrementalEligible || !basis;
  let incrementalPrompt: string | undefined;
  if (basis) {
    validateIncrementalReviewBasis(basis);
    incrementalPrompt = renderIncrementalPrompt(
      input.runtimeContract,
      input.roleContract,
      basis,
      full.knownExecutionEnvironment,
      input.rolePrompt,
      input.dispatchPrompt!,
    );
  }
  const incrementalBytes = incrementalPrompt ? promptUtf8Bytes(incrementalPrompt) : undefined;
  let selectionReason: NonNullable<PromptEnvelope['selectionReason']>;
  if (input.reviewerEscalationReason?.trim()) {
    selectionReason = 'REVIEWER_REQUESTED_FULL';
  } else if (safetyRequiresFull) {
    selectionReason = 'SAFETY_REQUIRES_FULL';
  } else if (incrementalBytes! > incrementalBudgetBytes) {
    selectionReason = 'INCREMENTAL_BUDGET_EXCEEDED';
  } else if (incrementalBytes! >= full.envelope.bytes) {
    selectionReason = 'FULL_CHEAPER_OR_EQUAL';
  } else {
    selectionReason = 'SAFE_INCREMENTAL';
  }
  const contextMode = selectionReason === 'SAFE_INCREMENTAL' ? 'incremental' as const : 'full' as const;
  const prompt = contextMode === 'incremental' ? incrementalPrompt! : full.prompt;
  const envelopeBase: PromptEnvelope = {
    ...full.envelope,
    contextMode,
    eligibilityDecision: contextMode,
    contextDigest: contextMode === 'incremental'
      ? domainSeparatedDigest('incremental-review-basis.v1', basis!)
      : full.envelope.contextDigest,
    ...(input.priorPassRef ? { priorPassRef: input.priorPassRef } : {}),
    eligibilityDigest: input.eligibilityDigest,
    freshnessClassification: input.freshnessClassification,
    impactPolicyVersion: input.impactPolicyVersion,
    eligibilityReasonCodes: [...new Set(input.eligibilityReasonCodes)].sort(),
    changedFilesDigest: input.changedFilesDigest,
    impactedFilesDigest: input.impactedFilesDigest,
    taskSemanticDigest: fullTaskSemanticDigest(input.taskContext),
    findingProjection: input.findingProjection ?? [],
    findingProjectionDigest: domainSeparatedDigest('prompt-finding-projection.v1', input.findingProjection ?? []),
    ...(basis ? {
      reviewBasisDigest: domainSeparatedDigest('incremental-review-basis.v1', basis),
      incrementalContextDigest: domainSeparatedDigest('incremental-review-context.raw-utf8.v1', incrementalPrompt!),
    } : {}),
    selectionReason,
    fullContextBytes: full.envelope.bytes,
    ...(incrementalBytes !== undefined ? { incrementalContextBytes: incrementalBytes } : {}),
    escalatedToFull: contextMode === 'full' && Boolean(basis),
    ...(selectionReason === 'REVIEWER_REQUESTED_FULL'
      ? { escalationReason: input.reviewerEscalationReason!.trim() }
      : selectionReason !== 'SAFE_INCREMENTAL' && basis
        ? { escalationReason: selectionReason }
        : {}),
    ...((contextMode === 'full' && fullBudgetViolation)
      ? { budgetViolation: 'full' as const }
      : (selectionReason === 'INCREMENTAL_BUDGET_EXCEEDED')
        ? { budgetViolation: 'incremental' as const }
        : {}),
    assembledPromptDigest: domainSeparatedDigest('assembled-prompt.raw-utf8.v1', prompt),
    bytes: promptUtf8Bytes(prompt),
    lines: promptLogicalLines(prompt),
    estimatedTokens: estimatePromptTokens(prompt),
  };
  const provisional = { ...envelopeBase, envelopeId: '0'.repeat(64) };
  const envelope = { ...envelopeBase, envelopeId: computePromptEnvelopeId(provisional) };
  validatePromptEnvelope(envelope);
  if (!verifyPromptEnvelopeIntegrity(envelope)) throw new Error('conditional Prompt Envelope failed integrity verification');
  return {
    prompt,
    taskContext: full.taskContext,
    knownExecutionEnvironment: full.knownExecutionEnvironment,
    envelope,
    selectionReason,
    fullPrompt: full.prompt,
    ...(incrementalPrompt ? { incrementalPrompt } : {}),
  };
}

/**
 * Reconstructs the exact trusted assembly from canonical inputs and rejects any
 * mismatch between the persisted bytes and the gate-consumed envelope.
 */
export function verifyFullPromptAssemblyIntegrity(input: {
  prompt: string;
  envelope: PromptEnvelope;
  runtimeContract: RuntimeContract;
  roleContract: RoleContract;
  rolePrompt: string;
  dispatchPrompt?: string;
  reviewerDispatchBindingDigest?: string;
  hostRenderIdentityDigest?: string;
}): boolean {
  try {
    assertContractRenderCoherence(input.runtimeContract, input.roleContract, input.rolePrompt);
    validatePromptEnvelope(input.envelope);
    const taskMarker = '\n\n## Task Context\n\n';
    const environmentMarker = '\n\n## Known Execution Environment\n\n';
    const dispatchPromptMarker = '\n\n## Dispatch Prompt\n\n';
    const rolePromptMarker = '\n\n## Role Prompt\n\n';
    const taskStart = input.prompt.indexOf(taskMarker);
    const environmentStart = input.prompt.indexOf(environmentMarker, taskStart + taskMarker.length);
    const dispatchPromptStart = input.prompt.indexOf(
      dispatchPromptMarker,
      environmentStart + environmentMarker.length,
    );
    const rolePromptStart = input.prompt.indexOf(rolePromptMarker, environmentStart + environmentMarker.length);
    if (taskStart < 0 || environmentStart < 0 || rolePromptStart < 0) return false;
    const taskJson = input.prompt.slice(taskStart + taskMarker.length, environmentStart);
    const environmentEnd = dispatchPromptStart >= 0 ? dispatchPromptStart : rolePromptStart;
    const environmentJson = input.prompt.slice(environmentStart + environmentMarker.length, environmentEnd);
    const embeddedDispatchPrompt = dispatchPromptStart >= 0
      ? input.prompt.slice(dispatchPromptStart + dispatchPromptMarker.length, rolePromptStart)
      : undefined;
    if (embeddedDispatchPrompt !== input.dispatchPrompt) return false;
    const taskContext = JSON.parse(taskJson) as FullTaskContext;
    const environment = JSON.parse(environmentJson) as KnownExecutionEnvironment;
    validateFullTaskContext(taskContext);
    validateKnownExecutionEnvironment(environment);
    if (canonicalJsonStringify(taskContext) !== taskJson) return false;
    if (canonicalJsonStringify(environment) !== environmentJson) return false;
    const expectedPrompt = renderFullPrompt(
      input.runtimeContract,
      input.roleContract,
      taskContext,
      environment,
      input.rolePrompt,
      input.dispatchPrompt,
    );
    if (input.prompt !== expectedPrompt) return false;
    const envelope = input.envelope;
    return envelope.assemblerVersion === PROMPT_ENVELOPE_ASSEMBLER_VERSION
      && envelope.dispatchProtocolVersion === PROMPT_DISPATCH_PROTOCOL_VERSION
      && envelope.roleId === input.roleContract.roleId
      && envelope.runtimeContractVersion === input.runtimeContract.schemaVersion
      && envelope.runtimeSemanticDigest === input.runtimeContract.semanticDigest
      && envelope.runtimeRenderDigest === input.runtimeContract.renderDigest
      && envelope.roleContractVersion === input.roleContract.schemaVersion
      && envelope.reviewerDispatchBindingDigest === input.reviewerDispatchBindingDigest
      && envelope.roleSemanticDigest === input.roleContract.semanticDigest
      && envelope.roleRenderDigest === input.roleContract.renderDigest
      && envelope.dispatchPromptDigest === (
        input.dispatchPrompt === undefined ? undefined : reviewerDispatchPromptDigest(input.dispatchPrompt)
      )
      && envelope.hostRenderIdentityDigest === input.hostRenderIdentityDigest
      && envelope.storyId === taskContext.storyId
      && envelope.headHash === taskContext.headHash
      && envelope.materialHash === taskContext.materialHash
      && envelope.storyFilesHash === taskContext.storyFilesHash
      && envelope.policyHash === taskContext.scopeContractDigest
      && envelope.contextDigest === domainSeparatedDigest('full-task-context.v1', taskContext)
      && envelope.knownExecutionEnvironmentDigest === domainSeparatedDigest('known-execution-environment.v1', environment)
      && envelope.assembledPromptDigest === domainSeparatedDigest('assembled-prompt.raw-utf8.v1', input.prompt)
      && envelope.bytes === promptUtf8Bytes(input.prompt)
      && envelope.lines === promptLogicalLines(input.prompt)
      && envelope.estimatedTokens === estimatePromptTokens(input.prompt);
  } catch {
    return false;
  }
}

export function verifyIncrementalPromptAssemblyIntegrity(input: {
  prompt: string;
  envelope: PromptEnvelope;
  runtimeContract: RuntimeContract;
  roleContract: RoleContract;
  rolePrompt: string;
  dispatchPrompt: string;
  reviewerDispatchBindingDigest?: string;
  hostRenderIdentityDigest: string;
}): boolean {
  try {
    assertContractRenderCoherence(input.runtimeContract, input.roleContract, input.rolePrompt);
    validatePromptEnvelope(input.envelope);
    if (input.envelope.contextMode !== 'incremental') return false;
    const basisMarker = '\n\n## Incremental Review Basis\n\n';
    const environmentMarker = '\n\n## Known Execution Environment\n\n';
    const dispatchPromptMarker = '\n\n## Dispatch Prompt\n\n';
    const rolePromptMarker = '\n\n## Role Prompt\n\n';
    const basisStart = input.prompt.indexOf(basisMarker);
    const environmentStart = input.prompt.indexOf(environmentMarker, basisStart + basisMarker.length);
    const dispatchStart = input.prompt.indexOf(dispatchPromptMarker, environmentStart + environmentMarker.length);
    const roleStart = input.prompt.indexOf(rolePromptMarker, dispatchStart + dispatchPromptMarker.length);
    if (basisStart < 0 || environmentStart < 0 || dispatchStart < 0 || roleStart < 0) return false;
    const basisJson = input.prompt.slice(basisStart + basisMarker.length, environmentStart);
    const environmentJson = input.prompt.slice(environmentStart + environmentMarker.length, dispatchStart);
    const embeddedDispatchPrompt = input.prompt.slice(dispatchStart + dispatchPromptMarker.length, roleStart);
    const basis = JSON.parse(basisJson) as IncrementalReviewBasis;
    const environment = JSON.parse(environmentJson) as KnownExecutionEnvironment;
    validateIncrementalReviewBasis(basis);
    validateKnownExecutionEnvironment(environment);
    if (canonicalJsonStringify(basis) !== basisJson || canonicalJsonStringify(environment) !== environmentJson) return false;
    if (embeddedDispatchPrompt !== input.dispatchPrompt) return false;
    const expected = renderIncrementalPrompt(
      input.runtimeContract,
      input.roleContract,
      basis,
      environment,
      input.rolePrompt,
      input.dispatchPrompt,
    );
    const envelope = input.envelope;
    return input.prompt === expected
      && envelope.roleId === input.roleContract.roleId
      && envelope.runtimeContractVersion === input.runtimeContract.schemaVersion
      && envelope.runtimeSemanticDigest === input.runtimeContract.semanticDigest
      && envelope.runtimeRenderDigest === input.runtimeContract.renderDigest
      && envelope.roleContractVersion === input.roleContract.schemaVersion
      && envelope.reviewerDispatchBindingDigest === input.reviewerDispatchBindingDigest
      && envelope.roleSemanticDigest === input.roleContract.semanticDigest
      && envelope.roleRenderDigest === input.roleContract.renderDigest
      && envelope.dispatchPromptDigest === reviewerDispatchPromptDigest(input.dispatchPrompt)
      && envelope.hostRenderIdentityDigest === input.hostRenderIdentityDigest
      && envelope.storyId === basis.storyId
      && envelope.lane === basis.lane
      && envelope.priorPassRef === basis.priorPassRef
      && envelope.contextDigest === domainSeparatedDigest('incremental-review-basis.v1', basis)
      && envelope.reviewBasisDigest === domainSeparatedDigest('incremental-review-basis.v1', basis)
      && envelope.incrementalContextDigest === domainSeparatedDigest('incremental-review-context.raw-utf8.v1', input.prompt)
      && envelope.knownExecutionEnvironmentDigest === domainSeparatedDigest('known-execution-environment.v1', environment)
      && envelope.assembledPromptDigest === domainSeparatedDigest('assembled-prompt.raw-utf8.v1', input.prompt)
      && envelope.bytes === promptUtf8Bytes(input.prompt)
      && envelope.lines === promptLogicalLines(input.prompt)
      && envelope.estimatedTokens === estimatePromptTokens(input.prompt)
      && verifyPromptEnvelopeIntegrity(envelope);
  } catch {
    return false;
  }
}

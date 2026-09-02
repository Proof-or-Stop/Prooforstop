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
  type FullTaskContext,
  type IncrementalReviewBasis,
  type KnownExecutionEnvironment,
  type PromptEnvelope,
  type RoleContract,
  type RuntimeContract,
} from './prompt-contracts.js';
import { PROOF_OR_STOP_CLI_VERSION } from './proof-or-stop-brand.js';
import type { ChecklistData, ScopeContractData, StoryInfo } from './types.js';
import { digestScopeContract } from './guard-session.js';
import { isModularReviewerRoleId } from './prompt-registry.js';

export const PROMPT_ENVELOPE_ASSEMBLER_VERSION = 'proofbound.full-context-assembler.v1';
export const PROMPT_DISPATCH_PROTOCOL_VERSION = 'proofbound.prompt-dispatch.v1';

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

function hasDismissalApplicabilityAssertion(text: string): boolean {
  const dismissal = /\b(?:finding\s+dismiss|dismissal|dismissed|(?:closed|dismissed|archived)\s+finding|finding\s+(?:is|was|becomes?|counts?\s+as)\s+(?:closed|dismissed|archived)|archiv(?:e|es|ed|ing)(?:\s+the)?\s+finding|closing|close\s+the\s+finding)\b/u;
  const applicabilityOutcome = /\b(?:out\s+of\s+scope|outside\s+(?:(?:this|the|current)\s+)?story\s+boundary|non\s+applicable|nonapplicable|applicability|deferral|repair|resolution|resolved)\b/u;
  return hasAffirmativeConceptRelation(
    text,
    dismissal,
    applicabilityOutcome,
    /\b(?:(?:prove|establish|confirm|demonstrate|mean|make|classify|set|count|show|constitute|suffice|follow|result|render)\w*|be|is)\b/u,
    220,
  );
}

function hasUnknownApplicabilityRoutingAssertion(text: string): boolean {
  const unknownApplicability = /\b(?:(?:unknown|uncertain|undetermined|pending|unassessed|unevaluated|unresolved)\s+applicability|applicability\s+(?:is|remains|stays)?\s*(?:unknown|uncertain|undetermined|pending|unassessed|unevaluated|unresolved)|applicability\s+(?:is|remains|stays|has)?\s*(?:not\s+yet|not\s+been)\s+(?:known|determined|assessed|evaluated))\b/u;
  const routingOrGateRelief = /\b(?:routing|route|routes|routed|defer|deferral|defer\s+with\s+proof|non\s+blocking|advisory|away\s+from\s+(?:this|the|current|the\s+current)\s+story|leave(?:s|ing)?\s+(?:(?:this|the|current|the\s+current)\s+)?story|clear(?:s|ed)?\s+(?:the\s+)?(?:review\s+)?blocker|remove(?:s|d)?\s+(?:the\s+)?(?:review\s+)?blocker|unblock(?:s|ed)?)\b/u;
  return hasAffirmativeConceptRelation(
    text,
    unknownApplicability,
    routingOrGateRelief,
    /\b(?:permit|allow|authorize|approve|enable|route|defer|leave|make|become|is|remove|clear|lift|bypass|waive|turn)\w*\b/u,
    220,
  );
}

function hasUnauthorizedDispositionCapability(
  segment: string,
  actor: RegExp,
  action: RegExp,
  disposition: RegExp,
): boolean {
  const dispositionRanges = matchRanges(segment, disposition);
  for (const actorRange of matchRanges(segment, actor)) {
    for (const actionRange of matchRanges(segment, action)) {
      const actorActionDistance = Math.max(0, Math.max(actorRange.start, actionRange.start) - Math.min(actorRange.end, actionRange.end));
      if (actorActionDistance > 72) continue;
      const targetRange = dispositionRanges.find(range => Math.abs(range.start - actionRange.start) <= 180);
      if (!targetRange) continue;
      if (relationIsNegated(segment, actionRange, actorRange, targetRange)) continue;
      const actorActionBridge = segment.slice(
        Math.min(actorRange.end, actionRange.end),
        Math.max(actorRange.start, actionRange.start),
      );
      if (/\b(?:unavailable|incapable|unable|neither|nor|without)\b/u.test(actorActionBridge)) continue;
      return true;
    }
  }
  return false;
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
  return /(?:\b(?:reject|refuse|block)\w*\s+(?:it|them|these|every\s+(?:permission|mutation|claim)|the\s+(?:wording|mutation|claim|statement|label))|\b(?:semantic\s+)?(?:contract|guard|validation|guidance)\s+(?:reject|refuse|block)\w*\s+(?:it|them|these|the\s+(?:wording|mutation|claim|statement|label))|\b(?:the\s+)?(?:story\s+owner\s+)?(?:contract|guard|validation|guidance)\s+(?:remains?\s+)?fail(?:s)?\s+closed\b[^.;]*|\b(?:contract\s+)?tests?\s+fail\b[^.;]*|\brequires?\b[^.;]*(?:current\s+story\s+repair|structured\s+evidence|traceable\s+owner|valid\s+route)|\bmust\s+remain\b[^.;]*future\s+system\s+work)\s*[.!?]*$/u.test(outcome);
}

function hasDynamicFindingAuthorityAmendmentAssertion(segment: string): boolean {
  const authority = /\bdynamic\s+finding(?:\s+system)?(?:\s+execution)?\s+(?:plan|authority|runtime)\b/u;
  const amendment = /\b(?:amend|modify|rewrite|override|replace|extend|change|update|authorit(?:ize|ise))\w*\b|\b(?:make|publish)\b[^.;]{0,80}\bauthoritative\b/u;
  for (const authorityRange of matchRanges(segment, authority)) {
    for (const amendmentRange of matchRanges(segment, amendment)) {
      const distance = Math.max(
        0,
        Math.max(authorityRange.start, amendmentRange.start) - Math.min(authorityRange.end, amendmentRange.end),
      );
      if (distance > 120) continue;
      const amendmentToken = segment.slice(amendmentRange.start, amendmentRange.end);
      const amendmentPrefix = segment.slice(Math.max(0, amendmentRange.start - 64), amendmentRange.start);
      const nominalChangeReference = /^(?:change|changes|update|updates)$/u.test(amendmentToken)
        && /\b(?:this|that|these|those|the|current|proposed|metadata\s+only|prompt\s+only|implementation|code)\s+$/u.test(amendmentPrefix);
      const explicitInvariantCheck = /\b(?:compare|verify|assert|prove|confirm|ensure|audit|check|preserve)\b/u.test(segment)
        && /\b(?:remain|remains|stay|stays|is|are|must\s+remain)\s+(?:completely\s+)?(?:unchanged|unaltered|unmodified|identical)\b|\bno\s+(?:authority|runtime|schema|semantic|contract)?\s*changes?\b/u.test(segment);
      // A Story may name its own implementation change while proving that the
      // authoritative Dynamic Finding contract is invariant. This narrow
      // nominal-reference exception does not excuse an affirmative amendment
      // verb: "this change modifies/updates the runtime" is still rejected by
      // the separate modify/update match.
      if (nominalChangeReference && explicitInvariantCheck) continue;
      if (!relationIsNegated(segment, amendmentRange, authorityRange, authorityRange)) return true;
    }
  }
  return false;
}

function reviewTriageAuthorityViolation(source: ReviewerTaskContextAuthoritySource): ReviewTriageAuthorityViolation | null {
  if (isPureInterrogative(source.text)
    || isExplicitFailClosedQuotedFixture(source.text)
    || isNegativeMutationVerificationIntent(source)) return null;
  for (const segment of triageAuthoritySegments(source.text)) {
    if (hasDynamicFindingAuthorityAmendmentAssertion(segment)) {
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

    const deferral = /\b(?:defer\s+with\s+proof|deferral|finding\s+deferral\s+disposition)\b/u;
    const collapsedOutcome = /\b(?:applicability\s+verdict|non\s+applicability\s+verdict|out\s+of\s+scope|resolved|resolution|repaired|repair|dismissed|finding\s+dismiss|disproven|duplicate|pre\s+existing\s+unaffected)\b/u;
    if (hasAffirmativeConceptRelation(
      segment,
      deferral,
      collapsedOutcome,
      /\b(?:is|as|mean|become|count|equal|qualify|serve|treat|classify|set|use|collapse|turn|make)\w*\b/u,
    )) {
      return 'disposition collapsed into applicability';
    }

    const unauthorizedActor = /\b(?:reviewers?|review\s+lanes?|agents?|story\s+owners?)\b/u;
    const signedDispositionInspection = unauthorizedActor.test(segment)
      && deferral.test(segment)
      && /\b(?:inspect|read|audit|verify|consume)\w*\b/u.test(segment)
      && /\bsigned\b/u.test(segment)
      && !/\b(?:mint|signs|signing|supply|supplies|supplying|approve|approves|approving|authorize|authorizes|authorizing|issue|issues|issuing|create|creates|creating|generate|generates|generating|fabricate|fabricates|fabricating)\b/u.test(segment);
    const dispositionMinting = /\b(?:mint|sign|supply|approve|create|issue|generate|authorize|fabricate)\w*\b/u;
    if (!signedDispositionInspection && hasUnauthorizedDispositionCapability(
      segment,
      unauthorizedActor,
      dispositionMinting,
      deferral,
    )) {
      return 'unauthorized disposition minting';
    }
    const compatibilityAuthority = /\b(?:current\s+cli|compatibility\s+cli|compatibility\s+path)\b/u;
    const futureCapability = /\b(?:implement|support|mint|sign|supply|create|issue|generate)\w*\b/u;
    if (hasUnauthorizedDispositionCapability(segment, compatibilityAuthority, futureCapability, deferral)) {
      return 'unauthorized disposition minting';
    }

    const severity = /\b(?:severity(?:\s+(?:rating|rank|level|score))?|criticality|critical|high|medium|low|priority|seriousness(?:\s+(?:rating|rank|level|score))?|risk\s+(?:rating|rank|level|score)|impact\s+(?:rating|rank|level|score)|harm\s+(?:rating|rank|level|score))\b/u;
    const soleAuthority = /\b(?:alone|solely|only|automatically|independently|independent\s+basis|exclusive(?:ly|\s+basis)?|by\s+itself|on\s+its\s+own)\b/u;
    const storyResponsibility = /\b(?:scope|applicability|ownership|owns?|belongs?|responsibility|(?:this|the|current)\s+story|routing|repair)\b/u;
    const soleQualifierBindsSeverity = matchRanges(segment, soleAuthority).some(soleRange => {
      const qualifier = segment.slice(soleRange.start, soleRange.end);
      const qualifierPrefix = segment.slice(Math.max(0, soleRange.start - 24), soleRange.start);
      if (qualifier === 'only' && /\b(?:append|read|review|documentation)\s+$/u.test(qualifierPrefix)) return false;
      return matchRanges(segment, severity).some(severityRange =>
        Math.max(0, Math.max(soleRange.start, severityRange.start) - Math.min(soleRange.end, severityRange.end)) <= 40,
      );
    });
    if (soleQualifierBindsSeverity && hasAffirmativeConceptRelation(
      segment,
      severity,
      storyResponsibility,
      /\b(?:control|determine|decide|set|establish|make|define|assign|require|govern|follow|derive)\w*\b/u,
    )) {
      return 'severity used as sole ownership or scope authority';
    }

    if (hasDismissalApplicabilityAssertion(segment)) {
      return 'dismissal used as applicability proof';
    }

    if (hasUnknownApplicabilityRoutingAssertion(segment)) {
      return 'unknown applicability used to route or unblock';
    }
  }
  const normalizedSource = normalizeTriageAuthorityText(source.text);
  if (hasDismissalApplicabilityAssertion(normalizedSource)) {
    return 'dismissal used as applicability proof';
  }
  if (hasUnknownApplicabilityRoutingAssertion(normalizedSource)) {
    return 'unknown applicability used to route or unblock';
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
    schemaVersion: 'proofbound.full-task-context.v1',
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
      scope: {
        mode: args.scopeContract.mode,
        allowedModify: canonicalStrings(args.scopeContract.allowedModify),
        allowedCreate: canonicalStrings(args.scopeContract.allowedCreate),
        allowedTest: canonicalStrings(args.scopeContract.allowedTest),
        protectedFiles: canonicalStrings(args.scopeContract.protectedFiles),
        explicitExcludes: canonicalStrings(args.scopeContract.explicitExcludes),
        protectedAnchors: canonicalStrings(args.scopeContract.protectedAnchors),
        fileRules: [...(args.scopeContract.fileRules ?? [])]
          .map(rule => ({
            path: rule.path,
            allowedAnchors: canonicalStrings(rule.allowedAnchors),
            deniedAnchors: canonicalStrings(rule.deniedAnchors),
            protectedAnchors: canonicalStrings(rule.protectedAnchors),
            allowedChangeKinds: canonicalStrings(rule.allowedChangeKinds),
            intentRefs: canonicalStrings(rule.intentRefs),
          }))
          .sort((left, right) => left.path.localeCompare(right.path)),
        ...(args.scopeContract.pathCanonicalizerVersion ? {
          pathCanonicalizerVersion: args.scopeContract.pathCanonicalizerVersion,
        } : {}),
        ...(args.scopeContract.pathCanonicalizationMode ? {
          pathCanonicalizationMode: args.scopeContract.pathCanonicalizationMode,
        } : {}),
        ...(args.scopeContract.anchorParserVersion ? {
          anchorParserVersion: args.scopeContract.anchorParserVersion,
        } : {}),
        ...(args.scopeContract.anchorArtifactVersion ? {
          anchorArtifactVersion: args.scopeContract.anchorArtifactVersion,
        } : {}),
        ...(args.scopeContract.astAnchorMode ? { astAnchorMode: args.scopeContract.astAnchorMode } : {}),
      },
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
    schemaVersion: 'proofbound.known-execution-environment.v1',
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
  if (input.dispatchKind === 'review-run') {
    for (const [key, value] of Object.entries({
      reviewRunId: input.reviewRunId,
      reviewRound: input.reviewRound,
      lane: input.lane,
    })) {
      if (typeof value !== 'string' || value.trim().length === 0) {
        throw new Error(`review-run Prompt Envelope requires ${key}`);
      }
    }
    if (input.roleContract.roleId !== input.lane) {
      throw new Error(
        `review-run Prompt Envelope role/lane mismatch: ${input.roleContract.roleId} !== ${input.lane}`,
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
    schemaVersion: 'proofbound.prompt-envelope.v1',
    roleId: input.roleContract.roleId,
    storyId: input.taskContext.storyId,
    dispatchKind: input.dispatchKind,
    ...(input.reviewRunId ? { reviewRunId: input.reviewRunId } : {}),
    ...(input.reviewRound ? { reviewRound: input.reviewRound } : {}),
    ...(input.lane ? { lane: input.lane } : {}),
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
  const basis = input.reviewBasis ?? null;
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

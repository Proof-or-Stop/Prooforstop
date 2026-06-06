/**
 * Init Check gate/hash primitives — core signature + gate helpers for init-check.json.
 *
 * This module is the single source of truth for the init-check.json signature
 * algorithm and the INIT_CHECK gate helpers. It lives in core/ (depends only on
 * StoryStore + crypto + fs) so that core consumers (machine.ts) can verify the
 * hash and evaluate the gate without an upward core→handlers import — the same
 * layering fix applied to delivery-check-hash.ts in B-37e9 F-001. The
 * init_check_set command shell (handlers/init-check.ts) re-uses these same
 * functions and re-exports them for backward compatibility.
 *
 * The signature structure follows the signScopeCheck approach in scope-check.ts (architecture already landed in B-d4d1 / B-ed3e),
 * differing in the signature domain: scope-check uses `storyId:timestamp:gaps:covered:reviewRound:salt`,
 * init-check uses `storyId:backgroundHash:title:description:checklistHash:reviewRound:salt`,
 * incorporating the entire "source of truth at story creation by the main agent (background + metadata + initial checklist)" into the signature.
 *
 * If the main agent modifies background.md / title / description / any of checklist.items[*].{title,context}
 * → recomputeInitCheckHash recalculates → mismatches init-check.json._hash →
 * story_advance INIT_CHECK reports init_check_tampered blocker.
 *
 * The agentId field does not participate in the signature (EXP-001 has disproved the mechanical verifiability of agentId, see
 * docs/story/actives/B-e71f/experiments/exp-001.md), used only for audit traceability.
 * The issues field does not participate in the signature (reviewer subjective judgment, advisory mode, allows later fixes).
 */

import { createHash } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { StoryStore } from './store.js';
import type { InitCheckData, InitCheckIssue } from './types.js';

export const INIT_CHECK_SALT = 'koala-init-check-integrity-v1';
export const REQUIRED_INIT_CHECK_AGENTS = ['koala-review-story-init', 'product-reviewer'] as const;

/**
 * B-95d8 CHK-001: suffix appended to required-agent ids when init-check.json is
 * produced by the manual `init_check_repair` fallback rather than an independent
 * reviewer run. `<required>@fallback` still satisfies missingRequiredInitCheckAgents
 * (initCheckAgentMatches matches the `<required>@` prefix), so the fallback passes
 * the gate WITHOUT weakening it, while remaining mechanically distinguishable from
 * a real reviewer record (which is the bare `<required>` id).
 */
export const INIT_CHECK_FALLBACK_AGENT_SUFFIX = 'fallback';

/**
 * Classify how an init-check.json was attested:
 *  - `'fallback'`  → produced by the manual `init_check_repair` command
 *    (`data.fallback` block present, or any agent id carries the `@fallback` suffix).
 *  - `'independent'` → produced by independent reviewer runs via `init_check_set`.
 *
 * Pure derivation over persisted data; used by story_get / dashboard / report to
 * surface "this gate was passed by a human fallback, not a reviewer".
 */
export function initCheckAttestationMode(data: InitCheckData): 'independent' | 'fallback' {
  if (data.fallback) return 'fallback';
  const suffix = `@${INIT_CHECK_FALLBACK_AGENT_SUFFIX}`;
  for (const result of initCheckAgentResults(data)) {
    if (normalizeAgentId(result.agentId).endsWith(suffix)) return 'fallback';
  }
  return 'independent';
}

export function normalizeAgentId(agentId: string | undefined): string {
  return (agentId || '').trim();
}

export function initCheckAgentMatches(agentId: string | undefined, required: string): boolean {
  const normalized = normalizeAgentId(agentId);
  return normalized === required || normalized.startsWith(`${required}@`);
}

export function initCheckAgentResults(data: InitCheckData): NonNullable<InitCheckData['agentResults']> {
  if (Array.isArray(data.agentResults) && data.agentResults.length > 0) return data.agentResults;
  return [{
    agentId: normalizeAgentId(data.agentId),
    checkedAt: data.checkedAt,
    issues: Array.isArray(data.issues) ? data.issues : [],
  }];
}

export function missingRequiredInitCheckAgents(data: InitCheckData): string[] {
  const results = initCheckAgentResults(data);
  return REQUIRED_INIT_CHECK_AGENTS.filter(required =>
    !results.some(result => initCheckAgentMatches(result.agentId, required)),
  );
}

export function blockingInitCheckIssues(data: InitCheckData): Array<{ agentId: string; issue: InitCheckIssue }> {
  const blockers: Array<{ agentId: string; issue: InitCheckIssue }> = [];
  for (const result of initCheckAgentResults(data)) {
    for (const issue of result.issues || []) {
      if (issue?.severity === 'critical' || issue?.severity === 'high') {
        blockers.push({ agentId: result.agentId || '<unknown>', issue });
      }
    }
  }
  return blockers;
}

/**
 * Computes the sha256 of the full background.md content. Returns the fixed string "missing" when the file does not exist,
 * so that the signed hash is also deterministic (avoiding throwing errors that would make the sign function potentially throw).
 * The gate side performs pre-checks via store.readStory / file existence validation before calling sign.
 */
export function computeBackgroundHash(root: string, storyId: string): string {
  const store = new StoryStore(root);
  const p = store.storyFilePath(storyId, 'background.md');
  if (!existsSync(p)) return 'missing';
  const content = readFileSync(p, 'utf-8');
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Computes the sha256 of the initial checklist: takes only each item's title / context (other fields like status / startTime /
 * id change at runtime and should not enter the signature domain, otherwise normal DEV progression would repeatedly trigger _hash mismatches).
 *
 * Input is ChecklistItem[] (or Pick), output is deterministic hex. Empty arrays are also valid (hash is a fixed value).
 */
export function computeChecklistHash(
  items: ReadonlyArray<{ title: string; context?: string }>,
): string {
  // Explicitly extract title / context, and normalize undefined to '', ensuring stable JSON.stringify output.
  const normalized = items.map(i => ({ title: i.title, context: i.context ?? '' }));
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

/**
 * Signature function for init-check.json. Deterministic (same input produces same output).
 *
 * Signature domain: storyId / backgroundHash / title / description / checklistHash / reviewRound + salt
 *
 * Not in signature domain: agentId / issues / checkedAt (avoiding reviewer reruns producing different _hash for the same input).
 */
export function signInitCheck(
  storyId: string,
  backgroundHash: string,
  title: string,
  description: string,
  checklistHash: string,
  reviewRound: string,
): string {
  return createHash('sha256')
    .update(`${storyId}:${backgroundHash}:${title}:${description}:${checklistHash}:${reviewRound}:${INIT_CHECK_SALT}`)
    .digest('hex');
}

/**
 * Recomputation entry point reused by the gate: reads current story.title / story.description /
 * background.md / initial checklist → calls signInitCheck → returns the expected current _hash value.
 *
 * When checklist does not exist, treated as empty array (in theory it exists at INIT phase, but this guards fs boundary).
 */
export function recomputeInitCheckHash(storyId: string, store: StoryStore, projectRoot: string): string {
  const story = store.readStory(storyId);
  const backgroundHash = computeBackgroundHash(projectRoot, storyId);
  let items: Array<{ title: string; context?: string }> = [];
  try {
    const checklist = store.readChecklist(storyId);
    items = checklist.items.map(i => ({ title: i.title, context: i.context }));
  } catch {
    // checklist.json does not exist → compute hash with empty array; semantically equivalent to "uninitialized checklist" on the gate side.
  }
  const checklistHash = computeChecklistHash(items);
  const reviewRound = story.currentReviewRound || '';
  return signInitCheck(
    storyId,
    backgroundHash,
    story.title,
    story.description,
    checklistHash,
    reviewRound,
  );
}

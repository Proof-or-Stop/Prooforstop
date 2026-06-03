/**
 * @task B-6bfd
 * @checklist CHK-005
 * @title Bind reviewer evidence to scope + diff hashes
 * @type feature
 * @priority high
 * @description
 *   Pure logic (no I/O) that binds a reviewer run to the EXACT scope contract
 *   and diff context the reviewer inspected. For a scope-protected story (one
 *   that has a scope contract), a reviewer run carries a ReviewScopeBinding
 *   computed from:
 *     - scopeContractHash : digestScopeContract(current contract)
 *     - diffPackHash      : a stable digest of the MATERIAL diff (story metadata
 *                           excluded — see note below)
 *     - reviewedChangedFiles / reviewedHunkDigests : the material file + hunk set
 *     - reviewedIntentRefs : reviewer-recorded verification intents inspected
 *     - bindingHash        : a signature over all of the above (tamper-evident)
 *
 *   The REVIEW→TEST gate recomputes the live scope context and rejects any
 *   reviewer evidence whose run binding is missing, tampered, or bound to a
 *   different scopeContractHash / diffPackHash / hunk-digest set.
 *
 *   Metadata-exclusion note: buildScopeDiffPack() reports EVERY changed file,
 *   including committed `.koala/story/` / `docs/story/` metadata. Every
 *   finding_add / review_pass_set auto-commits story metadata, so a raw
 *   diffPackHash would churn on every reviewer write and make the binding stale
 *   immediately. We therefore exclude the same material-excluded paths that
 *   evidence-freshness.ts excludes from materialHash, so the binding tracks only
 *   real code/diff changes during the review window. This is NOT a back door:
 *   story metadata is never reviewer-attestable code anyway.
 * @changes
 *   - [CHK-005] Bind a reviewer run to the exact scope contract + material diff via scopeContractHash / diffPackHash / reviewed hunk digests / intent refs / bindingHash
 *   - [CHK-005] Exclude story-metadata paths from the diff pack so reviewer auto-commits do not make the binding stale
 *   - [CHK-005] Let the REVIEW→TEST gate reject reviewer evidence whose binding is missing, tampered, or bound to a different scope/diff context
 */
import { createHash } from 'node:crypto';
import type {
  GuardSessionData,
  ReviewRun,
  ReviewScopeBinding,
  ScopeContractData,
  ScopeDiffPack,
} from './types.js';
import { digestScopeContract, guardSessionStateLabel, type GuardSessionStateLabel } from './guard-session.js';
import { checkScopeContract } from './scope-contract.js';
import { checkSemanticScope, isSemanticContract } from './semantic-scope-gate.js';
import { isMaterialExcludedPath } from './evidence-freshness.js';

export const REVIEW_SCOPE_BINDING_SALT = 'koala-review-scope-binding-v1';

function uniqSorted(values: readonly string[]): string[] {
  return [...new Set(values.map((v) => v.trim()).filter((v) => v.length > 0))].sort();
}

/**
 * Derive the stable, story-metadata-excluded view of a diff pack used for review
 * binding: the material changed files, material hunk digests, and a digest over
 * that material subset.
 *
 * Pass projectRoot so that a custom storyDir from lattice.config.json
 * (canonical) or koala.config.json (legacy fallback) is honoured
 * when deciding which paths are story-metadata (and therefore excluded from the
 * digest). Without projectRoot the function falls back to the built-in default
 * prefixes (docs/story/, .koala/story/, …), which is still correct for the
 * common case but misses custom storyDir configurations.
 */
export function materialDiffPackDigest(diffPack: ScopeDiffPack, projectRoot?: string): {
  diffPackHash: string;
  reviewedChangedFiles: string[];
  reviewedHunkDigests: string[];
} {
  const reviewedChangedFiles = uniqSorted(
    diffPack.changedFiles.filter((f) => !isMaterialExcludedPath(f, projectRoot)),
  );
  const materialHunks = diffPack.hunks
    .filter((h) => !isMaterialExcludedPath(h.path, projectRoot))
    .map((h) => ({
      path: h.path,
      header: h.header,
      hunkDigest: h.hunkDigest,
      anchor: h.anchor ?? null,
      keyPath: h.keyPath ?? null,
      changeKind: h.changeKind ?? null,
    }))
    .sort((a, b) => (a.path === b.path ? a.hunkDigest.localeCompare(b.hunkDigest) : a.path.localeCompare(b.path)));
  const reviewedHunkDigests = uniqSorted(materialHunks.map((h) => h.hunkDigest));
  const diffPackHash = createHash('sha256')
    .update(JSON.stringify({ reviewedChangedFiles, hunks: materialHunks }))
    .digest('hex');
  return { diffPackHash, reviewedChangedFiles, reviewedHunkDigests };
}

/** Sign a scope binding over its scope/diff/intent fields (excludes bindingHash itself). */
export function signReviewScopeBinding(binding: {
  scopeContractHash?: string;
  diffPackHash?: string;
  reviewedChangedFiles: readonly string[];
  reviewedIntentRefs: readonly string[];
  reviewedHunkDigests: readonly string[];
}): string {
  return createHash('sha256')
    .update(JSON.stringify({
      scopeContractHash: binding.scopeContractHash ?? '',
      diffPackHash: binding.diffPackHash ?? '',
      reviewedChangedFiles: uniqSorted(binding.reviewedChangedFiles),
      reviewedIntentRefs: uniqSorted(binding.reviewedIntentRefs),
      reviewedHunkDigests: uniqSorted(binding.reviewedHunkDigests),
      salt: REVIEW_SCOPE_BINDING_SALT,
    }))
    .digest('hex');
}

/**
 * Compute a review scope binding from the live scope contract + diff pack.
 *
 * Returns null when the story is NOT scope-protected (no contract). The caller
 * then keeps the reviewer run binding-free and the gate stays fully backward
 * compatible (legacy stories never require a scope binding).
 */
export function computeReviewScopeBinding(args: {
  contract: ScopeContractData | null | undefined;
  diffPack: ScopeDiffPack;
  reviewedIntentRefs?: readonly string[];
  projectRoot?: string;
}): ReviewScopeBinding | null {
  if (!args.contract) return null;
  const scopeContractHash = digestScopeContract(args.contract);
  const { diffPackHash, reviewedChangedFiles, reviewedHunkDigests } = materialDiffPackDigest(args.diffPack, args.projectRoot);
  const reviewedIntentRefs = uniqSorted(args.reviewedIntentRefs ?? []);
  const bindingHash = signReviewScopeBinding({
    scopeContractHash,
    diffPackHash,
    reviewedChangedFiles,
    reviewedIntentRefs,
    reviewedHunkDigests,
  });
  return {
    scopeContractHash,
    diffPackHash,
    reviewedChangedFiles,
    reviewedIntentRefs,
    reviewedHunkDigests,
    bindingHash,
  };
}

/** Verify a stored binding's bindingHash matches its contents (tamper check). */
export function verifyReviewScopeBinding(binding: ReviewScopeBinding | null | undefined): boolean {
  if (!binding || !binding.bindingHash) return false;
  return binding.bindingHash === signReviewScopeBinding(binding);
}

/** The live scope context the REVIEW→TEST gate compares stored bindings against. */
export interface CurrentScopeContext {
  scopeContractHash: string;
  diffPackHash: string;
  hunkDigests: string[];
}

/** Build the live scope context from the current contract + diff pack. */
export function buildCurrentScopeContext(
  contract: ScopeContractData,
  diffPack: ScopeDiffPack,
  projectRoot?: string,
): CurrentScopeContext {
  const { diffPackHash, reviewedHunkDigests } = materialDiffPackDigest(diffPack, projectRoot);
  return {
    scopeContractHash: digestScopeContract(contract),
    diffPackHash,
    hunkDigests: reviewedHunkDigests,
  };
}

export type ScopeBindingStaleCode =
  | 'missing_scope_binding'
  | 'scope_binding_tampered'
  | 'scope_contract_changed'
  | 'diff_pack_changed'
  | 'hunk_digest_set_changed';

export interface ScopeBindingComparison {
  ok: boolean;
  code?: ScopeBindingStaleCode;
  /** Live (current) value the gate expects. */
  expected?: string;
  /** Value the stored binding actually carries. */
  actual?: string;
  detail?: string;
}

function shortHash(value: string): string {
  if (!value || value === '(none)') return '(none)';
  return value.length > 12 ? `${value.slice(0, 12)}…` : value;
}

/**
 * Compare a stored review scope binding against the live scope context. The gate
 * checks the three mechanical facts the requirement calls out — scopeContractHash,
 * diffPackHash, and the reviewed hunk-digest set — plus a bindingHash tamper
 * check. reviewedIntentRefs are reviewer-recorded context and are NOT recomputed
 * against a live value (the reviewer chooses what to inspect), but they ARE part
 * of the tamper-evident bindingHash.
 */
export function compareScopeBinding(
  stored: ReviewScopeBinding | null | undefined,
  current: CurrentScopeContext,
): ScopeBindingComparison {
  if (!stored) {
    return {
      ok: false,
      code: 'missing_scope_binding',
      expected: `scopeContractHash=${shortHash(current.scopeContractHash)} diffPackHash=${shortHash(current.diffPackHash)}`,
      actual: '(none)',
      detail: 'reviewer run carries no scope binding for a scope-protected story',
    };
  }
  if (!verifyReviewScopeBinding(stored)) {
    return {
      ok: false,
      code: 'scope_binding_tampered',
      expected: shortHash(signReviewScopeBinding(stored)),
      actual: shortHash(stored.bindingHash),
      detail: 'scope binding hash does not match its recorded contents (tampered)',
    };
  }
  if ((stored.scopeContractHash ?? '') !== current.scopeContractHash) {
    return {
      ok: false,
      code: 'scope_contract_changed',
      expected: shortHash(current.scopeContractHash),
      actual: shortHash(stored.scopeContractHash ?? '(none)'),
      detail: 'scope contract changed after this reviewer run',
    };
  }
  if ((stored.diffPackHash ?? '') !== current.diffPackHash) {
    return {
      ok: false,
      code: 'diff_pack_changed',
      expected: shortHash(current.diffPackHash),
      actual: shortHash(stored.diffPackHash ?? '(none)'),
      detail: 'diff pack changed after this reviewer run (code changed since review)',
    };
  }
  const storedHunks = uniqSorted(stored.reviewedHunkDigests);
  const currentHunks = uniqSorted(current.hunkDigests);
  if (storedHunks.join(',') !== currentHunks.join(',')) {
    return {
      ok: false,
      code: 'hunk_digest_set_changed',
      expected: `${currentHunks.length} hunk(s)`,
      actual: `${storedHunks.length} hunk(s)`,
      detail: 'reviewed hunk-digest set changed after this reviewer run',
    };
  }
  return { ok: true };
}

/* ------------------------------------------------------------------------- *
 * Scope protection summary (CHK-006)
 *
 * Pure logic (no I/O) for the session_brief "Scope protection summary" block.
 * It folds the four scope-protection signals a human needs at a glance —
 * path gate, semantic gate, guard mode, review-hash freshness — plus a derived
 * next-action hint into one display projection.
 *
 * Backward compatibility / honesty: a story with no scope contract is reported
 * as NOT protected (gates render `n/a`) rather than pretending protection
 * exists. Callers read the contract / diff pack / guard session / review runs
 * and pass them in; this logic never touches the filesystem or git.
 * ------------------------------------------------------------------------- */

/** Gate cell label. `n/a` = not scope-protected; `skip` = v1 path-only contract. */
export type ScopeGateLabel = 'pass' | 'warn' | 'fail' | 'skip' | 'n/a';

/**
 * Review-binding freshness for the active review round:
 *   fresh   — every current-round reviewer run carries a binding that matches the
 *             live scope contract + diff pack.
 *   stale   — at least one current-round binding no longer matches (contract or
 *             code changed since the reviewer bound to it).
 *   missing — scope-protected & in REVIEW/TEST, but no current-round run carries a
 *             scope binding yet (natural-language-only evidence, not bound).
 *   n/a     — not scope-protected, or not yet in a review round.
 */
export type ReviewHashFreshness = 'fresh' | 'stale' | 'missing' | 'n/a';

export interface ScopeProtectionSummary {
  /** True only when a scope contract exists. Legacy stories are false. */
  protected: boolean;
  pathGate: ScopeGateLabel;
  semanticGate: ScopeGateLabel;
  guardMode: GuardSessionStateLabel;
  reviewHashFreshness: ReviewHashFreshness;
  /** Human next-action hint, derived from the four signals above. */
  nextAction: string;
}

export interface ScopeProtectionSummaryInput {
  contract: ScopeContractData | null;
  diffPack: ScopeDiffPack;
  guardSession: GuardSessionData | null;
  reviewRuns: readonly ReviewRun[];
  currentReviewRound?: string | null;
  phase: string;
  projectRoot?: string;
}

/**
 * Compute review-hash freshness for the active round. Only meaningful for a
 * scope-protected story once it is in REVIEW/TEST with a current review round.
 */
export function computeReviewHashFreshness(input: ScopeProtectionSummaryInput): ReviewHashFreshness {
  if (!input.contract) return 'n/a';
  if (input.phase !== 'REVIEW' && input.phase !== 'TEST') return 'n/a';
  const round = input.currentReviewRound;
  if (!round) return 'n/a';

  const roundRuns = input.reviewRuns.filter((run) => run.reviewRound === round);
  if (roundRuns.length === 0) return 'missing';

  const current = buildCurrentScopeContext(input.contract, input.diffPack, input.projectRoot);
  let sawBinding = false;
  for (const run of roundRuns) {
    if (!run.scopeBinding) {
      // A current-round reviewer run with no scope binding = prose-only evidence
      // that is not mechanically bound to the inspected scope.
      return 'missing';
    }
    sawBinding = true;
    const cmp = compareScopeBinding(run.scopeBinding, current);
    if (!cmp.ok) return 'stale';
  }
  return sawBinding ? 'fresh' : 'missing';
}

function deriveNextAction(s: {
  pathGate: ScopeGateLabel;
  semanticGate: ScopeGateLabel;
  guardMode: GuardSessionStateLabel;
  reviewHashFreshness: ReviewHashFreshness;
  phase: string;
}): string {
  // Priority: hard blockers first, then freshness, then advisory warnings.
  if (s.guardMode === 'violations detected') {
    return 'Guard session recorded forbidden write(s) — remove them or scope_contract_acknowledge, then guard_session_check.';
  }
  if (s.pathGate === 'fail' || s.semanticGate === 'fail') {
    return 'Out-of-scope change blocks the gate — fix the diff or scope_contract_acknowledge the necessary expansion before advancing.';
  }
  // CHK-002 B-a30e: phase-aware freshness guidance — TEST/DONE renders post-review
  // advisory copy instead of a REVIEW→TEST instruction (which is past tense in those phases).
  if (s.reviewHashFreshness === 'stale') {
    if (s.phase === 'TEST' || s.phase === 'DONE') {
      return 'Reviewer scope binding is stale (post-review advisory) — if changes were made after REVIEW, roll back to DEV and re-review, or verify via delivery reviewer.';
    }
    return 'Reviewer scope binding is stale (contract/code changed) — re-run the reviewer via review_run_start before REVIEW→TEST.';
  }
  if (s.reviewHashFreshness === 'missing') {
    if (s.phase === 'TEST' || s.phase === 'DONE') {
      return 'Reviewer scope binding is missing (post-review advisory) — confirm reviewer ran with review_run_start, or verify via delivery reviewer.';
    }
    return 'Reviewer evidence is not bound to the scope — start review_run_start (captures the scope binding) before recording a pass.';
  }
  // CHK-004 B-a30e: clearer advisory warning copy — name the exact recovery path.
  if (s.pathGate === 'warn' || s.semanticGate === 'warn') {
    return 'Scope warnings present (advisory, not blocking) — acknowledge in DEV/REVIEW via scope_contract_acknowledge if needed, roll back to DEV when in TEST, or verify via delivery reviewer.';
  }
  return 'Scope protection clean — proceed.';
}

/**
 * Build the aggregate scope-protection summary. For an unprotected (no-contract)
 * story every gate is `n/a` and the next action points at scope_contract_init_from_plan;
 * the diff pack is not consulted in that case.
 */
export function buildScopeProtectionSummary(input: ScopeProtectionSummaryInput): ScopeProtectionSummary {
  const guardMode = guardSessionStateLabel(input.guardSession);

  if (!input.contract) {
    return {
      protected: false,
      pathGate: 'n/a',
      semanticGate: 'n/a',
      guardMode,
      reviewHashFreshness: 'n/a',
      nextAction:
        guardMode === 'inactive'
          ? 'No scope contract — run scope_contract_init_from_plan to enable scope protection (optional for legacy stories).'
          : 'Guard session is running without a scope contract — run scope_contract_init_from_plan so guard_session_check has rules to enforce.',
    };
  }

  const path = checkScopeContract(input.contract, input.diffPack.changedFiles);
  const pathGate = path.status as ScopeGateLabel;

  const semanticGate: ScopeGateLabel = isSemanticContract(input.contract)
    ? (checkSemanticScope(input.contract, input.diffPack).status as ScopeGateLabel)
    : 'skip';

  const reviewHashFreshness = computeReviewHashFreshness(input);
  const nextAction = deriveNextAction({ pathGate, semanticGate, guardMode, reviewHashFreshness, phase: input.phase });

  return { protected: true, pathGate, semanticGate, guardMode, reviewHashFreshness, nextAction };
}

/**
 * Render the summary as session_brief lines. The exact row labels — "path gate",
 * "semantic gate", "guard mode", "review hash freshness", "next action" — are a
 * stable contract consumed by CHK-006 verification and any downstream tooling.
 */
export function renderScopeProtectionSummary(summary: ScopeProtectionSummary): string[] {
  const protectionNote = summary.protected ? '' : ' (no scope contract)';
  return [
    '## Scope protection summary',
    `  path gate: ${summary.pathGate}${protectionNote}`,
    `  semantic gate: ${summary.semanticGate}`,
    `  guard mode: ${summary.guardMode}`,
    `  review hash freshness: ${summary.reviewHashFreshness}`,
    `  next action: ${summary.nextAction}`,
  ];
}

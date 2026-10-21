import { rethrowIntentAmendmentIntegrityError } from './verification-intent-amendment.js';
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
 * differing in the signature domain. The domain is declared ONCE, as data, in
 * INIT_CHECK_SIGNATURE_DOMAIN below; every consumer (the signing function, the
 * recompute entry point, and the human-readable tamper message) derives from that
 * declaration instead of restating it, so widening the domain cannot leave a stale
 * hand-written field list behind.
 *
 * If the main agent modifies any signed component (background.md / title / description /
 * checklist.items[*].{title,context} / the reviewer verdict) → recomputeInitCheckHash
 * recalculates → mismatches init-check.json._hash → story_advance INIT_CHECK reports
 * init_check_tampered blocker.
 *
 * B-8df9 CHK-002: `agentResults` and `issues` — the two fields the INIT_CHECK gate
 * actually DECIDES on (missingRequiredInitCheckAgents / blockingInitCheckIssues) — are
 * inside the domain, via computeInitCheckVerdictHash. Before that they were outside it,
 * so a hand-edited file that injected reviewer coverage, or erased a recorded critical
 * issue, stayed signature-VALID and the gate accepted it with zero init_check_set calls
 * (proven by packages/main/tests/red/red-b8df9-init-check-verdict-signature.mjs).
 *
 * B-8df9 CHK-003: a signature nobody CHECKS before trusting the data is not a signature.
 * `store.readInitCheck` is an unverified read by decision (refusing to TRUST is not the
 * same as refusing to READ — see its contract note), so the trust boundary is here:
 * initCheckSignatureIsValid / initCheckHashMatches. Every consumer that DECIDES on the
 * record — the gate, and `init_check_set`'s carry-forward of the previous file's
 * agentResults — crosses it. Without the carry-forward check, one ordinary reviewer call
 * would re-sign hand-edited reviewer records into validity: tamper once, wait for any
 * legitimate call, and CHK-002's tamper-evidence is laundered away.
 *
 * SCOPE OF THAT PROPERTY: it makes the record TAMPER-EVIDENT. Reviewer coverage is
 * independently constrained by the controller-owned managed-dispatch run recorded on
 * each bare required-role result. Caller-supplied role ids cannot satisfy either lane;
 * an explicit @fallback record remains the only non-independent path.
 *
 * The top-level agentId field does not participate in the signature DIRECTLY and remains
 * an audit projection — but when `agentResults`
 * is absent it is one of the inputs initCheckAgentResults synthesizes the gate's decision array from, and in
 * that shape it is bound through the synthesized value (see computeInitCheckVerdictHash).
 */

import { createHash } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { StoryStore } from './store.js';
import type { InitCheckData, InitCheckIssue } from './types.js';
import { canonicalAgentRoleId } from './agent-role-identity.js';
import { verifyManagedDispatchDelivery } from './managed-host-run.js';

export const INIT_CHECK_SALT = 'proof-or-stop-init-check-integrity-v1';
export const REQUIRED_INIT_CHECK_AGENTS = ['proof-or-stop-review-story-init', 'proof-or-stop-product-reviewer'] as const;

/**
 * B-95d8 CHK-001: suffix appended to required-agent ids when init-check.json is
 * produced by the manual `init_check_repair` fallback rather than an independent
 * reviewer run. Only the byte-exact bare id or byte-exact `<required>@fallback`
 * form satisfies missingRequiredInitCheckAgents, so the fallback passes
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
export function initCheckAttestationMode(
  data: InitCheckData,
  verification?: { root: string; storyId: string },
): 'independent' | 'fallback' | 'unverified' {
  if (data.fallback) return 'fallback';
  const suffix = `@${INIT_CHECK_FALLBACK_AGENT_SUFFIX}`;
  for (const result of initCheckAgentResults(data)) {
    if (normalizeAgentId(result.agentId).endsWith(suffix)) return 'fallback';
  }
  if (!verification || missingRequiredInitCheckAgents(data).length > 0) return 'unverified';
  return invalidInitReviewerDeliveries(data, verification.root, verification.storyId).length === 0
    ? 'independent'
    : 'unverified';
}

export function normalizeAgentId(agentId: string | undefined): string {
  return canonicalAgentRoleId(agentId || '');
}

export function initCheckAgentMatches(agentId: string | undefined, required: string): boolean {
  if (typeof agentId !== 'string') return false;
  return agentId === required || agentId === `${required}@${INIT_CHECK_FALLBACK_AGENT_SUFFIX}`;
}

/**
 * The subset of init-check.json the verdict hash and the gate read. Every field is
 * optional because the corpus contains files that predate each of them, and because
 * producers call computeInitCheckVerdictHash on a record they are still assembling.
 */
export type InitCheckVerdictSource = Partial<
  Pick<InitCheckData, 'agentResults' | 'issues' | 'agentId' | 'checkedAt'>
>;

export function initCheckAgentResults(data: InitCheckVerdictSource): NonNullable<InitCheckData['agentResults']> {
  if (Array.isArray(data.agentResults) && data.agentResults.length > 0) return data.agentResults;
  return [{
    agentId: normalizeAgentId(data.agentId),
    checkedAt: data.checkedAt ?? '',
    issues: Array.isArray(data.issues) ? data.issues : [],
  }];
}

export function missingRequiredInitCheckAgents(data: InitCheckData): string[] {
  const results = initCheckAgentResults(data);
  return REQUIRED_INIT_CHECK_AGENTS.filter(required =>
    !results.some(result => {
      if (!initCheckAgentMatches(result.agentId, required)) return false;
      if (result.agentId === `${required}@${INIT_CHECK_FALLBACK_AGENT_SUFFIX}`) return true;
      return typeof result.deliveryRunId === 'string' && result.deliveryRunId.trim().length > 0;
    }),
  );
}

export function invalidInitReviewerDeliveries(
  data: InitCheckData,
  root: string,
  storyId: string,
): Array<{ agentId: string; runId: string; reason: string }> {
  const invalid: Array<{ agentId: string; runId: string; reason: string }> = [];
  for (const result of initCheckAgentResults(data)) {
    if (result.agentId.endsWith(`@${INIT_CHECK_FALLBACK_AGENT_SUFFIX}`)) continue;
    if (!REQUIRED_INIT_CHECK_AGENTS.some(required => result.agentId === required)) continue;
    const runId = result.deliveryRunId?.trim() ?? '';
    if (!runId) continue; // reported by missingRequiredInitCheckAgents
    const verdict = verifyManagedDispatchDelivery({ root, runId, storyId, agentType: result.agentId });
    if (!verdict.valid) invalid.push({ agentId: result.agentId, runId, reason: verdict.reason });
  }
  return invalid;
}

export function blockingInitCheckIssues(data: InitCheckData): Array<{ agentId: string; issue: InitCheckIssue }> {
  const blockers: Array<{ agentId: string; issue: InitCheckIssue }> = [];
  for (const result of initCheckAgentResults(data)) {
    for (const issue of result.issues || []) {
      const postImplementationOnly = issue?.kind === 'post_implementation_evidence_missing';
      if (!postImplementationOnly && (issue?.severity === 'critical' || issue?.severity === 'high')) {
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
  // The verbatim request (request.md) is part of what INIT reviewers approve. A
  // Story without one keeps the exact pre-existing background-only hash.
  const requestPath = store.storyFilePath(storyId, 'request.md');
  if (!existsSync(requestPath)) return createHash('sha256').update(content).digest('hex');
  return createHash('sha256').update(content).update('\0request.md\0').update(readFileSync(requestPath, 'utf-8')).digest('hex');
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
 * Deterministic serialization used by the verdict hash. Object keys are sorted, so the
 * key order a file happens to be written in cannot change the digest, and `undefined`
 * members are dropped exactly as JSON.stringify drops them — the producer hashes an
 * in-memory object while the verifier hashes the same object after a round trip through
 * disk, and those two must agree.
 *
 * B-8df9 F-003 — WHY THIS IS NOT core/digest.ts's EXPORTED `canonicalJson`. That module is
 * a leaf built for reuse and this file imports nothing else from it, so reuse looks free.
 * It is not: the two canonicalizations were compared and they DISAGREE on shapes an
 * on-disk init-check.json can carry, so swapping would silently change the digest of
 * already-signed records. Measured differences:
 *
 *  - digest.ts sorts keys with `a.localeCompare(b)`, i.e. by the VERIFIER'S DEFAULT LOCALE
 *    (measured on this Node: under LANG=sv_SE a key "ä" sorts after "z"; under en-US/de-DE
 *    it sorts right after "a"; and 'a' orders before 'B'). This function uses code-unit
 *    order, which is identical on every host. A signature canonicalized by locale would
 *    report `init_check_tampered` on a record nobody touched, purely because it was
 *    verified on a differently configured machine — the opposite of what it exists for.
 *  - digest.ts rebuilds a plain object and lets JSON.stringify emit it, so integer-like
 *    keys come out FIRST in ascending numeric order no matter what the sort decided
 *    (`{"2":..,"10":..}`); this function emits its own sorted entry list (`{"10":..,"2":..}`).
 *  - producer-side only (cannot come back off disk): digest.ts drops function/symbol-valued
 *    members entirely and stringifies a bigint, where this function keeps such a member as
 *    `null` and lets a bigint throw.
 *
 * The first two are reachable from a hand-edited file, which is precisely the input class
 * this hash exists to catch. The swap happens to move none of the 267 init-check.json files
 * in the live corpus (measured), but the domain's claim is totality over ARBITRARY on-disk
 * content, so "the corpus today is unaffected" is not the property being defended. Removing
 * this copy is a deliberate, migrated change of the signature algorithm — never a cleanup.
 */
function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(entry => canonicalJson(entry)).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * B-8df9 CHK-002: hash of the reviewer VERDICT — the two fields the INIT_CHECK gate
 * decides on (`agentResults`, consumed by missingRequiredInitCheckAgents, and `issues`,
 * consumed by blockingInitCheckIssues). This is the component that makes a hand-edited
 * verdict fail the signature instead of passing it.
 *
 * Two components are hashed, on purpose, because either one alone leaves a hole:
 *
 *  - `raw` is what is PERSISTED, verbatim (unknown keys included — no projection to a
 *    field list that could go stale). An ABSENT field hashes to the JSON `null` sentinel
 *    and is therefore a DISTINCT value: absence is NOT equated with the value a reader
 *    would synthesize for it. Signing a synthesized value in place of an absent field
 *    would silently accept re-encodings of a record nobody wrote.
 *  - `consumed` is what the GATE reads: the array initCheckAgentResults() returns. For a
 *    record carrying NO `agentResults` field at all, that array is
 *    SYNTHESIZED from top-level `agentId` / `checkedAt` / `issues`; hashing only `raw`
 *    would leave those synthesis inputs outside the domain, i.e. the same defect one
 *    layer down (edit top-level `agentId`, change who the gate believes reviewed, hash
 *    unmoved). Hashing the consumed array binds them for exactly the shapes that use them.
 *
 * Accepts a partial record so a producer can hash the object it is about to write; a
 * missing file (null/undefined) hashes as the empty record rather than throwing, since
 * the gate reports missing_init_check before it ever compares a digest.
 */
export function computeInitCheckVerdictHash(source: InitCheckVerdictSource | null | undefined): string {
  const data: InitCheckVerdictSource = source ?? {};
  const payload = {
    raw: {
      agentResults: data.agentResults ?? null,
      issues: data.issues ?? null,
    },
    consumed: initCheckAgentResults(data),
  };
  return createHash('sha256').update(canonicalJson(payload)).digest('hex');
}

/**
 * THE signature domain of init-check.json, declared once as data.
 *
 * `key` is the component's slot in the signed string (order is the concatenation order);
 * `label` is how that component is named to a human when the signature fails. The tamper
 * message renders these labels rather than restating them, so a domain change updates the
 * message by construction. A hand-written field list standing in for the real domain is
 * the defect family this story exists to remove — do not reintroduce one downstream.
 */
export const INIT_CHECK_SIGNATURE_DOMAIN = [
  { key: 'storyId', label: 'storyId' },
  { key: 'backgroundHash', label: 'background.md (+ request.md when recorded)' },
  { key: 'title', label: 'title' },
  { key: 'description', label: 'description' },
  { key: 'checklistHash', label: 'checklist' },
  { key: 'reviewRound', label: 'reviewRound' },
  { key: 'verdictHash', label: 'reviewer verdict (agentResults + issues)' },
] as const;

export type InitCheckSignatureComponent = typeof INIT_CHECK_SIGNATURE_DOMAIN[number]['key'];
export type InitCheckSignatureInput = Record<InitCheckSignatureComponent, string>;

/** Human-readable names of the signed components, in signing order. */
export function initCheckSignatureDomainLabels(): string[] {
  return INIT_CHECK_SIGNATURE_DOMAIN.map(component => component.label);
}

/** One-line rendering of the domain for error/diagnostic text. */
export function describeInitCheckSignatureDomain(): string {
  return initCheckSignatureDomainLabels().join(' / ');
}

/**
 * Signature function for init-check.json. Deterministic (same input produces same output).
 * Derives both the component order and the component set from INIT_CHECK_SIGNATURE_DOMAIN.
 */
export function signInitCheckDomain(input: InitCheckSignatureInput): string {
  const ordered = INIT_CHECK_SIGNATURE_DOMAIN.map(component => input[component.key]);
  return createHash('sha256')
    .update(`${ordered.join(':')}:${INIT_CHECK_SALT}`)
    .digest('hex');
}

/**
 * Positional wrapper over signInitCheckDomain, kept for the existing producers.
 *
 * `verdictHash` is REQUIRED (computeInitCheckVerdictHash over the record being written).
 * It is deliberately not optional-with-a-default: a producer that forgot to pass it would
 * otherwise sign "no verdict" and silently restore the gap this parameter closes.
 */
export function signInitCheck(
  storyId: string,
  backgroundHash: string,
  title: string,
  description: string,
  checklistHash: string,
  reviewRound: string,
  verdictHash: string,
): string {
  return signInitCheckDomain({
    storyId,
    backgroundHash,
    title,
    description,
    checklistHash,
    reviewRound,
    verdictHash,
  });
}

/**
 * B-8df9 CHK-003: THE comparison rule for "is this record one this tool signed?",
 * declared once so no consumer re-invents it.
 *
 * An absent record, an absent/blank `_hash`, and an expected hash that could not be
 * computed are all UNTRUSTED — never "assume valid because there is nothing to compare".
 * Callers pass the hash they recomputed over the SAME story snapshot the record is being
 * judged against; see the two entry points below/next to this one for the two ways that
 * snapshot is obtained.
 */
export function initCheckHashMatches(
  data: Pick<InitCheckData, '_hash'> | null | undefined,
  expectedHash: string,
): boolean {
  if (!data) return false;
  const stored = typeof data._hash === 'string' ? data._hash.trim() : '';
  const expected = typeof expectedHash === 'string' ? expectedHash.trim() : '';
  return stored.length > 0 && expected.length > 0 && stored === expected;
}

/**
 * Lab run132 (I2): whether `data` is a record this tool signed over the inputs its `_signedInputs` states (an older
 * snapshot): its stored `_hash` recomputed from those inputs and its PERSISTED verdict. A hand-edited verdict (issues,
 * agentResults, a slice hash), edited inputs or a record without `_signedInputs` fails. It says nothing about the
 * current Story; a caller carries forward only the reviewer rows whose own judged slice is still current.
 */
export function initCheckSignedOverRecordedInputs(storyId: string, data: InitCheckData | null | undefined): boolean {
  const inputs = data?._signedInputs;
  if (!data || !inputs || typeof inputs !== 'object') return false;
  const fields = [inputs.backgroundHash, inputs.title, inputs.description, inputs.checklistHash, inputs.reviewRound];
  if (fields.some(field => typeof field !== 'string')) return false;
  return initCheckHashMatches(data, signInitCheck(storyId, inputs.backgroundHash, inputs.title, inputs.description, inputs.checklistHash, inputs.reviewRound,
    computeInitCheckVerdictHash(data)));
}

/**
 * B-8df9 CHK-003: verifier entry point — recompute over the story's CURRENT content and
 * compare with the `_hash` stored beside the record.
 *
 * `store.readInitCheck` is deliberately an UNVERIFIED read (see its contract note in
 * core/store.ts): refusing to TRUST is not the same as refusing to READ, and the paths
 * that render / diagnose / audit an init-check.json — including the one that has to
 * report `init_check_tampered` — need the untrusted bytes in hand to say anything useful
 * about them. This function is where a caller crosses from reading to TRUSTING, and every
 * caller that DECIDES on the record's contents must cross it.
 *
 * `false` covers every not-trusted cause on purpose (missing record, blank/legacy hash,
 * hand-edited content); a caller that needs to tell those apart already has the record.
 */
export function initCheckSignatureIsValid(
  storyId: string,
  store: StoryStore,
  projectRoot: string,
  data: InitCheckData | null | undefined,
): boolean {
  if (!data) return false;
  return initCheckHashMatches(data, recomputeInitCheckHash(storyId, store, projectRoot, data));
}

/**
 * Recomputation entry point reused by the gate: reads current story.title / story.description /
 * background.md / initial checklist / the PERSISTED reviewer verdict → calls signInitCheck →
 * returns the expected current _hash value.
 *
 * When checklist does not exist, treated as empty array (in theory it exists at INIT phase, but this guards fs boundary).
 *
 * `verdictSource` (B-8df9 CHK-002) defaults to the persisted init-check.json, which is what a
 * VERIFIER wants: recompute over what is on disk and compare with the `_hash` stored beside it.
 * A PRODUCER, including an isolated regression fixture, passes the record it is about to write as
 * the fourth argument, because at that moment the file on disk is
 * either absent or still holds the previous verdict. Pass `null` to recompute against no verdict
 * at all.
 */
export function recomputeInitCheckHash(
  storyId: string,
  store: StoryStore,
  projectRoot: string,
  verdictSource?: InitCheckVerdictSource | null,
): string {
  const story = store.readStory(storyId);
  const backgroundHash = computeBackgroundHash(projectRoot, storyId);
  let items: Array<{ title: string; context?: string }> = [];
  try {
    const checklist = store.readChecklist(storyId);
    items = checklist.items.map(i => ({ title: i.title, context: i.context }));
  } catch (intentIntegrityError) { rethrowIntentAmendmentIntegrityError(intentIntegrityError);
    // checklist.json does not exist → compute hash with empty array; semantically equivalent to "uninitialized checklist" on the gate side.
  }
  const checklistHash = computeChecklistHash(items);
  const reviewRound = story.currentReviewRound || '';
  const verdict = verdictSource !== undefined ? verdictSource : store.readInitCheck(storyId);
  return signInitCheck(
    storyId,
    backgroundHash,
    story.title,
    story.description,
    checklistHash,
    reviewRound,
    computeInitCheckVerdictHash(verdict),
  );
}

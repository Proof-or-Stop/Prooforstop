// Shared runtime floor for native and managed critic receipt writers.
export const INVENTORY_CRITIC_REASON_MIN_LENGTH = 10;
export function validInventoryCriticReason(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length >= INVENTORY_CRITIC_REASON_MIN_LENGTH;
}
/** Provider-authored transport data. Shape validation grants no signing authority. */
export type ManagedInventoryFindingRef = { findingId: string } | { proposalFindingIndex: number };
export interface ManagedInventoryDisposition {
  finding: ManagedInventoryFindingRef;
  disposition: 'verified_family' | 'duplicate' | 'not_verified';
  familyKey?: string;
  canonicalFinding?: ManagedInventoryFindingRef;
  reason: string;
}
export interface ManagedInventoryCritic {
  epochId: string;
  wave: number;
  findingDispositions: ManagedInventoryDisposition[];
}
export const MANAGED_INVENTORY_CRITIC_LANE = 'proof-or-stop-review-topology-critic';
// Provider schema stays flat; the authoritative local parser enforces exact-one-reference.
const referenceSchema = {type: 'object', additionalProperties: false,
  properties: {findingId: {type: 'string'}, proposalFindingIndex: {type: 'integer'}}};
export const managedInventoryCriticJsonSchema = {
  type: 'object', additionalProperties: false, required: ['epochId', 'wave', 'findingDispositions'],
  properties: {
    epochId: {type: 'string'}, wave: {type: 'integer'},
    findingDispositions: {type: 'array',
      description: 'Exactly one row for every verified aggregate finding of the wave (finding={findingId}; the evidence pack lists the ids) and one for every entry of your own findings array (finding={proposalFindingIndex}); no row for a suspected or disproven finding. A missing or extra row refuses the critic.',
      items: {
      type: 'object', additionalProperties: false, required: ['finding', 'disposition', 'reason'],
      properties: {finding: referenceSchema, disposition: {type: 'string', enum: ['verified_family', 'duplicate', 'not_verified']},
        familyKey: {type: 'string'}, canonicalFinding: referenceSchema, reason: {type: 'string'}},
    }},
  },
};
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const keys = (v: Record<string, unknown>, allowed: string[]) => Object.keys(v).every(k => allowed.includes(k));
function ref(v: unknown, count: number): v is ManagedInventoryFindingRef {
  if (!record(v)) return false;
  if (keys(v, ['findingId']) && text(v.findingId)) return true;
  return keys(v, ['proposalFindingIndex']) && Number.isSafeInteger(v.proposalFindingIndex)
    && (v.proposalFindingIndex as number) >= 0 && (v.proposalFindingIndex as number) < count;
}
/** Bounded JSON rendering of a provider value for a model-readable violation. */
function shown(v: unknown): string {
  if (v === undefined) return 'missing';
  const encoded = JSON.stringify(v) ?? String(v);
  return encoded.length > 80 ? `${encoded.slice(0, 77)}...` : encoded;
}
const refExpected = (count: number) => count > 0
  ? `{findingId:<existing id>} or {proposalFindingIndex:0..${count - 1}}`
  : '{findingId:<existing id>} (no own findings, so no proposalFindingIndex)';
/**
 * Every way `value` misses the managed critic contract, as `path: expected
 * ..., got ...` lines (empty when valid). The single source for both the
 * predicate below and the provider-facing rejection reason.
 */
export function managedInventoryCriticViolations(value: unknown, lane: string, agent: string, findingCount: number, path = 'inventoryCritic'): string[] {
  if (lane !== MANAGED_INVENTORY_CRITIC_LANE || agent !== MANAGED_INVENTORY_CRITIC_LANE) {
    return [`${path}: only the ${MANAGED_INVENTORY_CRITIC_LANE} lane may carry an inventoryCritic block`];
  }
  if (!record(value)) return [`${path}: expected an object {epochId,wave,findingDispositions}, got ${shown(value)}`];
  const out: string[] = [];
  const extra = Object.keys(value).filter(k => !['epochId', 'wave', 'findingDispositions'].includes(k));
  if (extra.length) out.push(`${path}: unexpected field(s) ${extra.join(', ')}; allowed epochId, wave, findingDispositions`);
  if (!text(value.epochId)) out.push(`${path}.epochId: expected a non-blank string, got ${shown(value.epochId)}`);
  if (!Number.isSafeInteger(value.wave) || (value.wave as number) < 1) out.push(`${path}.wave: expected an integer >= 1, got ${shown(value.wave)}`);
  if (!Array.isArray(value.findingDispositions)) {
    out.push(`${path}.findingDispositions: expected an array, got ${shown(value.findingDispositions)}`);
    return out;
  }
  const seen = new Set<string>();
  value.findingDispositions.forEach((row, i) => {
    const at = `${path}.findingDispositions[${i}]`;
    if (!record(row)) { out.push(`${at}: expected an object, got ${shown(row)}`); return; }
    const rowExtra = Object.keys(row).filter(k => !['finding', 'disposition', 'familyKey', 'canonicalFinding', 'reason'].includes(k));
    if (rowExtra.length) out.push(`${at}: unexpected field(s) ${rowExtra.join(', ')}; allowed finding, disposition, familyKey, canonicalFinding, reason`);
    if (!ref(row.finding, findingCount)) out.push(`${at}.finding: expected ${refExpected(findingCount)}, got ${shown(row.finding)}`);
    if (!validInventoryCriticReason(row.reason)) out.push(`${at}.reason: expected a string of at least ${INVENTORY_CRITIC_REASON_MIN_LENGTH} trimmed characters, got ${shown(row.reason)}`);
    const identity = JSON.stringify(row.finding);
    if (seen.has(identity)) out.push(`${at}.finding: ${shown(row.finding)} is classified more than once; one row per finding`);
    seen.add(identity);
    // A verified family is its own canonical finding; a canonicalFinding that
    // names the row itself is redundant (importers drop it), another is contradictory.
    if (row.disposition === 'verified_family') {
      if (!text(row.familyKey)) out.push(`${at}.familyKey: verified_family requires a non-blank familyKey, got ${shown(row.familyKey)}`);
      if (row.canonicalFinding !== undefined && JSON.stringify(row.canonicalFinding) !== identity) {
        out.push(`${at}.canonicalFinding: verified_family omits canonicalFinding (it is its own canonical finding), got ${shown(row.canonicalFinding)}`);
      }
    } else if (row.disposition === 'duplicate') {
      if (!text(row.familyKey)) out.push(`${at}.familyKey: duplicate requires a non-blank familyKey, got ${shown(row.familyKey)}`);
      if (!ref(row.canonicalFinding, findingCount)) out.push(`${at}.canonicalFinding: duplicate requires ${refExpected(findingCount)}, got ${shown(row.canonicalFinding)}`);
    } else if (row.disposition === 'not_verified') {
      if (row.familyKey !== undefined) out.push(`${at}.familyKey: not_verified permits no familyKey, got ${shown(row.familyKey)}`);
      if (row.canonicalFinding !== undefined) out.push(`${at}.canonicalFinding: not_verified permits no canonicalFinding, got ${shown(row.canonicalFinding)}`);
    } else {
      out.push(`${at}.disposition: expected one of verified_family, duplicate, not_verified, got ${shown(row.disposition)}`);
    }
  });
  return out;
}
export function isManagedInventoryCritic(value: unknown, lane: string, agent: string, findingCount: number): value is ManagedInventoryCritic {
  return managedInventoryCriticViolations(value, lane, agent, findingCount).length === 0;
}

/** Exact lane contract shared by terminal and legacy managed-review ingress. */
export function isManagedInventoryCriticEnvelopeValid(
  value: unknown,
  lane: string,
  agent: string,
  findingCount: number,
): value is ManagedInventoryCritic | undefined {
  return lane === MANAGED_INVENTORY_CRITIC_LANE
    ? isManagedInventoryCritic(value, lane, agent, findingCount)
    : value === undefined;
}

/** A Finding as the restatement matcher sees it (id, claim text, cited files). */
export interface CriticRestatementFinding { id: string; desc: string; files?: readonly string[] }
/** One resolved critic disposition row (finding references already resolved to ids). */
export interface CriticResolvedDisposition {
  findingId: string;
  disposition: 'verified_family' | 'duplicate' | 'not_verified';
  familyKey?: string;
  canonicalFindingId?: string;
  reason: string;
}
export interface CriticRestatement { ownFindingId: string; restatedFindingId: string; similarity: number; basis: 'text' | 'critic-link' }

/** Token-set Jaccard similarity floor at which a same-file critic finding is the same claim as an earlier finding. */
export const CRITIC_RESTATEMENT_TEXT_SIMILARITY = 0.6;
/** Lower floor when the critic itself links its own finding to that earlier finding (familyKey/canonical/reason names its id). */
export const CRITIC_RESTATEMENT_LINKED_SIMILARITY = 0.25;
/** The best match must beat the runner-up by this margin unless the critic linked it explicitly. */
const CRITIC_RESTATEMENT_MARGIN = 0.15;

function claimTokens(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? []);
}
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / (a.size + b.size - shared);
}
const normalizedPath = (path: string): string => path.trim().replace(/^\.\//, '').replace(/\\/g, '/');
/**
 * Code symbols a claim names: called names (`Reverse(`), camelCase/PascalCase
 * compounds and snake_case identifiers. Two findings that each name symbols but
 * share none are about different code, however alike their prose is
 * ("Upper has no focused test for an empty string" vs the same about Reverse).
 */
function claimSymbols(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) out.add(m[1]!.toLowerCase());
  for (const m of text.matchAll(/\b([a-z]+[A-Z][A-Za-z0-9]*|[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]*|[A-Za-z]+_[A-Za-z0-9_]+)\b/g)) out.add(m[1]!.toLowerCase());
  return out;
}
function symbolsDisjoint(a: Set<string>, b: Set<string>): boolean {
  if (a.size === 0 || b.size === 0) return false;
  for (const symbol of a) if (b.has(symbol)) return false;
  return true;
}

/**
 * Detection A/B control D2-r3 / D9-r1: the inventory critic re-raised the
 * lanes' findings as its own new findings, then dispositioned only one copy of
 * each (the lane finding or its own restatement), and the import refused the
 * whole critic with REVIEW_INVENTORY_FINDING_DISPOSITION_INCOMPLETE. A critic
 * finding that PROVABLY restates an earlier finding of the same wave (at least
 * one shared cited file AND the same claim: token similarity >=
 * CRITIC_RESTATEMENT_TEXT_SIMILARITY about the same code (the code symbols
 * both name, if any, overlap), or >= CRITIC_RESTATEMENT_LINKED_SIMILARITY when
 * the critic's own row names that finding's id) is the critic's duplicate
 * of it: the missing row is completed from the critic's row for the other copy.
 * The restated copy stays a recorded verified finding (a `duplicate` with an
 * exact canonical link, closed by the duplicate-coverage path), so nothing is
 * dropped. A critic finding that matches nothing, matches ambiguously, or
 * whose counterpart has no usable row is left untouched: the import still
 * refuses it with the exact missing ids.
 */
export function reconcileRestatedCriticFindings(args: {
  ownFindings: readonly CriticRestatementFinding[];
  otherFindings: readonly CriticRestatementFinding[];
  dispositions: readonly CriticResolvedDisposition[];
}): { dispositions: CriticResolvedDisposition[]; restated: CriticRestatement[] } {
  const rows = new Map(args.dispositions.map(row => [row.findingId, { ...row }]));
  const restated: CriticRestatement[] = [];
  const own = [...args.ownFindings].sort((a, b) => a.id.localeCompare(b.id));
  for (const finding of own) {
    const ownRow = rows.get(finding.id);
    const ownTokens = claimTokens(finding.desc);
    const ownSymbols = claimSymbols(finding.desc);
    const ownFiles = new Set((finding.files ?? []).map(normalizedPath));
    const linked = (other: CriticRestatementFinding): boolean => Boolean(ownRow && (ownRow.familyKey === other.id
      || ownRow.canonicalFindingId === other.id || ownRow.reason.includes(other.id)));
    const scored = args.otherFindings
      .filter(other => other.id !== finding.id && (other.files ?? []).some(path => ownFiles.has(normalizedPath(path))))
      .map(other => ({ other, similarity: jaccard(ownTokens, claimTokens(other.desc)), linked: linked(other),
        differentCode: symbolsDisjoint(ownSymbols, claimSymbols(other.desc)) }))
      .sort((a, b) => b.similarity - a.similarity);
    const explicit = scored.filter(row => row.linked && row.similarity >= CRITIC_RESTATEMENT_LINKED_SIMILARITY);
    let match: (typeof scored)[number] | undefined;
    if (explicit.length === 1) match = explicit[0];
    else if (explicit.length === 0 && scored[0] && !scored[0].differentCode && scored[0].similarity >= CRITIC_RESTATEMENT_TEXT_SIMILARITY
      && (scored[1]?.similarity ?? 0) <= scored[0].similarity - CRITIC_RESTATEMENT_MARGIN) match = scored[0];
    if (!match) continue;
    const other = match.other;
    const otherRow = rows.get(other.id);
    const note = `restates ${other.id} (shared file, claim similarity ${match.similarity.toFixed(2)}${match.linked ? ', linked by the critic' : ''})`;
    if (otherRow && !ownRow) {
      if (otherRow.disposition === 'not_verified' || !otherRow.familyKey) continue;
      const canonical = otherRow.disposition === 'verified_family' ? other.id : otherRow.canonicalFindingId;
      if (!canonical) continue;
      rows.set(finding.id, { findingId: finding.id, disposition: 'duplicate', familyKey: otherRow.familyKey, canonicalFindingId: canonical,
        reason: `Framework: the critic's own finding ${note}; recorded as a duplicate of ${canonical}.` });
    } else if (ownRow && !otherRow) {
      if (ownRow.disposition === 'not_verified' || !ownRow.familyKey) continue;
      if (ownRow.disposition === 'verified_family') {
        rows.set(other.id, { findingId: other.id, disposition: 'verified_family', familyKey: ownRow.familyKey,
          reason: `${ownRow.reason} [Framework: the critic recorded this on its restatement ${finding.id}.]` });
        rows.set(finding.id, { findingId: finding.id, disposition: 'duplicate', familyKey: ownRow.familyKey, canonicalFindingId: other.id,
          reason: `Framework: the critic's own finding ${note}; recorded as a duplicate of ${other.id}.` });
      } else {
        if (!ownRow.canonicalFindingId || ownRow.canonicalFindingId === other.id) continue;
        rows.set(other.id, { findingId: other.id, disposition: 'duplicate', familyKey: ownRow.familyKey, canonicalFindingId: ownRow.canonicalFindingId,
          reason: `${ownRow.reason} [Framework: the critic recorded this on its restatement ${finding.id}.]` });
      }
    } else continue;
    restated.push({ ownFindingId: finding.id, restatedFindingId: other.id, similarity: Number(match.similarity.toFixed(4)), basis: match.linked ? 'critic-link' : 'text' });
  }
  return { dispositions: [...rows.values()], restated };
}

/**
 * The managed inventory protocol the critic prompt carries. It states exactly
 * what the importer (handlers/review-inventory.ts) requires, so a complete
 * critic is never refused for a rule it was not told (A/B control D2-r3, D9-r1).
 */
export const MANAGED_INVENTORY_CRITIC_PROTOCOL: readonly string[] = [
  'Managed inventory protocol: do not call review_inventory_critic_set. The authenticated importer writes the critic receipt from your sealed inventoryCritic block after terminal evidence import.',
  'Include inventoryCritic={epochId,wave,findingDispositions} bound exactly to the current evidence pack. findingDispositions needs exactly one row for every verified aggregate finding of this wave (finding={findingId:existingId}; the evidence pack lists the exact ids) AND one row for every entry of your own findings array (finding={proposalFindingIndex:zeroBasedIndex}); a missing row refuses the whole critic import with REVIEW_INVENTORY_FINDING_DISPOSITION_INCOMPLETE. A suspected or disproven finding takes NO row (a row for it is REVIEW_INVENTORY_FINDING_DISPOSITION_INVALID); if you verified one, report it as your own finding. Each row has finding, disposition, reason, optional familyKey and canonicalFinding. Each reason must contain at least 10 trimmed characters. canonicalFinding uses the same reference forms. Never guess allocated Finding IDs. Duplicate rows require familyKey and canonicalFinding; verified_family requires familyKey and omits canonicalFinding (it is its own canonical finding); not_verified permits neither.',
  'Your own findings array is only for a defect that no aggregate finding already reports. Never copy, restate or re-raise an aggregate finding as your own finding: classify it by its findingId instead (confirming it is verified_family; a severity note goes in its reason). If you found nothing new, use conclusion="pass" with an empty findings array; your rows still classify every aggregate finding.',
  'Do not put findingDispositions at the top level. The block does not certify omitted reads or resolve findings. Preserve incomplete-read findings rather than claiming complete coverage.',
];

/** Existing-finding rows a managed critic's block must carry, sealed at launch (reviewBinding.inventoryCriticCoverage). */
export interface ManagedInventoryCriticCoverage {
  requiredFindingIds: string[];
  noRowFindingIds: string[];
  /** Claim text and files of the required findings, so a provable restatement counts as covered (reconcileRestatedCriticFindings). */
  requiredFindingClaims?: CriticRestatementFinding[];
}

export function isManagedInventoryCriticCoverage(value: unknown): value is ManagedInventoryCriticCoverage {
  const ids = (v: unknown) => Array.isArray(v) && v.every(id => typeof id === 'string' && id.trim().length > 0);
  const claims = (v: unknown) => v === undefined || (Array.isArray(v) && v.every(row => record(row) && text(row.id) && typeof row.desc === 'string'
    && (row.files === undefined || ids(row.files))));
  return record(value) && keys(value, ['requiredFindingIds', 'noRowFindingIds', 'requiredFindingClaims'])
    && ids(value.requiredFindingIds) && ids(value.noRowFindingIds) && claims(value.requiredFindingClaims);
}

/**
 * Coverage violations of a shape-valid critic block against the sealed
 * coverage, as `path: expected ..., got ...` lines (empty when complete). The
 * worker turns them into a same-session format repair before sealing, so the
 * importer never sees a block it would refuse for coverage (run 19 B-8166: a
 * row for suspected F-001). A missing row that the importer completes itself
 * (a provable restatement, A/B control D2-r3/D9-r1) is not a violation.
 */
export function managedInventoryCriticCoverageViolations(block: ManagedInventoryCritic,
  ownFindings: ReadonlyArray<{ desc: string; files?: readonly string[] }>,
  coverage: ManagedInventoryCriticCoverage, path = 'inventoryCritic.findingDispositions'): string[] {
  const out: string[] = [];
  const ownId = (index: number) => `#own-${index}`;
  const refId = (ref: ManagedInventoryFindingRef) => 'findingId' in ref ? ref.findingId : ownId(ref.proposalFindingIndex);
  block.findingDispositions.forEach((row, i) => {
    if (!('findingId' in row.finding)) return;
    const id = row.finding.findingId;
    if (!coverage.requiredFindingIds.includes(id)) {
      out.push(`${path}[${i}].finding: expected one of ${JSON.stringify(coverage.requiredFindingIds)} (this wave's verified aggregate), got ${JSON.stringify(id)}${
        coverage.noRowFindingIds.includes(id) ? ', which is suspected/disproven and takes no row (remove the row; report it as your own finding if you verified it)' : ''}`);
    }
  });
  const rows: CriticResolvedDisposition[] = block.findingDispositions.map(row => ({ findingId: refId(row.finding), disposition: row.disposition,
    reason: row.reason, ...(row.familyKey ? { familyKey: row.familyKey } : {}),
    ...(row.canonicalFinding && row.disposition !== 'verified_family' ? { canonicalFindingId: refId(row.canonicalFinding) } : {}) }));
  const own = ownFindings.map((finding, index) => ({ id: ownId(index), desc: finding.desc, files: finding.files }));
  const completed = new Set(reconcileRestatedCriticFindings({ ownFindings: own, otherFindings: coverage.requiredFindingClaims ?? [],
    dispositions: rows }).dispositions.map(row => row.findingId));
  const missing = coverage.requiredFindingIds.filter(id => !completed.has(id));
  if (missing.length) out.push(`${path}: expected a row for every verified aggregate finding, missing ${JSON.stringify(missing)}`);
  const missingOwn = own.map((row, index) => completed.has(row.id) ? -1 : index).filter(index => index >= 0);
  if (missingOwn.length) out.push(`${path}: expected a row for every own finding, missing proposalFindingIndex ${JSON.stringify(missingOwn)} (a restated aggregate finding is a duplicate of it)`);
  return out;
}

/**
 * B-2aa7 CHK-004 — fail-closed validation of the legacy v1 red-evidence ARTIFACT
 * at the read boundary, with D-4 quarantine.
 *
 * Source of truth:
 * `docs/requirements/decisions/red-evidence-legacy-v1-record-validation-audit.md`
 * (decisions D-1, D-3, D-4, D-5, D-8; acceptance rows §10.2 and §10.2.1).
 *
 * ── WHY THIS FILE EXISTS, AND WHY IT IS A SIBLING OF `red-evidence/` ─────────
 *
 * `core/red-evidence/` is the v2 chain leaf owned by sibling story B-506e and is
 * a blocked path in this story's scope contract, so the v1 ARTIFACT validator
 * lives beside it rather than inside it. The two are complementary and the split
 * is exactly the audit's §6.1 authority rule (D-1):
 *
 *   the FILE declares the era, the RECORD declares the exception.
 *
 * `red-evidence/record-v2.ts` owns the RECORD exception: it discriminates v2 by
 * the exact `schemaVersion` literal and fails closed on an unsupported one. This
 * file owns the FILE era: the envelope, and the shape of the `'v1'` RESIDUAL
 * class that the discriminator leaves behind. A versionless record inside a
 * v1-declared file is only *claimed* v1 — it must be validated against the v1
 * schema, never assumed to satisfy it (D-1, D-3 Axis A = (ii) full validation).
 *
 * ── ENVELOPE BEFORE RECORDS (D-8) ───────────────────────────────────────────
 *
 * The envelope is validated FIRST so a bad envelope never reaches record-level
 * code. This is not tidiness, it is the fix for a real misattribution: before
 * this file, `records: "x"` was handed to `for (const record of data.records)`,
 * which iterated the STRING'S CHARACTERS, classified `'x'` as unsupported, and
 * reported `a record must be an object` — blaming a record that does not exist
 * for a fault that is entirely the envelope's (audit §2.4, RED row A8). An
 * envelope fault is therefore reported AS an envelope fault, naming the artifact
 * path, and record-level code is never entered at all.
 *
 * ── TWO REJECTION FORMS, ON PURPOSE ─────────────────────────────────────────
 *
 * ENVELOPE fault  -> a TYPED {@link RedEvidenceArtifactError} NAMING THE PATH.
 *   The whole artifact is unusable; there is no clean subset to hand to the
 *   typed domain, and §10.2.1 row E7 states the requirement for the sharpest of
 *   these cases positively: an unparseable file must still THROW, just typed and
 *   naming the path. The absence of a throw would NOT satisfy E7.
 *
 * RECORD fault    -> D-4 QUARANTINE: retain-and-report, never drop.
 *   `records` keeps only well-formed entries, and every rejected entry is
 *   RETAINED VERBATIM in `malformedRecords` with its index, its identifying
 *   field and the reason. Dropping them silently would produce a "clean empty
 *   array", which reads exactly like an absent artifact — the very defect this
 *   story exists to remove (§10.2.1 row E5). Quarantine also keeps the CLI
 *   usable on a corrupt artifact, which a throwing read path would not (§9/D-6).
 *
 * ── THE ONE PLACE D-4 IS DELIBERATELY OVERRIDDEN (D-5) ──────────────────────
 *
 * A blank `observedFailure` (`""` / `"   "`) is LEGACY-TOLERATED input: not
 * well-formed under the WRITE schema (`requireNonEmptyString` rejects and trims
 * it), but historically accepted by the READ path and treated by the predicate
 * as an ordinary non-satisfier. It must keep producing UNSATISFIED with NO NEW
 * DIAGNOSTIC and must NEVER be quarantined, because scenario 3 of
 * `packages/main/tests/red/red-w2c-v1-verdict-invariance.mjs` depends on that
 * exact report shape. Quarantining it moves the pinned digest, and a moved
 * digest means the fix is wrong — not that the constant needs re-pinning. See
 * {@link V1_MANDATORY_RECORD_FIELDS}, where the carve-out is `blankTolerated`.
 *
 * ── HAND-OFF TO CHK-006 (consumer behaviour) — NOW ANSWERED BELOW ───────────
 *
 * Quarantine keeps `records` clean, so a consumer that reads an artifact and
 * writes a REBUILT envelope back would persist the clean `records` and lose the
 * quarantined originals from disk. `appendRedEvidence` (`core/proofstory.ts`)
 * and `appendControlRecord` (`core/red-evidence/append.ts`) both rebuild the
 * envelope that way. Retention here is in-memory and complete (each entry keeps
 * its verbatim `value`); making the WRITE path preserve it is CHK-006's
 * `red_evidence_create` obligation — "repair by appending, or refuse with an
 * actionable message, never leave the artifact unrepairable" (§10.4 row C2).
 *
 * CHK-006 answers it in the CONSUMER SURFACE section at the foot of this file:
 * {@link restoreQuarantinedRecords} is the write-path counterpart that puts
 * every quarantined original back at its on-disk index before the rebuilt
 * envelope is written, and {@link renderRedEvidenceQuarantineNotice} /
 * {@link describeRedEvidenceReadFailure} give every consumer one corruption
 * vocabulary so corruption never renders as absence.
 *
 * ── `malformedRecords` IS DERIVED, AND IS NEVER INHERITED ───────────────────
 *
 * `malformedRecords` is READ-TIME CLASSIFICATION: it is what THIS validator
 * concluded about THIS read. It is not part of the on-disk schema and it is
 * never a fact the artifact gets to assert about itself.
 *
 * That distinction was load-bearing and was, for one revision, not enforced.
 * The two "nothing was malformed" returns below handed back the parsed envelope
 * UNCHANGED, so an on-disk `malformedRecords` key — planted by a crafted
 * artifact, or simply left behind by a stale one — travelled into the typed
 * domain and was then read by {@link redEvidenceQuarantinedRecords} as though
 * the validator had produced it. {@link retainQuarantinedRecordsOnWrite} duly
 * re-inserted its `value`s into `records`, so an artifact could fabricate
 * quarantine state and INJECT arbitrary records into the very evidence the
 * DEV / REVIEW / DONE gates read. The guard that exists to stop unvalidated
 * data being trusted was itself trusting an unvalidated on-disk field.
 *
 * So EVERY typed value this module produces goes through
 * {@link withDerivedQuarantine}, which strips any inherited key and re-attaches
 * only this read's own classification — INCLUDING the all-records-valid case,
 * where the derived answer is "none" and the key is therefore absent. There is
 * no path from disk to `RedEvidenceData.malformedRecords`.
 *
 * That closes the path from DISK. It does not close the path from a CALLER, and
 * for one further revision that distinction was missed. `malformedRecords` on a
 * hand-built payload is arbitrary caller data, and it reaches the write boundary
 * intact because `store.writeRedEvidence` passes whatever it is given: an
 * in-memory `RedEvidenceData` never went through a read, so nothing had stripped
 * anything. A SHAPE check could not tell it apart — a quarantine entry is five
 * ordinary members, so anything the check accepts, a caller can type out — and
 * an object literal was duly re-inserted into `records` by direct call.
 *
 * So the acceptance rule is PROVENANCE, not shape: {@link
 * DERIVED_QUARANTINE_ENTRIES} registers the objects this module derived, and
 * {@link redEvidenceQuarantinedRecords} honours only those. It stays TOTAL —
 * a non-array or an unregistered entry yields nothing rather than throwing,
 * because it renders on gate paths — and nothing is what a consumer may
 * re-insert from it. Dropping a bogus CLASSIFICATION drops no RECORD: `records`
 * is untouched, and the next read re-derives the truth from it.
 *
 * At the WRITE boundary dropping is not free, because the envelope would then be
 * persisted WITHOUT the records the payload claims are quarantined, so {@link
 * retainQuarantinedRecordsOnWrite} REFUSES an unregistered claim rather than
 * ignoring it. Neither guard is a statement about the caller's intent: a copied
 * payload and a forged one are the same value here, and both are refused.
 *
 * ── PURITY ──────────────────────────────────────────────────────────────────
 *
 * Pure functions only: no fs, no process, no I/O. The read boundary
 * (`core/store.ts`) does the I/O and calls in here. {@link
 * classifyRedEvidenceArtifact} is the TOTAL entry point — it returns a
 * classification and never throws; {@link validateRedEvidenceArtifact} is the
 * thin throwing wrapper the store uses.
 */
import { classifyRedRecordSchema, classifyRedRecordSchemaSafe, RedEvidenceSchemaError } from './red-evidence/record-v2.js';
import type { RedEvidenceData, RedEvidenceMalformedRecord, RedEvidenceRecord } from './types.js';

/** Compile-time assertion that `T` is uninhabited. A non-`never` `T` is a tsc error. */
type AssertNever<T extends never> = T;

/**
 * The keys of `T` that are MANDATORY, i.e. whose declared type does not admit
 * `undefined`. Drives the field table below off the interface itself, so adding
 * or removing a mandatory member of `RedEvidenceRecord` is a COMPILE error here
 * rather than a silent validation hole. (The audit's line numbers for that
 * interface have drifted; this binds by symbol and cannot drift at all.)
 */
type RequiredKeysOf<T> = { [K in keyof T]-?: undefined extends T[K] ? never : K }[keyof T];

/** The FILE-level era literal (D-1). Bound to the interface so it cannot drift. */
const RED_EVIDENCE_FILE_SCHEMA_VERSION: RedEvidenceData['schemaVersion'] = 'proofstory.red_evidence.v1';

/**
 * `VALID_GREEN_RELATIONS` is module-private in `core/proofstory.ts` and that file
 * is out of this item's write set, so the list is restated here and pinned to the
 * interface's union by the exhaustiveness check below: a new relation added to
 * `RedEvidenceRecord` without being added here fails to compile.
 */
const V1_GREEN_RELATIONS = ['same_acceptance', 'regression_to_green', 'replacement'] as const;
type _GreenRelationsExhaustive = AssertNever<
  Exclude<RedEvidenceRecord['greenRelation']['relation'], (typeof V1_GREEN_RELATIONS)[number]>
>;

/** How one mandatory v1 field is checked. */
interface V1FieldSpec {
  readonly kind: 'string' | 'object';
  /** Closed value set, for a literal-union member such as `greenRelation.relation`. */
  readonly literals?: readonly string[];
  /**
   * D-5 carve-out. `true` ONLY for `observedFailure`: a blank value there is
   * legacy-tolerated and must reach the predicate as an ordinary non-satisfier,
   * never as a quarantined record. Every other mandatory string treats a blank
   * value as a violation, matching column B of
   * `packages/main/tests/red/red-b2aa7-migration-scan.mjs`.
   */
  readonly blankTolerated?: boolean;
  /** Mandatory members of a nested object field. */
  readonly children?: Readonly<Record<string, V1FieldSpec>>;
}

/**
 * Mandatory members of `RedEvidenceRecord['greenRelation']`. Typed as a mapped
 * type over the nested interface's required keys, so it is exhaustive by
 * construction.
 */
const V1_MANDATORY_GREEN_RELATION_FIELDS: {
  readonly [K in RequiredKeysOf<RedEvidenceRecord['greenRelation']>]: V1FieldSpec;
} = {
  targetRef: { kind: 'string' },
  relation: { kind: 'string', literals: V1_GREEN_RELATIONS },
};

/**
 * D-3 Axis A = (ii) FULL validation: EVERY mandatory field of
 * `RedEvidenceRecord`, not only the one the predicate happens to dereference.
 *
 * The mapped-type key set is the load-bearing part. `id`, `trigger` and
 * `createdAt` are mandatory on the interface yet are NEVER read by the gate
 * predicate, so a record missing only those SATISFIES the gate today. Including
 * them is what makes this full validation rather than the rejected narrow
 * option, and it is the licensed verdict movement of §8.3 — enumerated before
 * merge by the D-7 migration scan, which reported it empty on this corpus.
 */
const V1_MANDATORY_RECORD_FIELDS: {
  readonly [K in RequiredKeysOf<RedEvidenceRecord>]: V1FieldSpec;
} = {
  id: { kind: 'string' },
  trigger: { kind: 'string' },
  acceptanceTargetRef: { kind: 'string' },
  baselineHeadHash: { kind: 'string' },
  baselineMaterialHash: { kind: 'string' },
  // D-5: blank is legacy-tolerated here and ONLY here. See the header.
  observedFailure: { kind: 'string', blankTolerated: true },
  greenRelation: { kind: 'object', children: V1_MANDATORY_GREEN_RELATION_FIELDS },
  createdAt: { kind: 'string' },
};

/** The machine-readable envelope faults of §10.2.1. */
export type RedEvidenceEnvelopeFaultCode =
  /** E7 — the file is not valid JSON. */
  | 'unparseable'
  /** E5 — the JSON root is not an object (`[]`, `"x"`, `null`, `42`). */
  | 'root_not_object'
  /** E6 — no FILE-level `schemaVersion`; it must NOT silently degrade to v1. */
  | 'schema_version_missing'
  /** E6 — a FILE-level `schemaVersion` this build does not know. */
  | 'schema_version_unknown'
  /** E1 / E2 / E3 — `records` is present but is not an array. */
  | 'records_not_array';

/**
 * The SHARED corruption vocabulary (B-2aa7 CHK-006).
 *
 * Every corruption surface in the system opens with this exact phrase, so a
 * corrupt artifact can never be mistaken for an absent one by an operator
 * skimming output or by a grep over a transcript. The ordinary not-configured
 * wording ("not configured", "unavailable", "no red evidence") never carries it.
 * That distinction IS the story: §10.2.1 row E5 and the §4 `story_review`
 * degradation are both cases of corruption reading as absence.
 */
export const RED_EVIDENCE_CORRUPT_MARKER = 'red-evidence artifact is corrupt';

/**
 * Typed error for an ENVELOPE fault. Always NAMES THE ARTIFACT PATH, and never
 * describes the fault as a record fault — the whole point of row A8 / §2.4.
 *
 * It is deliberately a distinct class from `RedEvidenceSchemaError`
 * (`red-evidence/record-v2.ts`): that one means "a RECORD carries an unsupported
 * schemaVersion", this one means "the FILE is not a readable v1 artifact".
 * Collapsing them would re-create the misattribution this story removes.
 */
export class RedEvidenceArtifactError extends Error {
  readonly code: RedEvidenceEnvelopeFaultCode;
  readonly artifactPath: string;

  constructor(code: RedEvidenceEnvelopeFaultCode, artifactPath: string, detail: string, options?: { cause?: unknown }) {
    super(`${RED_EVIDENCE_CORRUPT_MARKER} [${code}]: ${detail} — file: ${artifactPath}`, options);
    this.name = 'RedEvidenceArtifactError';
    this.code = code;
    this.artifactPath = artifactPath;
  }
}

/**
 * E7. Build the typed replacement for the raw `SyntaxError` that used to escape
 * `JSON.parse` at the read boundary naming nothing. The requirement is a TYPED
 * throw NAMING THE PATH — not the absence of a throw — so callers rethrow this.
 */
export function redEvidenceArtifactParseError(artifactPath: string, cause: unknown): RedEvidenceArtifactError {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new RedEvidenceArtifactError('unparseable', artifactPath, `the file is not valid JSON (${detail})`, { cause });
}

/** A validated v1 envelope. */
export interface RedEvidenceEnvelope {
  /** The envelope object itself, still carrying its original members verbatim. */
  readonly value: Readonly<Record<string, unknown>>;
  /**
   * The on-disk `records` array, or `undefined` when the key is GENUINELY ABSENT.
   * Absent is NOT corruption: it is the ordinary not-configured shape (§10.2.1
   * row E4) and must stay distinguishable from a malformed one, so this is
   * `undefined` rather than a helpfully-substituted `[]`.
   */
  readonly records: readonly unknown[] | undefined;
}

/** Records partitioned by v1 well-formedness (D-4). */
export interface RedEvidenceRecordPartition {
  /** Well-formed v1 records, plus every non-v1 record, in their original order. */
  readonly records: readonly unknown[];
  /** Rejected entries, RETAINED with index, identifying field and reason. */
  readonly malformed: readonly RedEvidenceMalformedRecord[];
}

/** The total classification of an artifact (see {@link classifyRedEvidenceArtifact}). */
export type RedEvidenceArtifactClassification =
  | {
      readonly ok: true;
      readonly data: RedEvidenceData;
      /** Empty when the artifact is fully well-formed. */
      readonly malformed: readonly RedEvidenceMalformedRecord[];
    }
  | {
      readonly ok: false;
      /** `envelope` — the FILE is unreadable; `record_schema` — a RECORD carries an unsupported version. */
      readonly fault: 'envelope' | 'record_schema';
      readonly error: RedEvidenceArtifactError | RedEvidenceSchemaError;
    };

const hasOwn = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);

/**
 * A non-null, non-array object. Deliberately NOT a `constructor === Object`
 * check: `Object.create(null)` has no prototype at all and is still a perfectly
 * good record container — what must be rejected is a value REACHED THROUGH the
 * prototype chain, which {@link hasOwn} handles.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describeValue(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return `a ${typeof value}`;
}

/**
 * Validate the FILE envelope. Throws {@link RedEvidenceArtifactError} — never a
 * record-level error — so record code is only ever entered with a real array.
 */
export function validateRedEvidenceEnvelope(parsed: unknown, artifactPath: string): RedEvidenceEnvelope {
  // E5. The sharpest SILENCE in the audit: a non-object root does not crash,
  // it flows through as the raw parsed value and every consumer reads
  // `?.records ?? []` and concludes there is NO red evidence. A corrupt
  // artifact was therefore indistinguishable from an absent one. It is
  // rejected here rather than tolerated, which is why a crash-only fix would
  // have left this untouched.
  if (!isPlainObject(parsed)) {
    throw new RedEvidenceArtifactError(
      'root_not_object',
      artifactPath,
      `the JSON root is ${describeValue(parsed)}, not a red-evidence envelope object`,
    );
  }

  // E6 + D-1. The FILE declares the era, so a missing or unknown file-level
  // version must NOT silently degrade to v1: under D-1 a versionless record is
  // only *claimed* v1 BY ITS FILE, and a file that declares nothing cannot make
  // that claim on the record's behalf.
  if (!hasOwn(parsed, 'schemaVersion') || parsed.schemaVersion === undefined) {
    throw new RedEvidenceArtifactError(
      'schema_version_missing',
      artifactPath,
      `the envelope declares no file-level "schemaVersion"; it does not silently degrade to ${JSON.stringify(RED_EVIDENCE_FILE_SCHEMA_VERSION)}`,
    );
  }
  if (parsed.schemaVersion !== RED_EVIDENCE_FILE_SCHEMA_VERSION) {
    throw new RedEvidenceArtifactError(
      'schema_version_unknown',
      artifactPath,
      `unknown file-level "schemaVersion" ${JSON.stringify(parsed.schemaVersion)} — only ${JSON.stringify(RED_EVIDENCE_FILE_SCHEMA_VERSION)} is accepted (fail-closed)`,
    );
  }

  // E4. A genuinely absent `records` key is the ordinary not-configured shape,
  // not a fault. Reported as `undefined` and NOT substituted with `[]`, so the
  // caller can hand the envelope back byte-identically.
  if (!hasOwn(parsed, 'records') || parsed.records === undefined) {
    return { value: parsed, records: undefined };
  }

  // E1 / E2 / E3. The envelope fault that used to be misattributed to a record.
  // The message says ENVELOPE and names the file; it must never read as
  // "a record must be an object".
  if (!Array.isArray(parsed.records)) {
    throw new RedEvidenceArtifactError(
      'records_not_array',
      artifactPath,
      `the envelope field "records" is ${describeValue(parsed.records)}, not an array — this is an ENVELOPE fault, no record was read`,
    );
  }

  return { value: parsed, records: parsed.records };
}

/** Collect the v1 schema violations of one already-`'v1'`-classified entry. */
function v1RecordViolations(
  record: unknown,
  fields: Readonly<Record<string, V1FieldSpec>>,
  path = '',
): string[] {
  // An ARRAY record reaches here because `typeof [] === 'object'` and it carries
  // no `schemaVersion`, so `classifyRedRecordSchemaSafe` still calls it `'v1'`.
  // It is not a record (§10.2 row M7).
  if (!isPlainObject(record)) return [`not-a-plain-object:${path || '<record>'}`];

  const violations: string[] = [];
  for (const [name, spec] of Object.entries(fields)) {
    const label = path ? `${path}.${name}` : name;
    // `hasOwn`, deliberately: a PROTOTYPE-INHERITED value is visible to the
    // predicate's plain `record.x` read but is not a stored field, so it must
    // count as missing (§10.2 row M8).
    if (!hasOwn(record, name) || record[name] === undefined) {
      violations.push(`missing:${label}`);
      continue;
    }
    const value = record[name];
    if (spec.kind === 'string') {
      if (typeof value !== 'string') {
        violations.push(`wrong-type:${label}`);
      } else if (spec.literals && !spec.literals.includes(value)) {
        violations.push(`not-in-enum:${label}`);
      } else if (!spec.blankTolerated && value.trim().length === 0) {
        violations.push(`blank:${label}`);
      }
      continue;
    }
    if (!isPlainObject(value)) {
      violations.push(`wrong-type:${label}`);
      continue;
    }
    violations.push(...v1RecordViolations(value, spec.children ?? {}, label));
  }
  return violations;
}

/** The rejected entry's identifying field, when it has a usable one. */
function identifyingId(record: unknown): string | null {
  if (!isPlainObject(record) || !hasOwn(record, 'id')) return null;
  const id = record.id;
  return typeof id === 'string' && id.trim().length > 0 ? id : null;
}

/**
 * D-4 quarantine. Splits entries into the clean `records` the typed domain sees
 * and the RETAINED `malformed` list. Total: never throws, on any input.
 *
 * Only the `'v1'` residual class is shape-checked here. A `'v2'` record is the
 * record-v2 leaf's business and passes through UNCHANGED — a read-boundary
 * validator that rejected records it does not recognise would break the v2 union
 * (invariant row B1). An `'unsupported'` record is B-506e's fail-closed class,
 * already rejected upstream by `classifyRedRecordSchema`; it passes through here
 * so this function stays total for callers that use it directly.
 */
export function partitionRedEvidenceRecords(entries: readonly unknown[]): RedEvidenceRecordPartition {
  const records: unknown[] = [];
  const malformed: RedEvidenceMalformedRecord[] = [];

  entries.forEach((entry, index) => {
    if (classifyRedRecordSchemaSafe(entry) !== 'v1') {
      records.push(entry);
      return;
    }
    const violations = v1RecordViolations(entry, V1_MANDATORY_RECORD_FIELDS);
    if (violations.length === 0) {
      records.push(entry);
      return;
    }
    const id = identifyingId(entry);
    malformed.push({
      index,
      id,
      reason:
        `records[${index}]${id === null ? ' (no id)' : ` (id ${JSON.stringify(id)})`} ` +
        `is not well-formed under the legacy v1 red-evidence schema: ${violations.join(', ')}`,
      violations,
      // RETAIN-AND-REPORT: the rejected entry verbatim. Quarantine never drops.
      value: entry,
    });
  });

  return { records, malformed };
}

/**
 * THE PROVENANCE REGISTER for quarantine entries — the record of which objects
 * THIS MODULE derived, held OFF the values themselves.
 *
 * A derived entry has no shape a caller cannot type out: `index`, `id`,
 * `reason`, `violations`, `value` are five ordinary members, so a hand-written
 * object literal can satisfy any predicate that inspects only the value. Being
 * derived is not a property OF the value, so it cannot be checked BY the value,
 * and the register therefore lives beside it.
 *
 * A `WeakSet` rather than a branding property, symbol-keyed or otherwise,
 * because a property is a channel and this must not be one. It cannot be
 * serialised (so it can never appear on disk, never survive `JSON.stringify`,
 * and never make a written envelope differ by a byte); and it cannot be
 * enumerated or reflected off a genuine entry with
 * `Object.getOwnPropertySymbols`, so holding a real entry does not hand anyone
 * the means to mint a fake one. Entries are weakly held, so registering them
 * retains nothing.
 *
 * ── WHAT THIS DOES AND DOES NOT CLAIM ───────────────────────────────────────
 *
 * PRECISELY: a registered entry's `index` and `value` are what THIS MODULE
 * computed from some `records` array, not what anyone DECLARED about one. That
 * is the whole property, and it is exactly the property the write path needs,
 * because the write path re-inserts `value` at `index`.
 *
 * It is NOT a claim that the input was authentic. {@link
 * classifyRedEvidenceArtifact} is exported, so a caller may run bytes of their
 * own through it and receive registered entries — no file required. That buys
 * nothing: every `value` it registers was, by construction, an element of the
 * `records` array the caller passed in, at the index they put it, so restoring
 * the lot reproduces that same array. The reviewer's payload is the case this
 * closes — a DECLARED entry whose `value` was never in `records` at all, which
 * is how the write path was made to insert a record from nowhere. Note also
 * that an in-process caller holding `store.writeRedEvidence` needs none of
 * this: that method writes `records` verbatim and validates nothing, so this
 * register removes a laundering route, not a caller's ability to write.
 *
 * It is NOT value equality, and NOT cross-instance. Provenance identifies THE
 * OBJECT, so a copy of a derived entry — `structuredClone`, a JSON round trip,
 * a spread of the ENTRY — is a value the caller built and is treated as one.
 * (Spreading the DATA or the array keeps entry identity, which is why all three
 * live writers are unaffected.) That is deliberate, and is why {@link
 * retainQuarantinedRecordsOnWrite} REFUSES an unregistered claim instead of
 * ignoring it: a copying writer must be told, not silently written without the
 * records it says are quarantined.
 */
const DERIVED_QUARANTINE_ENTRIES = new WeakSet<object>();

/**
 * THE DERIVATION AUTHORITY for `malformedRecords`, and the ONLY producer of a
 * typed {@link RedEvidenceData} in this module.
 *
 * `malformedRecords` describes THIS read, so whatever the artifact carried under
 * that name is discarded and replaced by `malformed` — the classification the
 * validator just computed. Every outcome goes through here, including the
 * all-records-valid one, where the derived answer is "none" and the key is
 * therefore ABSENT rather than empty (an artifact that is merely clean must not
 * acquire a corruption surface; see the `RedEvidenceData` doc comment).
 *
 * The identity fast path is deliberate, not an optimisation: an artifact that
 * does NOT carry the key and has nothing to quarantine loads UNCHANGED — the
 * very object that was parsed, with its own `records` array, no copy and no
 * added key, which is the invariant the row-B / order-independence rows pin.
 * The copy happens only when there is something to strip or something to add.
 */
function withDerivedQuarantine(
  value: Readonly<Record<string, unknown>>,
  malformed: readonly RedEvidenceMalformedRecord[],
): RedEvidenceData {
  // PROVENANCE, registered in the derivation authority itself, because it is the
  // ONE place that knows an entry was derived rather than supplied. Freezing
  // first means a registered entry cannot afterwards be RE-TARGETED — `index`
  // and `value` are exactly what the write path dereferences.
  for (const entry of malformed) {
    Object.freeze(entry);
    DERIVED_QUARANTINE_ENTRIES.add(entry);
  }
  const inherited = hasOwn(value, 'malformedRecords');
  if (!inherited && malformed.length === 0) return value as unknown as RedEvidenceData;

  // The rest element is what performs the STRIP: an inherited key cannot
  // survive, whether or not this read has anything of its own to put back.
  const { malformedRecords: _inherited, ...envelope } = value;
  if (malformed.length === 0) return envelope as unknown as RedEvidenceData;
  return { ...envelope, malformedRecords: [...malformed] } as unknown as RedEvidenceData;
}

/**
 * TOTAL artifact classification: envelope first, then the B-506e per-record
 * version check, then D-4 quarantine of the v1 residual class. Returns a
 * classification instead of throwing, so it is safe to run over arbitrary
 * JSON-representable input.
 *
 * Every `ok: true` outcome is built by {@link withDerivedQuarantine}, so the
 * returned `malformedRecords` is always this read's own classification and never
 * a value the artifact supplied.
 */
export function classifyRedEvidenceArtifact(parsed: unknown, artifactPath: string): RedEvidenceArtifactClassification {
  let envelope: RedEvidenceEnvelope;
  try {
    envelope = validateRedEvidenceEnvelope(parsed, artifactPath);
  } catch (e) {
    if (e instanceof RedEvidenceArtifactError) return { ok: false, fault: 'envelope', error: e };
    throw e;
  }

  // A genuinely absent `records` key: hand the envelope back UNCHANGED. Adding a
  // `records: []` here would erase the distinction between "not configured" and
  // "configured but empty" that invariant row B2 pins.
  //
  // "Unchanged" means its own members, NOT an on-disk `malformedRecords`: an
  // envelope with no records cannot have had a record quarantined, so the
  // derived answer is "none" and any inherited key is stripped. Without that,
  // a records-less artifact was the shortest injection vector of all — nothing
  // to validate, and a fabricated classification straight into the typed domain.
  if (envelope.records === undefined) {
    return { ok: true, data: withDerivedQuarantine(envelope.value, []), malformed: [] };
  }

  // §6.4 fail-closed forward-compatibility (W2c / B-506e), UNCHANGED and still
  // ahead of any v1 shape check: a record carrying an UNSUPPORTED per-record
  // `schemaVersion` (a future v3, a typo, a corrupted value) is rejected rather
  // than accepted into `records[]`. It is now reached only after the envelope is
  // known good, so it can no longer be handed the characters of a string.
  try {
    for (const record of envelope.records) classifyRedRecordSchema(record);
  } catch (e) {
    if (e instanceof RedEvidenceSchemaError) return { ok: false, fault: 'record_schema', error: e };
    throw e;
  }

  const partition = partitionRedEvidenceRecords(envelope.records);
  if (partition.malformed.length === 0) {
    // A well-formed artifact loads UNCHANGED: the very object that was parsed,
    // with its own `records` array. No copy, no reordering, no added key.
    //
    // EXCEPT an on-disk `malformedRecords`, which is not one of "its own"
    // members in any meaningful sense — it is a claim about a read that had not
    // happened yet. Every record here validated, so THIS read's classification
    // is "none", and that is what the typed domain gets. This is the exact
    // return the injection travelled through.
    return { ok: true, data: withDerivedQuarantine(envelope.value, []), malformed: [] };
  }

  // Quarantined. `records` is the clean subset; the rejected entries are
  // retained on a SEPARATE key so absence and corruption stay distinguishable.
  // The key is written from `partition.malformed` alone — an inherited value is
  // replaced, never merged with, this read's own findings.
  const data = withDerivedQuarantine(
    { ...envelope.value, records: partition.records },
    partition.malformed,
  );
  return { ok: true, data, malformed: partition.malformed };
}

/**
 * The read boundary's entry point: {@link classifyRedEvidenceArtifact}, with an
 * envelope or unsupported-record fault rethrown as its typed error.
 */
export function validateRedEvidenceArtifact(parsed: unknown, artifactPath: string): RedEvidenceData {
  const classified = classifyRedEvidenceArtifact(parsed, artifactPath);
  if (!classified.ok) throw classified.error;
  return classified.data;
}

// ─────────────────────────────────────────────────────────────────────────────
// CONSUMER SURFACE (B-2aa7 CHK-006 — audit §9 and §10.4 rows C1 / C2 / C3)
//
// CHK-004 stopped the READ boundary crashing and lying. That is only half the
// defect. A consumer can still take a correctly-classified corrupt artifact and
// make it read as an ABSENT one — the gate says `missing_red_evidence`,
// `red_evidence_get` says "not configured", `story_review` says "unavailable" —
// which is the same silence §10.2.1 row E5 and §4 describe. And one consumer
// class can do worse than mis-render: it can DESTROY evidence.
//
// So there are two obligations here, and they are not the same obligation:
//
//   DISPLAY   Every consumer must render corruption DISTINCTLY FROM ABSENCE.
//             {@link RED_EVIDENCE_CORRUPT_MARKER} is the one phrase they all
//             share; {@link renderRedEvidenceQuarantineNotice} covers the
//             quarantined case (no throw) and
//             {@link describeRedEvidenceReadFailure} the rejected case (throw).
//
//   PRESERVE  Quarantine retains rejected entries IN MEMORY ONLY. `records`
//             reaches the typed domain CLEAN, so any consumer that reads and
//             writes back a REBUILT envelope silently drops the quarantined
//             originals from disk — an operator repairing a corrupt artifact
//             with `red_evidence_create` would delete the very evidence they
//             came to repair. {@link restoreQuarantinedRecords} is the
//             write-path counterpart that makes repair-by-append non-destructive
//             and FAILS CLOSED rather than guessing.
//
// Pure, like the rest of this file: these render and re-order values, they never
// read the filesystem and never decide a gate verdict.
// ─────────────────────────────────────────────────────────────────────────────

/** The sentence appended to every corruption surface, so absence can never be inferred from it. */
const NOT_ABSENCE = 'This is CORRUPTION, not an absent or unconfigured artifact.';

/**
 * Did THIS MODULE derive `value`, and is it shaped the way its derivation shapes
 * one? Both, in that order, and the order is the point.
 *
 * PROVENANCE is the acceptance rule. Shape cannot be: an entry is five ordinary
 * members, so anything a shape check accepts, a caller can type out — which is
 * how a hand-built payload reached the write path and had its `value` inserted
 * into `records`. {@link DERIVED_QUARANTINE_ENTRIES} answers the question shape
 * cannot, and it answers it about the object rather than about its bytes.
 *
 * SHAPE is kept as the second half, and is now defence in depth rather than the
 * guarantee. A registered entry is frozen at registration and comes from one
 * construction site, so these checks are expected to be redundant; they stay
 * because {@link restoreQuarantinedRecords} DEREFERENCES `index` and `value`,
 * and because their coupling to {@link partitionRedEvidenceRecords}' output is
 * asserted mechanically by
 * `packages/main/tests/red/red-b2aa7-quarantine-derivation.mjs` — every derived
 * entry must satisfy this predicate, or {@link redEvidenceQuarantinedRecords}
 * would be silently discarding real quarantine state instead of junk.
 *
 * `value` is deliberately unconstrained — it is the rejected record VERBATIM,
 * and constraining it would defeat retain-and-report. What is constrained is
 * everything the write path DEREFERENCES: the index it restores to, and the
 * fields the operator-facing notice prints.
 */
function isDerivedQuarantineEntry(value: unknown): value is RedEvidenceMalformedRecord {
  if (!isPlainObject(value)) return false;
  if (!DERIVED_QUARANTINE_ENTRIES.has(value)) return false;
  if (!hasOwn(value, 'index') || !Number.isInteger(value.index) || (value.index as number) < 0) return false;
  if (!hasOwn(value, 'id') || !(typeof value.id === 'string' || value.id === null)) return false;
  if (!hasOwn(value, 'reason') || typeof value.reason !== 'string') return false;
  if (!hasOwn(value, 'violations') || !Array.isArray(value.violations)) return false;
  if (!value.violations.every((v) => typeof v === 'string')) return false;
  // Present, but of any shape: this IS the retained original.
  return hasOwn(value, 'value');
}

/**
 * The entries the read boundary quarantined. Empty for an ABSENT artifact and
 * empty for a clean one — deliberately the same answer, because neither is
 * corruption, and the two are already distinguished by `data === null`.
 *
 * TOTAL, and it honours PROVENANCE rather than shape. On a value that came from
 * {@link classifyRedEvidenceArtifact} this is a plain read: that function is the
 * derivation authority and every entry it produces satisfies
 * {@link isDerivedQuarantineEntry}. But `RedEvidenceData` is also handed around
 * by callers that build it themselves, so this function treats
 * `malformedRecords` as UNTRUSTED INPUT rather than as a fact:
 *
 *   - a non-array (object, string, number) yields `[]`. It previously reached
 *     `for…of` and `.map` and produced a bare `TypeError` inside gate rendering
 *     — and a STRING was worse than a crash: it iterated as its own characters,
 *     the same misattribution §2.4 removed from the record path.
 *   - an entry this module did not derive is DROPPED — however well-formed it
 *     looks, and a hand-built one can look perfect — so it can never be
 *     re-inserted into `records` by the write path.
 *
 * It stays TOTAL, and silent, because it renders on GATE paths: a caller-built
 * payload must produce a count here, never a throw out of a gate. The loud half
 * belongs to the write boundary, where dropping a claim would cost records:
 * {@link retainQuarantinedRecordsOnWrite} REFUSES what this function drops. The
 * two are answering different questions — "what did this read quarantine"
 * (nothing, if nothing was derived) versus "am I about to write an envelope
 * missing records something claims are quarantined" (then stop).
 *
 * Dropping a bogus CLASSIFICATION is not dropping a RECORD: `records` is not
 * touched here, nothing on disk is lost, and the next read re-derives the true
 * quarantine from the records themselves. D-4's "never drop" governs rejected
 * RECORDS; it does not oblige anyone to honour a fabricated report about them.
 */
export function redEvidenceQuarantinedRecords(
  data: RedEvidenceData | null | undefined,
): readonly RedEvidenceMalformedRecord[] {
  const raw: unknown = data?.malformedRecords;
  if (!Array.isArray(raw)) return [];
  return raw.filter(isDerivedQuarantineEntry);
}

/**
 * Operator-facing summary of a QUARANTINED artifact, or `null` when there is
 * nothing to report.
 *
 * Returning `null` — rather than an empty string or a "no corruption" line — is
 * load-bearing: a caller can only render corruption where corruption exists, so
 * this cannot be the source of a false corruption report on a clean or absent
 * artifact (the inverse of the defect, and just as bad).
 */
export function renderRedEvidenceQuarantineNotice(
  storyId: string,
  data: RedEvidenceData | null | undefined,
): string | null {
  const quarantined = redEvidenceQuarantinedRecords(data);
  if (quarantined.length === 0) return null;
  // TOTAL: this renders on gate paths (`core/machine.ts`, `handlers/phase-gates.ts`,
  // `handlers/story-review.ts`), so a payload whose `records` is not an array
  // must produce a count, not a `TypeError` out of a gate.
  const kept = Array.isArray(data?.records) ? data.records.length : 0;
  return [
    `${RED_EVIDENCE_CORRUPT_MARKER} [quarantined_records]: ${quarantined.length} of ${kept + quarantined.length} ` +
      `record(s) for story ${storyId} are not well-formed under the legacy v1 schema and were QUARANTINED at the ` +
      `read boundary. They are RETAINED, not dropped.`,
    ...quarantined.map((entry) => `  - ${entry.reason}`),
    `  ${NOT_ABSENCE}`,
  ].join('\n');
}

/**
 * Turn a CAUGHT read-boundary failure into an operator-facing corruption line,
 * or `null` when the failure is not a red-evidence artifact fault.
 *
 * The `null` return is the important half. A caller MUST rethrow on it: the §4
 * `story_review` degradation exists precisely because a blanket `catch` turned
 * every failure into one bland "unavailable" string, and a helper that
 * classified unrelated errors as corruption would just move that bug rather than
 * remove it.
 */
export function describeRedEvidenceReadFailure(error: unknown): string | null {
  if (error instanceof RedEvidenceArtifactError) {
    // Already opens with the marker and already names the artifact path.
    return `${error.message}\n  ${NOT_ABSENCE}`;
  }
  if (error instanceof RedEvidenceSchemaError) {
    // B-506e's per-record fail-closed class. Marked here so the RECORD fault and
    // the FILE fault share one operator vocabulary while staying separate types.
    return `${RED_EVIDENCE_CORRUPT_MARKER} [record_schema]: ${error.message}\n  ${NOT_ABSENCE}`;
  }
  return null;
}

/**
 * The single repair instruction every refusing consumer points at, so §9's
 * recoverability requirement is discoverable from wherever the operator hits it.
 */
export function redEvidenceRepairGuidance(storyId: string): string {
  return (
    `→ Inspect it with \`proof-or-stop red_evidence_get --storyId=${storyId}\` — that command DISPLAYS corruption ` +
    `instead of aborting (§9) — then repair red-evidence.json and retry.`
  );
}

/**
 * D-4's WRITE-path counterpart (§10.4 row C2) — the reason quarantine is
 * non-destructive rather than merely non-crashing.
 *
 * Quarantine hands the typed domain a CLEAN `records` array. Every appender in
 * the system then builds a NEW envelope from that clean array, so writing it
 * back persists the clean subset and DESTROYS the quarantined originals. This
 * re-inserts every quarantined entry VERBATIM at the index it occupied on disk,
 * so what gets written is the on-disk array plus whatever the rebuild appended —
 * the operator repairs the artifact by appending, and loses nothing.
 *
 * The derived `malformedRecords` key is STRIPPED from the result: it is a read-
 * time classification, not part of the on-disk schema, and persisting it would
 * both pollute the envelope and let a later non-spreading appender drop the
 * originals for good. The next read re-derives it from the restored records.
 *
 * FAILS CLOSED. If `rebuilt` is not `read.records` followed by a suffix, or the
 * retained indices are not a unique interleaving, it throws and the caller must
 * refuse. Silently losing a record is the one outcome D-4 forbids, so guessing
 * is not an option — and a bad guess here is unrecoverable, unlike a refusal.
 *
 * A clean or absent read returns `rebuilt` UNCHANGED (by identity), so the
 * ordinary write path is exactly what it was before this function existed.
 */
export function restoreQuarantinedRecords(
  read: RedEvidenceData | null | undefined,
  rebuilt: RedEvidenceData,
): RedEvidenceData {
  const quarantined = redEvidenceQuarantinedRecords(read);
  if (quarantined.length === 0) return rebuilt;

  const refuse = (detail: string): never => {
    throw new Error(
      `${RED_EVIDENCE_CORRUPT_MARKER} [quarantine_retention]: refusing to write — ${detail} ` +
        `Writing anyway would DELETE ${quarantined.length} quarantined record(s) that are still on disk. Nothing written.`,
    );
  };

  // TOTAL over both inputs. `redEvidenceQuarantinedRecords` already refused to
  // hand back anything that is not a well-formed derived entry; these two guards
  // do the same for the arrays the reconstruction indexes into, so a malformed
  // payload produces the TYPED refusal below rather than a bare `TypeError`
  // (`.length` / `[i]` / `.slice` on a non-array) from inside a writer.
  const clean: readonly unknown[] = Array.isArray(read?.records) ? read.records : [];
  if (!Array.isArray(rebuilt.records)) {
    refuse(`the rebuilt envelope's "records" is ${describeValue(rebuilt.records)}, not an array, so on-disk positions cannot be restored.`);
  }
  if (rebuilt.records.length < clean.length) {
    refuse(
      `the rebuilt envelope holds ${rebuilt.records.length} record(s), fewer than the ${clean.length} well-formed ` +
        `record(s) that were read.`,
    );
  }
  for (let i = 0; i < clean.length; i += 1) {
    if (rebuilt.records[i] !== clean[i]) {
      refuse(`the rebuilt envelope reordered or replaced well-formed record ${i}, so on-disk positions cannot be restored.`);
    }
  }

  const total = clean.length + quarantined.length;
  const byIndex = new Map<number, RedEvidenceMalformedRecord>();
  for (const entry of quarantined) {
    if (!Number.isInteger(entry.index) || entry.index < 0 || entry.index >= total || byIndex.has(entry.index)) {
      refuse(`quarantined entry index ${String(entry.index)} is not a unique position in a ${total}-record artifact.`);
    }
    byIndex.set(entry.index, entry);
  }

  const restored: unknown[] = [];
  let nextClean = 0;
  for (let i = 0; i < total; i += 1) {
    const entry = byIndex.get(i);
    if (entry) {
      restored.push(entry.value);
      continue;
    }
    restored.push(clean[nextClean]);
    nextClean += 1;
  }

  const { malformedRecords: _derived, ...envelope } = rebuilt;
  return {
    ...envelope,
    // The on-disk order verbatim, then whatever the rebuild appended. The values
    // are re-inserted UNVALIDATED on purpose: they are the operator's original
    // bytes, and the read boundary will quarantine them again on the next read.
    records: [...restored, ...rebuilt.records.slice(clean.length)] as RedEvidenceData['records'],
  };
}

/**
 * Refuse to write an envelope whose `malformedRecords` this module did not
 * derive — the loud counterpart to {@link redEvidenceQuarantinedRecords}'
 * silent drop, placed where dropping would COST something.
 *
 * A caller-built classification cannot be honoured (it would inject its `value`s
 * into `records`), but it also cannot be ignored: ignoring it writes an envelope
 * whose `records` omits every record the payload says is quarantined, which
 * deletes them from disk with nobody told. Both halves are avoided by refusing,
 * and refusing costs the honest caller nothing — the object `readRedEvidence`
 * returned, and any spread of it, keeps its entries and passes.
 *
 * A non-array or empty `malformedRecords` claims NOTHING, so there is nothing to
 * lose and nothing to inject: it passes and is stripped like any other junk key.
 * That keeps a file-borne value harmless — the read boundary strips such keys
 * before any writer sees them, so this refusal is reachable only from an
 * in-process payload that never went through `store.readRedEvidence`, never from
 * an artifact on disk. A crafted file cannot make a write fail here.
 *
 * NOT a {@link RED_EVIDENCE_CORRUPT_MARKER} error, deliberately. The artifact on
 * disk is not corrupt and the operator has nothing to repair; the fault is in
 * the calling code, and pointing an operator at `red_evidence_get` would be a
 * diagnosis the evidence does not support.
 */
function refuseUnderivedQuarantineClaim(data: RedEvidenceData): void {
  const raw: unknown = data?.malformedRecords;
  if (!Array.isArray(raw) || raw.length === 0) return;
  const derived = raw.filter(isDerivedQuarantineEntry).length;
  if (derived === raw.length) return;
  throw new Error(
    `red-evidence write refused [quarantine_provenance]: the envelope carries ${raw.length} \`malformedRecords\` ` +
      `entr(ies), ${raw.length - derived} of which this process did not derive. \`malformedRecords\` is READ-TIME ` +
      `CLASSIFICATION, so only the value \`store.readRedEvidence\` produced can be honoured — a caller-built entry is ` +
      `indistinguishable from a fabricated one by its shape, and honouring it would insert its \`value\` into \`records\`, ` +
      `which is the evidence the DEV / REVIEW / DONE gates read. Ignoring it instead would write this envelope WITHOUT ` +
      `those ${raw.length} record(s), deleting them from disk. Nothing written.\n` +
      `  → Write the object \`store.readRedEvidence\` returned, or a spread of it (which keeps its entries), or omit ` +
      `\`malformedRecords\` to state explicitly that this write retains nothing.`,
  );
}

/**
 * D-4's LAST LINE OF DEFENCE — the same retention rule applied at the WRITE
 * boundary itself, to whatever envelope is about to be persisted.
 *
 * ── WHY A CALLER-LEVEL REMEDY WAS NOT ENOUGH ────────────────────────────────
 *
 * {@link restoreQuarantinedRecords} makes retention available to a caller that
 * remembers to ask for it. `red_evidence_create` does. The chain commands could
 * not — `core/red-evidence/append.ts` is owned by the merged sibling B-506e — so
 * they were given a corruption PRECHECK instead, refusing when the artifact they
 * read holds quarantined records.
 *
 * That precheck runs BEFORE the chain lock, and `appendControlRecord` takes the
 * lock and performs its OWN second read inside it, rebuilding from THAT read's
 * clean `records`. The two reads are different reads, so the precheck guards a
 * value the write is not derived from: if the artifact becomes malformed in the
 * window between them, the locked read quarantines the new entries and the
 * rebuild writes back only the clean subset. A pre-lock refusal cannot close a
 * post-lock window, and the loss is silent.
 *
 * Placing the rule at the write boundary protects EVERY writer instead of one
 * caller — including the blocked one, and including writers that do not exist
 * yet, which is the class of defect that produced this one.
 *
 * ── WHY IT RESTORES RATHER THAN REJECTS ─────────────────────────────────────
 *
 * A payload carrying `malformedRecords` descends from a quarantining read whose
 * rebuild did not restore. Refusing the write would also prevent the loss, but
 * it would fail an otherwise-correct operation to do it, and it would answer a
 * "never drop" rule with "never write". Restoring is the rule itself: the
 * artifact keeps what it had, plus whatever the caller appended. It is not a
 * guess — {@link restoreQuarantinedRecords} FAILS CLOSED when the reconstruction
 * cannot be proven, so refusal still happens exactly where a guess would
 * otherwise be needed.
 *
 * A writer that genuinely intends to drop malformed records still can: it must
 * hand over an envelope that does not carry the read's classification, which is
 * the explicit act this guard asks of it.
 *
 * ── WHY IT KEYS OFF THE PAYLOAD ─────────────────────────────────────────────
 *
 * The quarantined originals travel WITH the envelope (`malformedRecords` carries
 * each entry verbatim plus its on-disk index), so the payload is self-describing
 * and the guard needs no memory of a prior read — no per-store cache to go stale
 * and no cross-process state to be wrong about. What it cannot see, it does not
 * pretend to see: an envelope built from scratch rather than from a read carries
 * no classification and is passed through unchanged.
 *
 * Keying off the payload is only safe because the payload's classification can
 * only have been DERIVED, and that has to hold against a caller as well as
 * against a file, because this function re-inserts `entry.value` into `records`
 * and `records` is the evidence the DEV / REVIEW / DONE gates read. Two
 * different sources, two different guards:
 *
 *   FROM A FILE     {@link classifyRedEvidenceArtifact} strips any on-disk
 *                   `malformedRecords` and re-attaches its own, so a read can
 *                   never carry an artifact's own claim about itself.
 *   FROM A CALLER   {@link redEvidenceQuarantinedRecords} honours only entries
 *                   registered in {@link DERIVED_QUARANTINE_ENTRIES}, i.e. the
 *                   objects this module derived. Shape alone would not do it —
 *                   a quarantine entry is five ordinary members and a hand-
 *                   written literal can satisfy any check of its bytes, which
 *                   is precisely how this function was reproduced as an
 *                   injection primitive by direct call.
 *
 * So a caller-built classification is not honoured. This function does not stop
 * there and pass it through, because passing it through is its own defect: the
 * envelope would be written WITHOUT the records it claims are quarantined, and
 * D-4's one forbidden outcome is losing a record silently. An unregistered claim
 * is therefore REFUSED — see {@link refuseUnderivedQuarantineClaim} — so the
 * dishonest case and the merely-copied case both stop here instead of one being
 * injected and the other being deleted.
 *
 * The derived key is ALWAYS stripped, never persisted. It is read-time
 * classification, not part of the on-disk schema, and a persisted copy would
 * both pollute the envelope and be re-derived as stale corruption by every later
 * read.
 */
export function retainQuarantinedRecordsOnWrite(data: RedEvidenceData): RedEvidenceData {
  refuseUnderivedQuarantineClaim(data);
  // Self-restore: the payload is both the read that quarantined and the envelope
  // being written. `clean` is therefore the payload's own `records`, so the
  // prefix-identity check is trivially satisfied and the interleave re-inserts
  // each retained entry at its recorded on-disk index, leaving anything the
  // caller appended after it. The index bounds / uniqueness checks — and the
  // fail-closed refusal — still apply.
  const restored = restoreQuarantinedRecords(data, data);
  if (!hasOwn(restored, 'malformedRecords')) return restored;
  const { malformedRecords: _derived, ...envelope } = restored;
  return envelope as RedEvidenceData;
}

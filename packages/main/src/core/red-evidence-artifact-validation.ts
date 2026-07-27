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
 * ── KNOWN HAND-OFF TO CHK-006 (consumer behaviour) ──────────────────────────
 *
 * Quarantine keeps `records` clean, so a consumer that reads an artifact and
 * writes a REBUILT envelope back would persist the clean `records` and lose the
 * quarantined originals from disk. `appendRedEvidence` (`core/proofstory.ts`)
 * and `appendControlRecord` (`core/red-evidence/append.ts`) both rebuild the
 * envelope that way. Retention here is in-memory and complete (each entry keeps
 * its verbatim `value`); making the WRITE path preserve it is CHK-006's
 * `red_evidence_add` obligation — "repair by appending, or refuse with an
 * actionable message, never leave the artifact unrepairable" (§10.4 row C2).
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
    super(`red-evidence artifact is corrupt [${code}]: ${detail} — file: ${artifactPath}`, options);
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
 * TOTAL artifact classification: envelope first, then the B-506e per-record
 * version check, then D-4 quarantine of the v1 residual class. Returns a
 * classification instead of throwing, so it is safe to run over arbitrary
 * JSON-representable input.
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
  if (envelope.records === undefined) {
    return { ok: true, data: envelope.value as unknown as RedEvidenceData, malformed: [] };
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
    return { ok: true, data: envelope.value as unknown as RedEvidenceData, malformed: [] };
  }

  // Quarantined. `records` is the clean subset; the rejected entries are
  // retained on a SEPARATE key so absence and corruption stay distinguishable.
  const data = {
    ...envelope.value,
    records: partition.records,
    malformedRecords: partition.malformed,
  } as unknown as RedEvidenceData;
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

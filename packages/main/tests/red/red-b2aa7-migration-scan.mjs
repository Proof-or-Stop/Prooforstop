#!/usr/bin/env node
/**
 * D-7 MIGRATION SCAN (B-2aa7, CHK-003) — the only instrument that can detect the
 * verdict movement this story knowingly licenses.
 *
 * WHY THIS EXISTS
 * ---------------
 * The story chose Axis A = (ii) FULL v1 validation (audit §8.2, decision D-3).
 * §8.3 states the constraint that choice must satisfy:
 *
 *   > No record that is **well-formed under the legacy v1 schema** and that
 *   > previously produced a SATISFIED verdict may produce a different outcome.
 *   > Records that are **not** well-formed may change outcome; every such change
 *   > must be enumerated and justified before merge.
 *
 * The second sentence is a standing obligation, not a footnote: the v1 predicate
 * NEVER READS `id`, `trigger` or `createdAt`, yet all three are mandatory on
 * `RedEvidenceRecord`. A record missing only those satisfies the gate TODAY and
 * would be reclassified as malformed under full validation — a real verdict
 * change on a store that previously produced one.
 *
 * `red-w2c-v1-verdict-invariance.mjs` CANNOT see this: all five of its fixtures
 * are well-formed, so its digest is insensitive to the narrow-vs-full choice
 * (audit §8.2 last paragraph). Without this scan, "no valid verdict moved" is an
 * assumption, not a proof. That is decision D-7, and §12.1 states it as four
 * obligations, which map onto this file one-for-one:
 *
 *   1. enumerate every reachable `red-evidence.json`      -> discoverArtifacts()
 *   2. per record compute (today, under full validation)  -> classifyRecord()
 *   3. merge only if that set is empty or each entry is justified -> exit code
 *   4. report the count EVEN WHEN EMPTY                   -> the summary line
 *
 * WHY IT RE-IMPLEMENTS THE PREDICATE INSTEAD OF IMPORTING IT
 * ----------------------------------------------------------
 * This scan must stay meaningful when it is re-run AT MERGE TIME — i.e. after
 * CHK-004/CHK-005 have landed. If it imported the live predicate, "verdict today"
 * would silently become "verdict after the fix", both columns would agree by
 * construction and the affected set would be trivially empty forever. So
 * `satisfiesUnderPreFixPredicate` below is a deliberately FROZEN transcription of
 * `redEvidenceRecordSatisfied` (`packages/main/src/core/proofstory.ts`, located by
 * symbol — line numbers in the audit have drifted) as it behaves BEFORE the fix.
 * The v1/v2 discrimination likewise mirrors `classifyRedRecordSchemaSafe`
 * (`core/red-evidence/record-v2.ts`).
 *
 * The other column, by contrast, is DERIVED AT RUNTIME rather than transcribed:
 * `deriveMandatoryFields()` parses the `RedEvidenceRecord` interface out of
 * `core/types.ts` by symbol, so if a mandatory field is added or removed the scan
 * follows the interface instead of drifting away from it.
 *
 * NOTHING IS PINNED. A PLAN-phase exploratory run on one machine saw 105
 * artifacts / 144 records / 0 affected. That is one machine at one moment, and
 * parallel sessions create stories continuously, so every number below is
 * recomputed on each run. To prove the instrument is live rather than a constant
 * `0`, each run FIRST executes a self-test over synthetic fixtures in a throwaway
 * temp dir (a record missing only `trigger` MUST be reported affected; a
 * well-formed control MUST NOT), through the exact same code path. A scan that
 * always prints 0 proves nothing; this one demonstrates it can print non-zero
 * before it claims zero.
 *
 * Markers are printed ONLY when their condition genuinely holds, so a pinned
 * `--selector` cannot match a run in which the condition failed.
 *
 * Usage, from the repository root:
 *   node packages/main/tests/red/red-b2aa7-migration-scan.mjs            # scan this checkout
 *   node packages/main/tests/red/red-b2aa7-migration-scan.mjs <root>...  # scan explicit roots
 *   node packages/main/tests/red/red-b2aa7-migration-scan.mjs --json     # machine-readable
 *
 * Exit code: 0 when the affected set is empty, 1 when it is not (each hit must
 * then be dispositioned in the story record per D-7) or when the scan cannot
 * vouch for itself.
 */
import { readFileSync, readdirSync, statSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, relative } from 'node:path';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, '..', '..', '..', '..'); // packages/main/tests/red -> repo root
const TYPES_FILE = join(REPO_ROOT, 'packages', 'main', 'src', 'core', 'types.ts');

const argv = process.argv.slice(2);
const JSON_OUT = argv.includes('--json');
const explicitRoots = argv.filter((a) => !a.startsWith('--'));

/** Directories that can never contain a real story store, pruned for speed. */
const PRUNE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next', '.cache']);

/** The exact v2 discriminant literal (`core/red-evidence/record-v2.ts`). */
const RED_EVIDENCE_V2_SCHEMA_VERSION = 'proofstory.red_evidence.v2';

/** Frozen copy of `VALID_GREEN_RELATIONS` (`core/proofstory.ts`). */
const VALID_GREEN_RELATIONS = new Set(['same_acceptance', 'regression_to_green', 'replacement']);

/**
 * Every record field the PRE-FIX predicate dereferences. Used only for the
 * anti-vacuity self-check: if the mandatory set derived from the interface were
 * ever a subset of this, no record could POSSIBLY be "satisfies today but
 * schema-invalid" and the scan would be structurally incapable of finding
 * anything. That must be an error, not a silent zero.
 */
const PREDICATE_READ_FIELDS = new Set([
  'schemaVersion',
  'observedFailure',
  'failingCommand',
  'failureReceiptHash',
  'acceptanceTargetRef',
  'baselineHeadHash',
  'baselineMaterialHash',
  'greenRelation',
  'expectedGreenCommand',
]);

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

// ─────────────────────────────────────────────────────────────────────────────
// 1. Mandatory v1 field set — DERIVED from the interface, not transcribed.
// ─────────────────────────────────────────────────────────────────────────────

/** Strip block and line comments so `/** ... *\/` docs cannot be read as members. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/** Extract the balanced `{...}` body that follows `marker` in `src`. */
function balancedBody(src, marker) {
  const at = src.indexOf(marker);
  if (at === -1) return null;
  const open = src.indexOf('{', at);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return null;
}

/** Split an interface body into top-level `name: type` members. */
function parseMembers(body) {
  const members = [];
  let depth = 0;
  let buf = '';
  const flush = () => {
    const chunk = buf.trim();
    buf = '';
    if (!chunk) return;
    const m = /^([A-Za-z_$][\w$]*)(\?)?\s*:\s*([\s\S]+)$/.exec(chunk);
    if (!m) return;
    members.push({ name: m[1], optional: m[2] === '?', typeText: m[3].trim() });
  };
  for (const ch of body) {
    if (ch === '{' || ch === '[' || ch === '(') depth += 1;
    if (ch === '}' || ch === ']' || ch === ')') depth -= 1;
    if ((ch === ';' || ch === ',' || ch === '\n') && depth === 0) {
      // `;` and `,` terminate a member; a bare newline does too for members
      // written without a terminator.
      flush();
      continue;
    }
    buf += ch;
  }
  flush();
  return members;
}

/** Turn a parsed member into a validation spec. */
function toSpec(member) {
  const t = member.typeText;
  if (t.startsWith('{')) {
    const inner = balancedBody(t, '{');
    return {
      name: member.name,
      optional: member.optional,
      kind: 'object',
      children: inner === null ? [] : parseMembers(inner).map(toSpec),
    };
  }
  const literalUnion = t.split('|').map((p) => p.trim());
  if (literalUnion.length > 1 && literalUnion.every((p) => /^'[^']*'$/.test(p))) {
    return {
      name: member.name,
      optional: member.optional,
      kind: 'string',
      literals: literalUnion.map((p) => p.slice(1, -1)),
    };
  }
  if (t === 'string' || /^'[^']*'$/.test(t)) {
    return { name: member.name, optional: member.optional, kind: 'string', literals: /^'[^']*'$/.test(t) ? [t.slice(1, -1)] : undefined };
  }
  return { name: member.name, optional: member.optional, kind: 'other' };
}

function deriveMandatoryFields() {
  const src = stripComments(readFileSync(TYPES_FILE, 'utf8'));
  const body = balancedBody(src, 'export interface RedEvidenceRecord');
  if (body === null) {
    throw new Error(
      `could not locate 'export interface RedEvidenceRecord' in ${TYPES_FILE} — the symbol moved or was renamed; ` +
        'the scan refuses to run against an undeclared schema rather than report a meaningless 0',
    );
  }
  const specs = parseMembers(body).map(toSpec);
  return specs.filter((s) => !s.optional);
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Column B — full v1 schema validity.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validate one record against the derived mandatory field set. Returns the list
 * of violations; empty means well-formed under the legacy v1 schema.
 *
 * Presence is checked with `hasOwnProperty`, deliberately: a prototype-inherited
 * value (`Object.create(...)`) is visible to the pre-fix predicate's plain
 * `record.x` read but is NOT a stored field, so it must count as a violation.
 */
function v1SchemaViolations(record, mandatory, path = '') {
  if (!isPlainObject(record)) return [`${path || '<record>'}:not-a-plain-object`];
  const out = [];
  for (const spec of mandatory) {
    const label = path ? `${path}.${spec.name}` : spec.name;
    if (!hasOwn(record, spec.name) || record[spec.name] === undefined) {
      out.push(`missing:${label}`);
      continue;
    }
    const value = record[spec.name];
    if (spec.kind === 'string') {
      if (typeof value !== 'string') {
        out.push(`wrong-type:${label}`);
      } else if (spec.literals && !spec.literals.includes(value)) {
        out.push(`not-in-enum:${label}`);
      } else if (value.trim().length === 0) {
        out.push(`blank:${label}`);
      }
    } else if (spec.kind === 'object') {
      if (!isPlainObject(value)) {
        out.push(`wrong-type:${label}`);
      } else {
        out.push(...v1SchemaViolations(value, (spec.children ?? []).filter((c) => !c.optional), label));
      }
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Column A — the verdict TODAY, under the frozen pre-fix predicate.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Frozen transcription of `redEvidenceRecordSatisfied` (`core/proofstory.ts`),
 * pre-fix. Two deliberate deviations, both documented and both in the
 * OVER-reporting direction so the scan cannot miss a flip:
 *
 *  - `expectedTargets.has(record.acceptanceTargetRef)` is assumed TRUE. The real
 *    target set is per-story and derived from milestones/intents; assuming
 *    membership can only ADD records to "satisfies today", never remove one, so
 *    the affected set stays an upper bound. `!record.acceptanceTargetRef` (a
 *    record-local check) is still applied.
 *  - a TypeError escaping the predicate is reported as `crash`, not `satisfies`.
 *    A crash is not a verdict (audit §8), so it cannot be a verdict MOVEMENT —
 *    it is the OTHER defect class, owned by CHK-001/CHK-004/CHK-005.
 */
function satisfiesUnderPreFixPredicate(record) {
  try {
    // `isRedEvidenceV2` / `classifyRedRecordSchemaSafe`, frozen.
    if (typeof record === 'object' && record !== null && record.schemaVersion === RED_EVIDENCE_V2_SCHEMA_VERSION) return 'not-satisfied';
    if (typeof record !== 'object' || record === null) return 'not-satisfied'; // classify -> 'unsupported'
    if (record.schemaVersion !== undefined) return 'not-satisfied'; // classify -> 'unsupported'
    // From here the pre-fix predicate reads v1-only fields unguarded.
    if (record.observedFailure.trim().length === 0) return 'not-satisfied';
    if (!record.failingCommand && !record.failureReceiptHash) return 'not-satisfied';
    if (!record.acceptanceTargetRef) return 'not-satisfied';
    if (!record.baselineHeadHash || !record.baselineMaterialHash) return 'not-satisfied';
    if (!record.greenRelation || record.greenRelation.targetRef !== record.acceptanceTargetRef) return 'not-satisfied';
    if (!VALID_GREEN_RELATIONS.has(record.greenRelation.relation)) return 'not-satisfied';
    if (
      !record.expectedGreenCommand &&
      !record.greenRelation.command &&
      !record.greenRelation.greenHeadHash &&
      !record.greenRelation.greenMaterialHash
    )
      return 'not-satisfied';
    if (record.greenRelation.greenHeadHash && record.greenRelation.greenHeadHash === record.baselineHeadHash) return 'not-satisfied';
    if (record.greenRelation.greenMaterialHash && record.greenRelation.greenMaterialHash === record.baselineMaterialHash) return 'not-satisfied';
    return 'satisfied';
  } catch {
    return 'crash';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Enumeration.
// ─────────────────────────────────────────────────────────────────────────────

function discoverArtifacts(roots) {
  const found = [];
  const seen = new Set();
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable dir: not reachable
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (PRUNE_DIRS.has(entry.name)) continue;
        walk(full);
      } else if (entry.isFile() && entry.name === 'red-evidence.json') {
        let key = full;
        try {
          key = realpathSync(full);
        } catch {
          /* keep the literal path */
        }
        if (seen.has(key)) continue;
        seen.add(key);
        found.push(full);
      }
    }
  };
  for (const root of roots) {
    try {
      if (!statSync(root).isDirectory()) continue;
    } catch {
      continue;
    }
    walk(root);
  }
  found.sort();
  return found;
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. The scan itself.
// ─────────────────────────────────────────────────────────────────────────────

function scan(roots, mandatory) {
  const artifacts = discoverArtifacts(roots);
  const result = {
    artifacts: artifacts.length,
    records: 0,
    skippedVersioned: 0,
    envelopeFaults: [],
    affected: [],
    crashingToday: 0,
    /**
     * Records the frozen pre-fix predicate SATISFIES. Reported because it is the
     * denominator of the claim: "0 affected" out of 0 satisfying records would be
     * vacuously true, so a reader must be able to see that the corpus actually
     * contains verdicts that COULD have moved.
     */
    satisfiedToday: 0,
  };
  for (const file of artifacts) {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'));
    } catch (e) {
      result.envelopeFaults.push({ file, reason: `unparseable: ${e.message}` });
      continue;
    }
    if (!isPlainObject(parsed)) {
      result.envelopeFaults.push({ file, reason: `root is ${Array.isArray(parsed) ? 'an array' : `a ${parsed === null ? 'null' : typeof parsed}`}, not an object` });
      continue;
    }
    if (!hasOwn(parsed, 'records')) {
      // Ordinary "not configured" shape, not a fault: no records to move.
      continue;
    }
    if (!Array.isArray(parsed.records)) {
      result.envelopeFaults.push({ file, reason: `records is ${parsed.records === null ? 'null' : typeof parsed.records}, not an array` });
      continue;
    }
    parsed.records.forEach((record, index) => {
      result.records += 1;
      // A record carrying its OWN schemaVersion is v2 (or an unsupported future
      // version). Either way it is not the v1 predicate's business: the predicate
      // already skips it, and full v1 validation does not apply to it.
      if (isPlainObject(record) && record.schemaVersion !== undefined) {
        result.skippedVersioned += 1;
        return;
      }
      const today = satisfiesUnderPreFixPredicate(record);
      if (today === 'crash') {
        result.crashingToday += 1;
        return;
      }
      if (today !== 'satisfied') return;
      result.satisfiedToday += 1;
      const violations = v1SchemaViolations(record, mandatory);
      if (violations.length === 0) return; // well-formed AND satisfying: verdict provably cannot move
      result.affected.push({
        file,
        index,
        id: typeof record.id === 'string' ? record.id : '<no id>',
        verdictToday: 'SATISFIED',
        verdictUnderFullV1: 'UNSATISFIED (quarantined)',
        violations,
      });
    });
  }
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. Anti-vacuity self-test — run BEFORE the real scan, same code path.
// ─────────────────────────────────────────────────────────────────────────────

const WELL_FORMED_RECORD = {
  id: 'RED-1',
  trigger: 'acceptance',
  acceptanceTargetRef: 'AC-1',
  baselineHeadHash: 'head-base',
  baselineMaterialHash: 'material-base',
  failingCommand: 'node t.mjs',
  observedFailure: 'assertion failed',
  expectedGreenCommand: 'node t.mjs',
  greenRelation: { targetRef: 'AC-1', relation: 'same_acceptance', command: 'node t.mjs' },
  createdAt: '2026-01-01T00:00:00.000Z',
};

const drop = (record, field) => {
  const copy = { ...record };
  delete copy[field];
  return copy;
};

/**
 * Prove the instrument is live before trusting the number it prints on the real
 * corpus. One row per mandatory field the pre-fix predicate never reads — those
 * are exactly the fields §8 names as able to flip — plus a well-formed control
 * that must NOT be flagged, a v2 record that must be skipped, and three broken
 * envelopes that must be reported rather than dropped.
 */
function selfTest(mandatory) {
  const dir = mkdtempSync(join(tmpdir(), 'b2aa7-migration-scan-'));
  try {
    const storyDir = join(dir, 'stories', 'B-fixture');
    mkdirSync(storyDir, { recursive: true });
    writeFileSync(
      join(storyDir, 'red-evidence.json'),
      JSON.stringify({
        schemaVersion: 'proofstory.red_evidence.v1',
        storyId: 'B-fixture',
        records: [
          { ...WELL_FORMED_RECORD, id: 'CONTROL' },
          { ...drop(WELL_FORMED_RECORD, 'trigger'), id: 'FLIPS_MISSING_TRIGGER' },
          { ...drop(WELL_FORMED_RECORD, 'createdAt'), id: 'FLIPS_MISSING_CREATEDAT' },
          drop(WELL_FORMED_RECORD, 'id'),
          { ...WELL_FORMED_RECORD, id: 'FLIPS_BLANK_TRIGGER', trigger: '   ' },
          { schemaVersion: RED_EVIDENCE_V2_SCHEMA_VERSION, operation: 'red_assert', id: 'V2_SKIPPED' },
        ],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }),
      'utf8',
    );
    // Envelope faults must be RETAINED AND REPORTED, never silently dropped —
    // "clean empty output" reads exactly like an absent artifact.
    for (const [name, body] of [
      ['B-unparseable', '{not json'],
      ['B-records-string', JSON.stringify({ schemaVersion: 'proofstory.red_evidence.v1', records: 'x' })],
      ['B-array-root', '[]'],
    ]) {
      const d = join(dir, 'stories', name);
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, 'red-evidence.json'), body, 'utf8');
    }

    const probe = scan([dir], mandatory);
    const flagged = new Set(probe.affected.map((a) => a.id));
    const expectedFlags = ['FLIPS_MISSING_TRIGGER', 'FLIPS_MISSING_CREATEDAT', '<no id>', 'FLIPS_BLANK_TRIGGER'];
    const byId = (id) => probe.affected.find((a) => a.id === id);
    const checks = {
      artifacts: probe.artifacts === 4,
      records: probe.records === 6,
      v2Skipped: probe.skippedVersioned === 1,
      // The control satisfies today AND is well-formed, so it is a satisfying
      // record that correctly does NOT move.
      satisfiedDenominator: probe.satisfiedToday === 5,
      controlNotFlagged: !flagged.has('CONTROL'),
      allExpectedFlagged: expectedFlags.every((id) => flagged.has(id)),
      noExtraFlags: probe.affected.length === expectedFlags.length,
      triggerReason: (byId('FLIPS_MISSING_TRIGGER')?.violations ?? []).includes('missing:trigger'),
      createdAtReason: (byId('FLIPS_MISSING_CREATEDAT')?.violations ?? []).includes('missing:createdAt'),
      idReason: (byId('<no id>')?.violations ?? []).includes('missing:id'),
      blankReason: (byId('FLIPS_BLANK_TRIGGER')?.violations ?? []).includes('blank:trigger'),
      envelopeFaultsReported: probe.envelopeFaults.length === 3,
    };
    const failed = Object.entries(checks)
      .filter(([, v]) => !v)
      .map(([k]) => k);
    return { ok: failed.length === 0, failed, probe };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. Main.
// ─────────────────────────────────────────────────────────────────────────────

let mandatory;
try {
  mandatory = deriveMandatoryFields();
} catch (e) {
  console.error(`MIGRATION SCAN ABORTED: ${e.message}`);
  process.exit(1);
}
const mandatoryNames = mandatory.map((s) => s.name);
const unreadMandatory = mandatoryNames.filter((n) => !PREDICATE_READ_FIELDS.has(n));

const log = (line) => {
  if (!JSON_OUT) console.log(line);
};

log(`mandatory v1 fields derived from RedEvidenceRecord: ${mandatoryNames.join(', ')}`);
log(`  of which the pre-fix predicate never reads: ${unreadMandatory.join(', ') || '(none)'}`);

let fatal = null;
if (mandatoryNames.length === 0) {
  fatal = 'derived mandatory field set is EMPTY — every record would validate and the scan could only ever print 0';
} else if (unreadMandatory.length === 0) {
  fatal =
    'every mandatory field is already read by the pre-fix predicate — no record can be "satisfies today but schema-invalid", so this scan is structurally incapable of detecting a flip';
}

const st = fatal ? null : selfTest(mandatory);
if (!fatal && !st.ok) {
  fatal =
    `self-test FAILED (${st.failed.join(', ')}) — the scan did not behave as specified on synthetic fixtures, ` +
    `so any number it prints on the real corpus is meaningless (probe=${JSON.stringify(st.probe)})`;
}

if (fatal) {
  console.error(`MIGRATION SCAN ABORTED: ${fatal}`);
  process.exit(1);
}

log(
  `self-test: synthetic corpus (${st.probe.artifacts} artifacts / ${st.probe.records} records, ` +
    `${st.probe.satisfiedToday} satisfying today) -> ${st.probe.affected.length} affected ` +
    `[${st.probe.affected.map((a) => `${a.id}:${a.violations.join('+')}`).join(', ')}], ` +
    `${st.probe.skippedVersioned} v2 skipped, ${st.probe.envelopeFaults.length} envelope faults reported`,
);
// Condition-gated: prints ONLY when the same code path that scans the real tree
// demonstrably produced a NON-ZERO affected count on a known-bad fixture and a
// zero on the well-formed control. A hard-coded constant could not do both.
console.log('SCAN_RECOMPUTES_NOT_PINNED');

const roots = explicitRoots.length > 0 ? explicitRoots.map((r) => resolve(r)) : [REPO_ROOT];
const result = scan(roots, mandatory);

log('');
log(`roots: ${roots.map((r) => (r === REPO_ROOT ? `${r} (repository root)` : r)).join(', ')}`);
for (const fault of result.envelopeFaults) {
  log(`  ENVELOPE FAULT ${relative(REPO_ROOT, fault.file) || fault.file}: ${fault.reason}`);
}
for (const hit of result.affected) {
  log(
    `  AFFECTED ${relative(REPO_ROOT, hit.file) || hit.file} records[${hit.index}] id=${hit.id}: ` +
      `${hit.verdictToday} -> ${hit.verdictUnderFullV1}; violations: ${hit.violations.join(', ')}`,
  );
}

// Obligation 4: the count is stated positively, even when it is zero.
const summary = `scanned ${result.artifacts} artifacts / ${result.records} records, ${result.affected.length} affected`;
console.log(summary);
log(
  `  (of ${result.records} records: ${result.satisfiedToday} SATISFY the pre-fix predicate today and are the only ` +
    `records whose verdict could move — ${result.affected.length} of them are schema-invalid; ` +
    `${result.skippedVersioned} carry their own schemaVersion and are not v1; ` +
    `${result.crashingToday} crash the pre-fix predicate today, which is a crash class, not a verdict movement; ` +
    `${result.envelopeFaults.length} artifacts have envelope faults)`,
);

if (result.artifacts > 0) {
  // Condition-gated: obligations 1+2 actually happened over a non-empty corpus.
  console.log('MIGRATION_SCAN_ENUMERATED_AND_COUNTED');
}
if (result.affected.length === 0) {
  // Condition-gated: this is the "0 affected, stated rather than implied" claim.
  // If any record flipped, this marker is ABSENT and the AFFECTED lines above
  // carry the enumeration D-7 obligation 3 demands.
  console.log('ZERO_AFFECTED_STATED_POSITIVELY');
}

if (JSON_OUT) {
  console.log(JSON.stringify({ mandatory: mandatoryNames, unreadMandatory, selfTest: st.ok, ...result }, null, 2));
}

if (result.affected.length > 0) {
  console.error(
    `D-7: ${result.affected.length} record(s) are SATISFIED today but schema-invalid. ` +
      'The story may merge only once every one of them is individually justified in the story record.',
  );
  process.exit(1);
}
process.exit(0);

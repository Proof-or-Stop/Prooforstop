#!/usr/bin/env node
/**
 * CHK-011 verification receipt (B-2aa7) — the validator is TOTAL on arbitrary
 * acyclic JSON, asserted as a PROPERTY over generated inputs.
 *
 * CHK-011's three verification intents are EXECUTABLE: per B-ec67 the tool
 * refuses a caller-authored "result: pass" and derives the verdict from a pinned
 * command's real output. This file is that pinned command.
 *
 * ── WHY THIS RECEIPT RUNS THE ARTIFACT THREE TIMES ──────────────────────────
 *
 * A property test carries a failure mode no enumerated row has: it can be
 * NON-REPRODUCIBLE. An irreproducible failure gets re-run until it is green,
 * which is how a real defect becomes "that test is flaky". So determinism is
 * not an implementation detail here — it is part of what has to be proven, and
 * it cannot be proven from a single run:
 *
 *   RUN 1 + RUN 2  same seed  → the BLOCK D proof lines must be byte-identical,
 *                  including the `corpusDigest` over every generated value.
 *                  That is reproducibility, observed rather than claimed.
 *   RUN 3          different seed (`RED_B2AA7_FUZZ_SEED`) → a DIFFERENT corpus
 *                  digest that still holds the property. Without this, "seeded"
 *                  could mean the seed is ignored and the corpus hard-coded;
 *                  with it, the seed is demonstrably load-bearing AND the
 *                  property survives a corpus it was not tuned against.
 *
 * ── WHY IT IS NOT GATED ON BLOCK A BEING RED ────────────────────────────────
 *
 * The two earlier receipts (`red-b2aa7-chk001-receipt.mjs`,
 * `red-b2aa7-chk010-receipt.mjs`) legitimately require the pre-fix observation,
 * and are therefore silent on this post-fix tree. This one must stay meaningful
 * AFTER the fix, because CHK-007 registers the artifact as a permanent
 * regression check: it requires the whole file GREEN, which is the state a
 * regression would break.
 *
 * Run from the repository root:
 *   node packages/main/tests/red/red-b2aa7-chk011-receipt.mjs
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const ARTIFACT = join(here, 'red-b2aa7-artifact-validation.mjs');
const SECOND_SEED = 'B-2aa7/CHK-011/receipt/second-seed';

// ── Fail-closed marker ledger ───────────────────────────────────────────────
// `proof-or-stop validate` grades a command by its EXIT CODE alone. Printing a marker
// only when a check holds is what makes the pinned selectors meaningful, but on
// its own it makes this file a crash-detector when run by validate: a regression
// would print fewer markers and STILL exit 0. Every marker below is therefore
// REQUIRED. `emit` records what was actually printed and the epilogue exits
// non-zero naming any marker that was withheld, and why that is a regression.
// The `[receipt-incomplete]` diagnostics below stay on stdout and are printed
// alongside — they explain WHICH sub-fact collapsed; the epilogue is what makes
// the run fail.
const REQUIRED_MARKERS = new Map([
  ['VALIDATOR_TOTAL_ON_ARBITRARY_JSON',
    'the validator is no longer TOTAL over the generated corpus: classifyRedEvidenceArtifact threw or returned a non-'
    + 'classification, partitionRedEvidenceRecords threw or lost/duplicated/reordered records, or a raw builtin escaped the '
    + 'live read boundary or the full gate pair — the corpus may also have shrunk below its required size, which would make '
    + '"nothing threw" a statement about a small corpus rather than about the validator'],
  ['FUZZ_COVERS_STRUCTURAL_EDGE_SHAPES',
    'the corpus no longer CONTAINS the named structural shapes (empty objects/arrays, Object.create(null), prototype-'
    + 'inherited fields, own "__proto__" keys, mixed-primitive arrays, depth >= 100, >= 20 distinct keys), or it no longer '
    + 'REACHES all seven validator outcomes — so the fuzz stopped exercising the edges it claims to cover'],
  ['FUZZ_IS_A_PROPERTY_NOT_A_CASE_LIST',
    'the fuzz decayed into a decorative case list: too few generated shapes are novel versus the enumerated rows, the corpus '
    + 'lost POTENCY (it no longer crashes an unguarded transcription of the pre-fix read path, so "nothing threw" would be a '
    + 'fact about harmless inputs), it stopped being deterministic at a fixed seed, or the seed stopped being load-bearing'],
]);

const emitted = new Set();
/**
 * Print a marker line and record it. The recorded name is derived from the line
 * ACTUALLY printed, so the ledger cannot silently drift from the output — and a
 * reworded marker (which would invalidate the recorded verificationEvidence
 * selectors) is rejected outright rather than quietly passing.
 */
function emit(line) {
  const name = String(line).split(/[\s(]/)[0];
  if (!REQUIRED_MARKERS.has(name)) {
    throw new Error(
      `red-b2aa7-chk011-receipt: emitted unregistered marker "${name}". Marker text is a pinned selector in this story's `
      + 'recorded verificationEvidence; renaming one invalidates that evidence. Update the ledger and the evidence together.',
    );
  }
  emitted.add(name);
  console.log(line);
}

/** Run the artifact once and parse the machine-readable facts out of its stdout. */
function runArtifact(seed) {
  const env = { ...process.env };
  if (seed === null) delete env.RED_B2AA7_FUZZ_SEED;
  else env.RED_B2AA7_FUZZ_SEED = seed;
  const run = spawnSync(process.execPath, [ARTIFACT], { encoding: 'utf8', env });
  const stdout = run.stdout ?? '';

  const state = new Map();
  const proofs = {};
  for (const line of stdout.split('\n')) {
    const row = /^\s*\[(RED |GREEN)\]\s+(\S+)\s/.exec(line);
    if (row) state.set(row[2], row[1].trim());
    const proof = /^\s*proof (D\d+):\s*(.*)$/.exec(line);
    if (proof) proofs[proof[1]] = proof[2].trim();
  }
  const tally = /(\d+) RED \/ (\d+) GREEN of (\d+) rows/.exec(stdout);
  const digest = /corpusDigest=([0-9a-f]{64})/.exec(proofs.D0 ?? '');

  return {
    status: run.status,
    state,
    proofs,
    red: tally ? Number(tally[1]) : -1,
    green: tally ? Number(tally[2]) : -1,
    total: tally ? Number(tally[3]) : -1,
    digest: digest ? digest[1] : null,
    // The four BLOCK D lines together, i.e. everything the fuzz observed.
    blockD: ['D0', 'D1', 'D2', 'D3'].map((k) => `${k}|${proofs[k] ?? ''}`).join('\n'),
  };
}

const D1 = 'D1-classify-total-on-arbitrary-json';
const D2 = 'D2-partition-total-and-lossless';
const D3 = 'D3-read-boundary-total-on-generated-artifacts';

/**
 * The structural gate every marker shares. BLOCK B rows are fatal on failure,
 * BLOCK D's coverage / reach / potency / novelty / acyclicity checks are fatal
 * fixture assertions inside the observer, and any row failing for an
 * undocumented reason aborts with a STALE ROW assertion — so a green tally
 * proves the whole file ran and held, not merely that it printed something.
 */
function fullyGreen(run) {
  return run.status === 0
    && run.red === 0 && run.total > 0 && run.green === run.total
    && run.state.get(D1) === 'GREEN' && run.state.get(D2) === 'GREEN' && run.state.get(D3) === 'GREEN';
}

const runA = runArtifact(null);
const runB = runArtifact(null);
const runC = runArtifact(SECOND_SEED);

const allGreen = [runA, runB, runC].every(fullyGreen);
const deterministic = allGreen
  && runA.blockD === runB.blockD
  && runA.digest !== null && runA.digest === runB.digest;
const seedIsLoadBearing = allGreen
  && runC.digest !== null && runC.digest !== runA.digest;

const d0 = runA.proofs.D0 ?? '';
const d1 = runA.proofs.D1 ?? '';
const d2 = runA.proofs.D2 ?? '';
const d3 = runA.proofs.D3 ?? '';
const num = (line, key) => {
  const m = new RegExp(`${key}=(\\d+)`).exec(line);
  return m ? Number(m[1]) : -1;
};

// ── 1. happy — the validator returns a classification and never throws ──────
// Read off the row's OWN counters, not off the fact that a row printed GREEN:
// a corpus of at least 4000 generated acyclic values, zero throws out of the
// classify entry point documented as TOTAL, zero results that are not a member
// of the classification union, and zero raw builtins escaping the live read
// boundary or the live gate pair over the artifacts written from that corpus.
const cases = num(d1, 'corpus');
const total =
  allGreen
  && cases >= 4000
  && /classifyThrew=0\/\d+;/.test(d1)
  && /notAClassification=0\/\d+;/.test(d1)
  && num(d2, 'arrays') >= 2000
  && /partitionThrew=0\/\d+;/.test(d2)
  && /lossyOrReordered=0\/\d+;/.test(d2)
  && /readBoundaryRawBuiltins=0\/\d+;/.test(d3)
  && /gateRawBuiltins=0\/\d+/.test(d3)
  && num(d3, 'artifacts') >= 1000
  && /acyclic=true;/.test(d0);
if (total) {
  emit(
    `VALIDATOR_TOTAL_ON_ARBITRARY_JSON (${cases} generated acyclic JSON values: classifyRedEvidenceArtifact threw 0 and returned a `
    + `well-formed classification for every one; partitionRedEvidenceRecords threw 0 over ${num(d2, 'arrays')} arrays and lost, `
    + `duplicated or reordered nothing; ${num(d3, 'artifacts')} of them written to disk let 0 raw builtins escape the live read `
    + `boundary and 0 escape the full gate pair, with ${num(d3, 'typedRejections')} typed rejections all naming the artifact)`,
  );
}

// ── 2. edge — the corpus really contains the named structural shapes ────────
// Every count is derived by WALKING the generated corpus, so "coverage" is
// measured rather than asserted by the generator's intent. `maxDepth` and the
// prototype counts are the ones a hand-written fixture file cannot produce at
// all: `JSON.parse` can never yield a null-prototype object or one whose fields
// are only reachable through the prototype chain (row M8).
const covered =
  allGreen
  && num(d0, 'emptyObjects') > 0
  && num(d0, 'emptyArrays') > 0
  && num(d0, 'nullPrototype') > 0
  && num(d0, 'inheritedPrototype') > 0
  && num(d0, 'ownProtoKeys') > 0
  && num(d0, 'mixedPrimitiveArrays') > 0
  && num(d0, 'maxDepth') >= 100
  && num(d0, 'distinctKeys') >= 20
  // REACH: the corpus does not merely CONTAIN those shapes, it drives the
  // validator through every outcome — all four envelope fault codes, the
  // record-schema fault, quarantine and clean accept.
  && ['envelope/root_not_object', 'envelope/schema_version_missing', 'envelope/schema_version_unknown',
    'envelope/records_not_array', 'record_schema', 'ok-clean', 'ok-quarantined']
    .every((outcome) => new RegExp(`${outcome.replace('/', '\\/')}:[1-9]`).test(d1));
if (covered) {
  emit(
    `FUZZ_COVERS_STRUCTURAL_EDGE_SHAPES (walked the corpus: emptyObjects=${num(d0, 'emptyObjects')}, `
    + `emptyArrays=${num(d0, 'emptyArrays')}, Object.create(null)=${num(d0, 'nullPrototype')}, `
    + `prototype-inherited=${num(d0, 'inheritedPrototype')}, own "__proto__" keys=${num(d0, 'ownProtoKeys')}, `
    + `mixed-primitive arrays=${num(d0, 'mixedPrimitiveArrays')}, maxDepth=${num(d0, 'maxDepth')}, `
    + `distinctKeys=${num(d0, 'distinctKeys')}, acyclic=true — and those inputs drove the validator through ALL SEVEN outcomes: `
    + `all four envelope fault codes, the record-schema fault, quarantine and clean accept)`,
  );
}

// ── 3. adversarial — this is a property, not a case list in disguise ────────
// Four independent facts, because "it is a property" is exactly the claim a
// decorative fuzz would also make:
//   NOVELTY      most distinct generated shapes appear in NO enumerated row.
//   POTENCY      the same corpus still crashes an unguarded transcription of
//                the pre-fix read path, so "nothing threw" is a fact about the
//                validator and not about a harmless corpus.
//   DETERMINISM  same seed → byte-identical proof lines and corpus digest.
//   SEEDED       a different seed → a different corpus that still holds.
const novel = num(d0, 'novelVsEnumerated');
const potency = /potencyAgainstUnguardedPreFixReader=(\d+)\/(\d+)/.exec(d0);
const isProperty =
  allGreen && deterministic && seedIsLoadBearing
  && novel >= 3000
  && potency !== null && Number(potency[1]) >= 100;
if (isProperty) {
  emit(
    `FUZZ_IS_A_PROPERTY_NOT_A_CASE_LIST (${novel} of the distinct generated shapes appear in NO enumerated row; the SAME corpus `
    + `still crashes an unguarded transcription of the pre-fix read path on ${potency[1]}/${potency[2]} values, so "the validator `
    + `never threw" is a fact about the validator and not about harmless inputs; two runs at the default seed produced `
    + `byte-identical BLOCK D proof lines and corpusDigest=${runA.digest}; a third run at a different seed produced `
    + `corpusDigest=${runC.digest} and still held the property, so the seed is load-bearing and the corpus was not tuned to pass)`,
  );
}

// Diagnostics only when a marker is withheld — deliberately worded so it can
// never be mistaken for a marker by a selector match.
if (!(total && covered && isProperty)) {
  console.log(
    '[receipt-incomplete] '
    + `runs(status/red/green/total)=${[runA, runB, runC].map((r) => `${r.status}/${r.red}/${r.green}/${r.total}`).join(' ')}; `
    + `allGreen=${allGreen}; deterministic=${deterministic}; seedIsLoadBearing=${seedIsLoadBearing}; `
    + `totality=${total}; coverage=${covered}; property=${isProperty}`,
  );
  console.log(`[receipt-incomplete] D0: ${d0}`);
  console.log(`[receipt-incomplete] D1: ${d1}`);
  console.log(`[receipt-incomplete] D2: ${d2}`);
  console.log(`[receipt-incomplete] D3: ${d3}`);
}

// ── Fail closed ─────────────────────────────────────────────────────────────
const withheld = [...REQUIRED_MARKERS.keys()].filter((marker) => !emitted.has(marker));
if (withheld.length > 0) {
  console.error(
    `\nred-b2aa7-chk011-receipt: ${withheld.length} of ${REQUIRED_MARKERS.size} required marker(s) WITHHELD. `
    + 'Each marker is printed ONLY when its check genuinely holds, so a withheld marker is a REGRESSION, not a neutral result:',
  );
  for (const marker of withheld) console.error(`  - ${marker}: ${REQUIRED_MARKERS.get(marker)}`);
  process.exitCode = 1;
}

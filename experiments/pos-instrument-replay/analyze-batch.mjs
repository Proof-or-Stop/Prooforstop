// M4 — analyze-batch.mjs: a PURELY OFFLINE analyzer over the committed
// proof-or-stop replay evidence.
//
// This program reads ONLY committed files and never re-runs the instrument.
// It NEVER shells out (no execFileSync/spawn), never calls the lattice CLI,
// and uses NO Date.now()/new Date()/Math.random() anywhere in the report's
// digested preimage — so the report + its digest are byte-reproducible
// cross-host (given identical evidence bytes).
//
// It re-uses sha256 + canonicalJson from lib/instrument.mjs so there is exactly
// ONE hashing convention shared with the instrument that produced the evidence.
//
// Flow:
//   1. INPUT INTEGRITY PRE-CHECK (plan §6.2/§6.4/§9) — re-derive every ledger
//      recordDigest and verify protocol.json's sha256; abort on any mismatch.
//   2. THREE-STATE ADJUDICATION of H1-H4 (pass|fail|inconclusive) — missing or
//      insufficient evidence yields inconclusive, NEVER pass.
//   3. REPORT (report.json + report.md) with a reproducible digest, and — only
//      when overall==='all-pass' — the verbatim §3 claim (plan §10 no-overclaim).

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256, canonicalJson } from './lib/instrument.mjs';

// The analyzer resolves its input directory from its OWN location, so a copied
// analyze-batch.mjs run inside a sandbox reads that sandbox's evidence.
const HERE = dirname(fileURLToPath(import.meta.url));

// Section-3 Claim Boundary text, transcribed VERBATIM from
// docs/requirements/decisions/proof-or-stop-evidence-instrument-replay-execution-plan.md (plan §3).
// Asserted ONLY when overall==='all-pass'. Read at author-time; NEVER read at
// runtime (the analyzer stays offline over evidence).
const CLAIM_TEXT =
  'Under the recorded environment (pinned node version, platform, and ' +
  'instrument commit), the memory-baseline evidence instrument is ' +
  'replay-deterministic (identical digests over N independent replays at 1k ' +
  'and 1M scale), tamper-evident for the enumerated tamper matrix (every ' +
  'class in the fail-closed set fails closed with its pre-registered ' +
  'fingerprint, including classes that leave surface scores perfect), and ' +
  'campaign-operable (an ' +
  'unattended batch completed with every iteration ending in a ' +
  'machine-checkable proof record or an explicit stop record, surviving the ' +
  'probed interruption classes — process kill at an iteration boundary and ' +
  'mid-iteration — without duplication or gaps).';

// ---------------------------------------------------------------------------
// small IO helpers (offline; read committed bytes only)
// ---------------------------------------------------------------------------
function readFileBytes(p) {
  return readFileSync(p); // Buffer
}
// ABSENT (file does not exist) vs PRESENT is a load-bearing distinction: an
// absent input makes the dependent hypothesis inconclusive and its
// generatedInputs sha null — it must NEVER crash and NEVER yield all-pass.
function readFileBytesOrNull(p) {
  try {
    return readFileSync(p); // Buffer
  } catch {
    return null;
  }
}
function readTextOrNull(p) {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}
function parseJsonl(text) {
  return text
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

function fatal(msg) {
  console.error(msg);
  process.exit(1);
}

// three-state verdict helper: prefer pass, then fail, then inconclusive.
function verdict(pass, fail) {
  return pass ? 'pass' : fail ? 'fail' : 'inconclusive';
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
function main() {
  const paths = {
    ledger: join(HERE, 'batch-ledger.jsonl'),
    tamper: join(HERE, 'tamper-verdicts.jsonl'),
    resume: join(HERE, 'resume-reconciliation.json'),
    protocol: join(HERE, 'protocol.json'),
    protocolSha: join(HERE, 'protocol.json.sha256'),
  };

  // ---- load protocol (required) ----
  const protocolText = readTextOrNull(paths.protocol);
  if (protocolText == null) {
    fatal('analyze-batch: FATAL input-integrity — protocol.json missing');
  }
  const protocol = JSON.parse(protocolText);

  // ---- INPUT INTEGRITY PRE-CHECK (before any adjudication) ----
  // (a) protocol.json sha256 must equal the trimmed .sha256 sidecar.
  const protocolShaText = readTextOrNull(paths.protocolSha);
  if (protocolShaText == null) {
    fatal('analyze-batch: FATAL input-integrity — protocol.json.sha256 missing');
  }
  const protocolBytes = readFileBytes(paths.protocol);
  const protocolShaActual = sha256(protocolBytes);
  const protocolShaExpected = protocolShaText.trim();
  if (protocolShaActual !== protocolShaExpected) {
    fatal(
      'analyze-batch: FATAL input-integrity — protocol.json sha256 mismatch ' +
        `(expected ${protocolShaExpected}, got ${protocolShaActual})`,
    );
  }

  // (b) batch-ledger.jsonl: ABSENT (file does not exist) is NOT a hard fatal —
  // it makes H1/H4 inconclusive (the integrity pre-check must not crash on an
  // absent ledger). A PRESENT-but-naively-edited ledger IS a hard fatal.
  const ledgerBytes = readFileBytesOrNull(paths.ledger);
  const ledgerAbsent = ledgerBytes == null;
  let ledger = [];
  if (!ledgerAbsent) {
    ledger = parseJsonl(ledgerBytes.toString('utf8'));
    for (const rec of ledger) {
      const { recordDigest, ...rest } = rec;
      const derived = sha256(canonicalJson(rest));
      if (derived !== recordDigest) {
        // Naive edit: a field changed but the record's own digest was not
        // recomputed. Abort — do NOT emit a report.
        fatal(
          `analyze-batch: FATAL input-integrity — record ${rec.iterationId} ` +
            'recordDigest mismatch (naively-edited ledger)',
        );
      }
    }
  }

  // tamper-verdicts.jsonl has NO per-record digest: integrity there is
  // structural (a missing required field makes a hypothesis inconclusive,
  // never a crash). ABSENT (file does not exist) is distinct from PRESENT:
  // absent => H2 inconclusive AND generatedInputs sha null.
  const tamperBytes = readFileBytesOrNull(paths.tamper);
  const tamperAbsent = tamperBytes == null;
  const tamper = tamperAbsent ? [] : parseJsonl(tamperBytes.toString('utf8'));

  // resume-reconciliation.json: ABSENT/empty/unparseable => H3 inconclusive.
  const resumeBytes = readFileBytesOrNull(paths.resume);
  const resumeAbsent = resumeBytes == null;
  let resume = null;
  if (!resumeAbsent) {
    const resumeText = resumeBytes.toString('utf8');
    if (resumeText.trim()) {
      try {
        resume = JSON.parse(resumeText);
      } catch {
        resume = null; // unparseable => treat as missing => inconclusive
      }
    }
  }

  // ---- ADJUDICATION ----
  const proofs = ledger.filter((r) => r.verifyStatus !== undefined);

  const hypotheses = {
    H1: adjudicateH1(proofs, protocol),
    H2: adjudicateH2(tamper, protocol),
    H3: adjudicateH3(resume, protocol),
    H4: adjudicateH4(proofs, protocol),
  };

  // scale-envelope (plan §7): per-scale max elapsed + peak RSS over proof records.
  const scaleEnvelope = buildScaleEnvelope(proofs);

  // instrument-defect list (plan §12): empty when clean. A real entry only when
  // a hypothesis is falsified in a way that indicts the instrument itself
  // (H1 non-determinism or H2 tamper not failing closed).
  const instrumentDefects = buildInstrumentDefects(hypotheses);

  const verdicts = Object.values(hypotheses).map((h) => h.verdict);
  const overall = verdicts.every((v) => v === 'pass')
    ? 'all-pass'
    : verdicts.some((v) => v === 'fail')
      ? 'some-fail'
      : 'some-inconclusive';

  // ---- generated-input digests (over the raw file bytes as committed) ----
  // An ABSENT file => null sha (never a crash). protocol.json is already
  // proven present + integrity-checked above, so it always has a real sha.
  const generatedInputs = {
    'batch-ledger.jsonl': ledgerAbsent ? null : sha256(ledgerBytes),
    'tamper-verdicts.jsonl': tamperAbsent ? null : sha256(tamperBytes),
    'resume-reconciliation.json': resumeAbsent ? null : sha256(resumeBytes),
    'protocol.json': protocolShaActual,
  };

  // ---- assemble report (order-independent; digest is over canonicalJson) ----
  const report = {
    campaign: 'pos-instrument-replay',
    generatedInputs,
    envPins: protocol.envPins,
    hypotheses,
    scaleEnvelope,
    instrumentDefects,
    overall,
  };
  if (overall === 'all-pass') {
    report.claim = CLAIM_TEXT; // §3 claim asserted ONLY on all-pass
  }

  const digest = sha256(canonicalJson(report));

  // ---- write report.json ----
  const reportJson = { ...report, digest };
  writeFileSync(join(HERE, 'report.json'), JSON.stringify(reportJson, null, 2) + '\n');

  // ---- write report.md ----
  writeFileSync(join(HERE, 'report.md'), renderMarkdown(report, digest));

  // ---- stdout ----
  console.log(`H1 replay-determinism: ${hypotheses.H1.verdict}`);
  console.log(`H2 tamper-fail-closed: ${hypotheses.H2.verdict}`);
  console.log(`H3 resume-integrity: ${hypotheses.H3.verdict}`);
  console.log(`H4 scale-envelope: ${hypotheses.H4.verdict}`);
  console.log(`overall: ${overall}`);
  console.log(`digest: ${digest}`);
}

// ---------------------------------------------------------------------------
// H1 replay-determinism (STRICT completeness + non-vacuous + closed scale set)
//   For every scale s declared in protocol.N:
//     - recs = proof records at scale s.
//     - recs.length MUST equal protocol.N[s] (incomplete OR extra => FAIL).
//     - every rec MUST carry non-empty digests {records, gold, manifest}
//       (all three present, non-empty strings) AND a goldMetrics object with
//       EVERY EXPECTED_GOLD_METRIC_KEYS key present with a finite-number value
//       (a partial/stripped goldMetrics => FAIL).
//     - all recs at the scale MUST be pairwise-equal on
//       canonicalJson({digests, goldMetrics}) (mismatch => FAIL).
//   ADDITIONALLY (closed scale set, F-009/F-011/F-014):
//     - every proof record's `scale` MUST be a declared key of protocol.N;
//       ANY proof record at an undeclared/extra scale => FAIL (never silently
//       ignored — a re-signed record at scale:"bogus" must falsify H1).
//     - the TOTAL proof-record count MUST equal the sum of protocol.N values
//       (no extra, no missing across the whole ledger) => else FAIL.
//   inconclusive ONLY when there are ZERO proof records overall (no evidence).
//   pass iff the scale set is closed, the total count matches, and every scale
//   in protocol.N has exactly N[s] well-formed records all pairwise-equal.
// ---------------------------------------------------------------------------
// The FULL gold-metric key set the instrument's gold-metrics verify emits.
// Cited from lib/instrument.mjs gold-metrics (the memory-baseline verify's
// gold-metric surface). A proof record is well-formed ONLY if its goldMetrics
// carries EVERY one of these keys with a finite-number value; a partial
// goldMetrics (e.g. {expectedIdsFoundRate:1}) MUST fail well-formedness.
const EXPECTED_GOLD_METRIC_KEYS = [
  'candidateFalseSurfaceRate',
  'currentOverSupersededPreferenceRate',
  'deprecatedFalseSurfaceRate',
  'expectedDeprecatedTermHitsFoundRate',
  'expectedIdsFoundRate',
  'expectedSuppressedIdsFoundRate',
  'goldQueryPresenceRate',
  'goldRecordPresenceRate',
  'malformedRowsSkipped',
  'supersededFalseSurfaceRate',
];
function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}
function hasFullGoldMetrics(g) {
  if (g == null || typeof g !== 'object' || Array.isArray(g)) return false;
  // EVERY expected key must be present with a finite number value.
  return EXPECTED_GOLD_METRIC_KEYS.every((k) => Number.isFinite(g[k]));
}
function hasWellFormedProofEvidence(r) {
  const d = r.digests;
  if (d == null || typeof d !== 'object') return false;
  if (!isNonEmptyString(d.records) || !isNonEmptyString(d.gold) || !isNonEmptyString(d.manifest)) {
    return false;
  }
  // FULL gold-metric key set (not merely non-empty): a partial goldMetrics fails.
  if (!hasFullGoldMetrics(r.goldMetrics)) return false;
  return true;
}
function adjudicateH1(proofs, protocol) {
  const criterion =
    'Every proof record has a declared protocol.N scale and the total proof ' +
    'count equals sum(protocol.N); per scale s in protocol.N: exactly N[s] ' +
    'proof records exist, each with non-empty digests {records,gold,manifest} ' +
    '+ goldMetrics carrying the full expected key set (finite numbers), and all ' +
    'records share identical canonicalJson({digests, goldMetrics}).';

  // No proof records at all => no evidence => inconclusive.
  if (!proofs.length) {
    return {
      verdict: 'inconclusive',
      criterion,
      evidence: { reason: 'no proof records in ledger (absent/empty)' },
    };
  }

  const expectedN = (protocol && protocol.N) || {};
  const declaredScales = new Set(Object.keys(expectedN));
  const byScale = {};
  for (const r of proofs) (byScale[r.scale] ??= []).push(r);
  const scales = Object.keys(expectedN).sort();

  // CLOSED SCALE SET (F-009): every proof record's scale must be declared.
  const undeclaredScales = [...new Set(proofs.map((r) => r.scale))]
    .filter((sc) => !declaredScales.has(sc))
    .sort();
  const scaleSetClosed = undeclaredScales.length === 0;

  // TOTAL COUNT: total proof records must equal sum(protocol.N) — no extra,
  // no missing anywhere (an extra bogus-scale record also trips this).
  const expectedTotal = Object.values(expectedN).reduce(
    (a, v) => a + (Number.isFinite(v) ? v : 0),
    0,
  );
  const totalCountOk = proofs.length === expectedTotal;

  let anyFail = !scaleSetClosed || !totalCountOk;
  const perScale = {};
  for (const s of scales) {
    const recs = byScale[s] || [];
    const expected = expectedN[s];
    const countOk = recs.length === expected;
    const wellFormed = recs.length > 0 && recs.every((r) => hasWellFormedProofEvidence(r));
    let pairwiseEqual = null;
    if (countOk && wellFormed) {
      const key = (r) => canonicalJson({ digests: r.digests, goldMetrics: r.goldMetrics });
      const k0 = key(recs[0]);
      pairwiseEqual = recs.every((r) => key(r) === k0);
    }
    const scalePass = countOk && wellFormed && pairwiseEqual === true;
    if (!scalePass) anyFail = true;
    perScale[s] = {
      n: recs.length,
      expected,
      countOk,
      wellFormed,
      pairwiseEqual,
      pass: scalePass,
    };
  }

  return {
    verdict: verdict(!anyFail, anyFail),
    criterion,
    evidence: {
      perScale,
      totalProofCount: proofs.length,
      expectedTotal,
      totalCountOk,
      scaleSetClosed,
      undeclaredScales,
    },
  };
}

// ---------------------------------------------------------------------------
// H2 tamper-fail-closed
//   per-verdict bucket conformance + dispositionMatch===true + per-disposition
//   counts equal to protocol.tamperMatrix bucket lengths.
// ---------------------------------------------------------------------------
function adjudicateH2(tamper, protocol) {
  const criterion =
    'The set of {class|handling} verdicts exactly equals the protocol.tamperMatrix ' +
    'identity set (no missing, no unexpected, no duplicate); EACH verdict\'s ' +
    'rederivedDisposition equals the disposition its {class|handling} identity is ' +
    'assigned by protocol.tamperMatrix (identity->disposition binding); every ' +
    'tamper verdict conforms to its rederivedDisposition rule ' +
    '(fail-closed => verifyStatus in {fail,crash} & fingerprintMatch; ' +
    'accepted/acknowledged-limitation => pass & fingerprintMatch; ' +
    'dropped => pass), every dispositionMatch===true, and the per-disposition ' +
    'counts equal the protocol.tamperMatrix bucket lengths.';

  if (!tamper.length) {
    return {
      verdict: 'inconclusive',
      criterion,
      evidence: { reason: 'tamper-verdicts.jsonl empty or missing' },
    };
  }

  // structural integrity: required fields present per verdict.
  const requiredFields = ['rederivedDisposition', 'verifyStatus', 'dispositionMatch'];
  const structurallyBad = tamper.filter((v) =>
    requiredFields.some((f) => !(f in v)),
  );
  if (structurallyBad.length) {
    return {
      verdict: 'inconclusive',
      criterion,
      evidence: {
        reason: 'one or more tamper verdicts missing a required field',
        missingFieldRecords: structurallyBad.length,
      },
    };
  }

  const conforms = (v) => {
    const st = v.verifyStatus;
    const fp = v.fingerprintMatch;
    const d = v.rederivedDisposition;
    if (d === 'fail-closed') return (st === 'fail' || st === 'crash') && fp === true;
    if (d === 'accepted' || d === 'acknowledged-limitation') return st === 'pass' && fp === true;
    if (d === 'dropped') return st === 'pass';
    return false; // unknown disposition never conforms
  };

  const nonConforming = tamper.filter((v) => !conforms(v));
  const dispositionMismatch = tamper.filter((v) => v.dispositionMatch !== true);

  // per-disposition counts vs protocol.tamperMatrix bucket lengths.
  const tm = protocol.tamperMatrix || {};
  const bucketOf = {
    'fail-closed': 'failClosed',
    accepted: 'acceptanceBucket',
    'acknowledged-limitation': 'acknowledgedLimitations',
    dropped: 'dropped',
  };
  const counts = {};
  for (const v of tamper) {
    counts[v.rederivedDisposition] = (counts[v.rederivedDisposition] || 0) + 1;
  }
  const expectedCounts = {};
  for (const [disp, bucket] of Object.entries(bucketOf)) {
    expectedCounts[disp] = Array.isArray(tm[bucket]) ? tm[bucket].length : null;
  }
  const countsMatch = Object.keys(bucketOf).every((disp) => {
    const got = counts[disp] || 0;
    return got === expectedCounts[disp];
  });

  // IDENTITY coverage: the actual set of `${class}|${handling}` verdicts must
  // exactly equal the expected set built from EVERY protocol.tamperMatrix
  // entry — same size, no missing identity, no unexpected identity, and no
  // duplicate (a duplicate collapses in the actual Set => size mismatch).
  const expectedIdentities = [];
  for (const bucket of ['failClosed', 'acceptanceBucket', 'acknowledgedLimitations', 'dropped']) {
    if (Array.isArray(tm[bucket])) {
      for (const e of tm[bucket]) expectedIdentities.push(`${e.class}|${e.handling}`);
    }
  }
  const E = new Set(expectedIdentities);
  const actualIdentities = tamper.map((v) => `${v.class}|${v.handling}`);
  const A = new Set(actualIdentities);
  const missingIdentities = [...E].filter((id) => !A.has(id)).sort();
  const unexpectedIdentities = [...A].filter((id) => !E.has(id)).sort();
  // A duplicate (or any count divergence) shows up as actual-list length not
  // matching the actual-Set size; identity coverage also requires |A| === |E|.
  const duplicateIdentities = actualIdentities.length !== A.size;
  const identityMatch =
    A.size === E.size &&
    missingIdentities.length === 0 &&
    unexpectedIdentities.length === 0 &&
    !duplicateIdentities;

  // IDENTITY -> DISPOSITION BINDING (F-012): the protocol assigns each
  // `${class}|${handling}` identity a bucket, and thus a single expected
  // disposition. EACH verdict's rederivedDisposition MUST equal the disposition
  // its own identity is assigned by protocol.tamperMatrix. This catches a
  // relabel attack that keeps counts + set-coverage + per-row conformance
  // consistent (e.g. cross-profile-swap|refreshed is protocol-assigned
  // fail-closed; relabeling its rederivedDisposition to 'accepted' with a
  // matching verifyStatus='pass' still violates the identity's bound disposition).
  const dispositionOfBucket = {
    failClosed: 'fail-closed',
    acceptanceBucket: 'accepted',
    acknowledgedLimitations: 'acknowledged-limitation',
    dropped: 'dropped',
  };
  const expectedDispByIdentity = new Map();
  for (const [bucket, disp] of Object.entries(dispositionOfBucket)) {
    if (Array.isArray(tm[bucket])) {
      for (const e of tm[bucket]) expectedDispByIdentity.set(`${e.class}|${e.handling}`, disp);
    }
  }
  const bindingViolations = tamper.filter((v) => {
    const id = `${v.class}|${v.handling}`;
    const expDisp = expectedDispByIdentity.get(id);
    // An unbound identity (not in the protocol) is a binding violation too; its
    // rederivedDisposition cannot match a disposition the protocol never assigned.
    return expDisp === undefined || v.rederivedDisposition !== expDisp;
  });
  const bindingMatch = bindingViolations.length === 0;

  const pass =
    identityMatch &&
    bindingMatch &&
    nonConforming.length === 0 &&
    dispositionMismatch.length === 0 &&
    countsMatch;

  return {
    verdict: verdict(pass, !pass),
    criterion,
    evidence: {
      total: tamper.length,
      counts,
      expectedCounts,
      nonConforming: nonConforming.length,
      dispositionMismatch: dispositionMismatch.length,
      countsMatch,
      identityMatch,
      bindingMatch,
      bindingViolations: bindingViolations.length,
      bindingViolationIdentities: bindingViolations
        .map((v) => `${v.class}|${v.handling}`)
        .sort(),
      expectedIdentityCount: E.size,
      actualIdentityCount: A.size,
      missingIdentities,
      unexpectedIdentities,
      duplicateIdentities,
    },
  };
}

// ---------------------------------------------------------------------------
// H3 resume-integrity (substantive VALUES, not just key presence)
//   ABSENT/empty/unparseable resume-reconciliation.json => inconclusive.
//   PRESENT but missing the substantive reconciliation structure => FAIL:
//     - killA, killB, killC each an object with keys casualtyId + postResume +
//       recordedBeforeKill;
//     - EACH kill trial's postResume (F-010/F-013) is a NON-EMPTY object with
//       dup===0 && gap===0 && a non-empty-string casualtyDisposition
//       (killA/killB.postResume = {dup,gap,casualtyDisposition};
//        killC.postResume = {dup,gap,stoppedDisposition,stoppedRecordPreserved,
//        casualtyDisposition}); an empty {} postResume must FAIL.
//     - killC SPECIFICALLY: postResume.stoppedRecordPreserved === true AND a
//       non-empty-string stoppedDisposition (stoppedRecordPreserved=false FAILS).
//     - protocolReplaySmallCount === protocol.N.small;
//     - hypothesis === 'H3'.
//   pass iff the substantive structure + values are present AND dupTotal===0 &&
//   gapTotal===0 && finalMultisetMatch===true.
// ---------------------------------------------------------------------------
function isNonEmptyStr(v) {
  return typeof v === 'string' && v.length > 0;
}
// A kill trial's postResume must carry the real reconciliation VALUES, not
// merely exist: no duplication (dup===0), no gap (gap===0), and a recorded
// disposition string for the casualty. `requireStopped` adds killC's stop-record
// preservation checks (stoppedRecordPreserved===true + a stoppedDisposition).
function isPostResumeWellFormed(k, requireStopped) {
  if (k == null || typeof k !== 'object' || Array.isArray(k)) return false;
  const pr = k.postResume;
  if (pr == null || typeof pr !== 'object' || Array.isArray(pr)) return false;
  if (Object.keys(pr).length === 0) return false; // empty {} => FAIL
  if (pr.dup !== 0 || pr.gap !== 0) return false;
  if (!isNonEmptyStr(pr.casualtyDisposition)) return false;
  if (requireStopped) {
    if (pr.stoppedRecordPreserved !== true) return false;
    if (!isNonEmptyStr(pr.stoppedDisposition)) return false;
  }
  return true;
}
function isKillWellFormed(k, requireStopped = false) {
  return (
    k != null &&
    typeof k === 'object' &&
    !Array.isArray(k) &&
    'casualtyId' in k &&
    'postResume' in k &&
    'recordedBeforeKill' in k &&
    // substantive postResume VALUES, not just key presence (F-010/F-013).
    isPostResumeWellFormed(k, requireStopped)
  );
}
function adjudicateH3(resume, protocol) {
  const criterion =
    'resume-reconciliation carries the substantive structure (killA/killB/killC ' +
    'each with casualtyId+postResume+recordedBeforeKill, ' +
    'protocolReplaySmallCount===protocol.N.small, hypothesis===H3) AND reports ' +
    'dupTotal===0, gapTotal===0, finalMultisetMatch===true.';

  // ABSENT / empty / unparseable => inconclusive (no evidence).
  if (
    resume == null ||
    resume.dupTotal === undefined ||
    resume.gapTotal === undefined ||
    resume.finalMultisetMatch === undefined
  ) {
    return {
      verdict: 'inconclusive',
      criterion,
      evidence: {
        reason: 'resume-reconciliation.json missing or lacks dup/gap/multiset fields',
      },
    };
  }

  // PRESENT but stub/malformed (lacks substantive structure) => FAIL.
  const expectedSmall = protocol && protocol.N ? protocol.N.small : undefined;
  const structure = {
    killA: isKillWellFormed(resume.killA),
    killB: isKillWellFormed(resume.killB),
    killC: isKillWellFormed(resume.killC, /* requireStopped */ true),
    protocolReplaySmallCount:
      Number.isFinite(expectedSmall) &&
      resume.protocolReplaySmallCount === expectedSmall,
    hypothesis: resume.hypothesis === 'H3',
  };
  const substantive = Object.values(structure).every(Boolean);

  const invariantsHold =
    resume.dupTotal === 0 &&
    resume.gapTotal === 0 &&
    resume.finalMultisetMatch === true;

  const pass = substantive && invariantsHold;
  return {
    verdict: verdict(pass, !pass),
    criterion,
    evidence: {
      dupTotal: resume.dupTotal,
      gapTotal: resume.gapTotal,
      finalMultisetMatch: resume.finalMultisetMatch,
      substantive,
      structure,
      expectedSmall,
      protocolReplaySmallCount: resume.protocolReplaySmallCount,
      hypothesis: resume.hypothesis,
    },
  };
}

// ---------------------------------------------------------------------------
// H4 scale-envelope (physical elapsed)
//   A proof record is in-envelope iff its elapsedMs is a finite, non-negative
//   number that is <= protocol.budgetCaps.msPerVerify. A negative, null, NaN,
//   or non-finite elapsedMs is OVER/INVALID (null must NOT coerce to 0/pass).
//   pass iff every proof record is in-envelope.
// ---------------------------------------------------------------------------
function adjudicateH4(proofs, protocol) {
  const cap = protocol.budgetCaps?.msPerVerify;
  const criterion =
    'Every proof record elapsedMs is a finite, non-negative number ' +
    '<= protocol.budgetCaps.msPerVerify.';
  if (!Number.isFinite(cap)) {
    return {
      verdict: 'inconclusive',
      criterion,
      evidence: { reason: 'protocol.budgetCaps.msPerVerify not a finite number' },
    };
  }
  if (!proofs.length) {
    return {
      verdict: 'inconclusive',
      criterion,
      evidence: { reason: 'no proof records', budgetCapMs: cap },
    };
  }
  const inEnvelope = (r) =>
    Number.isFinite(r.elapsedMs) && r.elapsedMs >= 0 && r.elapsedMs <= cap;
  const over = proofs.filter((r) => !inEnvelope(r));
  const finiteElapsed = proofs.map((r) => r.elapsedMs).filter((v) => Number.isFinite(v));
  const maxElapsedMs = finiteElapsed.length ? Math.max(...finiteElapsed) : null;
  const pass = over.length === 0;
  return {
    verdict: verdict(pass, !pass),
    criterion,
    evidence: {
      budgetCapMs: cap,
      proofCount: proofs.length,
      maxElapsedMs,
      overCap: over.length,
      overCapIds: over.map((r) => r.iterationId),
    },
  };
}

// ---------------------------------------------------------------------------
// scale-envelope: per-scale max elapsed + peak end-of-run RSS (plan §7).
// ---------------------------------------------------------------------------
function buildScaleEnvelope(proofs) {
  const byScale = {};
  for (const r of proofs) (byScale[r.scale] ??= []).push(r);
  const envelope = {};
  for (const s of Object.keys(byScale).sort()) {
    const recs = byScale[s];
    envelope[s] = {
      maxElapsedMs: Math.max(...recs.map((r) => r.elapsedMs)),
      peakEndOfRunRssBytes: Math.max(...recs.map((r) => r.endOfRunRss || 0)),
    };
  }
  return envelope;
}

// ---------------------------------------------------------------------------
// instrument-defect list (plan §12): empty when clean. Only H1 non-determinism
// and H2 not-failing-closed indict the INSTRUMENT itself.
// ---------------------------------------------------------------------------
function buildInstrumentDefects(hypotheses) {
  const defects = [];
  if (hypotheses.H1.verdict === 'fail') {
    defects.push({
      hypothesis: 'H1',
      kind: 'non-deterministic-replay',
      detail: 'Proof records at a checkable scale disagree on {digests, goldMetrics}.',
    });
  }
  if (hypotheses.H2.verdict === 'fail') {
    defects.push({
      hypothesis: 'H2',
      kind: 'tamper-not-fail-closed',
      detail:
        'One or more tamper classes did not fail closed with the pre-registered fingerprint.',
    });
  }
  return defects;
}

// ---------------------------------------------------------------------------
// report.md renderer (human-readable). No overclaim: the verbatim claim text
// appears ONLY on all-pass; otherwise the unmet hypotheses are listed (plan §10).
// ---------------------------------------------------------------------------
function renderMarkdown(report, digest) {
  const env = report.envPins || {};
  const lines = [];
  lines.push('# proof-or-stop instrument replay — M4 report');
  lines.push('');
  lines.push('## Environment pins');
  lines.push(`- nodeVersion: ${env.nodeVersion ?? '(unrecorded)'}`);
  lines.push(`- platform: ${env.platform ?? '(unrecorded)'}`);
  lines.push(`- instrumentCommit: ${env.instrumentCommit ?? '(unrecorded)'}`);
  lines.push('');
  lines.push('## Hypotheses');
  const H = report.hypotheses;
  lines.push(`- H1 replay-determinism: **${H.H1.verdict.toUpperCase()}** — ${H.H1.criterion} — ${h1Evidence(H.H1)}`);
  lines.push(`- H2 tamper-fail-closed: **${H.H2.verdict.toUpperCase()}** — ${H.H2.criterion} — ${h2Evidence(H.H2)}`);
  lines.push(`- H3 resume-integrity: **${H.H3.verdict.toUpperCase()}** — ${H.H3.criterion} — ${h3Evidence(H.H3)}`);
  lines.push(`- H4 scale-envelope: **${H.H4.verdict.toUpperCase()}** — ${H.H4.criterion} — ${h4Evidence(H.H4)}`);
  lines.push('');
  lines.push('## Scale envelope');
  for (const [scale, e] of Object.entries(report.scaleEnvelope)) {
    lines.push(`- ${scale}: maxElapsedMs=${e.maxElapsedMs}, peakEndOfRunRssBytes=${e.peakEndOfRunRssBytes}`);
  }
  lines.push('');
  lines.push('## Instrument defects');
  if (report.instrumentDefects.length === 0) {
    lines.push('- none');
  } else {
    for (const d of report.instrumentDefects) {
      lines.push(`- ${d.hypothesis} ${d.kind}: ${d.detail}`);
    }
  }
  lines.push('');
  lines.push(`## Overall: ${report.overall}`);
  lines.push('');
  lines.push(`digest: ${digest}`);
  lines.push('');
  if (report.overall === 'all-pass') {
    lines.push('## Claim (asserted)');
    lines.push('');
    lines.push(`> ${CLAIM_TEXT}`);
  } else {
    const unmet = Object.entries(report.hypotheses)
      .filter(([, h]) => h.verdict !== 'pass')
      .map(([name, h]) => `${name} (${h.verdict})`);
    lines.push('## Claim');
    lines.push('');
    lines.push(`Claim NOT asserted; unmet hypotheses: ${unmet.join(', ')}`);
  }
  lines.push('');
  return lines.join('\n');
}

function h1Evidence(h) {
  if (h.evidence.reason) return h.evidence.reason;
  const ps = h.evidence.perScale || {};
  const parts = Object.entries(ps).map(
    ([s, v]) =>
      `${s}: n=${v.n}/${v.expected} countOk=${v.countOk} wellFormed=${v.wellFormed} pairwiseEqual=${v.pairwiseEqual} pass=${v.pass}`,
  );
  return parts.length ? parts.join('; ') : '';
}
function h2Evidence(h) {
  const e = h.evidence;
  if (e.reason) return e.reason;
  return `total=${e.total}, identityMatch=${e.identityMatch} (expected=${e.expectedIdentityCount}, actual=${e.actualIdentityCount}), bindingMatch=${e.bindingMatch} (violations=${e.bindingViolations}), nonConforming=${e.nonConforming}, dispositionMismatch=${e.dispositionMismatch}, countsMatch=${e.countsMatch}`;
}
function h3Evidence(h) {
  const e = h.evidence;
  if (e.reason) return e.reason;
  return `dupTotal=${e.dupTotal}, gapTotal=${e.gapTotal}, finalMultisetMatch=${e.finalMultisetMatch}`;
}
function h4Evidence(h) {
  const e = h.evidence;
  if (e.reason) return e.reason;
  return `budgetCapMs=${e.budgetCapMs}, proofCount=${e.proofCount}, maxElapsedMs=${e.maxElapsedMs}, overCap=${e.overCap}`;
}

main();

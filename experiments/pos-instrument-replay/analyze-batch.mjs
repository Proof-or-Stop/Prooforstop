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

  // (b) ledger required; every record's recordDigest must re-derive.
  const ledgerText = readTextOrNull(paths.ledger);
  if (ledgerText == null) {
    fatal('analyze-batch: FATAL input-integrity — batch-ledger.jsonl missing');
  }
  const ledger = parseJsonl(ledgerText);
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

  // tamper-verdicts.jsonl has NO per-record digest: integrity there is
  // structural (a missing required field makes a hypothesis inconclusive,
  // never a crash). Load it best-effort.
  const tamperText = readTextOrNull(paths.tamper);
  const tamper = tamperText == null ? [] : parseJsonl(tamperText);

  // resume-reconciliation.json: missing/empty => H3 inconclusive.
  const resumeText = readTextOrNull(paths.resume);
  let resume = null;
  if (resumeText != null && resumeText.trim()) {
    try {
      resume = JSON.parse(resumeText);
    } catch {
      resume = null; // unparseable => treat as missing => inconclusive
    }
  }

  // ---- ADJUDICATION ----
  const proofs = ledger.filter((r) => r.verifyStatus !== undefined);

  const hypotheses = {
    H1: adjudicateH1(proofs),
    H2: adjudicateH2(tamper, protocol),
    H3: adjudicateH3(resume),
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
  const generatedInputs = {
    'batch-ledger.jsonl': sha256(readFileBytes(paths.ledger)),
    'tamper-verdicts.jsonl': sha256(readFileBytes(paths.tamper)),
    'resume-reconciliation.json': sha256(readFileBytes(paths.resume)),
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
// H1 replay-determinism
//   group proof records by scale; for each scale with >=2 records, all must
//   have pairwise-equal canonicalJson({digests, goldMetrics}).
//   pass  iff every checkable scale is equal;
//   fail  on any mismatch;
//   inconclusive if NO scale has >=2 records.
// ---------------------------------------------------------------------------
function adjudicateH1(proofs) {
  const criterion =
    'Per scale with >=2 proof records, all records share identical ' +
    'canonicalJson({digests, goldMetrics}).';
  const byScale = {};
  for (const r of proofs) (byScale[r.scale] ??= []).push(r);
  const scales = Object.keys(byScale).sort();

  let anyCheckable = false;
  let anyMismatch = false;
  const perScale = {};
  for (const s of scales) {
    const recs = byScale[s];
    if (recs.length < 2) {
      perScale[s] = { n: recs.length, checkable: false };
      continue;
    }
    anyCheckable = true;
    const key = (r) => canonicalJson({ digests: r.digests, goldMetrics: r.goldMetrics });
    const k0 = key(recs[0]);
    const equal = recs.every((r) => key(r) === k0);
    perScale[s] = { n: recs.length, checkable: true, pairwiseEqual: equal };
    if (!equal) anyMismatch = true;
  }

  if (!anyCheckable) {
    return {
      verdict: 'inconclusive',
      criterion,
      evidence: { reason: 'no scale had >=2 proof records', perScale },
    };
  }
  return {
    verdict: verdict(!anyMismatch, anyMismatch),
    criterion,
    evidence: { perScale },
  };
}

// ---------------------------------------------------------------------------
// H2 tamper-fail-closed
//   per-verdict bucket conformance + dispositionMatch===true + per-disposition
//   counts equal to protocol.tamperMatrix bucket lengths.
// ---------------------------------------------------------------------------
function adjudicateH2(tamper, protocol) {
  const criterion =
    'Every tamper verdict conforms to its rederivedDisposition rule ' +
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

  const pass =
    nonConforming.length === 0 && dispositionMismatch.length === 0 && countsMatch;

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
    },
  };
}

// ---------------------------------------------------------------------------
// H3 resume-integrity
//   pass iff dupTotal===0 && gapTotal===0 && finalMultisetMatch===true.
// ---------------------------------------------------------------------------
function adjudicateH3(resume) {
  const criterion =
    'resume-reconciliation reports dupTotal===0, gapTotal===0, and ' +
    'finalMultisetMatch===true.';
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
  const pass =
    resume.dupTotal === 0 &&
    resume.gapTotal === 0 &&
    resume.finalMultisetMatch === true;
  return {
    verdict: verdict(pass, !pass),
    criterion,
    evidence: {
      dupTotal: resume.dupTotal,
      gapTotal: resume.gapTotal,
      finalMultisetMatch: resume.finalMultisetMatch,
    },
  };
}

// ---------------------------------------------------------------------------
// H4 scale-envelope
//   pass iff every proof record elapsedMs <= protocol.budgetCaps.msPerVerify.
// ---------------------------------------------------------------------------
function adjudicateH4(proofs, protocol) {
  const cap = protocol.budgetCaps?.msPerVerify;
  const criterion = 'Every proof record elapsedMs <= protocol.budgetCaps.msPerVerify.';
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
  const over = proofs.filter((r) => !(r.elapsedMs <= cap));
  const maxElapsedMs = Math.max(...proofs.map((r) => r.elapsedMs));
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
  const ps = h.evidence.perScale || {};
  const parts = Object.entries(ps).map(([s, v]) =>
    v.checkable ? `${s}: n=${v.n} pairwiseEqual=${v.pairwiseEqual}` : `${s}: n=${v.n} (not checkable)`,
  );
  return parts.length ? parts.join('; ') : (h.evidence.reason || '');
}
function h2Evidence(h) {
  const e = h.evidence;
  if (e.reason) return e.reason;
  return `total=${e.total}, nonConforming=${e.nonConforming}, dispositionMismatch=${e.dispositionMismatch}, countsMatch=${e.countsMatch}`;
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

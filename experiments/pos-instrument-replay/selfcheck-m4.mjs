#!/usr/bin/env node
// M4 hermetic selfcheck (CHK-003 + CHK-004 adversarial).
//
// Run by: node selfcheck-m4.mjs   (exit 0 iff every sub-check A..I passes)
//
// Guards analyze-batch.mjs — the purely-offline three-state H1-H4 analyzer —
// WITHOUT touching the committed evidence. Every sub-check builds a FRESH
// mkdtemp sandbox, COPIES the four evidence files + protocol.json(+.sha256) +
// lib/ + analyze-batch.mjs into it, mutates the copy as needed, runs the COPIED
// analyze-batch.mjs inside the sandbox (so the analyzer resolves its input dir
// from its own location), asserts on stdout / report.json / report.md, and
// cleans up. The committed artifacts are never mutated and the instrument is
// never re-run (analyze-batch is offline; this selfcheck only ever runs it).
//
// Sub-checks:
//   (A) HAPPY          — pristine evidence => overall all-pass + report written + digest.
//   (B) REPRODUCIBLE   — two runs => byte-identical report.json + identical digest.
//   (C) H1-FAIL        — mutate a proof's digests + recompute recordDigest => H1 fail.
//   (D) H2-FAIL        — flip a fail-closed verdict's fingerprintMatch => H2 fail.
//   (E) H3-FAIL        — set resume gapTotal=1 => H3 fail.
//   (F) H4-FAIL        — set a proof elapsedMs above cap + recompute recordDigest => H4 fail.
//   (G) INCONCLUSIVE   — empty resume-reconciliation.json => H3 inconclusive, some-inconclusive.
//   (H) INTEGRITY-ABORT— edit a ledger field WITHOUT recomputing recordDigest =>
//                        analyze-batch exits nonzero, names the iterationId, writes no all-pass report.
//   (I) NO-OVERCLAIM   — a fail case => report.md omits the claim text, says it is not asserted.
//   (J) H1-INCOMPLETE  — delete one full-scale proof record (re-sign the rest) => H1 fail.
//   (K) H1-VACUOUS     — strip digests+goldMetrics from proof records (re-sign) => H1 fail.
//   (L) H2-IDENTITY    — delete one fail-closed verdict + duplicate another (counts unchanged) => H2 fail.
//   (M) H3-STUB        — replace resume with a 3-field stub => H3 fail.
//   (N) H4-NEGATIVE    — one proof elapsedMs=-1 (re-sign) => H4 fail; and elapsedMs=null => H4 fail.
//   (O) ABSENT-FILE    — delete tamper-verdicts.jsonl entirely => no crash, H2 inconclusive,
//                        overall some-inconclusive, generatedInputs['tamper-verdicts.jsonl']===null.

import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256, canonicalJson } from './lib/instrument.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

function fail(name, msg) {
  console.error(`selfcheck-m4 FAIL: ${name}: ${msg}`);
  process.exit(1);
}
function ok(name, msg) {
  console.log(`  ${name} PASS: ${msg}`);
}

// A fragment of the §3 claim text, sufficient to detect the claim in report.md.
const CLAIM_FRAGMENT = 'the memory-baseline evidence instrument is';

/** Build a fresh sandbox with everything analyze-batch.mjs needs. */
function makeSandbox(tag) {
  const sandbox = mkdtempSync(join(tmpdir(), `pos-selfcheck-m4-${tag}-`));
  mkdirSync(join(sandbox, 'lib'), { recursive: true });
  cpSync(join(HERE, 'lib', 'instrument.mjs'), join(sandbox, 'lib', 'instrument.mjs'));
  cpSync(join(HERE, 'analyze-batch.mjs'), join(sandbox, 'analyze-batch.mjs'));
  for (const f of [
    'batch-ledger.jsonl',
    'tamper-verdicts.jsonl',
    'resume-reconciliation.json',
    'protocol.json',
    'protocol.json.sha256',
  ]) {
    cpSync(join(HERE, f), join(sandbox, f));
  }
  return sandbox;
}

/**
 * Run the sandbox copy of analyze-batch.mjs. Returns
 * { status, stdout, stderr }. status is 0 on success, nonzero on abort.
 */
function runAnalyze(sandbox) {
  try {
    const stdout = execFileSync('node', [join(sandbox, 'analyze-batch.mjs')], {
      encoding: 'utf8',
    });
    return { status: 0, stdout, stderr: '' };
  } catch (e) {
    return {
      status: e.status ?? 1,
      stdout: e.stdout ? String(e.stdout) : '',
      stderr: e.stderr ? String(e.stderr) : String(e.message || e),
    };
  }
}

/** Parse the `key: value` verdict lines analyze-batch prints to stdout. */
function parseVerdicts(stdout) {
  const map = {};
  for (const line of stdout.split('\n')) {
    const m = line.match(/^(H1 replay-determinism|H2 tamper-fail-closed|H3 resume-integrity|H4 scale-envelope|overall|digest):\s*(.+)$/);
    if (m) map[m[1]] = m[2].trim();
  }
  return map;
}

const readJsonl = (p) => readFileSync(p, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
function writeJsonl(p, recs) {
  writeFileSync(p, recs.map((r) => JSON.stringify(r)).join('\n') + '\n');
}
/** Re-sign a ledger record: recompute recordDigest over canonicalJson(record\recordDigest). */
function reSign(rec) {
  const { recordDigest, ...rest } = rec;
  return { ...rest, recordDigest: sha256(canonicalJson(rest)) };
}
function cleanup(sandbox) {
  rmSync(sandbox, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// (A) HAPPY
// ---------------------------------------------------------------------------
function checkA() {
  const s = makeSandbox('A');
  try {
    const r = runAnalyze(s);
    if (r.status !== 0) fail('A-happy', `analyze-batch exited ${r.status}: ${r.stderr}`);
    const v = parseVerdicts(r.stdout);
    if (v.overall !== 'all-pass') fail('A-happy', `overall=${v.overall}, expected all-pass`);
    if (!v.digest || !/^[0-9a-f]{64}$/.test(v.digest)) fail('A-happy', `missing/invalid digest: ${v.digest}`);
    if (!existsSync(join(s, 'report.json'))) fail('A-happy', 'report.json not written');
    if (!existsSync(join(s, 'report.md'))) fail('A-happy', 'report.md not written');
    const rep = readJson(join(s, 'report.json'));
    if (rep.digest !== v.digest) fail('A-happy', 'report.json digest != stdout digest');
    if (rep.overall !== 'all-pass') fail('A-happy', 'report.json overall != all-pass');
    if (!rep.claim) fail('A-happy', 'all-pass report.json missing claim field');
    ok('A-happy', `overall=all-pass, digest=${v.digest.slice(0, 12)}…, report.json+md written`);
  } finally {
    cleanup(s);
  }
}

// ---------------------------------------------------------------------------
// (B) REPRODUCIBLE
// ---------------------------------------------------------------------------
function checkB() {
  const s = makeSandbox('B');
  try {
    const r1 = runAnalyze(s);
    if (r1.status !== 0) fail('B-reproducible', `first run exited ${r1.status}`);
    const bytes1 = readFileSync(join(s, 'report.json'));
    const digest1 = parseVerdicts(r1.stdout).digest;
    const r2 = runAnalyze(s);
    if (r2.status !== 0) fail('B-reproducible', `second run exited ${r2.status}`);
    const bytes2 = readFileSync(join(s, 'report.json'));
    const digest2 = parseVerdicts(r2.stdout).digest;
    if (!bytes1.equals(bytes2)) fail('B-reproducible', 'report.json not byte-identical across runs');
    if (digest1 !== digest2) fail('B-reproducible', `digests differ: ${digest1} vs ${digest2}`);
    ok('B-reproducible', `two runs byte-identical, digest stable ${digest1.slice(0, 12)}…`);
  } finally {
    cleanup(s);
  }
}

// ---------------------------------------------------------------------------
// (C) H1-FAIL — mutate a proof's digests value AND re-sign (integrity passes).
// ---------------------------------------------------------------------------
function checkC() {
  const s = makeSandbox('C');
  try {
    const p = join(s, 'batch-ledger.jsonl');
    const recs = readJsonl(p);
    // pick the first small-scale proof and perturb its records digest.
    const idx = recs.findIndex((r) => r.scale === 'small' && r.verifyStatus !== undefined && r.digests);
    if (idx < 0) fail('C-h1-fail', 'no small proof record with digests found');
    const rec = recs[idx];
    rec.digests = { ...rec.digests, records: 'deadbeef'.repeat(8) };
    recs[idx] = reSign(rec); // recompute recordDigest so integrity passes
    writeJsonl(p, recs);
    const r = runAnalyze(s);
    if (r.status !== 0) fail('C-h1-fail', `analyze-batch aborted (${r.status}) — integrity should pass: ${r.stderr}`);
    const v = parseVerdicts(r.stdout);
    if (v['H1 replay-determinism'] !== 'fail') fail('C-h1-fail', `H1=${v['H1 replay-determinism']}, expected fail`);
    if (v.overall === 'all-pass') fail('C-h1-fail', 'overall should not be all-pass');
    ok('C-h1-fail', `H1=fail, overall=${v.overall}`);
  } finally {
    cleanup(s);
  }
}

// ---------------------------------------------------------------------------
// (D) H2-FAIL — flip a fail-closed verdict's fingerprintMatch to false.
// ---------------------------------------------------------------------------
function checkD() {
  const s = makeSandbox('D');
  try {
    const p = join(s, 'tamper-verdicts.jsonl');
    const recs = readJsonl(p);
    const idx = recs.findIndex((v) => v.rederivedDisposition === 'fail-closed');
    if (idx < 0) fail('D-h2-fail', 'no fail-closed verdict found');
    recs[idx] = { ...recs[idx], fingerprintMatch: false }; // violates the fail-closed rule
    writeJsonl(p, recs);
    const r = runAnalyze(s);
    if (r.status !== 0) fail('D-h2-fail', `analyze-batch aborted (${r.status}): ${r.stderr}`);
    const v = parseVerdicts(r.stdout);
    if (v['H2 tamper-fail-closed'] !== 'fail') fail('D-h2-fail', `H2=${v['H2 tamper-fail-closed']}, expected fail`);
    ok('D-h2-fail', `H2=fail (fail-closed verdict with fingerprintMatch=false), overall=${v.overall}`);
  } finally {
    cleanup(s);
  }
}

// ---------------------------------------------------------------------------
// (E) H3-FAIL — set resume gapTotal=1.
// ---------------------------------------------------------------------------
function checkE() {
  const s = makeSandbox('E');
  try {
    const p = join(s, 'resume-reconciliation.json');
    const j = readJson(p);
    j.gapTotal = 1;
    writeFileSync(p, JSON.stringify(j, null, 2));
    const r = runAnalyze(s);
    if (r.status !== 0) fail('E-h3-fail', `analyze-batch aborted (${r.status}): ${r.stderr}`);
    const v = parseVerdicts(r.stdout);
    if (v['H3 resume-integrity'] !== 'fail') fail('E-h3-fail', `H3=${v['H3 resume-integrity']}, expected fail`);
    ok('E-h3-fail', `H3=fail (gapTotal=1), overall=${v.overall}`);
  } finally {
    cleanup(s);
  }
}

// ---------------------------------------------------------------------------
// (F) H4-FAIL — set one proof elapsedMs above the cap AND re-sign.
// ---------------------------------------------------------------------------
function checkF() {
  const s = makeSandbox('F');
  try {
    const protocol = readJson(join(s, 'protocol.json'));
    const cap = protocol.budgetCaps.msPerVerify;
    const p = join(s, 'batch-ledger.jsonl');
    const recs = readJsonl(p);
    const idx = recs.findIndex((r) => r.verifyStatus !== undefined && r.elapsedMs !== undefined);
    if (idx < 0) fail('F-h4-fail', 'no proof record with elapsedMs found');
    const rec = recs[idx];
    rec.elapsedMs = cap + 1; // over the cap
    recs[idx] = reSign(rec); // recompute recordDigest so integrity passes
    writeJsonl(p, recs);
    const r = runAnalyze(s);
    if (r.status !== 0) fail('F-h4-fail', `analyze-batch aborted (${r.status}) — integrity should pass: ${r.stderr}`);
    const v = parseVerdicts(r.stdout);
    if (v['H4 scale-envelope'] !== 'fail') fail('F-h4-fail', `H4=${v['H4 scale-envelope']}, expected fail`);
    ok('F-h4-fail', `H4=fail (elapsedMs=${cap + 1} > cap=${cap}), overall=${v.overall}`);
  } finally {
    cleanup(s);
  }
}

// ---------------------------------------------------------------------------
// (G) INCONCLUSIVE — empty resume-reconciliation.json => H3 inconclusive.
// ---------------------------------------------------------------------------
function checkG() {
  const s = makeSandbox('G');
  try {
    writeFileSync(join(s, 'resume-reconciliation.json'), ''); // empty => missing evidence
    const r = runAnalyze(s);
    if (r.status !== 0) fail('G-inconclusive', `analyze-batch crashed (${r.status}) — should be graceful: ${r.stderr}`);
    const v = parseVerdicts(r.stdout);
    if (v['H3 resume-integrity'] !== 'inconclusive') fail('G-inconclusive', `H3=${v['H3 resume-integrity']}, expected inconclusive`);
    if (v['H3 resume-integrity'] === 'pass') fail('G-inconclusive', 'H3 must NOT be pass on missing evidence');
    if (v.overall !== 'some-inconclusive') fail('G-inconclusive', `overall=${v.overall}, expected some-inconclusive`);
    ok('G-inconclusive', `H3=inconclusive (empty file, no crash, not pass), overall=some-inconclusive`);
  } finally {
    cleanup(s);
  }
}

// ---------------------------------------------------------------------------
// (H) INTEGRITY-ABORT — edit a ledger field WITHOUT recomputing recordDigest.
// ---------------------------------------------------------------------------
function checkH() {
  const s = makeSandbox('H');
  try {
    const p = join(s, 'batch-ledger.jsonl');
    const recs = readJsonl(p);
    const idx = recs.findIndex((r) => r.verifyStatus !== undefined && r.elapsedMs !== undefined);
    if (idx < 0) fail('H-integrity-abort', 'no proof record found');
    const targetId = recs[idx].iterationId;
    recs[idx].elapsedMs = recs[idx].elapsedMs + 12345; // naive edit: recordDigest NOT recomputed
    writeJsonl(p, recs);
    // remove any stale report so we can assert none is written
    rmSync(join(s, 'report.json'), { force: true });
    rmSync(join(s, 'report.md'), { force: true });
    const r = runAnalyze(s);
    if (r.status === 0) fail('H-integrity-abort', 'analyze-batch should have aborted nonzero on a naively-edited ledger');
    const msg = r.stderr + r.stdout;
    if (!msg.includes('input-integrity')) fail('H-integrity-abort', `abort message missing "input-integrity": ${msg.trim()}`);
    if (!msg.includes(targetId)) fail('H-integrity-abort', `abort message did not name the iterationId ${targetId}: ${msg.trim()}`);
    // no all-pass report may exist
    if (existsSync(join(s, 'report.json'))) {
      const rep = readJson(join(s, 'report.json'));
      if (rep.overall === 'all-pass') fail('H-integrity-abort', 'an all-pass report.json was written despite abort');
    }
    ok('H-integrity-abort', `exit ${r.status}, named ${targetId}, no all-pass report`);
  } finally {
    cleanup(s);
  }
}

// ---------------------------------------------------------------------------
// (I) NO-OVERCLAIM — a fail case (reuse E: gapTotal=1) => report.md omits the
//     claim text and states the claim is not asserted.
// ---------------------------------------------------------------------------
function checkI() {
  const s = makeSandbox('I');
  try {
    const p = join(s, 'resume-reconciliation.json');
    const j = readJson(p);
    j.gapTotal = 1;
    writeFileSync(p, JSON.stringify(j, null, 2));
    const r = runAnalyze(s);
    if (r.status !== 0) fail('I-no-overclaim', `analyze-batch aborted (${r.status}): ${r.stderr}`);
    const v = parseVerdicts(r.stdout);
    if (v.overall === 'all-pass') fail('I-no-overclaim', 'expected a non-all-pass overall');
    const md = readFileSync(join(s, 'report.md'), 'utf8');
    if (md.includes(CLAIM_FRAGMENT)) fail('I-no-overclaim', 'report.md contains the claim text in a fail case');
    if (!/Claim NOT asserted/i.test(md)) fail('I-no-overclaim', 'report.md does not say the claim is not asserted');
    // report.json must also omit the claim field
    const rep = readJson(join(s, 'report.json'));
    if ('claim' in rep) fail('I-no-overclaim', 'report.json still carries a claim field in a fail case');
    ok('I-no-overclaim', `overall=${v.overall}, report.md omits claim + says "Claim NOT asserted"`);
  } finally {
    cleanup(s);
  }
}

// ---------------------------------------------------------------------------
// (J) H1-INCOMPLETE — delete one full-scale proof record (re-sign the rest) so
//     the ledger stays integrity-clean but the full scale has < N[full]
//     records => H1 must FAIL (incomplete), overall must NOT be all-pass.
// ---------------------------------------------------------------------------
function checkJ() {
  const s = makeSandbox('J');
  try {
    const p = join(s, 'batch-ledger.jsonl');
    const recs = readJsonl(p);
    const idx = recs.findIndex((r) => r.scale === 'full' && r.verifyStatus !== undefined);
    if (idx < 0) fail('J-h1-incomplete', 'no full-scale proof record found');
    recs.splice(idx, 1); // drop one full-scale proof record
    // Each surviving record still has a valid recordDigest (untouched); re-sign
    // is a no-op here but keep the ledger integrity-clean explicitly.
    writeJsonl(p, recs.map((r) => reSign(r)));
    const r = runAnalyze(s);
    if (r.status !== 0) fail('J-h1-incomplete', `analyze-batch aborted (${r.status}) — integrity should pass: ${r.stderr}`);
    const v = parseVerdicts(r.stdout);
    if (v['H1 replay-determinism'] !== 'fail') fail('J-h1-incomplete', `H1=${v['H1 replay-determinism']}, expected fail`);
    if (v.overall === 'all-pass') fail('J-h1-incomplete', 'overall should not be all-pass');
    ok('J-h1-incomplete', `H1=fail (full scale short one record), overall=${v.overall}`);
  } finally {
    cleanup(s);
  }
}

// ---------------------------------------------------------------------------
// (K) H1-VACUOUS — strip digests + goldMetrics from the proof records and
//     re-sign each (integrity passes) => H1 must FAIL (vacuous/malformed):
//     stripping the substantive evidence must NOT pass.
// ---------------------------------------------------------------------------
function checkK() {
  const s = makeSandbox('K');
  try {
    const p = join(s, 'batch-ledger.jsonl');
    const recs = readJsonl(p);
    const stripped = recs.map((r) => {
      if (r.verifyStatus === undefined) return r;
      const { digests, goldMetrics, ...rest } = r;
      return reSign(rest); // remove digests+goldMetrics, recompute recordDigest
    });
    writeJsonl(p, stripped);
    const r = runAnalyze(s);
    if (r.status !== 0) fail('K-h1-vacuous', `analyze-batch aborted (${r.status}) — integrity should pass: ${r.stderr}`);
    const v = parseVerdicts(r.stdout);
    if (v['H1 replay-determinism'] !== 'fail') fail('K-h1-vacuous', `H1=${v['H1 replay-determinism']}, expected fail`);
    if (v.overall === 'all-pass') fail('K-h1-vacuous', 'overall should not be all-pass');
    ok('K-h1-vacuous', `H1=fail (digests+goldMetrics stripped), overall=${v.overall}`);
  } finally {
    cleanup(s);
  }
}

// ---------------------------------------------------------------------------
// (L) H2-IDENTITY — delete one fail-closed verdict and DUPLICATE a different
//     one so per-disposition COUNTS are unchanged, but the {class|handling}
//     identity set now has a missing + a duplicate => H2 must FAIL on identity
//     coverage even though counts still match.
// ---------------------------------------------------------------------------
function checkL() {
  const s = makeSandbox('L');
  try {
    const p = join(s, 'tamper-verdicts.jsonl');
    const recs = readJsonl(p);
    const failClosed = recs.filter((v) => v.rederivedDisposition === 'fail-closed');
    if (failClosed.length < 2) fail('L-h2-identity', 'need >=2 fail-closed verdicts to swap');
    const victim = failClosed[0]; // this identity will go missing
    const donor = failClosed[1]; // this identity will be duplicated
    const victimId = `${victim.class}|${victim.handling}`;
    const donorId = `${donor.class}|${donor.handling}`;
    if (victimId === donorId) fail('L-h2-identity', 'victim and donor share an identity');
    // remove the victim; append a copy of the donor => counts unchanged.
    const out = recs.filter((v) => v !== victim);
    out.push({ ...donor });
    writeJsonl(p, out);
    const r = runAnalyze(s);
    if (r.status !== 0) fail('L-h2-identity', `analyze-batch aborted (${r.status}): ${r.stderr}`);
    const v = parseVerdicts(r.stdout);
    if (v['H2 tamper-fail-closed'] !== 'fail') fail('L-h2-identity', `H2=${v['H2 tamper-fail-closed']}, expected fail`);
    // confirm the counts really did stay matched (so identity is what caught it)
    const rep = readJson(join(s, 'report.json'));
    if (rep.hypotheses.H2.evidence.countsMatch !== true) {
      fail('L-h2-identity', 'expected countsMatch to stay true so IDENTITY is the discriminator');
    }
    if (rep.hypotheses.H2.evidence.identityMatch !== false) {
      fail('L-h2-identity', 'expected identityMatch=false');
    }
    ok('L-h2-identity', `H2=fail via identity (missing ${victimId}, dup ${donorId}; counts unchanged), overall=${v.overall}`);
  } finally {
    cleanup(s);
  }
}

// ---------------------------------------------------------------------------
// (M) H3-STUB — replace resume-reconciliation.json with a bare 3-field stub
//     {dupTotal,gapTotal,finalMultisetMatch} => H3 must FAIL (missing the
//     substantive kill*/protocolReplaySmallCount/hypothesis structure).
// ---------------------------------------------------------------------------
function checkM() {
  const s = makeSandbox('M');
  try {
    const p = join(s, 'resume-reconciliation.json');
    writeFileSync(p, JSON.stringify({ dupTotal: 0, gapTotal: 0, finalMultisetMatch: true }, null, 2));
    const r = runAnalyze(s);
    if (r.status !== 0) fail('M-h3-stub', `analyze-batch aborted (${r.status}): ${r.stderr}`);
    const v = parseVerdicts(r.stdout);
    if (v['H3 resume-integrity'] !== 'fail') fail('M-h3-stub', `H3=${v['H3 resume-integrity']}, expected fail`);
    if (v.overall === 'all-pass') fail('M-h3-stub', 'overall should not be all-pass');
    ok('M-h3-stub', `H3=fail (3-field stub, no substantive structure), overall=${v.overall}`);
  } finally {
    cleanup(s);
  }
}

// ---------------------------------------------------------------------------
// (N) H4-NEGATIVE — a proof record with elapsedMs=-1 (re-signed) must FAIL H4;
//     and elapsedMs=null must ALSO FAIL (must not coerce to 0 and pass).
// ---------------------------------------------------------------------------
function checkN() {
  const s = makeSandbox('N');
  try {
    const p = join(s, 'batch-ledger.jsonl');
    // sub-case (i): elapsedMs = -1
    {
      const recs = readJsonl(p);
      const idx = recs.findIndex((r) => r.verifyStatus !== undefined && r.elapsedMs !== undefined);
      if (idx < 0) fail('N-h4-negative', 'no proof record with elapsedMs found');
      const rec = recs[idx];
      rec.elapsedMs = -1;
      recs[idx] = reSign(rec);
      writeJsonl(p, recs);
      const r = runAnalyze(s);
      if (r.status !== 0) fail('N-h4-negative', `analyze-batch aborted (${r.status}) — integrity should pass: ${r.stderr}`);
      const v = parseVerdicts(r.stdout);
      if (v['H4 scale-envelope'] !== 'fail') fail('N-h4-negative', `elapsedMs=-1: H4=${v['H4 scale-envelope']}, expected fail`);
    }
    // sub-case (ii): elapsedMs = null (must NOT coerce to 0 and pass)
    {
      const recs = readJsonl(p); // fresh copy of the still-pristine committed file
      const idx = recs.findIndex((r) => r.verifyStatus !== undefined && r.elapsedMs !== undefined);
      const rec = recs[idx];
      rec.elapsedMs = null;
      recs[idx] = reSign(rec);
      writeJsonl(p, recs);
      const r = runAnalyze(s);
      if (r.status !== 0) fail('N-h4-negative', `elapsedMs=null: analyze-batch aborted (${r.status}): ${r.stderr}`);
      const v = parseVerdicts(r.stdout);
      if (v['H4 scale-envelope'] !== 'fail') fail('N-h4-negative', `elapsedMs=null: H4=${v['H4 scale-envelope']}, expected fail`);
    }
    ok('N-h4-negative', 'H4=fail for elapsedMs=-1 and for elapsedMs=null (no coercion to 0)');
  } finally {
    cleanup(s);
  }
}

// ---------------------------------------------------------------------------
// (O) ABSENT-FILE — delete tamper-verdicts.jsonl entirely: analyze-batch must
//     NOT crash (exit 0), H2 must be inconclusive, overall some-inconclusive,
//     and generatedInputs['tamper-verdicts.jsonl'] must be null.
// ---------------------------------------------------------------------------
function checkO() {
  const s = makeSandbox('O');
  try {
    rmSync(join(s, 'tamper-verdicts.jsonl'), { force: true }); // genuinely absent
    const r = runAnalyze(s);
    if (r.status !== 0) fail('O-absent-file', `analyze-batch crashed (${r.status}) on an absent input — must be graceful: ${r.stderr}`);
    const v = parseVerdicts(r.stdout);
    if (v['H2 tamper-fail-closed'] !== 'inconclusive') fail('O-absent-file', `H2=${v['H2 tamper-fail-closed']}, expected inconclusive`);
    if (v.overall !== 'some-inconclusive') fail('O-absent-file', `overall=${v.overall}, expected some-inconclusive`);
    if (v.overall === 'all-pass') fail('O-absent-file', 'must NOT emit all-pass when an input was absent');
    const rep = readJson(join(s, 'report.json'));
    if (rep.generatedInputs['tamper-verdicts.jsonl'] !== null) {
      fail('O-absent-file', `generatedInputs['tamper-verdicts.jsonl']=${JSON.stringify(rep.generatedInputs['tamper-verdicts.jsonl'])}, expected null`);
    }
    ok('O-absent-file', 'no crash, H2=inconclusive, overall=some-inconclusive, generatedInputs sha=null');
  } finally {
    cleanup(s);
  }
}

function main() {
  checkA();
  checkB();
  checkC();
  checkD();
  checkE();
  checkF();
  checkG();
  checkH();
  checkI();
  checkJ();
  checkK();
  checkL();
  checkM();
  checkN();
  checkO();
  console.log('selfcheck-m4 PASS');
  process.exit(0);
}

main();

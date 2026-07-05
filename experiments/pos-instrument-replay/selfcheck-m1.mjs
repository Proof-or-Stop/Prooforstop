#!/usr/bin/env node
// M1 hermetic selfcheck (B-bae9 CHK-003).
//
// Run by: node selfcheck-m1.mjs   (exit 0 iff both guards pass)
//
// Guards the M1 tamper harness's two load-bearing properties WITHOUT touching
// the committed tamper-verdicts.jsonl (all work happens in an mkdtemp sandbox
// copy of the experiment dir):
//
//   (a) DETERMINISM: run tamper.mjs TWICE against the frozen protocol.json and
//       assert the produced tamper-verdicts.jsonl is byte-identical (the harness
//       already excludes volatile fields elapsedMs/rss/absolute paths from the
//       recorded content, so a byte compare is the modulo-volatile compare).
//
//   (a2) CLEAN-RUN INVARIANTS (findings F-001/F-002): assert that every clean-run
//       verdict carries the new byteDiff/dispositionMatch evidence AND satisfies
//       the mutation-applied + re-derived-disposition + dropped-semantics
//       invariants (dispositionMatch true for all classes; every non-dropped
//       class shows a real byteDiff; every dropped class is records+gold-identical
//       to clean). This re-checks the recorded evidence independently of
//       tamper.mjs's own exit code.
//
//   (b) NEGATIVE TEST (anti-tautology): copy protocol.json to a temp path, flip
//       exactly ONE expected boolean flag in ONE failClosed entry's frozen
//       fingerprint, point tamper.mjs at the corrupted copy via POS_PROTOCOL_PATH,
//       and assert tamper.mjs (i) exits NONZERO and (ii) reports fingerprintMatch
//       false for that class in its emitted tamper-verdicts.jsonl. This proves
//       the conformance check is not a tautology: it actually compares against
//       the frozen fingerprint and fails when the frozen fingerprint is wrong.
//
// Hermeticity: the experiment dir (tamper.mjs + lib + protocol.json) is copied
// into an mkdtemp sandbox; tamper.mjs is executed with cwd=sandbox and its output
// tamper-verdicts.jsonl is read from the sandbox. The committed artifacts are
// never mutated. (The generate/verify CLI IS invoked — the harness needs a live
// baseline — but only the frozen protocol.json is read, never rewritten.)

import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

function fail(msg) {
  console.error('selfcheck-m1 FAIL: ' + msg);
  process.exit(1);
}

/** Copy the pieces tamper.mjs needs into a fresh sandbox dir. */
function makeSandbox() {
  const sandbox = mkdtempSync(join(tmpdir(), 'pos-selfcheck-m1-'));
  mkdirSync(join(sandbox, 'lib'), { recursive: true });
  cpSync(join(HERE, 'lib', 'instrument.mjs'), join(sandbox, 'lib', 'instrument.mjs'));
  cpSync(join(HERE, 'tamper.mjs'), join(sandbox, 'tamper.mjs'));
  cpSync(join(HERE, 'protocol.json'), join(sandbox, 'protocol.json'));
  // viability-results.json carries the authoritative per-(class,handling) intent
  // that tamper.mjs uses to RE-DERIVE the M0 disposition (findings F-001/F-002).
  // Copy it so the sandbox resolves intent via the primary source, exactly as
  // the committed run does.
  cpSync(join(HERE, 'viability-results.json'), join(sandbox, 'viability-results.json'));
  return sandbox;
}

/**
 * Run tamper.mjs in the sandbox. Returns { code, stdout, stderr, verdicts }
 * where verdicts is the sandbox tamper-verdicts.jsonl content (or null if not
 * produced). Never throws on a nonzero exit — the caller inspects code.
 */
function runTamper(sandbox, env = {}) {
  let code = 0;
  let stdout = '';
  let stderr = '';
  try {
    stdout = execFileSync('node', ['tamper.mjs'], {
      cwd: sandbox,
      encoding: 'utf8',
      env: { ...process.env, ...env },
      maxBuffer: 1 << 26,
    });
  } catch (e) {
    code = typeof e.status === 'number' ? e.status : 1;
    stdout = e.stdout ? String(e.stdout) : '';
    stderr = e.stderr ? String(e.stderr) : '';
  }
  let verdicts = null;
  try {
    verdicts = readFileSync(join(sandbox, 'tamper-verdicts.jsonl'), 'utf8');
  } catch {
    verdicts = null;
  }
  return { code, stdout, stderr, verdicts };
}

function main() {
  // -----------------------------------------------------------------------
  // (a) Determinism: two clean runs must produce byte-identical verdicts.
  // -----------------------------------------------------------------------
  const sandboxA = makeSandbox();
  let run1, run2;
  try {
    run1 = runTamper(sandboxA);
    if (run1.code !== 0) {
      fail(`determinism run #1 exited nonzero (code=${run1.code}).\n${run1.stderr}`);
    }
    if (run1.verdicts === null) {
      fail('determinism run #1 produced no tamper-verdicts.jsonl.');
    }
    run2 = runTamper(sandboxA);
    if (run2.code !== 0) {
      fail(`determinism run #2 exited nonzero (code=${run2.code}).\n${run2.stderr}`);
    }
    if (run2.verdicts === null) {
      fail('determinism run #2 produced no tamper-verdicts.jsonl.');
    }
    if (run1.verdicts !== run2.verdicts) {
      fail('tamper-verdicts.jsonl is NOT byte-identical across two runs (non-deterministic).');
    }
  } finally {
    rmSync(sandboxA, { recursive: true, force: true });
  }

  const verdictLines = run1.verdicts.trim().split('\n');
  console.log(
    `selfcheck-m1 (a) determinism: two runs byte-identical (${verdictLines.length} verdict lines).`,
  );

  // -----------------------------------------------------------------------
  // (a2) Clean-run invariants (findings F-001/F-002): on the clean run every
  //      verdict must carry the new byteDiff / dispositionMatch fields and
  //      satisfy the three invariants tamper.mjs asserts:
  //        - dispositionMatch === true for ALL classes (re-derived M0
  //          disposition matches the frozen bucket);
  //        - every NON-dropped class has a real byteDiff (records OR gold OR
  //          manifest changed) — no silent no-op mutation;
  //        - every dropped class has records + gold byte-identical to clean
  //          (byteDiff.recordsChanged === false AND goldChanged === false).
  //      run1.code === 0 already proves tamper.mjs did not itself flag a
  //      violation; this re-checks the recorded evidence independently so the
  //      selfcheck fails if a future edit records the fields but drops the guard.
  // -----------------------------------------------------------------------
  const verdicts = verdictLines
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
  for (const v of verdicts) {
    if (!v.byteDiff || typeof v.byteDiff.recordsChanged !== 'boolean') {
      fail(`clean-run invariant: verdict for ${v.class}[${v.handling}] is missing a byteDiff.`);
    }
    if (v.dispositionMatch !== true) {
      fail(
        `clean-run invariant: dispositionMatch is not true for ${v.class}[${v.handling}] ` +
          `(rederived='${v.rederivedDisposition}' expected='${v.expectedDisposition}').`,
      );
    }
    if (v.bucket === 'dropped') {
      if (v.byteDiff.recordsChanged || v.byteDiff.goldChanged) {
        fail(
          `clean-run invariant: dropped class ${v.class}[${v.handling}] has records/gold ` +
            `changed vs clean (byteDiff=${JSON.stringify(v.byteDiff)}); dropped must be content-inert.`,
        );
      }
    } else {
      const anyChanged =
        v.byteDiff.recordsChanged || v.byteDiff.goldChanged || v.byteDiff.manifestChanged;
      if (!anyChanged) {
        fail(
          `clean-run invariant: non-dropped class ${v.class}[${v.handling}] has an EMPTY byteDiff ` +
            `(silent no-op mutation); every non-dropped mutation must change records, gold or manifest.`,
        );
      }
    }
  }
  console.log(
    `selfcheck-m1 (a2) clean-run invariants: all ${verdicts.length} verdicts have dispositionMatch ` +
      `true, every non-dropped class has a non-empty byteDiff, and every dropped class is ` +
      `records+gold-identical to clean.`,
  );

  // -----------------------------------------------------------------------
  // (b) Negative test (anti-tautology): flip one expected flag in one
  //     failClosed entry's frozen fingerprint and prove the harness detects it.
  // -----------------------------------------------------------------------
  const sandboxB = makeSandbox();
  try {
    // Load the frozen protocol from the sandbox and pick a deterministic target:
    // the failClosed entry whose class sorts FIRST, that has a real (non-crash)
    // flag payload to flip. cross-profile-swap sorts first and has flags.
    const protoPath = join(sandboxB, 'protocol.json');
    const proto = JSON.parse(readFileSync(protoPath, 'utf8'));
    const failClosed = proto.tamperMatrix.failClosed
      .filter((e) => e.fingerprint && e.fingerprint.flags && Object.keys(e.fingerprint.flags).length)
      .sort((a, b) =>
        a.class === b.class ? a.handling.localeCompare(b.handling) : a.class.localeCompare(b.class),
      );
    if (failClosed.length === 0) {
      fail('no failClosed entry with a flag payload to corrupt (unexpected frozen matrix).');
    }
    const target = failClosed[0];
    const targetClass = target.class;
    const targetHandling = target.handling;

    // Flip exactly ONE expected boolean flag. Pick a deterministic flag key: the
    // first flag key (sorted) whose value is a boolean.
    const flagKeys = Object.keys(target.fingerprint.flags)
      .filter((k) => typeof target.fingerprint.flags[k] === 'boolean')
      .sort();
    if (flagKeys.length === 0) {
      fail(`target failClosed entry ${targetClass} has no boolean flag to flip.`);
    }
    const flipKey = flagKeys[0];
    const original = target.fingerprint.flags[flipKey];
    target.fingerprint.flags[flipKey] = !original;

    // Write the corrupted protocol to a temp path (NOT overwriting the sandbox's
    // protocol.json used elsewhere — write a distinct file and point at it).
    const corruptedPath = join(sandboxB, 'protocol.corrupted.json');
    writeFileSync(corruptedPath, JSON.stringify(proto));

    const neg = runTamper(sandboxB, { POS_PROTOCOL_PATH: corruptedPath });

    // (i) must exit nonzero.
    if (neg.code === 0) {
      fail(
        `negative test: tamper.mjs exited 0 against a corrupted frozen fingerprint ` +
          `(flipped ${targetClass}[${targetHandling}].flags.${flipKey} ${original}->${!original}); ` +
          `the conformance check is a TAUTOLOGY.`,
      );
    }

    // (ii) must report fingerprintMatch false for the corrupted class.
    if (neg.verdicts === null) {
      fail('negative test: tamper.mjs produced no tamper-verdicts.jsonl.');
    }
    let foundMismatchForTarget = false;
    for (const line of neg.verdicts.trim().split('\n')) {
      if (!line.trim()) continue;
      const v = JSON.parse(line);
      if (v.class === targetClass && v.handling === targetHandling) {
        if (v.fingerprintMatch === false) foundMismatchForTarget = true;
      }
    }
    if (!foundMismatchForTarget) {
      fail(
        `negative test: expected fingerprintMatch:false for ${targetClass}[${targetHandling}] ` +
          `after flipping flags.${flipKey}, but the verdict did not report a mismatch.`,
      );
    }

    console.log(
      `selfcheck-m1 (b) negative test: flipped ${targetClass}[${targetHandling}].flags.${flipKey} ` +
        `${original}->${!original} => tamper.mjs exited ${neg.code} (nonzero) and reported ` +
        `fingerprintMatch:false for that class (conformance check is NOT a tautology).`,
    );
  } finally {
    rmSync(sandboxB, { recursive: true, force: true });
  }

  // (c) op-coverage self-test (finding F-005): tamper.mjs --optselftest exercises
  // every compareFingerprint predicate branch (==, <, >, !=) plus the unknown-op
  // throw, which the frozen protocol (only == / <) and the negative test (flips a
  // boolean flag) never reach.
  let optOut;
  try {
    optOut = execFileSync('node', ['tamper.mjs', '--optselftest'], {
      cwd: HERE,
      encoding: 'utf8',
    });
  } catch (e) {
    fail(`(c) op-coverage: tamper.mjs --optselftest exited nonzero: ${e.stderr || e.message}`);
  }
  if (!/optselftest PASS/.test(optOut)) {
    fail(`(c) op-coverage: expected "optselftest PASS", got: ${optOut}`);
  }
  console.log(
    'selfcheck-m1 (c) op-coverage: compareFingerprint ==,<,>,!= branches + unknown-op-throw all verified.',
  );

  console.log('selfcheck-m1 PASS');
  process.exit(0);
}

main();

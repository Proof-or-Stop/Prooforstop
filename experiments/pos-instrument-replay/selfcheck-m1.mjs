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

  console.log('selfcheck-m1 PASS');
  process.exit(0);
}

main();

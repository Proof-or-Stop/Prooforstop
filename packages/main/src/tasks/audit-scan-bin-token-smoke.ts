/**
 * audit-scan-bin-token-smoke — B-cdf6 CHK-005 regression guard against the docs-drift extractor
 * going VACUOUSLY BLIND after the `proof-or-stop` -> `proof-or-stop` bin rename.
 *
 * The bug this pins: `scanCommandDrift` / `scanFlagDrift` used to extract documented commands with
 * a single hardcoded literal (`/\bproofOrStop\s+(...)/g`). Once the active docs were rewritten to read
 * `proof-or-stop <cmd>`, that regex matched NOTHING — the loop body never executed, the scan
 * returned zero drifts, and the gate reported a PASS. A doc could then reference a nonexistent
 * command forever undetected, defeating the exact drift class the scanner exists to catch. A
 * vacuous pass is strictly worse than a loud failure, so every assertion below is written to FAIL
 * if the extractor regresses to a single bin token or stops distinguishing "extracted nothing"
 * from "found nothing wrong".
 *
 * Coverage:
 *   1. happy       — a bogus `proof-or-stop no_such_command` reference IS reported as drift
 *   2. happy       — multiple canonical command references are all reported
 *   3. happy       — a real command with a real flag produces no drift (no false positive)
 *   4. edge        — flag drift is caught under the renamed bin token too
 *   5. adversarial — the ORIGINAL vacuous-pass scenario: renamed-bin doc, bogus command, zero
 *                    drift would mean blindness. Asserts drift IS reported.
 *   7. adversarial — an empty extraction is mechanically distinguishable from a clean scan
 *                    (`extractedCommands` is empty ONLY when nothing was extracted)
 *   8. adversarial — `runMechanicalAudit` propagates extractedCommands, so the handler that
 *                    prints the blindness warning cannot be fed a false "clean" signal
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runMechanicalAudit,
  scanCommandDrift,
  scanFlagDrift,
} from '../core/audit-scan.js';
import { PROOF_OR_STOP_PRIMARY_BIN } from '../core/proof-or-stop-brand.js';

/** Stub help runner: `validate` is the only registered command; everything else exits non-zero. */
const runHelp = (cmd: string) => (cmd === 'validate'
  ? { ok: true, output: 'Usage: validate [--json] [--full]\n' }
  : { ok: false, reason: 'exit-nonzero', output: `unknown command: ${cmd}` });

const BOGUS = 'no_such_command';

function fence(...body: string[]): string {
  return ['# Doc', '', '```bash', ...body, '```', ''].join('\n');
}

// ---------------------------------------------------------------------------
// 1. happy — bogus command under the CANONICAL renamed bin is reported as drift
// ---------------------------------------------------------------------------
{
  const md = fence(`${PROOF_OR_STOP_PRIMARY_BIN} ${BOGUS}`);
  const r = scanCommandDrift(md, 'CLAUDE.md', { runHelp });
  const hit = r.drifts.find(d => d.driftType === 'missing-command' && d.symbol.endsWith(` ${BOGUS}`));
  assert.ok(
    hit,
    `REGRESSION: \`${PROOF_OR_STOP_PRIMARY_BIN} ${BOGUS}\` was NOT reported as drift — the extractor is blind to the canonical bin token, so the docs-drift scan passes vacuously`,
  );
  assert.equal(hit.symbol, `${PROOF_OR_STOP_PRIMARY_BIN} ${BOGUS}`, 'drift symbol echoes the bin token the doc actually used');
  assert.deepEqual(r.extractedCommands, [BOGUS], 'the bogus command is recorded as extracted');
  console.log(`  test1 ok: ${PROOF_OR_STOP_PRIMARY_BIN} ${BOGUS} -> drift (${hit.symbol})`);
}

// ---------------------------------------------------------------------------
// 2. happy — multiple canonical commands are all reported
// ---------------------------------------------------------------------------
{
  const md = fence(
    `${PROOF_OR_STOP_PRIMARY_BIN} ${BOGUS}`,
    `${PROOF_OR_STOP_PRIMARY_BIN} another_missing_cmd`,
  );
  const r = scanCommandDrift(md, 'CLAUDE.md', { runHelp });
  const symbols = r.drifts.map(d => d.symbol).sort();
  assert.deepEqual(
    symbols,
    [`${PROOF_OR_STOP_PRIMARY_BIN} ${BOGUS}`, `${PROOF_OR_STOP_PRIMARY_BIN} another_missing_cmd`].sort(),
    'multiple canonical command references must each report drift',
  );
  assert.equal(r.extractedCommands.length, 2, 'both commands counted as extracted');
  console.log('  test2 ok: multiple canonical commands report all drifts');
}

// ---------------------------------------------------------------------------
// 4. happy — a real command + real flag yields NO drift (guards against false positives)
// ---------------------------------------------------------------------------
{
  const md = fence(`${PROOF_OR_STOP_PRIMARY_BIN} validate --json`);
  const c = scanCommandDrift(md, 'CLAUDE.md', { runHelp });
  const f = scanFlagDrift(md, 'CLAUDE.md', { runHelp });
  assert.equal(c.drifts.length, 0, 'a registered command must not be reported as drift');
  assert.equal(f.drifts.length, 0, 'a flag present in help output must not be reported as drift');
  // This is the case that distinguishes a genuine clean scan from a blind one.
  assert.deepEqual(c.extractedCommands, ['validate'], 'a clean scan still records a NON-EMPTY extraction');
  console.log('  test4 ok: real command + real flag -> no drift, extraction non-empty');
}

// ---------------------------------------------------------------------------
// 5. edge — flag drift under the renamed bin token
// ---------------------------------------------------------------------------
{
  const md = fence(`${PROOF_OR_STOP_PRIMARY_BIN} validate --totally-made-up`);
  const f = scanFlagDrift(md, 'CLAUDE.md', { runHelp });
  const hit = f.drifts.find(d => d.driftType === 'missing-flag');
  assert.ok(
    hit,
    `REGRESSION: flag drift went blind under \`${PROOF_OR_STOP_PRIMARY_BIN}\` — scanFlagDrift shares the same vacuous-pass failure mode as scanCommandDrift`,
  );
  assert.equal(hit.symbol, `${PROOF_OR_STOP_PRIMARY_BIN} validate --totally-made-up`);
  console.log(`  test5 ok: flag drift caught under ${PROOF_OR_STOP_PRIMARY_BIN}`);
}

// ---------------------------------------------------------------------------
// 6. adversarial — the exact vacuous-pass scenario, asserted from the OUTSIDE
// ---------------------------------------------------------------------------
{
  // A doc written entirely in the renamed brand, referencing a command that does not exist.
  // Pre-fix this returned `drifts: []` and the gate called it a PASS.
  const md = fence(`${PROOF_OR_STOP_PRIMARY_BIN} ${BOGUS} --some-flag`);
  const r = scanCommandDrift(md, 'CLAUDE.md', { runHelp });
  assert.notEqual(
    r.drifts.length,
    0,
    'VACUOUS PASS: a renamed-bin doc referencing a nonexistent command returned ZERO drifts — the scan is blind and its PASS is meaningless',
  );
  assert.notEqual(r.extractedCommands.length, 0, 'a scan that reports drift must have extracted something');
  console.log('  test6 ok: renamed-bin bogus command is NOT a vacuous pass');
}

// ---------------------------------------------------------------------------
// 7. adversarial — empty extraction is distinguishable from a clean scan
// ---------------------------------------------------------------------------
{
  // Prose that names no command at all: extraction is legitimately empty AND there is no drift.
  const noCommands = ['# Doc', '', 'This document mentions no runnable command.', ''].join('\n');
  const empty = scanCommandDrift(noCommands, 'CLAUDE.md', { runHelp });
  assert.equal(empty.drifts.length, 0, 'no commands documented -> no drift');
  assert.equal(empty.extractedCommands.length, 0, 'no commands documented -> empty extraction');

  // A genuinely clean doc: also zero drift, but a NON-EMPTY extraction.
  const clean = scanCommandDrift(fence(`${PROOF_OR_STOP_PRIMARY_BIN} validate`), 'CLAUDE.md', { runHelp });
  assert.equal(clean.drifts.length, 0, 'registered command -> no drift');
  assert.ok(clean.extractedCommands.length > 0, 'clean scan -> non-empty extraction');

  // The load-bearing assertion: drifts.length alone CANNOT tell these two apart, extractedCommands can.
  assert.equal(empty.drifts.length, clean.drifts.length, 'drift count alone is ambiguous between blind and clean');
  assert.notEqual(
    empty.extractedCommands.length,
    clean.extractedCommands.length,
    'REGRESSION: extractedCommands no longer distinguishes a blind scan from a clean one, so an empty extraction could again be misread as "all good"',
  );
  console.log('  test7 ok: empty extraction is mechanically distinguishable from a clean scan');
}

// ---------------------------------------------------------------------------
// 8. adversarial — runMechanicalAudit propagates the blindness signal end to end
// ---------------------------------------------------------------------------
{
  const root = mkdtempSync(join(tmpdir(), 'audit-scan-bin-token-'));
  try {
    const mdPath = join(root, 'CLAUDE.md');
    writeFileSync(mdPath, fence(
      `${PROOF_OR_STOP_PRIMARY_BIN} validate --json`,
      `${PROOF_OR_STOP_PRIMARY_BIN} ${BOGUS}`,
    ), 'utf-8');

    const report = runMechanicalAudit([mdPath], root, {
      registryNames: new Set(['validate']),
      runHelp,
      grepLiteral: () => true,
      pathExists: () => true,
    });

    assert.ok(
      report.drifts.some(d => d.symbol === `${PROOF_OR_STOP_PRIMARY_BIN} ${BOGUS}` && d.driftType === 'missing-command'),
      `REGRESSION: runMechanicalAudit did not surface \`${PROOF_OR_STOP_PRIMARY_BIN} ${BOGUS}\` as missing-command drift`,
    );
    assert.deepEqual(
      report.extractedCommands.sort(),
      [BOGUS, 'validate'].sort(),
      'aggregate report exposes every extracted command so the handler can warn on a zero-extraction scan',
    );
    // The registry advisory branch must not double-report what the command scanner already caught.
    const bogusHits = report.drifts.filter(d => d.symbol.endsWith(` ${BOGUS}`) && d.driftType === 'missing-command');
    assert.equal(bogusHits.length, 1, 'bin-token-aware dedup keeps the registry advisory from duplicating the command drift');
    console.log('  test8 ok: runMechanicalAudit propagates drift + extractedCommands, no duplicate advisory');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

console.log('audit-scan-bin-token-smoke ok');

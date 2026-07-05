#!/usr/bin/env node
// Hermetic selfcheck (M0 CHK-004).
//
// Run by: node selfcheck.mjs
//
// Guards the two M0 invariants without any network access and without a
// pre-existing live baseline:
//   (a) build-protocol re-emits protocol.json BYTE-IDENTICAL (sha256 stable);
//   (b) every failClosed entry fingerprint carries a failure signal (a flag off
//       its clean gold OR a metric off its clean gold) — no vacuous class;
//   (c) every acceptanceBucket entry has a status:pass fingerprint.
//
// Hermeticity: the producer + its committed JSON inputs (viability-results.json,
// calibration.json) + lib are copied into an mkdtemp sandbox and build-protocol
// is re-run there. The committed viability-results.json / calibration.json are
// frozen inputs (not live baselines), so no generate/verify CLI call is made.

import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sha256, failureSignals } from './lib/instrument.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

function fail(msg) {
  console.error('selfcheck FAIL: ' + msg);
  process.exit(1);
}

function main() {
  const committedProtocol = readFileSync(join(HERE, 'protocol.json'));
  const committedSha = readFileSync(join(HERE, 'protocol.json.sha256'), 'utf8').trim();

  // Sanity: committed sha256 file matches committed protocol.json bytes.
  const actualCommittedSha = sha256(committedProtocol);
  if (actualCommittedSha !== committedSha) {
    fail(
      `committed protocol.json.sha256 (${committedSha}) does not match committed protocol.json bytes (${actualCommittedSha}).`,
    );
  }

  // (a) Re-emit hermetically in an mkdtemp sandbox and compare byte-for-byte.
  const sandbox = mkdtempSync(join(tmpdir(), 'pos-selfcheck-'));
  try {
    mkdirSync(join(sandbox, 'lib'), { recursive: true });
    cpSync(join(HERE, 'lib', 'instrument.mjs'), join(sandbox, 'lib', 'instrument.mjs'));
    cpSync(join(HERE, 'build-protocol.mjs'), join(sandbox, 'build-protocol.mjs'));
    cpSync(join(HERE, 'viability-results.json'), join(sandbox, 'viability-results.json'));
    cpSync(join(HERE, 'calibration.json'), join(sandbox, 'calibration.json'));

    execFileSync('node', ['build-protocol.mjs'], {
      cwd: sandbox,
      encoding: 'utf8',
    });

    const reProtocol = readFileSync(join(sandbox, 'protocol.json'));
    const reSha = readFileSync(join(sandbox, 'protocol.json.sha256'), 'utf8').trim();

    if (!reProtocol.equals(committedProtocol)) {
      fail('re-emitted protocol.json is NOT byte-identical to the committed protocol.json.');
    }
    if (reSha !== committedSha) {
      fail(`re-emitted sha256 (${reSha}) differs from committed sha256 (${committedSha}).`);
    }
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }

  // Parse the committed protocol for the fingerprint invariants.
  const protocol = JSON.parse(committedProtocol.toString('utf8'));
  const failClosed = protocol.tamperMatrix?.failClosed ?? [];
  const acceptanceBucket = protocol.tamperMatrix?.acceptanceBucket ?? [];

  if (failClosed.length === 0) {
    fail('failClosed set is empty in protocol.json.');
  }

  // (b) Every failClosed fingerprint carries a failure signal (independent
  // re-derivation from the fingerprint, not trusting the stored failureSignals).
  const vacuous = [];
  for (const entry of failClosed) {
    const signals = failureSignals(entry.fingerprint);
    if (signals.length === 0) {
      vacuous.push(`${entry.class} [${entry.handling}]`);
    }
    // Cross-check: stored failureSignals must also be non-empty.
    if (!Array.isArray(entry.failureSignals) || entry.failureSignals.length === 0) {
      fail(`failClosed entry ${entry.class} [${entry.handling}] has no stored failureSignals.`);
    }
  }
  if (vacuous.length > 0) {
    fail('vacuous failClosed class(es) with no failure signal: ' + vacuous.join(', '));
  }

  // (c) Every acceptanceBucket entry has a status:pass fingerprint.
  for (const entry of acceptanceBucket) {
    if (entry.fingerprint?.status !== 'pass') {
      fail(
        `acceptanceBucket entry ${entry.class} [${entry.handling}] has non-pass fingerprint status=${entry.fingerprint?.status}.`,
      );
    }
  }

  console.log(
    `selfcheck: protocol.json re-emit byte-identical (sha256 ${committedSha.slice(0, 16)}...); ` +
      `${failClosed.length} failClosed all carry a failure signal; ` +
      `${acceptanceBucket.length} acceptanceBucket all status:pass.`,
  );
  console.log('selfcheck PASS');
  process.exit(0);
}

main();

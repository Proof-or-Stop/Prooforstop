#!/usr/bin/env node
/**
 * @task B-7fc2
 * @checklist CHK-001, CHK-002, CHK-003
 * @title cli-json-stdout-contract-smoke
 * @type chore
 * @priority high
 * @description
 *   B-7fc2 — keep Lattice CLI `--json` / `--format=json` stdout machine-parseable.
 *
 *   Background:
 *     Before this contract, `node packages/main/dist/cli.js validate --json`
 *     wrote a valid JSON document followed by `→ 验证全绿。...`, so
 *     `JSON.parse(stdout)` failed for the host-neutral dashboard and other
 *     adapters consuming the CLI JSON surface.
 *
 *     The fix lives at the CLI choke point (cli-engine.ts) and is shared by
 *     every command: when args.json===true OR args.format==="json", the
 *     CLI skips the hint decoration entirely. Text mode keeps the existing
 *     human next-step hint.
 *
 *   This smoke executes real CLI child processes and feeds their stdout
 *   directly into JSON.parse — no substring extraction, no
 *   extractFirstJsonObject. It also asserts the human-mode hint is still
 *   emitted on text mode, and that a known-good `--format=json` surface
 *   remains a parseable single JSON object.
 *
 *   Coverage:
 *     happy:  validate --json stdout → JSON.parse direct
 *     happy:  authority_status --format=json stdout → JSON.parse direct
 *     happy:  text-mode validate keeps "→ 验证全绿" hint
 *     edge:   validate --json stdout contains no human hint markers
 *     adversarial: stdout has exactly one JSON document (no trailing decoration)
 * @changes
 *   - [CHK-001] Add validator-required changes metadata for the CLI JSON stdout smoke task header.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const cliPath = join(here, '..', 'cli.js');
const repoRoot = join(here, '..', '..', '..', '..');

type EnvOverride = Record<string, string | undefined>;

function runCli(args: string[], env: EnvOverride = {}): string {
  return execFileSync(process.execPath, [cliPath, '--root', repoRoot, ...args], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

const HUMAN_HINT_MARKERS = [
  '→ 验证全绿',
  '→ 验证未通过',
  '→ 标记为',
  '→ 完成',
  '→ Story',
  '→ 还有',
];

function assertNoHumanHint(stdout: string, label: string): void {
  for (const marker of HUMAN_HINT_MARKERS) {
    assert.ok(
      !stdout.includes(marker),
      `${label} stdout must not contain human hint marker "${marker}"`,
    );
  }
}

// ── validate --json — the original B-7fc2 reproduction ─────────────────────
// `validate` is the canonical hint-decorated command and the smoke target
// for this story. It accepts `--json` (the verifier flag) only; `--format` is
// not in its schema, so we use `--json` for validate and exercise
// `--format=json` against commands that document it.
{
  const stdout = runCli(['validate', '--json']);
  // Adversarial: JSON.parse must succeed *directly*. No substring extraction,
  // no extractFirstJsonObject. This is the contract the dashboard depends on.
  const parsed = JSON.parse(stdout) as Record<string, unknown>;
  assert.equal(typeof parsed.allPass, 'boolean', 'validate --json has allPass');
  assert.equal(typeof parsed.provider, 'string', 'validate --json has provider');
  assertNoHumanHint(stdout, 'validate --json');
}

// ── text-mode validate must STILL keep the human next-step hint ────────────
// This guards the pre-mortem scenario where a naive fix would suppress the
// hint globally and degrade the human CLI experience.
{
  const stdout = runCli(['validate']);
  assert.ok(
    stdout.includes('→ 验证全绿'),
    `text-mode validate must keep "→ 验证全绿" hint; got:\n${stdout.slice(-400)}`,
  );
  // Defence-in-depth: text mode is not expected to be a parseable JSON document.
  let textIsJson = false;
  try {
    JSON.parse(stdout);
    textIsJson = true;
  } catch { /* expected */ }
  assert.equal(textIsJson, false, 'text-mode stdout is intentionally not pure JSON');
}

// ── A known-good --format=json command remains direct-parseable ────────────
// authority_status was already direct-parseable; locking that in here makes
// any future regression to the shared output pipeline fail loudly even on
// commands that never had a hint to begin with.
{
  const stdout = runCli(['authority_status', '--format=json'], {
    KOALA_AUTHORITY_MODE: '',
    KOALA_AUTHORITY_URL: '',
    KOALA_AUTHORITY_TIMEOUT_MS: '',
  });
  const parsed = JSON.parse(stdout) as Record<string, unknown>;
  assert.equal(parsed.schemaVersion, 'lattice.authority_status.v1');
  assert.equal(parsed.productionDone, false);
  assertNoHumanHint(stdout, 'authority_status --format=json');
}

// ── A known-good --json shortcut also remains direct-parseable ─────────────
{
  const stdout = runCli(['authority_status', '--json'], {
    KOALA_AUTHORITY_MODE: '',
    KOALA_AUTHORITY_URL: '',
    KOALA_AUTHORITY_TIMEOUT_MS: '',
  });
  const parsed = JSON.parse(stdout) as Record<string, unknown>;
  assert.equal(parsed.schemaVersion, 'lattice.authority_status.v1');
  assertNoHumanHint(stdout, 'authority_status --json');
}

// ── A broader Lattice host JSON surface command remains direct-parseable ───
// host_list is one of the canonical host-neutral observability inputs; if a
// future hint registration accidentally fires for it, this guard catches it.
{
  const stdout = runCli(['host_list', '--format=json']);
  const parsed = JSON.parse(stdout) as Record<string, unknown>;
  assert.equal(parsed.schemaVersion, 'lattice.host_list.v1');
  assertNoHumanHint(stdout, 'host_list --format=json');
}

// ── Adversarial: stdout has exactly one JSON document, no trailing line ────
// Reject substring parsing as a solution — the contract is "stdout is a
// single JSON payload + optional trailing newline".
{
  const stdout = runCli(['validate', '--json']);
  const trimmed = stdout.replace(/\n+$/, '');
  // Whole trimmed string must parse — not just a prefix.
  const parsed = JSON.parse(trimmed) as Record<string, unknown>;
  assert.equal(typeof parsed.allPass, 'boolean');
  // Sanity: no second JSON document concatenated.
  assert.ok(
    trimmed.lastIndexOf('}') === trimmed.length - 1,
    'JSON stdout must end with "}" (single document, no trailing text)',
  );
}

console.log('✓ cli json stdout contract smoke passed');

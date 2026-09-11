import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  isProviderExecutionSurfaceCandidate,
  PROVIDER_EXECUTION_SURFACES,
} from '../core/provider-process-registry.js';

function productionSources(sourceRoot: string, relativeDir = ''): Array<{ path: string; source: string }> {
  const absolute = join(sourceRoot, relativeDir);
  const rows: Array<{ path: string; source: string }> = [];
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!['tasks', 'tests', 'generated'].includes(entry.name)) {
        rows.push(...productionSources(sourceRoot, relativePath));
      }
      continue;
    }
    if (entry.isFile() && relativePath.endsWith('.ts')) {
      rows.push({ path: relativePath, source: readFileSync(join(sourceRoot, relativePath), 'utf8') });
    }
  }
  return rows;
}

/** Shared executable contract used by both the direct inventory pin and docs/doctor pin. */
/**
 * B-137a: negative/positive controls for isProviderExecutionSurfaceCandidate.
 *
 * Three independent defects were found in the same predicate:
 *  1. FALSE POSITIVE — provider words are matched case-insensitively, so a prose
 *     citation of "CLAUDE.md" (the project convention doc, cited by many core
 *     modules) read as a provider reference. Any file that both used
 *     child_process for git AND cited that doc became an "unclassified provider
 *     execution surface"; core/scope-contract.ts tripped exactly this way.
 *  2. FALSE NEGATIVE — the trailing \b meant identifier forms never matched:
 *     `claudeCli`, `CLAUDE_CLI_PATH`, `codexRunner` all failed, because \b does
 *     not break between two word characters or before `_`. A module spawning a
 *     provider through such an identifier was INVISIBLE to this tripwire.
 *  3. FALSE NEGATIVE — an aliased child_process launch API or a provider command
 *     held in a variable was invisible because detection required both the literal
 *     API name and provider text in the first argument position.
 *  4. FALSE NEGATIVE — provider command maps/resolvers can leave `spawn()` with
 *     only a neutral local identifier even though a bounded local definition
 *     selects Codex/Claude. Those execution surfaces still require inventory.
 *
 * These controls pin both directions, so narrowing the docs exclusion or
 * restoring the trailing boundary fails here rather than silently reopening a
 * blind spot in a security tripwire.
 */
export function assertProviderExecutionSurfaceDetectorControls(): void {
  const childProcess = "import cp from 'node:child_process';\n";
  const cases: ReadonlyArray<readonly [string, string, boolean]> = [
    ['literal codex spawn', `${childProcess}spawn('codex', ['exec']);`, true],
    ['unprefixed child_process import', "import { spawn } from 'child_process';\nspawn('codex', ['exec']);", true],
    ['literal claude spawn', `${childProcess}spawn('claude', ['--print']);`, true],
    ['camelCase identifier launch', `${childProcess}spawn(claudeCli);`, true],
    ['SCREAMING_SNAKE identifier launch', `${childProcess}spawn(CLAUDE_CLI_PATH);`, true],
    ['suffixed identifier launch', `${childProcess}spawn(codexRunner);`, true],
    ['aliased child-process launch', "import { spawn as launch } from 'node:child_process';\nlaunch('codex', ['exec']);", true],
    ['direct child-process API alias assignment launch', "import { spawn } from 'node:child_process';\nconst launch = spawn;\nlaunch('codex', ['exec']);", true],
    ['assigned child-process API alias chain launch', "import { spawn } from 'node:child_process';\nlet first;\nfirst = spawn;\nconst launch = first;\nlaunch('claude', ['--print']);", true],
    ['local spawn alias is not mistaken for child-process API', "import { execFile } from 'node:child_process';\nconst spawn = appFactory();\nconst launch = spawn;\nlaunch('codex', ['exec']);", false],
    ['namespace child-process launch', `${childProcess}cp.spawn('codex', ['exec']);`, true],
    ['provider command variable launch', `${childProcess}const command = 'codex';\nspawn(command, ['exec']);`, true],
    ['provider command mapping launch', `${childProcess}const PROVIDER_COMMANDS = { codex: 'codex', claude: 'claude' };\nconst command = PROVIDER_COMMANDS[host];\nspawn(command, ['exec']);`, true],
    ['provider command resolver launch', `${childProcess}function resolveProviderCommand(host) { return host === 'codex' ? 'codex' : 'claude'; }\nconst command = resolveProviderCommand(host);\nspawn(command, ['exec']);`, true],
    ['direct provider command mapping launch', `${childProcess}const PROVIDER_COMMANDS = { codex: 'codex', claude: 'claude' };\nspawn(PROVIDER_COMMANDS[host], ['exec']);`, true],
    ['direct provider command resolver launch', `${childProcess}function resolveProviderCommand(host) { return host === 'codex' ? 'codex' : 'claude'; }\nspawn(resolveProviderCommand(host), ['exec']);`, true],
    ['gemini spawn', `${childProcess}spawn('gemini');`, true],
    ['agy spawn', `${childProcess}spawn('agy');`, true],
    ['docs citation only is NOT a provider surface', `${childProcess}// see CLAUDE.md conventions\nexecFileSync('git', ['diff']);`, false],
    ['multiple docs citations only', `${childProcess}// per CLAUDE.md and codex.md\nexecFileSync('git', []);`, false],
    ['provider word without child_process', "// spawn('claude')", false],
    ['provider prose beside a Git launch is NOT a provider surface', `${childProcess}const codexStatus = 'observed';\nexecFileSync('git', ['status']);`, false],
    ['provider launch only in a comment is NOT a provider surface', `${childProcess}// spawn('codex', ['exec'])\nexecFileSync('git', ['status']);`, false],
    ['provider command variable launch through namespace is caught', `${childProcess}const command = 'codex';\ncp.spawn(command, ['exec']);`, true],
    ['docs citation PLUS a real spawn is still caught', `${childProcess}// CLAUDE.md says\nspawn('claude');`, true],
    ['unlisted execSync is a provider surface', "import { execSync } from 'node:child_process';\nexecSync('codex exec -');\n", true],
    ['namespace execSync is a provider surface', `${childProcess}cp.execSync('codex exec -');\n`, true],
    ['aliased execSync is a provider surface', "import { execSync as runSync } from 'node:child_process';\nrunSync('claude -p');\n", true],
  ];
  for (const [label, source, expected] of cases) {
    assert.equal(
      isProviderExecutionSurfaceCandidate('core/detector-control.ts', source),
      expected,
      `provider-surface detector control failed: ${label}`,
    );
  }
}

export function assertProviderExecutionInventoryContract(sourceRoot: string): void {
  assertProviderExecutionSurfaceDetectorControls();
  const inventory = new Map(PROVIDER_EXECUTION_SURFACES.map(entry => [entry.path, entry]));
  for (const path of [
    'core/managed-host-run.ts',
    'core/host-run.ts',
    'core/codex-review-leaf.ts',
    'core/autopilot-executor.ts',
    // B-137a main-merge fix: main renamed lattice-dispatch.ts ->
    // proof-or-stop-dispatch.ts. The retired name left the real file
    // unclassified, so the inventory contract refused it as an unknown
    // provider execution surface.
    'core/proof-or-stop-dispatch.ts',
    'core/native-review-evidence.ts',
    'core/planned-steps-executor.ts',
    'providers/codex-cli.ts',
    'providers/claude-cli.ts',
    'providers/gemini-cli.ts',
  ]) assert.ok(inventory.has(path), `provider execution surface must be classified: ${path}`);
  assert.equal(inventory.get('core/host-run.ts')?.status, 'admission_only',
    'runHostRun acquires its own provider-admission slot instead of delegating admission to its caller');
  assert.equal(inventory.get('core/host-run.ts')?.admissionOwner, 'core/provider-process-registry.ts');
  assert.equal(inventory.get('core/native-review-evidence.ts')?.status, 'readiness_probe');
  assert.equal(inventory.get('core/native-review-evidence.ts')?.admissionOwner, null);
  assert.equal(PROVIDER_EXECUTION_SURFACES.some(entry => entry.status === 'legacy_unmanaged'), false,
    'no production provider workload remains silently unmanaged');

  const candidates = productionSources(sourceRoot)
    .filter(row => isProviderExecutionSurfaceCandidate(row.path, row.source))
    .map(row => row.path)
    .sort();
  const missingInventory = candidates.filter(path => !inventory.has(path));
  assert.deepEqual(missingInventory, [],
    `every discovered provider execution/probe surface must be classified: ${missingInventory.join(', ')}`);
  for (const path of ['core/new-direct-provider.ts', 'cli/new-direct-provider.ts', 'verifier/new-direct-provider.ts', 'new-direct-provider.ts']) {
    assert.equal(
      isProviderExecutionSurfaceCandidate(path, "import { spawn } from 'node:child_process'; spawn('codex', ['exec']);"),
      true,
      `a new direct provider spawn must enter the exhaustive inventory contract: ${path}`,
    );
  }
}

#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { MAIN_TOOLS, parseFlags as parseFlagsFromEngine } from '../cli-engine.js';
import { normalizeNestedSpaceAlias } from '../cli/alias-normalizer.js';
import { ownerLeaseHelpBlock } from '../cli/ownership-gate.js';
import { parseFlags, parseFlagsTest } from '../cli/flag-parser.js';
import { READ_ONLY_COMMANDS } from '../cli/activity-policy.js';
import { resolveRootForCommand } from '../cli/runtime-root.js';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, '..', '..');
const repoRoot = join(packageRoot, '..', '..');
const cliPath = join(packageRoot, 'dist', 'cli.js');
const cliFallback = join(repoRoot, 'bin', 'proof-or-stop.js');

function cliBin(): string {
  return existsSync(cliPath) ? cliPath : cliFallback;
}

function runCli(args: string[], cwd = repoRoot): string {
  return execFileSync(process.execPath, [cliBin(), '--root', repoRoot, ...args], {
    cwd,
    env: {
      ...process.env,
      PROOF_OR_STOP_NO_HOOKS: '1',
    },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function runJson<T>(args: string[]): T {
  return JSON.parse(runCli(args)) as T;
}

function schemaFor(name: string) {
  const tool = MAIN_TOOLS.find(t => t.name === name);
  assert.ok(tool, `missing tool schema: ${name}`);
  return tool.schema;
}

const parserSchema = {
  storyId: z.string(),
  relatedDocs: z.array(z.string()).optional(),
  dryRun: z.boolean().optional(),
  count: z.number().optional(),
  snakeName: z.string().optional(),
};

const parsed = parseFlags([
  '--story-id=B-smoke',
  '--relatedDocs=["AGENTS.md"]',
  '--relatedDocs=CLAUDE.md',
  'dryRun=false',
  '--count=3',
  '--unknown-key=value',
  'ignored-positional',
], parserSchema);
assert.deepEqual(parsed, {
  storyId: 'B-smoke',
  relatedDocs: ['AGENTS.md', 'CLAUDE.md'],
  dryRun: false,
  count: 3,
  'unknown-key': 'value',
});
assert.deepEqual(parseFlagsFromEngine(['--story-id=B-smoke'], parserSchema), { storyId: 'B-smoke' });
assert.deepEqual(parseFlagsTest(['--names=a', '--names=b', '--enabled'], { names: 'array', enabled: 'boolean' }), {
  names: ['a', 'b'],
  enabled: true,
});

assert.deepEqual(
  normalizeNestedSpaceAlias(['proof-or-stop', 'host', 'runtime', 'list', '--json']),
  {
    matched: true,
    argv: ['host_runtime_list', '--json'],
    cmd: 'host_runtime_list',
    arg: '--json',
    canonicalAlias: 'host_runtime_list',
    displayAlias: 'host runtime list',
    consumed: 3,
    aliasStart: 1,
  },
);
assert.deepEqual(
  normalizeNestedSpaceAlias(['lab', 'create', '--help']),
  {
    matched: true,
    argv: ['lab_create', '--help'],
    cmd: 'lab_create',
    arg: '--help',
    canonicalAlias: 'lab_create',
    displayAlias: 'lab create',
    consumed: 2,
    aliasStart: 0,
  },
);
assert.deepEqual(
  normalizeNestedSpaceAlias(['capability', 'claim', 'formal', 'evaluate', '--help']).argv,
  ['capability_claim_formal_evaluate', '--help'],
);
assert.deepEqual(
  normalizeNestedSpaceAlias(['proof-or-stop', 'lab', 'create', '--target=test-case-reviewer']).argv,
  ['lab_create', '--target=test-case-reviewer'],
);
assert.deepEqual(
  normalizeNestedSpaceAlias(['lab', 'run', '--config=experiment.json', '--dryRun']).argv,
  ['lab_run', '--config=experiment.json', '--dryRun'],
);
assert.deepEqual(normalizeNestedSpaceAlias(['lab', 'eval', '{}']).argv, ['lab_eval', '{}']);
assert.deepEqual(normalizeNestedSpaceAlias(['lab', 'help']).argv, ['lab_help']);
assert.equal(normalizeNestedSpaceAlias(['lab', 'unknown']).matched, false, 'unknown Lab subcommands are not normalized');

// B-cdf6 CHK-005: the product name asserted below is now 'Proof-or-Stop'
// (PROOF_OR_STOP_PRODUCT_NAME, approved RENAMED row in brand-rename-mapping.md; `Proof-or-Stop` is a legacy
// spelling on the normalize list). Same repin CHK-002 applied to command-catalog-smoke; the
// branding assertions themselves are kept, not dropped.
const storyAdvanceHelp = runCli(['story_advance', '--help']);
assert.match(storyAdvanceHelp, /Proof-or-Stop/, 'tool help keeps Proof-or-Stop branding');
assert.match(storyAdvanceHelp, /Dry-run: optional via --dryRun/, 'optional dry-run class remains visible');
assert.match(storyAdvanceHelp, /Owner lease meta options/, 'owner lease help remains visible');

const storyReconcileHelp = runCli(['story_reconcile', '--help']);
assert.match(storyReconcileHelp, /Dry-run: default-on via --dryRun=true\./, 'default-on dry-run class remains visible');

const hostInstallHelp = runCli(['host_install', '--help']);
assert.match(hostInstallHelp, /Dry-run: always-on\./, 'always-on dry-run class remains visible');

// B-7c05 CHK-003: `proof-or-stop help` is BRIEF by default. Branding + every command
// name (no command silently dropped) stay on the brief catalog; the verbose
// host wording (antigravity/agy) lives in per-command descriptions, so those
// assertions move to `help --full`.
const globalHelp = runCli(['help']);
assert.match(globalHelp, /Proof-or-Stop/, 'brief global help keeps Proof-or-Stop branding');
assert.match(globalHelp, /host_runtime_list/, 'brief global help keeps every command name');
assert.match(globalHelp, /help --full/, 'brief global help points at the full catalog');
const briefHelpBytes = Buffer.byteLength(globalHelp, 'utf8');
assert.ok(briefHelpBytes < 16000, `brief help must stay under the 16000-byte budget, got ${briefHelpBytes}`);

const globalHelpFull = runCli(['help', '--full']);
assert.match(globalHelpFull, /Proof-or-Stop/, 'full global help keeps Proof-or-Stop branding');
assert.match(globalHelpFull, /host_runtime_list/, 'full global help keeps host runtime section entries');
assert.match(globalHelpFull.toLowerCase(), /antigravity/, 'full help keeps current host wording');
assert.match(globalHelpFull.toLowerCase(), /\bagy\b/, 'full help keeps antigravity alias wording');
assert.doesNotMatch(globalHelpFull.toLowerCase(), /current[^\n.]*gemini|gemini[^\n.]*current/, 'Gemini is not described as current');
assert.ok(globalHelpFull.length > globalHelp.length, 'full help is larger than the brief catalog');

const versionThroughProofOrStopNamespace = runCli(['proof-or-stop', 'version']);
assert.match(versionThroughProofOrStopNamespace, /Proof-or-Stop/, 'proof-or-stop version special path remains in runCli');

const hostRuntimeList = runJson<{ schemaVersion: string }>(['proof-or-stop', 'host', 'runtime', 'list', '--json']);
assert.equal(hostRuntimeList.schemaVersion, 'lattice.host_runtime_list.v1');

const hostRuntimeProbe = runJson<{ schemaVersion: string; host: string; requestedHost: string }>([
  'host',
  'runtime',
  'probe',
  JSON.stringify({ host: 'agy', json: true }),
]);
assert.equal(hostRuntimeProbe.schemaVersion, 'lattice.host_runtime_probe.v1');
assert.equal(hostRuntimeProbe.host, 'antigravity');
assert.equal(hostRuntimeProbe.requestedHost, 'agy');

const configDoctor = runJson<{ schemaVersion: string; migration: { cliFirst: boolean } }>([
  'proof-or-stop',
  'config',
  'doctor',
  '--json',
]);
assert.equal(configDoctor.schemaVersion, 'lattice.config_doctor.v1');
assert.equal(configDoctor.migration.cliFirst, true);

const conduitExplain = runJson<{ schemaVersion: string; authorityChanged: boolean }>([
  'proof-or-stop',
  'conduit',
  'explain',
  '--json',
]);
assert.equal(conduitExplain.schemaVersion, 'lattice.conduit_explain.v1');
assert.equal(conduitExplain.authorityChanged, false);

const invalidRoot = mkdtempSync(join(tmpdir(), 'proof-or-stop-cli-surface-root-'));
try {
  const invalid = spawnSync(process.execPath, [
    cliBin(),
    '--root',
    invalidRoot,
    'checklist_update',
    JSON.stringify({
      storyId: 'B-smoke',
      itemId: 'CHK-001',
      verificationIntent: {
        happy: [{ desc: 'bad enum', type: 'integration_test', priority: 'must' }],
      },
    }),
  ], {
    cwd: invalidRoot,
    env: { ...process.env, PROOF_OR_STOP_NO_HOOKS: '1' },
    encoding: 'utf8',
  });
  assert.notEqual(invalid.status, 0, 'invalid JSON body should fail validation');
  assert.match(invalid.stderr, /Argument validation failed/);
  assert.match(invalid.stderr, /verificationIntent\.happy\.0\.type/);
  assert.doesNotMatch(invalid.stderr, /Command "checklist_update" is not available in .* phase/);
} finally {
  rmSync(invalidRoot, { recursive: true, force: true });
}

assert.ok(ownerLeaseHelpBlock('story_advance')?.includes('--forceTakeover'), 'ownership-gate helper surface still renders owner meta help');
assert.equal(ownerLeaseHelpBlock('host_runtime_list'), null, 'read-only owner helper surface stays quiet');
assert.equal(READ_ONLY_COMMANDS.has('host_runtime_list'), true, 'activity-policy read-only surface still includes host runtime list');
assert.equal(resolveRootForCommand('host_runtime_list', repoRoot), repoRoot, 'runtime-root helper honors explicit root override');
assert.ok(schemaFor('host_runtime_list').json, 'command catalog surface still exposes host runtime json shortcut');

console.log('cli surface smoke passed');

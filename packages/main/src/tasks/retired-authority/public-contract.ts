import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { MAIN_TOOLS } from "../../cli-engine.js";
import { NESTED_SPACE_ALIASES } from "../../cli/alias-normalizer.js";
import { readRel } from "./file-scan.js";
import { CONTRACT_PATH, Violation, pkgRoot } from "./rule-data.js";
import { scanText } from "./dynamic-scan.js";

export function assertContract(): void {
  const contract = readRel(CONTRACT_PATH);
  for (const required of [
    'Authority Server',
    'authorityDone',
    'fullAuthorityDone',
    'productionDone',
    'PROOF_OR_STOP_AUTHORITY_*',
    'active `authority_*` command surfaces',
    'local assurance',
    'admissibilityStatus',
    'assuranceLevel',
    'evidenceScope',
    'local review quorum',
    'signed/offline receipt bundle',
    'Active-Surface Scan Scope',
    'Legacy Whitelist And Quarantine Rules',
  ]) {
    assert.ok(contract.includes(required), `${CONTRACT_PATH} must define ${required}`);
  }
  const self = readFileSync(fileURLToPath(new URL('./rule-data.js', import.meta.url)), 'utf8');
  assert.ok(self.includes(CONTRACT_PATH), 'guard must reference the migration contract path');
}

export function schemaDescription(schemaEntry: unknown): string {
  const desc = (schemaEntry as { description?: unknown } | undefined)?.description;
  return typeof desc === 'string' ? desc : '';
}

export function schemaIsHidden(schemaEntry: unknown): boolean {
  return schemaDescription(schemaEntry).includes('@help-hidden');
}

export function assertCommandCatalog(): Violation[] {
  const violations: Violation[] = [];
  const retiredCommands = [
    'story_authority_resolve',
    'authority_status',
    'authority_enforce_policy',
    'authority_receipt_verify',
    'authority_enforce_runner',
    'authority_receipt_fetch',
    'authority_verdict_submit',
    'authority_job_create',
    'authority_verdict_list',
    'authority_job_status',
  ];
  const toolNames = new Set(MAIN_TOOLS.map(tool => tool.name));
  for (const command of retiredCommands) {
    assert.equal(toolNames.has(command), false, `${command} must not be in MAIN_TOOLS`);
  }

  for (const [alias, command] of Object.entries(NESTED_SPACE_ALIASES)) {
    if (retiredCommands.includes(command) || /\bauthority\b/i.test(alias)) {
      violations.push({ file: 'NESTED_SPACE_ALIASES', line: 1, label: 'active alias', text: `${alias} -> ${command}` });
    }
  }

  for (const tool of MAIN_TOOLS) {
    violations.push(...scanText(`MAIN_TOOLS.${tool.name}.name`, tool.name));
    violations.push(...scanText(`MAIN_TOOLS.${tool.name}.description`, tool.description));
    for (const [key, schemaEntry] of Object.entries(tool.schema)) {
      if (schemaIsHidden(schemaEntry)) continue;
      violations.push(...scanText(`MAIN_TOOLS.${tool.name}.${key}.key`, key));
      violations.push(...scanText(`MAIN_TOOLS.${tool.name}.${key}.description`, schemaDescription(schemaEntry)));
    }
  }
  return violations;
}

export function runCli(root: string, args: string[]): string {
  const cliPath = join(pkgRoot, 'dist', 'cli.js');
  return execFileSync(process.execPath, [cliPath, '--root', root, ...args], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PROOF_OR_STOP_NO_HOOKS: '1',
      PROOF_OR_STOP_ACTIVITY_RECORD_READONLY: '0',
    },
  });
}

export function assertGeneratedHelp(): Violation[] {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-retired-help-'));
  try {
    writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify({
      scanRoot: 'packages/main',
      rootDir: 'src',
      storyDir: '.proof-or-stop/story/actives',
      requirementsDir: 'docs/requirements',
      storyPrefix: 'B',
    }, null, 2));
    const outputs = [
      ['help'],
      ['done_closure', '--help'],
      ['dispatch_policy_create', '--help'],
      ['observability_snapshot', '--help'],
      ['evidence_plan', '--help'],
      ['lifecycle_orchestrate', '--help'],
      ['live_smoke_transcript', '--help'],
      ['delivery_context_pack', '--help'],
      ['reviewer_batch', '--help'],
      ['init_preflight', '--help'],
      ['host_probe', '--help'],
      ['conduit_status', '--help'],
      ['story_export', '--help'],
    ];
    return outputs.flatMap(args => scanText(`proofOrStop ${args.join(' ')}`, runCli(root, args)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

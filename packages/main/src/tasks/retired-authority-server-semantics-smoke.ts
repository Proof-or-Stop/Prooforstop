#!/usr/bin/env node
/**
 * @task B-576e
 * @checklist CHK-005
 * @title retired Authority Server semantics guard
 * @type feature
 * @priority high
 * @description
 *   Guard the active Proofbound CLI/runtime surface against reintroducing
 *   server-backed Authority commands or product guidance. Retired decision docs
 *   may retain legacy vocabulary only when they are explicitly marked retired,
 *   legacy, out-of-core, or superseded by local proof admissibility.
 */
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAIN_TOOLS } from '../cli-engine.js';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..', '..');
const repoRoot = join(pkgRoot, '..', '..');

const retiredCommands = [
  'authority_status',
  'authority_enforce_policy',
  'authority_receipt_verify',
  'authority_enforce_runner',
  'authority_receipt_fetch',
  'authority_verdict_submit',
  'authority_job_create',
  'authority_verdict_list',
  'authority_job_status',
] as const;

const retiredAliasPatterns = [
  /\blattice\s+authority\s+status\b/i,
  /\blattice\s+authority\s+enforce\b/i,
  /\blattice\s+authority\s+receipt\s+(verify|fetch)\b/i,
  /\blattice\s+authority\s+verdict\s+(submit|list)\b/i,
  /\blattice\s+authority\s+job\s+(create|status)\b/i,
  /\bauthority\s+status\b/i,
  /\bauthority\s+enforce\b/i,
  /\bauthority\s+receipt\s+(verify|fetch)\b/i,
  /\bauthority\s+verdict\s+(submit|list)\b/i,
  /\bauthority\s+job\s+(create|status)\b/i,
] as const;

const activeServerProductPatterns = [
  /\bAuthority Server receipt\b/i,
  /\bAuthority Server\b/i,
  /\bAuthority-Verified\b/i,
  /\bAuthority modes\b/i,
  /\bPython authority\b/i,
  /\bLATTICE_AUTHORITY_/,
  /\brequireServerReceipt\b/,
  /\brequireServerAuthorityReceipt\b/,
  /\bserverAuthorityReceipt\b/,
  /\bverifiedAuthorityReceipt\b/,
  /\bauthorityReceiptGate\b/,
  /\bAuthorityClient\b/,
  /\bAuthorityMode\b/,
  /\bAuthoritySubmit/i,
  /\bauthority-gate-receipts\b/i,
  /\bauthority-client\b/i,
  /\bauthority-mode\b/i,
  /\bauthority-submit\b/i,
  /\bauthority-job-loop\b/i,
  /\bauthority-runner\b/i,
  /\blattice-authority-native\b/i,
  /\bserver-backed Authority\b/i,
  /\bserver authority receipt\b/i,
  /\bNon-authority unless an Authority Server\b/i,
] as const;

const activeFiles = [
  'README.md',
  'docs/guide.md',
  'packages/main/src/cli-engine.ts',
  'packages/main/src/cli/alias-normalizer.ts',
  'packages/main/src/cli/command-catalog.ts',
  'packages/main/src/cli/activity-policy.ts',
  'packages/main/src/core/config.ts',
  'packages/main/src/core/command-policy.ts',
  'packages/main/src/core/process-fact-levels.ts',
  'packages/main/src/core/process-fact-registry.ts',
  'packages/main/src/registry.ts',
  'packages/main/src/handlers/verdict.ts',
  'packages/main/src/handlers/lattice-cli.ts',
  'packages/main/src/handlers/autopilot.ts',
] as const;

const activeDirs = [
  'packages/main/src/cli',
  'packages/main/src/core',
  'packages/main/src/handlers',
  'packages/main/src/tasks',
  'packages/main/templates/agents',
  '.lattice-codex/agents',
  '.claude/agents',
] as const;

const sourceScanAllowlist = new Set([
  'packages/main/src/tasks/retired-authority-server-semantics-smoke.ts',
  'packages/main/src/tasks/command-catalog-smoke.ts',
  'packages/main/src/tasks/proof-admissibility-smoke.ts',
  'packages/main/src/core/proof-admissibility.ts',
  'packages/main/src/core/proof-admissibility-handoff.ts',
  'packages/main/src/core/receipt-bundle.ts',
  'packages/main/src/core/authority-contracts.ts',
  'packages/main/src/core/authority-signing.ts',
  'packages/main/src/core/autopilot-policy.ts',
  'packages/main/src/core/lattice-autopilot.ts',
  'packages/main/src/core/baseline.ts',
  'packages/main/src/core/baseline-suite-report.ts',
  'packages/main/src/core/usage-ledger/authority-evidence.ts',
  'packages/main/src/core/usage-ledger/record.ts',
  'packages/main/src/cli/command-schemas.ts',
  'packages/main/src/tasks/lattice-baseline-smoke.ts',
]);

const retiredDecisionDocs = [
  'docs/requirements/decisions/lattice-authority-receipt-contract.md',
  'docs/requirements/decisions/authority-receipt-gate-integration-execution-plan.md',
  'docs/requirements/decisions/authority-session-receipt-gate-execution.md',
  'docs/requirements/decisions/lattice-authority-remote-evidence-bundle.md',
  'docs/requirements/decisions/lattice-authority-customer-api-key-access.md',
  'docs/requirements/decisions/lattice-cli-authority-client-receipt-ref.md',
  'docs/requirements/decisions/authority-client-role.md',
  'docs/requirements/decisions/authority-receipt-cross-repo-live-smoke.md',
  'docs/requirements/decisions/authority-done-material-overlap-audit-cli-fix.md',
  'docs/requirements/decisions/lattice-authority-m1-m16-generated-proof-and-live-e2e.md',
  'docs/requirements/decisions/lifecycle-gate-receipt-consumption.md',
  'docs/requirements/decisions/unlock-layer4-production-safety-suite.md',
  'docs/requirements/decisions/lattice-authority-live-integration.md',
  'docs/requirements/decisions/authority-runner-session-evidence-envelope.md',
  'docs/requirements/decisions/autopilot-v2-reliability-execution-plan.md',
  'docs/requirements/decisions/proof-admissibility-hardening-execution-plan.md',
] as const;

interface PatternRule {
  pattern: RegExp;
  label: string;
  allowRetiredLine: boolean;
}

interface Violation {
  file: string;
  line: number;
  pattern: string;
  text: string;
}

function readRelative(path: string): string {
  return readFileSync(join(repoRoot, path), 'utf8');
}

function listFiles(dir: string, extensions: readonly string[]): string[] {
  const abs = join(repoRoot, dir);
  if (!existsSync(abs)) return [];
  const found: string[] = [];
  for (const entry of readdirSync(abs)) {
    const full = join(abs, entry);
    const rel = relative(repoRoot, full);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      found.push(...listFiles(rel, extensions));
    } else if (extensions.some(ext => entry.endsWith(ext))) {
      found.push(rel);
    }
  }
  return found;
}

function activePatterns(): PatternRule[] {
  const commandPatterns = retiredCommands.map(command => ({
    pattern: new RegExp(`\\b${command}\\b`, 'i'),
    label: command,
    allowRetiredLine: false,
  }));
  const aliasPatterns = retiredAliasPatterns.map(pattern => ({
    pattern,
    label: String(pattern),
    allowRetiredLine: false,
  }));
  const productPatterns = activeServerProductPatterns.map(pattern => ({
    pattern,
    label: String(pattern),
    allowRetiredLine: true,
  }));
  return [...commandPatterns, ...aliasPatterns, ...productPatterns];
}

function lineIsRetirementMarker(line: string): boolean {
  return /\b(retired|legacy|out-of-core|superseded|not active|no longer active)\b/i.test(line);
}

function lineIsNegativeBoundary(line: string): boolean {
  return /\b(does not|do not|must not|cannot|can not|never|without|no longer|not required|not verified|not claim|not satisfy|false|delete|refusal)\b/i.test(line);
}

function scanText(file: string, text: string, patterns: PatternRule[], allowRetiredLines: boolean): Violation[] {
  const violations: Violation[] = [];
  text.split(/\r?\n/).forEach((line, index) => {
    for (const { pattern, label, allowRetiredLine } of patterns) {
      if (allowRetiredLines && allowRetiredLine && (lineIsRetirementMarker(line) || lineIsNegativeBoundary(line))) continue;
      if (pattern.test(line)) {
        violations.push({ file, line: index + 1, pattern: label, text: line.trim() });
      }
    }
  });
  return violations;
}

function assertScannerRejectsReintroduction(): void {
  const virtual = [
    'lattice authority status --format=json',
    'authority_status must be wired into MAIN_TOOLS',
    'Use an Authority Server receipt before local evidence is admissible.',
  ].join('\n');
  const violations = scanText('<negative-self-check>', virtual, activePatterns(), false);
  assert.ok(
    violations.some(v => v.pattern === 'authority_status'),
    'negative self-check rejects retired flat command',
  );
  assert.ok(
    violations.some(v => /lattice\\s\+authority/.test(v.pattern) || /authority status/i.test(v.text)),
    'negative self-check rejects retired nested alias',
  );
  assert.ok(
    violations.some(v => /Authority Server receipt/i.test(v.text)),
    'negative self-check rejects active server receipt wording',
  );
}

assertScannerRejectsReintroduction();

const toolNames = new Set(MAIN_TOOLS.map(tool => tool.name));
for (const command of retiredCommands) {
  assert.equal(toolNames.has(command), false, `${command} must not be present in MAIN_TOOLS`);
}

const violations: Violation[] = [];
const activeScanFiles = [
  ...activeFiles,
  ...activeDirs.flatMap(dir => listFiles(dir, dir.includes('/src/') ? ['.ts'] : ['.md'])),
].filter((file, index, all) => all.indexOf(file) === index && !sourceScanAllowlist.has(file));
for (const file of activeScanFiles) {
  if (!existsSync(join(repoRoot, file))) continue;
  violations.push(...scanText(file, readRelative(file), activePatterns(), true));
}

for (const file of retiredDecisionDocs) {
  if (!existsSync(join(repoRoot, file))) continue;
  const text = readRelative(file);
  assert.ok(
    /\b(retired|legacy|out-of-core|superseded)\b/i.test(text.slice(0, 1200)),
    `${file} must identify Authority Server content as retired/legacy/out-of-core/superseded near the top`,
  );
}

if (violations.length > 0) {
  const rendered = violations
    .slice(0, 80)
    .map(v => `${v.file}:${v.line}: ${v.pattern}: ${v.text}`)
    .join('\n');
  throw new Error(`retired Authority Server semantics guard found ${violations.length} violation(s):\n${rendered}`);
}

process.stdout.write('retired Authority Server semantics smoke PASS\n');

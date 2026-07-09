#!/usr/bin/env node
/**
 * Reviewer scan-budget guard (B-cee5).
 *
 * Static regression guard for the token-stopgap contract: the scope-plan and
 * behavior reviewer prompts (template + .claude + .lattice-codex copies) must
 * not reintroduce unconditional full decisions-directory scan instructions,
 * and must keep the bounded memory/playbook preflight + candidateSpecSet +
 * scanEscalationReason wording. Escalation-path wording is explicitly allowed:
 * a line that names scanEscalationReason may describe a full scan.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..', '..');

interface PatternRule {
  label: string;
  pattern: RegExp;
}

interface Violation {
  file: string;
  line: number;
  label: string;
  text: string;
}

const guardedPromptFiles = [
  'packages/main/templates/agents/lattice-review-scope-plan.md',
  'packages/main/templates/agents/lattice-review-behavior.md',
  '.claude/agents/lattice-review-scope-plan.md',
  '.claude/agents/lattice-review-behavior.md',
  '.lattice-codex/agents/lattice-review-scope-plan.md',
  '.lattice-codex/agents/lattice-review-behavior.md',
] as const;

// Unconditional broad-scan instructions that must never return without
// escalation wording on the same line.
const bannedUnconditionalRules: PatternRule[] = [
  { label: 'always scan full decisions', pattern: /always scan the .*full decisions/i },
  { label: 'read every decisions file', pattern: /(?:must )?read every \.?md file/i },
  { label: 'read each decisions file unconditionally', pattern: /read every .*decisions/i },
  { label: 'full directory scan', pattern: /full directory scan of/i },
  { label: 'all md files under decisions', pattern: /all \.md files under .*decisions/i },
  { label: 'no cherry-picking full read', pattern: /read every \.md file one by one/i },
  { label: 'always defer to full decisions directory', pattern: /always defer to the full decisions/i },
];

// Phrases the bounded-search contract requires in every guarded copy.
const requiredPhrases = [
  'candidateSpecSet',
  'scanEscalationReason',
  'advisory only',
  'gateEvidence=false',
] as const;

// A line may legitimately describe the full-scan escalation path when it
// names the recorded escalation reason.
function lineIsEscalationPath(line: string): boolean {
  return line.includes('scanEscalationReason');
}

function readRel(path: string): string {
  return readFileSync(join(repoRoot, path), 'utf8');
}

function scanFile(file: string, content: string): Violation[] {
  const violations: Violation[] = [];
  const lines = content.split(/\r?\n/);
  lines.forEach((text, idx) => {
    if (lineIsEscalationPath(text)) return;
    for (const rule of bannedUnconditionalRules) {
      if (rule.pattern.test(text)) {
        violations.push({ file, line: idx + 1, label: rule.label, text: text.trim() });
      }
    }
  });
  return violations;
}

function assertPositiveControls(): void {
  const control = 'Always scan the **full decisions/ directory**.';
  const hits = scanFile('<positive-control>', control);
  assert.ok(hits.length > 0, 'positive control: banned pattern set must match the legacy full-scan wording');
  const escalated = scanFile(
    '<positive-control>',
    'Run a full decisions scan only with a recorded scanEscalationReason.',
  );
  assert.equal(escalated.length, 0, 'positive control: scanEscalationReason lines are exempt escalation-path wording');
}

function main(): void {
  assertPositiveControls();

  const violations: Violation[] = [];
  const missing: string[] = [];

  for (const file of guardedPromptFiles) {
    const content = readRel(file);
    violations.push(...scanFile(file, content));
    for (const phrase of requiredPhrases) {
      if (!content.includes(phrase)) {
        missing.push(`${file}: missing required phrase "${phrase}"`);
      }
    }
  }

  if (violations.length > 0) {
    console.error('reviewer-scan-budget-guard: banned unconditional broad-scan wording found:');
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line} [${v.label}] ${v.text}`);
    }
  }
  if (missing.length > 0) {
    console.error('reviewer-scan-budget-guard: required bounded-search phrases missing:');
    for (const m of missing) console.error(`  ${m}`);
  }
  assert.equal(violations.length, 0, `${violations.length} unconditional broad-scan violation(s)`);
  assert.equal(missing.length, 0, `${missing.length} missing required phrase(s)`);
  console.log(`reviewer-scan-budget-guard: PASS (${guardedPromptFiles.length} prompt copies clean, ${requiredPhrases.length} required phrases present)`);
}

main();

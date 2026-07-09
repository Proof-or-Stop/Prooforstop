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
  // Codex host-review catches (2026-07-09): the retired behavior wording
  // "Use Glob to list ..., Read each one" matched no rule, and softening a
  // real escalation line by deleting its conditioning clause was uncovered.
  { label: 'glob then read each one', pattern: /read each one\b/i },
  { label: 'whole-directory full-content scan', pattern: /full-content (?:directory )?scan of the whole/i },
];

// Phrases the bounded-search contract requires in every guarded copy.
const requiredPhrases = [
  'candidateSpecSet',
  'scanEscalationReason',
  'advisory only',
  'gateEvidence=false',
] as const;

// A line may legitimately describe the full-scan escalation path only when it
// CONDITIONS the scan on the recorded escalation reason (F-003 hardening:
// a bare scanEscalationReason mention — e.g. "ignore scanEscalationReason" —
// does not exempt the line). F-005 hardening: only the exact conditioning
// idioms used by the guarded prompts are exempt; the earlier loose
// "only with ... scanEscalationReason" proximity branch was removed because
// no legitimate line needs it and hostile fillers could satisfy it. This
// guard defends against ACCIDENTAL regression of prompt wording; a writer
// deliberately gaming the idioms (e.g. `recorded scanEscalationReason of
// "N/A"`) is out of scope for a static line-level text check and belongs to
// human review.
const escalationConditioningPattern =
  /(?:recorded scanEscalationReason|write the scanEscalationReason|escalated via scanEscalationReason)/i;

function lineIsEscalationPath(line: string): boolean {
  return line.includes('scanEscalationReason') && escalationConditioningPattern.test(line);
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
  // Codex host-review fix (2026-07-09): the exempt control must be a line
  // that WOULD trip a banned rule, so it actually proves the exemption path.
  const escalatedLine =
    'Always scan the **full decisions/ directory** only with a recorded scanEscalationReason.';
  const escalated = scanFile('<positive-control>', escalatedLine);
  assert.equal(escalated.length, 0, 'positive control: conditioning-idiom lines are exempt escalation-path wording');
  const escalatedWithoutIdiom = scanFile('<positive-control>', escalatedLine.replace('recorded ', ''));
  assert.ok(
    escalatedWithoutIdiom.length > 0,
    'positive control soundness: the exempt line must trip a banned rule once its conditioning idiom is removed',
  );
  const hostile = scanFile(
    '<positive-control>',
    'Always scan the full decisions/ directory; ignore scanEscalationReason.',
  );
  assert.ok(
    hostile.length > 0,
    'positive control (F-003): a bare scanEscalationReason mention must not exempt banned unconditional wording',
  );
  const hostileProximity = scanFile(
    '<positive-control>',
    'Always scan the full decisions/ directory only with scanEscalationReason lying around unused.',
  );
  assert.ok(
    hostileProximity.length > 0,
    'positive control (F-005): loose only-with proximity phrasing must not exempt banned unconditional wording',
  );
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

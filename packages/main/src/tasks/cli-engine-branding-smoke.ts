#!/usr/bin/env node
/**
 * @task B-3cca
 * @checklist CHK-002, CHK-003
 * @title CLI-engine branding audit smoke
 * @type feature
 * @priority high
 * @changes - [CHK-001] Add the required annotation metadata change summary for the CLI-engine branding smoke task.
 * @description
 * Scans src/dist CLI, hook runner, and related guide docs for unclassified
 * "koala/Koala" occurrences. Classified references (legacy alias, process lanes,
 * env vars, config paths, git commit message tokens) are expected and excluded
 * from the count.
 * Any unclassified occurrence fails the smoke with a non-zero exit.
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..', '..');

// ─── Classification rules ────────────────────────────────────────────────────
// Classification is token-based, not whole-line based. We strip exact
// compatibility tokens, then fail if any koala/Koala text remains. This catches
// lines such as "LATTICE_COMMAND ... koala command" instead of hiding them behind
// the legacy env var name.
const NEUTRAL_TOKEN_PATTERNS: RegExp[] = [
  // koala-codex / lattice-review-* / lattice-implementer / etc. are process lanes.
  /\bkoala-(?:codex|review[a-z-]*|implementer|reviewer|eval[a-z-]*|delivery|init|agent|story[a-z-]*)\b/gi,
  // Legacy internal constants and type names.
  /\bLEGACY_KOALA[A-Z0-9_]*\b/g,
  /\bKoalaConfig\b/g,
  // Legacy asset/file name (deferred .koala path work).
  /KOALA\.md/g,
  // String literal CLI alias token.
  /['"]koala['"]/g,
];

function stripContextualLegacyTokens(line: string): string {
  let stripped = line;

  if (/(legacy|fallback|兜底|兼容|旧项目)/i.test(stripped)) {
    stripped = stripped.replace(/koala\.config(?:\.json)?/gi, '');
  }

  if (/(legacy|runtime|health|activity|fallback|mirror|兼容|旧)/i.test(stripped)) {
    stripped = stripped.replace(/(?:~\/)?\.koala(?:\/[\w.*-]+)*/gi, '');
  }

  if (/legacy alias|alias: koala|仍是 legacy alias/i.test(stripped)) {
    stripped = stripped.replace(/\bkoala\b/gi, '');
  }

  if (/Lattice\/Koala/.test(stripped)) {
    stripped = stripped.replace(/Lattice\/Koala/g, 'Lattice');
  }

  if (/koala <|lattice lattice/i.test(stripped)) {
    stripped = stripped.replace(/koala (?=<|lattice)/gi, '');
  }

  return stripped;
}

function isClassified(line: string): boolean {
  let stripped = line;
  for (const re of NEUTRAL_TOKEN_PATTERNS) {
    stripped = stripped.replace(re, '');
  }
  stripped = stripContextualLegacyTokens(stripped);
  return !/koala|Koala/i.test(stripped);
}

// ─── Scanner ─────────────────────────────────────────────────────────────────

interface ScanResult {
  file: string;
  unclassified: Array<{ lineNo: number; text: string }>;
}

function scanFile(filePath: string): ScanResult {
  const content = readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  const unclassified: Array<{ lineNo: number; text: string }> = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!/koala|Koala/i.test(line)) continue;
    if (!isClassified(line)) {
      unclassified.push({ lineNo: i + 1, text: line.trimEnd() });
    }
  }

  return { file: filePath, unclassified };
}

// ─── Main ────────────────────────────────────────────────────────────────────

const repoRoot = join(pkgRoot, '..', '..');

const FILES_TO_AUDIT: Array<{ label: string; filePath: string; required: boolean }> = [
  { label: 'cli-engine src', filePath: join(pkgRoot, 'src', 'cli-engine.ts'), required: true },
  { label: 'cli-engine dist', filePath: join(pkgRoot, 'dist', 'cli-engine.js'), required: false },
  { label: 'hooks src', filePath: join(pkgRoot, 'src', 'core', 'hooks.ts'), required: true },
  { label: 'hooks dist', filePath: join(pkgRoot, 'dist', 'core', 'hooks.js'), required: false },
  { label: 'guide-hooks doc', filePath: join(repoRoot, 'docs', 'guide-hooks.md'), required: true },
];

let exitCode = 0;
const counts: Record<string, number> = {};

function auditFile(label: string, filePath: string, required: boolean): number {
  if (!existsSync(filePath)) {
    if (!required) {
      // dist may not exist in CI before build; treat as zero unclassified
      process.stdout.write(`cli-engine branding audit: ${label} file not found (skip)\n`);
      return 0;
    }
    process.stderr.write(`cli-engine branding audit: ERROR ${label} file not found: ${filePath}\n`);
    process.exit(1);
  }

  const result = scanFile(filePath);
  if (result.unclassified.length > 0) {
    process.stderr.write(
      `cli-engine branding audit: FAIL ${label} unclassified=${result.unclassified.length}\n`,
    );
    for (const { lineNo, text } of result.unclassified) {
      process.stderr.write(`  L${lineNo}: ${text}\n`);
    }
    exitCode = 1;
  }
  return result.unclassified.length;
}

for (const { label, filePath, required } of FILES_TO_AUDIT) {
  counts[label] = auditFile(label, filePath, required);
}

if (exitCode === 0) {
  const summary = Object.entries(counts)
    .map(([label, n]) => `${label} unclassified=${n}`)
    .join(', ');
  process.stdout.write(`cli-engine branding audit: PASS ${summary}\n`);
  process.stdout.write('cli-engine branding smoke passed\n');
} else {
  process.exit(exitCode);
}

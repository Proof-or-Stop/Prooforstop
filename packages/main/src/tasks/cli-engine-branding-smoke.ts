#!/usr/bin/env node
/**
 * @task B-3cca
 * @checklist CHK-002, CHK-003
 * @title CLI-engine branding audit smoke
 * @type feature
 * @priority high
 * @description
 * Scans src and dist cli-engine files for unclassified "koala/Koala" occurrences.
 * Classified references (legacy alias, process lanes, env vars, config paths, git commit
 * message tokens, hook system labels) are expected and excluded from the count.
 * Any unclassified occurrence fails the smoke with a non-zero exit.
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..', '..');

// ─── Classification rules ────────────────────────────────────────────────────
// A line containing "koala" / "Koala" is classified (and excluded from the
// unclassified count) when it matches ANY of the following patterns:
const CLASSIFIED_PATTERNS: RegExp[] = [
  // Env vars (process tokens — preserved by design)
  /KOALA_/,
  // Legacy config file name
  /koala\.config/i,
  // Legacy story directory path
  /\.koala\b/,
  // koala-codex — process lane (Codex adapter wrapper)
  /koala-codex/i,
  // koala-review-* — process-lane reviewer agent names
  /koala-review/i,
  // koala-implementer — process-lane implementer agent type
  /koala-implementer/i,
  // koala-reviewer — generic reviewer agent lane label
  /koala-reviewer/i,
  // koala-hook — hook system debug prefix (process lane)
  /koala-hook/i,
  // koala-eval* — evaluator agent process lane
  /koala-eval/i,
  // koala-delivery — delivery reviewer process lane
  /koala-delivery/i,
  // koala-init — init reviewer process lane
  /koala-init/i,
  // koala-agent — agent runtime process lane
  /koala-agent/i,
  // Git commit message process tokens (exact prefix used in git log)
  /koala: from-draft|koala: INIT_CHECK|koala: record/,
  // Explicit legacy alias annotations in source
  /legacy.*koala|koala.*legacy|alias: koala|Lattice\/Koala|legacy alias/i,
  // LEGACY_KOALA_DIR constant
  /LEGACY_KOALA/,
  // Inline source comment references to legacy CLI ("koala CLI", "koala <cmd>")
  /koala CLI|koala <|koala session|koala lattice/i,
  // "koala" appearing as a string literal CLI alias token
  /'koala'|"koala"/,
  // KOALA_MD_TEMPLATE / KOALA.md template reference (asset, not branding)
  /KOALA_MD_TEMPLATE|KOALA\.md/,
  // koala-story-init / koala-review-story-init (process lane)
  /koala-story/i,
  // Autopilot run tmp dir naming (mkdtemp prefix, internal)
  /koala-[a-z]+-/ ,
  // Legacy dir constant reference in comments
  /LEGACY_KOALA_DIR|KOALA_DIR/,
];

function isClassified(line: string): boolean {
  return CLASSIFIED_PATTERNS.some(re => re.test(line));
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

const srcFile = join(pkgRoot, 'src', 'cli-engine.ts');
const distFile = join(pkgRoot, 'dist', 'cli-engine.js');

let exitCode = 0;

function auditFile(label: 'src' | 'dist', filePath: string): number {
  if (!existsSync(filePath)) {
    if (label === 'dist') {
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

const srcCount = auditFile('src', srcFile);
const distCount = auditFile('dist', distFile);

if (exitCode === 0) {
  process.stdout.write(
    `cli-engine branding audit: PASS src unclassified=${srcCount} dist unclassified=${distCount}\n`,
  );
  process.stdout.write('cli-engine branding smoke passed\n');
} else {
  process.exit(exitCode);
}

/**
 * B-a2e3 CHK-003: Experience Layer — read-only referential re-validation handler.
 *
 * `learning_validate` reports the valid-rate / drift-rate of the derived
 * finding-signals against the current git HEAD. It is conservative step ① after
 * Baseline A (8% referential drift) and is STRICTLY READ-ONLY and ADVISORY:
 *   • It derives signals THROUGH the store read ports
 *     (`deriveFindingSignalsFromStore`) WITHOUT a `projectRoot`, so nothing is
 *     persisted — no finding-signals.json write, no derived index/cache.
 *   • It builds its own `fileExists` predicate from `git ls-tree HEAD` (own
 *     execFileSync, wrapped in try/catch — it does NOT import or modify
 *     evidence-freshness.ts).
 *   • The actual classification lives in the pure `core/experience-revalidation.ts`
 *     leaf; this handler only adapts the store + git to that leaf and renders.
 *   • It files NO findings, registers NO gate, and writes NOTHING.
 */

import { execFileSync } from 'node:child_process';

import { deriveFindingSignalsFromStore } from '../core/finding-signals.js';
import {
  revalidateSignals,
  computeValidRate,
  computeCoverageGap,
  type ValidRateReport,
  type CoverageGapReport,
} from '../core/experience-revalidation.js';
import { readFindingSignals } from '../core/learning-store.js';
import type { HandlerContext } from './context.js';

interface LearningValidateArgs {
  json?: boolean;
  story?: string;
}

/**
 * The set of file paths tracked at the current git HEAD. Mirrors the
 * try/catch-returns-empty style of core/evidence-freshness.ts#currentMaterialHash:
 * a non-git / empty repo (or any git failure) yields an empty set, in which case
 * every anchored signal classifies as stale (anchors "gone") rather than crashing.
 */
function buildHeadFileSet(cwd: string): Set<string> {
  try {
    const raw = execFileSync('git', ['ls-tree', '-r', '--name-only', '-z', 'HEAD'], {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return new Set(raw.split('\0').filter(Boolean));
  } catch {
    return new Set<string>();
  }
}

/** Short HEAD sha for the human/JSON header; `'unknown'` when git is unavailable. */
function shortHead(cwd: string): string {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * B-1a91 CHK-003: render the advisory coverage line from a CoverageGapReport.
 *   - no watermark (legacy/absent cache):  "coverage: unknown — run learning_scan"
 *   - known + in sync (gap 0):             "coverage: N/M findings, 0 gap"
 *   - known + behind (gap > 0):            "coverage: <covered>/<current> findings,
 *                                           <gap> across <J> stories not yet
 *                                           summarized (cache behind; run learning_scan)"
 * Advisory only — no gate reads it.
 */
function renderCoverageLine(gap: CoverageGapReport): string {
  if (!gap.known) return 'coverage: unknown — run learning_scan';
  if (gap.gapFindings <= 0) {
    return `coverage: ${gap.coveredFindingCount}/${gap.currentFindingCount} findings, 0 gap`;
  }
  return (
    `coverage: ${gap.coveredFindingCount}/${gap.currentFindingCount} findings, ` +
    `${gap.gapFindings} across ${gap.gapStories} stories not yet summarized ` +
    `(cache behind; run learning_scan)`
  );
}

/** Render the advisory human report (counts, valid-rate, drift-rate, stale list). */
function renderHuman(head: string, report: ValidRateReport, coverageLine: string): string {
  const lines: string[] = [];
  lines.push(`Experience Layer — referential validity (HEAD ${head})`);
  lines.push(`  signals (total):           ${report.total}`);
  lines.push(`  anchored (have files):     ${report.anchored}`);
  lines.push(`  valid (>=1 anchor live):   ${report.valid}`);
  lines.push(`  stale (all anchors gone):  ${report.stale}`);
  lines.push(`  unanchored (no files):     ${report.unanchored}`);
  lines.push(`  valid-rate:  ${report.validRate.toFixed(3)}`);
  lines.push(`  drift-rate:  ${report.driftRate.toFixed(3)}`);
  // B-1a91 CHK-003: coverage watermark vs the live store — advisory only.
  lines.push(`  ${coverageLine}`);
  lines.push('Stale signals (code anchors gone at HEAD):');
  if (report.staleSignals.length === 0) {
    lines.push('  (none)');
  } else {
    for (const s of report.staleSignals) {
      lines.push(`  - ${s.localSignature}   anchors: ${s.missing.join(', ')}`);
    }
  }
  lines.push('(advisory, read-only — no gate touched, nothing written)');
  return lines.join('\n');
}

export function createLearningValidateHandlers(ctx: HandlerContext) {
  return {
    /**
     * Report Experience Layer referential validity (valid-rate / drift-rate of
     * finding-signals vs HEAD). READ-ONLY: derives signals through the store read
     * ports WITHOUT projectRoot (no persist), checks anchors against git HEAD via
     * the pure leaf, and renders. Files no findings, touches no gate, writes nothing.
     */
    learning_validate(args: LearningValidateArgs = {}): string {
      // HandlerContext exposes no projectRoot field; fall back to process.cwd().
      const cwd = process.cwd();
      const storyIds = typeof args.story === 'string' ? [args.story.trim()] : undefined;

      // NO projectRoot => derive only, never persist. The derived cache carries the
      // CURRENT coverage watermark (counted by the same method as a learning_scan).
      const cache = deriveFindingSignalsFromStore(ctx.store, storyIds ? { storyIds } : {});

      const headFiles = buildHeadFileSet(cwd);
      const fileExists = (p: string): boolean => headFiles.has(p);

      const validity = revalidateSignals(cache, fileExists);
      const report = computeValidRate(validity);
      const head = shortHead(cwd);

      // B-1a91 CHK-003: coverage gap — compare the PERSISTED cache's watermark
      // against the just-derived CURRENT counts. The current counts come from the
      // derived cache's own watermark, so they are computed identically to what a
      // learning_scan would persist => gap=0 immediately after a scan (no false
      // positive). A persisted cache without a watermark (legacy/absent) degrades to
      // "coverage: unknown". Advisory only; readFindingSignals never throws (returns
      // null on absent/malformed) so the report can never crash learning_validate.
      const persisted = readFindingSignals(cwd);
      const gap = computeCoverageGap(persisted, {
        currentFindingCount: typeof cache.coveredFindingCount === 'number' ? cache.coveredFindingCount : 0,
        currentStoryCount: typeof cache.coveredStoryCount === 'number' ? cache.coveredStoryCount : 0,
      });
      const coverageLine = renderCoverageLine(gap);

      if (args.json) {
        return JSON.stringify({ head, ...report, coverage: gap }, null, 2);
      }
      return renderHuman(head, report, coverageLine);
    },
  };
}

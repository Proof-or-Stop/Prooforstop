/**
 * B-4eb6 CHK-001: Experience Layer ③.1 — `learning_scan` (derive + PERSIST).
 *
 * `learning_scan` is the missing writer that activates the Phase 1.5 advisory
 * review hints. The hint loader (`core/experience-hint-loader.ts`) reads
 * `.proof-or-stop/learning/finding-signals.json`, but until now no command WROTE that
 * cache, so the advisory hints could never fire. This handler closes the loop:
 *
 *   • It derives finding-signals THROUGH the store read ports
 *     (`deriveFindingSignalsFromStore`) — never by parsing findings.json — and
 *     PERSISTS the result by passing `projectRoot`, which writes the cache via the
 *     learning-store's atomic `writeFindingSignals`.
 *   • The cache lives under `.proof-or-stop/learning/`, which is materialHash-EXCLUDED
 *     (the `experience-layer-learning-cache` runtime-artifact-registry prefix), so
 *     writing it never makes evidence stale and never enters any gate's material
 *     hash.
 *   • The ONLY filesystem write is that advisory cache. It files NO findings,
 *     registers NO gate, and mutates no tracked source file. It is advisory-only:
 *     no gate reads finding-signals.json.
 *
 * `--story <id>` restricts derivation to a single story. `--json` emits a small
 * machine-readable summary; the default render is a short human summary.
 */

import { deriveFindingSignalsFromStore } from '../core/finding-signals.js';
import { FINDING_SIGNALS_FILENAME, LEARNING_DIR } from '../core/learning-store.js';
import type { HandlerContext } from './context.js';

interface LearningScanArgs {
  json?: boolean;
  story?: string;
}

/** Relative cache path used in both the human render and the --json payload. */
const CACHE_REL_PATH = `${LEARNING_DIR}/${FINDING_SIGNALS_FILENAME}`;

export function createLearningScanHandlers(ctx: HandlerContext) {
  return {
    /**
     * Derive and PERSIST the advisory finding-signals cache that powers the
     * Phase 1.5 review experience hints. Reads findings through the store read
     * ports; the ONLY write is `.proof-or-stop/learning/finding-signals.json` (a
     * materialHash-excluded advisory cache). Files no findings, touches no gate.
     */
    learning_scan(args: LearningScanArgs = {}): string {
      // HandlerContext exposes the repo root as `root` — the same field the
      // signature-registry / playbook writers use to address `.proof-or-stop/learning/`.
      // Persisting against the actual store root (NOT a caller-supplied path)
      // guarantees the hint loader finds the cache where it reads it.
      const projectRoot = ctx.root ?? process.cwd();
      const now = new Date().toISOString();
      const storyIds = args.story ? [args.story.trim()] : undefined;

      // Passing projectRoot persists the cache via writeFindingSignals.
      const cache = deriveFindingSignalsFromStore(ctx.store, {
        projectRoot,
        now,
        ...(storyIds ? { storyIds } : {}),
      });

      if (args.json) {
        return JSON.stringify({
          written: true,
          path: CACHE_REL_PATH,
          signals: cache.signals.length,
          schemaVersion: cache.schemaVersion,
          updatedAt: cache.updatedAt,
        }, null, 2);
      }

      const scope = storyIds ? ` (story ${storyIds[0]})` : '';
      return [
        `learning_scan: derived ${cache.signals.length} signal(s)${scope}`,
        `wrote ${CACHE_REL_PATH} (schemaVersion ${cache.schemaVersion}, updatedAt ${cache.updatedAt})`,
        '(advisory, no gate — powers review experience hints; nothing else written)',
      ].join('\n');
    },
  };
}

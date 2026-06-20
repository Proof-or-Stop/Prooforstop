/**
 * Smoke: parallel-decomposition gate config resolution (B-d2a8, program Story 3).
 *
 * Hermetic — resolveParallelGate is unit-tested directly with a fixed profileDefault, and
 * resolveAuditConfig is exercised against a temp .lattice/audit-config.json under os.tmpdir().
 * Proves: per-profile defaults, every sub-field override, mode "off", field-by-field
 * validation with soft warn+fallback, non-object => profile defaults (no crash), and the
 * no-user-config path still carrying a populated parallelGate.
 *
 * Run: node packages/main/dist/tasks/parallel-gate-config-smoke.js
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveAuditConfig, resolveParallelGate } from '../core/audit-config.js';
import { LATTICE_DIR } from '../core/lattice-paths.js';
import type { ParallelGateConfig } from '../core/parallel-decomposition.js';

let passed = 0;
function check(name: string, cond: boolean): void {
  if (!cond) throw new Error(`FAIL: ${name}`);
  passed += 1;
}
const eq = (a: ParallelGateConfig, b: ParallelGateConfig): boolean =>
  a.mode === b.mode && a.maxConcurrentReview === b.maxConcurrentReview && a.broadGlobBlocks === b.broadGlobBlocks;

/** Fixed profile default for the direct resolveParallelGate unit tests (the balanced row). */
const PD: ParallelGateConfig = { mode: 'advise', maxConcurrentReview: 3, broadGlobBlocks: false };

const cleanup: string[] = [];
/** Write a temp project root with .lattice/audit-config.json = `config`; return the root. */
function tmpProject(config: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'parallel-gate-config-'));
  cleanup.push(dir);
  mkdirSync(join(dir, LATTICE_DIR), { recursive: true });
  writeFileSync(join(dir, LATTICE_DIR, 'audit-config.json'), JSON.stringify(config));
  return dir;
}
/** A temp project root with NO audit-config.json. */
function tmpEmptyProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'parallel-gate-config-empty-'));
  cleanup.push(dir);
  return dir;
}

void (() => {
  try {
    // === resolveParallelGate direct (fixed profileDefault = balanced) ===

    // 1. A missing / non-object raw yields a copy of the profile default (no crash).
    check('undefined raw -> profile default', eq(resolveParallelGate(undefined, PD), PD));
    check('null raw -> profile default', eq(resolveParallelGate(null, PD), PD));
    check('string raw -> profile default', eq(resolveParallelGate('nope', PD), PD));
    check('array raw -> profile default', eq(resolveParallelGate([1, 2], PD), PD));
    check('number raw -> profile default', eq(resolveParallelGate(42, PD), PD));
    check('returns a COPY, not the same reference', resolveParallelGate(undefined, PD) !== PD);

    // 2. A valid full override is applied.
    check('valid full override applied', eq(
      resolveParallelGate({ mode: 'block', maxConcurrentReview: 5, broadGlobBlocks: true }, PD),
      { mode: 'block', maxConcurrentReview: 5, broadGlobBlocks: true },
    ));

    // 3. mode "off" is accepted (the reversible escape hatch).
    check('mode off accepted', resolveParallelGate({ mode: 'off' }, PD).mode === 'off');
    check('mode advise accepted', resolveParallelGate({ mode: 'advise' }, PD).mode === 'advise');
    check('mode block accepted', resolveParallelGate({ mode: 'block' }, PD).mode === 'block');

    // 4. An invalid mode warns and falls back to advise (NOT block, NOT the profile default if it differed).
    check('invalid mode -> advise', resolveParallelGate({ mode: 'nope' }, PD).mode === 'advise');
    check('invalid mode -> advise even when profileDefault was block', resolveParallelGate({ mode: 'xyz' }, { mode: 'block', maxConcurrentReview: 4, broadGlobBlocks: true }).mode === 'advise');

    // 5. maxConcurrentReview integer >= 1 guard; else profile default.
    check('valid max applied', resolveParallelGate({ maxConcurrentReview: 7 }, PD).maxConcurrentReview === 7);
    check('zero max -> profile default', resolveParallelGate({ maxConcurrentReview: 0 }, PD).maxConcurrentReview === 3);
    check('negative max -> profile default', resolveParallelGate({ maxConcurrentReview: -1 }, PD).maxConcurrentReview === 3);
    check('float max -> profile default', resolveParallelGate({ maxConcurrentReview: 2.5 }, PD).maxConcurrentReview === 3);
    check('Infinity max -> profile default', resolveParallelGate({ maxConcurrentReview: Infinity }, PD).maxConcurrentReview === 3);

    // 6. broadGlobBlocks boolean guard; else profile default.
    check('valid broadGlobBlocks applied', resolveParallelGate({ broadGlobBlocks: true }, PD).broadGlobBlocks === true);
    check('non-boolean broadGlobBlocks -> profile default', resolveParallelGate({ broadGlobBlocks: 'yes' }, PD).broadGlobBlocks === false);

    // 7. A partial override keeps the profile default for missing sub-fields.
    check('partial override keeps defaults', eq(
      resolveParallelGate({ mode: 'block' }, PD),
      { mode: 'block', maxConcurrentReview: 3, broadGlobBlocks: false },
    ));

    // 8. All-wrong-types simultaneously -> each sub-field falls back independently.
    check('all-wrong-types -> all profile defaults', eq(
      resolveParallelGate({ mode: 'bad', maxConcurrentReview: 'x', broadGlobBlocks: 1 }, PD),
      PD,
    ));

    // === resolveAuditConfig integration (temp .lattice/audit-config.json) ===

    // 9. Per-profile defaults with NO user config.
    const light = resolveAuditConfig('light', tmpEmptyProject()).parallelGate;
    check('light default advise/2/false', !!light && eq(light, { mode: 'advise', maxConcurrentReview: 2, broadGlobBlocks: false }));
    const balanced = resolveAuditConfig('balanced', tmpEmptyProject()).parallelGate;
    check('balanced default advise/3/false', !!balanced && eq(balanced, { mode: 'advise', maxConcurrentReview: 3, broadGlobBlocks: false }));
    const strict = resolveAuditConfig('strict', tmpEmptyProject()).parallelGate;
    check('strict default block/4/true', !!strict && eq(strict, { mode: 'block', maxConcurrentReview: 4, broadGlobBlocks: true }));
    check('no-user-config still carries a populated parallelGate', !!light && !!balanced && !!strict);

    // 10. A user override in the config is applied on top of the profile default.
    const overridden = resolveAuditConfig('light', tmpProject({ parallelGate: { mode: 'block', maxConcurrentReview: 6, broadGlobBlocks: true } })).parallelGate;
    check('config override applied', !!overridden && eq(overridden, { mode: 'block', maxConcurrentReview: 6, broadGlobBlocks: true }));

    // 11. A non-object parallelGate in the config yields the profile default (no crash).
    const badGate = resolveAuditConfig('strict', tmpProject({ parallelGate: 'broken' })).parallelGate;
    check('non-object config parallelGate -> profile default (no crash)', !!badGate && eq(badGate, { mode: 'block', maxConcurrentReview: 4, broadGlobBlocks: true }));

    // 12. An invalid mode in the config falls back to advise.
    const badMode = resolveAuditConfig('strict', tmpProject({ parallelGate: { mode: 'nope' } })).parallelGate;
    check('invalid config mode -> advise', !!badMode && badMode.mode === 'advise');

    console.log(`parallel-gate-config smoke passed: ${passed} assertions`);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  } finally {
    for (const d of cleanup) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort temp cleanup */ }
    }
  }
})();

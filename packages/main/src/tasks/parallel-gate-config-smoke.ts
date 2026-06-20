/**
 * Smoke: parallel-decomposition gate config resolution (B-d2a8, program Story 3).
 *
 * Hermetic — resolveParallelGate is unit-tested directly with each profile default, and
 * resolveAuditConfig is exercised against a temp .lattice/audit-config.json under os.tmpdir().
 * Proves: per-profile defaults, every sub-field override, mode "off", PRESENT-but-invalid vs
 * ABSENT semantics (an invalid mode of any type degrades to advise, never block), warn emission,
 * unknown-key forward-compat, non-object/null => profile defaults (no crash), and the
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

const LIGHT: ParallelGateConfig = { mode: 'advise', maxConcurrentReview: 2, broadGlobBlocks: false };
const BALANCED: ParallelGateConfig = { mode: 'advise', maxConcurrentReview: 3, broadGlobBlocks: false };
const STRICT: ParallelGateConfig = { mode: 'block', maxConcurrentReview: 4, broadGlobBlocks: true };

/** Run fn() while capturing console.warn output, then restore it. */
function captureWarn<T>(fn: () => T): { result: T; warnings: string[] } {
  const warnings: string[] = [];
  const orig = console.warn;
  console.warn = (...args: unknown[]): void => { warnings.push(args.map(String).join(' ')); };
  try {
    return { result: fn(), warnings };
  } finally {
    console.warn = orig;
  }
}

const cleanup: string[] = [];
function tmpProject(config: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'parallel-gate-config-'));
  cleanup.push(dir);
  mkdirSync(join(dir, LATTICE_DIR), { recursive: true });
  writeFileSync(join(dir, LATTICE_DIR, 'audit-config.json'), JSON.stringify(config));
  return dir;
}
function tmpEmptyProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'parallel-gate-config-empty-'));
  cleanup.push(dir);
  return dir;
}

void (() => {
  try {
    // === resolveParallelGate direct, exercised against EACH profile default ===

    // 1. A missing / non-object raw yields a copy of the given profile default (no crash).
    check('undefined raw -> light default', eq(resolveParallelGate(undefined, LIGHT), LIGHT));
    check('null raw -> strict default', eq(resolveParallelGate(null, STRICT), STRICT));
    check('string raw -> light default', eq(resolveParallelGate('nope', LIGHT), LIGHT));
    check('array raw -> balanced default', eq(resolveParallelGate([1, 2], BALANCED), BALANCED));
    check('number raw -> balanced default', eq(resolveParallelGate(42, BALANCED), BALANCED));
    check('returns a COPY, not the same reference', resolveParallelGate(undefined, BALANCED) !== BALANCED);
    check('empty object -> profile default', eq(resolveParallelGate({}, STRICT), STRICT));

    // 2. A valid full override is applied.
    check('valid full override applied', eq(
      resolveParallelGate({ mode: 'block', maxConcurrentReview: 5, broadGlobBlocks: true }, BALANCED),
      { mode: 'block', maxConcurrentReview: 5, broadGlobBlocks: true },
    ));

    // 3. mode "off" is accepted (the reversible escape hatch) — full return value checked.
    check('mode off accepted (full return)', eq(resolveParallelGate({ mode: 'off' }, BALANCED), { mode: 'off', maxConcurrentReview: 3, broadGlobBlocks: false }));
    check('mode advise accepted', resolveParallelGate({ mode: 'advise' }, BALANCED).mode === 'advise');
    check('mode block accepted', resolveParallelGate({ mode: 'block' }, BALANCED).mode === 'block');

    // 4. A PRESENT but invalid mode (string OR non-string) degrades to advise (NEVER block) + warns.
    {
      const { result, warnings } = captureWarn(() => resolveParallelGate({ mode: 'nope' }, STRICT));
      check('invalid string mode -> advise (not the strict block default)', result.mode === 'advise');
      check('invalid string mode emits a warn', warnings.some((w) => w.includes('parallelGate.mode')));
    }
    {
      const { result, warnings } = captureWarn(() => resolveParallelGate({ mode: 123 }, STRICT));
      check('numeric (present non-string) mode -> advise, NEVER block', result.mode === 'advise');
      check('numeric mode emits a warn', warnings.some((w) => w.includes('parallelGate.mode')));
    }
    check('boolean mode -> advise', resolveParallelGate({ mode: true }, STRICT).mode === 'advise');

    // 5. maxConcurrentReview integer >= 1 guard, against the profile each intent names.
    check('valid max applied', resolveParallelGate({ maxConcurrentReview: 7 }, LIGHT).maxConcurrentReview === 7);
    check('zero max -> light default 2', resolveParallelGate({ maxConcurrentReview: 0 }, LIGHT).maxConcurrentReview === 2);
    check('negative max -> light default 2', resolveParallelGate({ maxConcurrentReview: -1 }, LIGHT).maxConcurrentReview === 2);
    check('float max -> strict default 4', resolveParallelGate({ maxConcurrentReview: 2.5 }, STRICT).maxConcurrentReview === 4);
    check('Infinity max -> light default 2', resolveParallelGate({ maxConcurrentReview: Infinity }, LIGHT).maxConcurrentReview === 2);
    check('NaN max -> balanced default 3', resolveParallelGate({ maxConcurrentReview: NaN }, BALANCED).maxConcurrentReview === 3);
    {
      const { result, warnings } = captureWarn(() => resolveParallelGate({ maxConcurrentReview: '5' }, BALANCED));
      check('string max -> balanced default 3', result.maxConcurrentReview === 3);
      check('invalid max emits a warn', warnings.some((w) => w.includes('maxConcurrentReview')));
    }

    // 6. broadGlobBlocks boolean guard.
    check('valid broadGlobBlocks applied', resolveParallelGate({ broadGlobBlocks: true }, LIGHT).broadGlobBlocks === true);
    {
      const { result, warnings } = captureWarn(() => resolveParallelGate({ broadGlobBlocks: 'yes' }, LIGHT));
      check('non-boolean broadGlobBlocks -> light default false', result.broadGlobBlocks === false);
      check('invalid broadGlobBlocks emits a warn', warnings.some((w) => w.includes('broadGlobBlocks')));
    }

    // 7. A partial override keeps the profile default for missing sub-fields.
    check('partial override keeps defaults', eq(resolveParallelGate({ mode: 'block' }, BALANCED), { mode: 'block', maxConcurrentReview: 3, broadGlobBlocks: false }));

    // 8. All-wrong-types -> mode advise, the others keep the profile default.
    check('all-wrong-types -> mode advise + others profile default', eq(
      resolveParallelGate({ mode: 'bad', maxConcurrentReview: 'x', broadGlobBlocks: 1 }, STRICT),
      { mode: 'advise', maxConcurrentReview: 4, broadGlobBlocks: true },
    ));

    // 8b. Unknown extra keys are ignored, valid sub-fields kept (forward-compatibility).
    check('unknown keys ignored, valid kept', eq(
      resolveParallelGate({ mode: 'block', futureKey: 'x', another: 42 }, BALANCED),
      { mode: 'block', maxConcurrentReview: 3, broadGlobBlocks: false },
    ));

    // === resolveAuditConfig integration (temp .lattice/audit-config.json) ===

    // 9. Per-profile defaults with NO user config.
    check('light default via resolveAuditConfig', eq(resolveAuditConfig('light', tmpEmptyProject()).parallelGate!, LIGHT));
    check('balanced default via resolveAuditConfig', eq(resolveAuditConfig('balanced', tmpEmptyProject()).parallelGate!, BALANCED));
    check('strict default via resolveAuditConfig', eq(resolveAuditConfig('strict', tmpEmptyProject()).parallelGate!, STRICT));
    check('no-user-config still carries a populated parallelGate', !!resolveAuditConfig('balanced', tmpEmptyProject()).parallelGate);

    // 10. A user override in the config is applied.
    check('config override applied', eq(
      resolveAuditConfig('light', tmpProject({ parallelGate: { mode: 'block', maxConcurrentReview: 6, broadGlobBlocks: true } })).parallelGate!,
      { mode: 'block', maxConcurrentReview: 6, broadGlobBlocks: true },
    ));

    // 11. A non-object parallelGate in the config yields the profile default (no crash).
    check('non-object config parallelGate -> profile default', eq(resolveAuditConfig('strict', tmpProject({ parallelGate: 'broken' })).parallelGate!, STRICT));

    // 12. parallelGate: null in the config -> profile default (the integration path, not just the direct unit).
    check('null config parallelGate -> profile default', eq(resolveAuditConfig('strict', tmpProject({ parallelGate: null })).parallelGate!, STRICT));

    // 13. An invalid mode in the config falls back to advise.
    check('invalid config mode -> advise', resolveAuditConfig('strict', tmpProject({ parallelGate: { mode: 'nope' } })).parallelGate!.mode === 'advise');

    // 14. Unknown keys in the config parallelGate are ignored, valid kept.
    check('config unknown keys ignored', eq(
      resolveAuditConfig('light', tmpProject({ parallelGate: { mode: 'block', extra: 'x' } })).parallelGate!,
      { mode: 'block', maxConcurrentReview: 2, broadGlobBlocks: false },
    ));

    console.log(`parallel-gate-config smoke passed: ${passed} assertions`);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  } finally {
    for (const d of cleanup) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch (err) {
        console.warn(`[parallel-gate-config-smoke] temp cleanup failed for ${d}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
})();

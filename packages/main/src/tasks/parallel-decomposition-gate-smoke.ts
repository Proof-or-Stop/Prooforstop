/**
 * Smoke: parallel-decomposition gate verdict (B-986c, program Story 2).
 *
 * Hermetic — all StoryInfo / ScopeContractData fixtures are built in memory; no filesystem,
 * no git, no story store. Proves evaluateDecompositionGate blocks ONLY on provable scope
 * contradictions (tier-1 literal overlap, broad-glob-when-strict, missing-peer-contract),
 * advises on everything heuristic, never hard-blocks fake_dependency_chain, ignores terminal
 * peers, and never enforces cfg.mode.
 *
 * Run: node packages/main/dist/tasks/parallel-decomposition-gate-smoke.js
 */

import { evaluateDecompositionGate } from '../core/parallel-decomposition-gate.js';
import { TERMINAL_PHASES } from '../core/parallel-policy.js';
import type { ParallelGateConfig } from '../core/parallel-decomposition.js';
import type { StoryInfo, ScopeContractData } from '../core/types.js';

let passed = 0;
function check(name: string, cond: boolean): void {
  if (!cond) throw new Error(`FAIL: ${name}`);
  passed += 1;
}

function story(storyId: string, over: Partial<StoryInfo> = {}): StoryInfo {
  return { storyId, phase: 'DEV', ...over } as StoryInfo;
}
function contract(storyId: string, over: Partial<ScopeContractData> = {}): ScopeContractData {
  return {
    storyId,
    mode: 'enforce',
    allowedModify: [],
    allowedCreate: [],
    allowedTest: [],
    protectedFiles: [],
    explicitExcludes: [],
    ...over,
  } as ScopeContractData;
}
const cfg = (broadGlobBlocks: boolean): ParallelGateConfig => ({
  mode: 'block',
  maxConcurrentReview: 3,
  broadGlobBlocks,
});

void (async () => {
  try {
    // 0. TERMINAL_PHASES is the single exported source and is what the gate filters on.
    check('TERMINAL_PHASES exports DONE + DISCARDED only', TERMINAL_PHASES.has('DONE') && TERMINAL_PHASES.has('DISCARDED') && !TERMINAL_PHASES.has('DEV'));

    // 1. Clean disjoint parallel set -> no block, no overlap advisory.
    {
      const s = story('S', { parallelSafe: 'yes' });
      const p = story('P', { parallelSafe: 'yes' });
      const contracts = new Map([
        ['S', contract('S', { allowedCreate: ['src/a/x.ts'] })],
        ['P', contract('P', { allowedCreate: ['src/b/y.ts'] })],
      ]);
      const r = evaluateDecompositionGate(s, [p], contracts, cfg(true));
      check('clean disjoint -> block null', r.block === null);
      check('clean disjoint -> no overlap advisory', !r.advisories.some((a) => a.includes('overlap')));
    }

    // 2. Tier-1 literal collision (both parallel, same file) -> overlap_declared_parallel.
    {
      const s = story('S', { parallelSafe: 'yes' });
      const p = story('P', { parallelSafe: 'yes' });
      const contracts = new Map([
        ['S', contract('S', { allowedCreate: ['src/shared.ts'] })],
        ['P', contract('P', { allowedModify: ['src/shared.ts'] })],
      ]);
      const r = evaluateDecompositionGate(s, [p], contracts, cfg(false));
      check('tier-1 literal overlap -> overlap_declared_parallel', r.block === 'overlap_declared_parallel');
      check('tier-1 block cites the colliding path + peer', r.advisories.some((a) => a.includes('src/shared.ts') && a.includes('P')));
    }

    // 3. Tier-2 shared-prefix only (glob vs sibling literal, no literal collision) -> advisory, no block.
    {
      const s = story('S', { parallelSafe: 'yes' });
      const p = story('P', { parallelSafe: 'yes' });
      const contracts = new Map([
        ['S', contract('S', { allowedCreate: ['src/feat/*'] })],
        ['P', contract('P', { allowedCreate: ['src/feat/y.ts'] })],
      ]);
      const r = evaluateDecompositionGate(s, [p], contracts, cfg(true));
      check('tier-2 shared-prefix only -> block null', r.block === null);
      check('tier-2 emits a shared-prefix advisory', r.advisories.some((a) => a.includes('shared-prefix')));
    }

    // 4. Broad glob asserted parallel: block only when strict (broadGlobBlocks).
    {
      const s = story('S', { parallelSafe: 'yes' });
      const contracts = new Map([['S', contract('S', { allowedCreate: ['src/**'] })]]);
      const strict = evaluateDecompositionGate(s, [], contracts, cfg(true));
      check('broad + strict -> broad_glob_unprovable_parallel', strict.block === 'broad_glob_unprovable_parallel');
      const lenient = evaluateDecompositionGate(s, [], contracts, cfg(false));
      check('broad + lenient -> block null', lenient.block === null);
      check('broad + lenient -> advisory to narrow', lenient.advisories.some((a) => a.includes('narrow the contract')));
    }

    // 5. Active parallel peer with a MISSING contract -> peer_contract_unreadable_parallel.
    {
      const s = story('S', { parallelSafe: 'yes' });
      const p = story('P', { parallelSafe: 'yes' });
      const contracts = new Map([['S', contract('S', { allowedCreate: ['src/a.ts'] })]]); // no P contract
      const r = evaluateDecompositionGate(s, [p], contracts, cfg(false));
      check('missing parallel peer contract -> peer_contract_unreadable_parallel', r.block === 'peer_contract_unreadable_parallel');
    }

    // 6. fake_dependency_chain is ADVISE-ONLY: a depends edge never produces that hard block.
    {
      const s = story('S', { parallelSafe: 'yes', depends: ['GHOST'] });
      const contracts = new Map([['S', contract('S', { allowedCreate: ['src/a.ts'] })]]);
      const r = evaluateDecompositionGate(s, [], contracts, cfg(true));
      check('depends edge -> never fake_dependency_chain block', r.block !== 'fake_dependency_chain');
      check('unknown depends -> advisory only', r.advisories.some((a) => a.includes('GHOST')));
      // a depends edge that IS among peers emits no stale-edge advisory
      const p = story('P', { parallelSafe: 'yes' });
      const s2 = story('S', { parallelSafe: 'yes', depends: ['P'] });
      const contracts2 = new Map([
        ['S', contract('S', { allowedCreate: ['src/a.ts'] })],
        ['P', contract('P', { allowedCreate: ['src/b.ts'] })],
      ]);
      const r2 = evaluateDecompositionGate(s2, [p], contracts2, cfg(true));
      check('known depends peer -> no stale-edge advisory', !r2.advisories.some((a) => a.includes('not among the supplied peers')));
    }

    // 7. Terminal (DONE/DISCARDED) peers are ignored even on a literal collision.
    {
      const s = story('S', { parallelSafe: 'yes' });
      const done = story('P', { parallelSafe: 'yes', phase: 'DONE' });
      const discarded = story('Q', { parallelSafe: 'yes', phase: 'DISCARDED' });
      const contracts = new Map([
        ['S', contract('S', { allowedCreate: ['src/shared.ts'] })],
        ['P', contract('P', { allowedCreate: ['src/shared.ts'] })],
        ['Q', contract('Q', { allowedCreate: ['src/shared.ts'] })],
      ]);
      const r = evaluateDecompositionGate(s, [done, discarded], contracts, cfg(true));
      check('terminal peers ignored -> block null', r.block === null);
    }

    // 8. A non-parallel story yields NO parallel block even on a literal collision.
    {
      const s = story('S', { parallelSafe: 'no' });
      const p = story('P', { parallelSafe: 'yes' });
      const contracts = new Map([
        ['S', contract('S', { allowedCreate: ['src/shared.ts'] })],
        ['P', contract('P', { allowedCreate: ['src/shared.ts'] })],
      ]);
      const r = evaluateDecompositionGate(s, [p], contracts, cfg(true));
      check('non-parallel story -> no parallel block', r.block === null);
    }

    // 9. Precedence: overlap (highest) beats broad when both trigger.
    {
      const s = story('S', { parallelSafe: 'yes' });
      const p = story('P', { parallelSafe: 'yes' });
      const contracts = new Map([
        ['S', contract('S', { allowedCreate: ['src/shared.ts', 'src/**'] })],
        ['P', contract('P', { allowedCreate: ['src/shared.ts'] })],
      ]);
      const r = evaluateDecompositionGate(s, [p], contracts, cfg(true));
      check('precedence: overlap beats broad', r.block === 'overlap_declared_parallel');
    }

    // 10. The gate never enforces cfg.mode: mode=off still returns the same provable block.
    {
      const s = story('S', { parallelSafe: 'yes' });
      const p = story('P', { parallelSafe: 'yes' });
      const contracts = new Map([
        ['S', contract('S', { allowedCreate: ['src/shared.ts'] })],
        ['P', contract('P', { allowedCreate: ['src/shared.ts'] })],
      ]);
      const off = evaluateDecompositionGate(s, [p], contracts, { mode: 'off', maxConcurrentReview: 3, broadGlobBlocks: true });
      check('gate ignores cfg.mode (off still reports the provable block)', off.block === 'overlap_declared_parallel');
    }

    console.log(`parallel-decomposition-gate smoke passed: ${passed} assertions`);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
})();

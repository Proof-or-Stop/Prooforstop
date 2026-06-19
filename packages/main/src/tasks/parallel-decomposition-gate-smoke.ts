/**
 * Smoke: parallel-decomposition gate verdict (B-986c, program Story 2).
 *
 * Hermetic — all StoryInfo / ScopeContractData fixtures are built in memory; no filesystem,
 * no git, no story store. Proves evaluateDecompositionGate blocks ONLY on provable scope
 * contradictions (tier-1 literal overlap, broad-glob-when-strict-with-peers, missing-peer-
 * contract), advises on everything heuristic, fails OPEN on its own unreadable contract, is a
 * no-op with no active peers, never hard-blocks fake_dependency_chain, ignores terminal peers,
 * and never enforces cfg.mode.
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

void (() => {
  try {
    // 0. TERMINAL_PHASES is the single exported source and is what the gate filters on.
    check('TERMINAL_PHASES exports DONE + DISCARDED only', TERMINAL_PHASES.has('DONE') && TERMINAL_PHASES.has('DISCARDED') && !TERMINAL_PHASES.has('DEV'));

    // 1. Clean disjoint parallel set -> no block, no overlap advisory.
    {
      const r = evaluateDecompositionGate(
        story('S', { parallelSafe: 'yes' }),
        [story('P', { parallelSafe: 'yes' })],
        new Map([['S', contract('S', { allowedCreate: ['src/a/x.ts'] })], ['P', contract('P', { allowedCreate: ['src/b/y.ts'] })]]),
        cfg(true),
      );
      check('clean disjoint -> block null', r.block === null);
      check('clean disjoint -> no overlap advisory', !r.advisories.some((a) => a.includes('overlap')));
    }

    // 2. Tier-1 literal collision (both parallel, active) -> overlap_declared_parallel.
    {
      const r = evaluateDecompositionGate(
        story('S', { parallelSafe: 'yes' }),
        [story('P', { parallelSafe: 'yes' })],
        new Map([['S', contract('S', { allowedCreate: ['src/shared.ts'] })], ['P', contract('P', { allowedModify: ['src/shared.ts'] })]]),
        cfg(false),
      );
      check('tier-1 literal overlap -> overlap_declared_parallel', r.block === 'overlap_declared_parallel');
      check('tier-1 block cites path + peer', r.advisories.some((a) => a.includes('src/shared.ts') && a.includes('P')));
    }

    // 3. Tier-2 shared-prefix only (glob vs sibling literal, no literal collision) -> advisory, no block.
    {
      const r = evaluateDecompositionGate(
        story('S', { parallelSafe: 'yes' }),
        [story('P', { parallelSafe: 'yes' })],
        new Map([['S', contract('S', { allowedCreate: ['src/feat/*'] })], ['P', contract('P', { allowedCreate: ['src/feat/y.ts'] })]]),
        cfg(true),
      );
      check('tier-2 shared-prefix only -> block null', r.block === null);
      check('tier-2 emits a shared-prefix advisory', r.advisories.some((a) => a.includes('shared-prefix')));
    }

    // 4. Broad glob asserted parallel WITH an active parallel peer: block only when strict.
    {
      const peers = [story('P', { parallelSafe: 'yes' })];
      const contracts = new Map([['S', contract('S', { allowedCreate: ['src/**'] })], ['P', contract('P', { allowedCreate: ['other/y.ts'] })]]);
      const strict = evaluateDecompositionGate(story('S', { parallelSafe: 'yes' }), peers, contracts, cfg(true));
      check('broad + parallel + active peer + strict -> broad_glob_unprovable_parallel', strict.block === 'broad_glob_unprovable_parallel');
      const lenient = evaluateDecompositionGate(story('S', { parallelSafe: 'yes' }), peers, contracts, cfg(false));
      check('broad + lenient -> block null + advise', lenient.block === null && lenient.advisories.some((a) => a.includes('narrow the contract')));
    }

    // 5. §4.8 no active peers => TRUE no-op: broad + parallel but NO peers -> no block, no advisory.
    {
      const r = evaluateDecompositionGate(
        story('S', { parallelSafe: 'yes' }),
        [],
        new Map([['S', contract('S', { allowedCreate: ['src/**'] })]]),
        cfg(true),
      );
      check('broad + parallel + NO peers -> no-op (block null)', r.block === null);
      check('no-peers broad -> no advisory (true no-op)', r.advisories.length === 0);
    }

    // 5b. §4.8 no-op with ALL-TERMINAL peers (DONE + DISCARDED) + broad glob -> block null AND empty advisories.
    {
      const r = evaluateDecompositionGate(
        story('S', { parallelSafe: 'yes' }),
        [story('A', { parallelSafe: 'yes', phase: 'DONE' }), story('B', { parallelSafe: 'yes', phase: 'DISCARDED' })],
        new Map([['S', contract('S', { allowedCreate: ['src/**'] })]]),
        cfg(true),
      );
      check('all-terminal peers + broad -> block null', r.block === null);
      check('all-terminal peers + broad -> empty advisories (true no-op)', r.advisories.length === 0);
    }

    // 6. §4.2 BROAD without a parallel assertion -> advise only, never block.
    {
      const r = evaluateDecompositionGate(
        story('S', { parallelSafe: 'no' }),
        [story('P', { parallelSafe: 'yes' })],
        new Map([['S', contract('S', { allowedCreate: ['src/**'] })], ['P', contract('P', { allowedCreate: ['other/y.ts'] })]]),
        cfg(true),
      );
      check('broad without parallel assertion -> block null', r.block === null);
      check('broad without parallel -> advise to narrow', r.advisories.some((a) => a.includes('narrow the contract')));
    }

    // 7. Active parallel peer with a MISSING contract -> peer_contract_unreadable_parallel.
    {
      const r = evaluateDecompositionGate(
        story('S', { parallelSafe: 'yes' }),
        [story('P', { parallelSafe: 'yes' })],
        new Map([['S', contract('S', { allowedCreate: ['src/a.ts'] })]]), // no P contract
        cfg(false),
      );
      check('missing parallel peer contract -> peer_contract_unreadable_parallel', r.block === 'peer_contract_unreadable_parallel');
    }

    // 8. §4.8 fail-OPEN on an unreadable OWN contract: allow (block null) + advisory; depends advisory survives.
    {
      const r = evaluateDecompositionGate(
        story('S', { parallelSafe: 'yes', depends: ['GHOST'] }),
        [story('P', { parallelSafe: 'yes' })],
        new Map([['P', contract('P', { allowedCreate: ['src/a.ts'] })]]), // no S contract
        cfg(true),
      );
      check('own contract missing -> fail-open block null', r.block === null);
      check('own contract missing -> fail-open advisory', r.advisories.some((a) => a.includes('fail-open')));
      check('depends advisory survives the fail-open return', r.advisories.some((a) => a.includes('GHOST')));
    }

    // 9. fake_dependency_chain is ADVISE-ONLY; a known-peer depends emits no stale-edge advisory.
    {
      const ghost = evaluateDecompositionGate(
        story('S', { parallelSafe: 'yes', depends: ['GHOST'] }),
        [],
        new Map([['S', contract('S', { allowedCreate: ['src/a.ts'] })]]),
        cfg(true),
      );
      check('depends edge -> never fake_dependency_chain block', ghost.block !== 'fake_dependency_chain');
      check('unknown depends -> advisory only', ghost.advisories.some((a) => a.includes('GHOST')));
      const known = evaluateDecompositionGate(
        story('S', { parallelSafe: 'yes', depends: ['P'] }),
        [story('P', { parallelSafe: 'yes' })],
        new Map([['S', contract('S', { allowedCreate: ['src/a.ts'] })], ['P', contract('P', { allowedCreate: ['src/b.ts'] })]]),
        cfg(true),
      );
      check('known depends peer -> no stale-edge advisory', !known.advisories.some((a) => a.includes('not among the supplied peers')));
    }

    // 10/11. DONE and DISCARDED peers are each ignored in ISOLATION even on a literal collision.
    {
      const sc = new Map([['S', contract('S', { allowedCreate: ['src/shared.ts'] })], ['P', contract('P', { allowedCreate: ['src/shared.ts'] })]]);
      const done = evaluateDecompositionGate(story('S', { parallelSafe: 'yes' }), [story('P', { parallelSafe: 'yes', phase: 'DONE' })], sc, cfg(true));
      check('DONE peer ignored -> block null', done.block === null);
      const discarded = evaluateDecompositionGate(story('S', { parallelSafe: 'yes' }), [story('P', { parallelSafe: 'yes', phase: 'DISCARDED' })], sc, cfg(true));
      check('DISCARDED peer ignored -> block null', discarded.block === null);
    }

    // 12. parallel S + NON-parallel peer (overlapping) -> no block (peer does not assert parallel).
    {
      const r = evaluateDecompositionGate(
        story('S', { parallelSafe: 'yes' }),
        [story('P', { parallelSafe: 'no' })],
        new Map([['S', contract('S', { allowedCreate: ['src/shared.ts'] })], ['P', contract('P', { allowedCreate: ['src/shared.ts'] })]]),
        cfg(true),
      );
      check('parallel S + non-parallel peer -> block null', r.block === null);
    }

    // 13. A non-parallel STORY yields no parallel block even on a literal collision.
    {
      const r = evaluateDecompositionGate(
        story('S', { parallelSafe: 'no' }),
        [story('P', { parallelSafe: 'yes' })],
        new Map([['S', contract('S', { allowedCreate: ['src/shared.ts'] })], ['P', contract('P', { allowedCreate: ['src/shared.ts'] })]]),
        cfg(true),
      );
      check('non-parallel story -> no parallel block', r.block === null);
    }

    // 14. Precedence (2-way): overlap beats broad.
    {
      const r = evaluateDecompositionGate(
        story('S', { parallelSafe: 'yes' }),
        [story('P', { parallelSafe: 'yes' })],
        new Map([['S', contract('S', { allowedCreate: ['src/shared.ts', 'src/**'] })], ['P', contract('P', { allowedCreate: ['src/shared.ts'] })]]),
        cfg(true),
      );
      check('precedence: overlap beats broad', r.block === 'overlap_declared_parallel');
    }

    // 15. Precedence (3-way): overlap (vs peer A) > peer_contract_unreadable (vs peer B) > broad, all triggered.
    {
      const r = evaluateDecompositionGate(
        story('S', { parallelSafe: 'yes' }),
        [story('A', { parallelSafe: 'yes' }), story('B', { parallelSafe: 'yes' })],
        new Map([
          ['S', contract('S', { allowedCreate: ['src/shared.ts', 'src/**'] })],
          ['A', contract('A', { allowedCreate: ['src/shared.ts'] })],
          // B contract intentionally absent -> peer_contract_unreadable
        ]),
        cfg(true),
      );
      check('precedence 3-way: overlap wins over peer-unreadable + broad', r.block === 'overlap_declared_parallel');
    }

    // 16. Multi-peer mixed: a terminal overlapping peer is ignored, an active overlapping peer blocks.
    {
      const r = evaluateDecompositionGate(
        story('S', { parallelSafe: 'yes' }),
        [story('DONEPEER', { parallelSafe: 'yes', phase: 'DONE' }), story('ACT', { parallelSafe: 'yes' })],
        new Map([
          ['S', contract('S', { allowedCreate: ['src/shared.ts'] })],
          ['DONEPEER', contract('DONEPEER', { allowedCreate: ['src/shared.ts'] })],
          ['ACT', contract('ACT', { allowedCreate: ['src/shared.ts'] })],
        ]),
        cfg(true),
      );
      check('multi-peer mixed: active overlap blocks, terminal ignored', r.block === 'overlap_declared_parallel');
    }

    // 17. Self listed as a peer is filtered out (no self-overlap).
    {
      const r = evaluateDecompositionGate(
        story('S', { parallelSafe: 'yes' }),
        [story('S', { parallelSafe: 'yes' })], // same storyId as the subject
        new Map([['S', contract('S', { allowedCreate: ['src/shared.ts'] })]]),
        cfg(true),
      );
      check('self-as-peer filtered -> block null (no self-overlap)', r.block === null);
    }

    // 18. Duplicate paths in the write-set still detect a tier-1 collision without crashing.
    {
      const r = evaluateDecompositionGate(
        story('S', { parallelSafe: 'yes' }),
        [story('P', { parallelSafe: 'yes' })],
        new Map([['S', contract('S', { allowedCreate: ['src/x.ts', 'src/x.ts'] })], ['P', contract('P', { allowedCreate: ['src/x.ts'] })]]),
        cfg(true),
      );
      check('duplicate paths -> tier-1 still blocks', r.block === 'overlap_declared_parallel');
    }

    // 19. The gate never enforces cfg.mode: mode=off still returns the same provable block.
    {
      const off = evaluateDecompositionGate(
        story('S', { parallelSafe: 'yes' }),
        [story('P', { parallelSafe: 'yes' })],
        new Map([['S', contract('S', { allowedCreate: ['src/shared.ts'] })], ['P', contract('P', { allowedCreate: ['src/shared.ts'] })]]),
        { mode: 'off', maxConcurrentReview: 3, broadGlobBlocks: true },
      );
      check('gate ignores cfg.mode (off still reports the provable block)', off.block === 'overlap_declared_parallel');
    }

    console.log(`parallel-decomposition-gate smoke passed: ${passed} assertions`);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
})();

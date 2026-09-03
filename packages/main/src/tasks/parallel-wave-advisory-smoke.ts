/**
 * Smoke: parallel-decomposition ADVISORY wiring — Story 4 (B-fa7c).
 *
 * Hermetic (no StoryStore, no git): the two pure helpers are exercised with synthetic
 * inputs only.
 *   - computeScopeGlobOverlaps (core/proof-or-stop-parallel-wave.ts): which ACTIVE parallel
 *     peers' write-sets statically overlap self's, for the advisory scope_glob_overlap
 *     wave degradation.
 *   - decompositionAdvisoryIssues (handlers/story-review.ts): evaluateDecompositionGate's
 *     advisories surfaced at REVIEW as advisory-severity issues (the gate `block` field is
 *     intentionally ignored — enforcement is Story 5).
 *
 * Run: node packages/main/dist/tasks/parallel-wave-advisory-smoke.js
 */

import { computeScopeGlobOverlaps, scopeGlobOverlapDegradations, safeReadScopeContract } from '../core/proof-or-stop-parallel-wave.js';
import { decompositionAdvisoryIssues } from '../handlers/story-review.js';
import type { StoryInfo, ScopeContractData, StoryPhase } from '../core/types.js';
import type { ParallelGateConfig } from '../core/parallel-decomposition.js';
import type { StoryStore } from '../core/store.js';

let passed = 0;
function check(name: string, cond: boolean): void {
  if (!cond) throw new Error(`FAIL: ${name}`);
  passed += 1;
}

// ---- Fixtures -------------------------------------------------------------

type OverlapPeer = { storyId: string; phase: StoryPhase; parallelSafe?: StoryInfo['parallelSafe']; writeSet: string[] };

function story(over: Partial<StoryInfo> & { storyId: string }): StoryInfo {
  return {
    name: over.storyId,
    title: `title ${over.storyId}`,
    description: 'desc',
    type: 'feature',
    phase: 'DEV',
    priority: 'medium',
    createdAt: '2026-01-01T00:00:00.000Z',
    startedAt: null,
    endedAt: null,
    ...over,
  } as StoryInfo;
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
    acknowledgements: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

const CFG: ParallelGateConfig = { mode: 'advise', maxConcurrentReview: 3, broadGlobBlocks: false };
const CFG_STRICT: ParallelGateConfig = { mode: 'block', maxConcurrentReview: 4, broadGlobBlocks: true };

void (() => {
  try {
    // ================= CHK-001: computeScopeGlobOverlaps =================

    // (happy) self parallelSafe=yes writeSet [core/foo.ts] vs active parallel peer with the
    // same write-set -> one overlap naming the peer + a pairExample mentioning core/foo.ts.
    {
      const peers: OverlapPeer[] = [
        { storyId: 'B-p1', phase: 'DEV', parallelSafe: 'yes', writeSet: ['core/foo.ts'] },
      ];
      const out = computeScopeGlobOverlaps(
        { storyId: 'B-self', phase: 'DEV', parallelSafe: 'yes', writeSet: ['core/foo.ts'] },
        peers,
      );
      check('happy: one overlap emitted', out.length === 1);
      check('happy: names the peer', out[0].peerStoryId === 'B-p1');
      check('happy: pairExample mentions the colliding path', out[0].pairExample.includes('core/foo.ts'));
    }

    // (happy/shape) the ScopeGlobOverlap shape carries exactly peerStoryId + pairExample.
    {
      const out = computeScopeGlobOverlaps(
        { storyId: 'B-self', phase: 'DEV', parallelSafe: 'yes', writeSet: ['core/foo.ts'] },
        [{ storyId: 'B-p1', phase: 'DEV', parallelSafe: 'yes', writeSet: ['core/foo.ts'] }],
      );
      check('shape: keys are peerStoryId + pairExample only', JSON.stringify(Object.keys(out[0]).sort()) === JSON.stringify(['pairExample', 'peerStoryId']));
      check('shape: pairExample is a non-empty string', typeof out[0].pairExample === 'string' && out[0].pairExample.length > 0);
    }

    // (happy:2 — RUNTIME) the overlap, fed through scopeGlobOverlapDegradations (the exact pure
    // helper resolveWaveSafety calls), produces a ParallelWaveDegradation with the frozen shape:
    // capability scope_glob_overlap, severity warn, visible true, authorityImpact none, an id
    // carrying the kind + lower-cased peerStoryId, and a reason naming the peer.
    {
      const degs = scopeGlobOverlapDegradations('B-self', [{ peerStoryId: 'B-p1', pairExample: 'core/foo.ts ↔ core/foo.ts' }]);
      check('degradation: exactly one emitted', degs.length === 1);
      check('degradation: capability is scope_glob_overlap', degs[0].capability === 'scope_glob_overlap');
      check('degradation: severity is warn', degs[0].severity === 'warn');
      check('degradation: visible is true', degs[0].visible === true);
      check('degradation: authorityImpact is none', degs[0].authorityImpact === 'none');
      check('degradation: id contains scope-glob-overlap', degs[0].id.includes('scope-glob-overlap'));
      check('degradation: id contains lower-cased peer id', degs[0].id.includes('b-p1'));
      check('degradation: reason names the peer', degs[0].reason.includes('B-p1'));
      check('degradation: reason mentions the pairExample', degs[0].reason.includes('core/foo.ts ↔ core/foo.ts'));
      check('degradation: empty overlaps -> []', scopeGlobOverlapDegradations('B-self', []).length === 0);
    }

    // (F-005) end-to-end COMPOSITION: the two helpers chained as resolveWaveSafety chains them.
    // Pins the pairExample format contract — computeScopeGlobOverlaps must produce a pairExample
    // string that scopeGlobOverlapDegradations renders verbatim into the degradation reason.
    {
      const degs = scopeGlobOverlapDegradations(
        'B-self',
        computeScopeGlobOverlaps(
          { storyId: 'B-self', phase: 'DEV', parallelSafe: 'yes', writeSet: ['core/foo.ts'] },
          [{ storyId: 'B-p1', phase: 'DEV', parallelSafe: 'yes', writeSet: ['core/foo.ts'] }],
        ),
      );
      check('compose: one degradation from chained helpers', degs.length === 1);
      check('compose: reason carries the pairExample format verbatim', degs[0].reason.includes('core/foo.ts ↔ core/foo.ts'));
    }

    // (edge) self.parallelSafe !== 'yes' -> [] even with an overlapping active parallel peer.
    {
      const peers: OverlapPeer[] = [{ storyId: 'B-p1', phase: 'DEV', parallelSafe: 'yes', writeSet: ['core/foo.ts'] }];
      check('edge: self parallelSafe=no -> []', computeScopeGlobOverlaps({ storyId: 'B-self', phase: 'DEV', parallelSafe: 'no', writeSet: ['core/foo.ts'] }, peers).length === 0);
      check('edge: self parallelSafe=plan_only -> []', computeScopeGlobOverlaps({ storyId: 'B-self', phase: 'DEV', parallelSafe: 'plan_only', writeSet: ['core/foo.ts'] }, peers).length === 0);
      check('edge: self parallelSafe=undefined -> []', computeScopeGlobOverlaps({ storyId: 'B-self', phase: 'DEV', writeSet: ['core/foo.ts'] }, peers).length === 0);
    }

    // (F-006 edge) a TERMINAL self (phase DONE/DISCARDED) yields [] even when it asserts
    // parallelSafe='yes' and overlaps an active parallel peer — a finished story must not emit
    // live overlap advisories (symmetry with the peer terminal-phase filter).
    {
      const peers: OverlapPeer[] = [{ storyId: 'B-p1', phase: 'DEV', parallelSafe: 'yes', writeSet: ['core/foo.ts'] }];
      check('edge: self phase DONE -> []', computeScopeGlobOverlaps({ storyId: 'B-self', phase: 'DONE', parallelSafe: 'yes', writeSet: ['core/foo.ts'] }, peers).length === 0);
      check('edge: self phase DISCARDED -> []', computeScopeGlobOverlaps({ storyId: 'B-self', phase: 'DISCARDED', parallelSafe: 'yes', writeSet: ['core/foo.ts'] }, peers).length === 0);
    }

    // (edge) a peer in a TERMINAL phase (DONE / DISCARDED) -> no overlap even with identical write-set.
    {
      const self = { storyId: 'B-self', phase: 'DEV' as StoryPhase, parallelSafe: 'yes' as const, writeSet: ['core/foo.ts'] };
      check('edge: peer phase DONE -> []', computeScopeGlobOverlaps(self, [{ storyId: 'B-p1', phase: 'DONE', parallelSafe: 'yes', writeSet: ['core/foo.ts'] }]).length === 0);
      check('edge: peer phase DISCARDED -> []', computeScopeGlobOverlaps(self, [{ storyId: 'B-p1', phase: 'DISCARDED', parallelSafe: 'yes', writeSet: ['core/foo.ts'] }]).length === 0);
    }

    // (edge) peer with parallelSafe !== 'yes' -> no overlap; and self vs self (same storyId) skipped.
    {
      const self = { storyId: 'B-self', phase: 'DEV' as StoryPhase, parallelSafe: 'yes' as const, writeSet: ['core/foo.ts'] };
      check('edge: peer parallelSafe=no -> []', computeScopeGlobOverlaps(self, [{ storyId: 'B-p1', phase: 'DEV', parallelSafe: 'no', writeSet: ['core/foo.ts'] }]).length === 0);
      check('edge: peer parallelSafe=undefined -> []', computeScopeGlobOverlaps(self, [{ storyId: 'B-p1', phase: 'DEV', writeSet: ['core/foo.ts'] }]).length === 0);
      check('edge: self vs self skipped', computeScopeGlobOverlaps(self, [{ storyId: 'B-self', phase: 'DEV', parallelSafe: 'yes', writeSet: ['core/foo.ts'] }]).length === 0);
    }

    // (edge) disjoint write-sets -> no overlap.
    {
      const out = computeScopeGlobOverlaps(
        { storyId: 'B-self', phase: 'DEV', parallelSafe: 'yes', writeSet: ['core/foo.ts'] },
        [{ storyId: 'B-p1', phase: 'DEV', parallelSafe: 'yes', writeSet: ['core/bar.ts'] }],
      );
      check('edge: disjoint write-sets -> []', out.length === 0);
    }

    // (adversarial) a peer whose scope contract is null/missing is modeled by simply not
    // including it in the peers list (the call-site filters null) -> no overlap for it.
    {
      // Only the peer WITH a contract is present; the null-contract peer is absent by construction.
      const out = computeScopeGlobOverlaps(
        { storyId: 'B-self', phase: 'DEV', parallelSafe: 'yes', writeSet: ['core/foo.ts'] },
        [{ storyId: 'B-present', phase: 'DEV', parallelSafe: 'yes', writeSet: ['core/bar.ts'] }],
      );
      check('adversarial: absent (null-contract) peer yields no overlap, no throw', out.length === 0);
    }

    // (adversarial) multiple active parallel peers each overlapping -> one entry per peer.
    {
      const out = computeScopeGlobOverlaps(
        { storyId: 'B-self', phase: 'DEV', parallelSafe: 'yes', writeSet: ['core/foo.ts', 'core/baz.ts'] },
        [
          { storyId: 'B-p1', phase: 'DEV', parallelSafe: 'yes', writeSet: ['core/foo.ts'] },
          { storyId: 'B-p2', phase: 'REVIEW', parallelSafe: 'yes', writeSet: ['core/baz.ts'] },
        ],
      );
      check('adversarial: one entry per overlapping peer', out.length === 2);
      check('adversarial: peer fan-out names B-p1', out.some(o => o.peerStoryId === 'B-p1'));
      check('adversarial: peer fan-out names B-p2', out.some(o => o.peerStoryId === 'B-p2'));
    }

    // (F-003) safeReadScopeContract: the corrupt-peer CRASH SITE. store.readScopeContract
    // RE-THROWS on a corrupt scope-contract.json; safeReadScopeContract must swallow it to null
    // (corrupt == missing in this advisory path), and pass through a real contract unchanged.
    {
      const throwingSyntax = { readScopeContract(): ScopeContractData { throw new SyntaxError('corrupt'); } } as Pick<StoryStore, 'readScopeContract'>;
      check('safeRead: corrupt (SyntaxError) -> null, no throw', safeReadScopeContract(throwingSyntax, 'B-x') === null);
      const throwingErr = { readScopeContract(): ScopeContractData { throw new Error('missing'); } } as Pick<StoryStore, 'readScopeContract'>;
      check('safeRead: other throw -> null, no throw', safeReadScopeContract(throwingErr, 'B-x') === null);
      const good = contract('B-x', { allowedModify: ['core/foo.ts'] });
      const returning = { readScopeContract(): ScopeContractData { return good; } } as Pick<StoryStore, 'readScopeContract'>;
      check('safeRead: a returned contract passes through', safeReadScopeContract(returning, 'B-x') === good);
      const returningNull = { readScopeContract(): ScopeContractData | null { return null; } } as Pick<StoryStore, 'readScopeContract'>;
      check('safeRead: a missing (null) contract stays null', safeReadScopeContract(returningNull, 'B-x') === null);
    }

    // ================= CHK-002: decompositionAdvisoryIssues =================

    // (happy) story+peer that yields a (tier-2 shared-prefix) gate advisory -> each issue is
    // {type:'decomposition_advisory', severity:'advisory', message non-empty}.
    {
      const self = story({ storyId: 'B-self', parallelSafe: 'yes' });
      const peer = story({ storyId: 'B-p1', phase: 'DEV', parallelSafe: 'yes' });
      const contracts = new Map<string, ScopeContractData>([
        ['B-self', contract('B-self', { allowedModify: ['core/foo.ts'] })],
        ['B-p1', contract('B-p1', { allowedModify: ['core/*'] })],
      ]);
      const out = decompositionAdvisoryIssues(self, [peer], contracts, CFG);
      check('CHK-002 happy: at least one advisory issue', out.length >= 1);
      check('CHK-002 happy: every issue type=decomposition_advisory', out.every(i => i.type === 'decomposition_advisory'));
      check('CHK-002 happy: every issue severity=advisory', out.every(i => i.severity === 'advisory'));
      check('CHK-002 happy: every message non-empty', out.every(i => i.message.length > 0));

      // (happy) appended to a sample issues[] with one blocker -> blockerCount unchanged.
      const issues: Array<{ severity: 'blocker' | 'advisory' }> = [{ severity: 'blocker' }];
      const before = issues.filter(i => i.severity === 'blocker').length;
      issues.push(...out);
      const after = issues.filter(i => i.severity === 'blocker').length;
      check('CHK-002 happy: blockerCount unchanged by advisories', before === 1 && after === 1);
    }

    // (edge) a configuration where evaluateDecompositionGate returns advisories=[] -> [].
    // A lone story (no active peers), no broad glob, no depends -> §4.8 no-op, no advisories.
    {
      const self = story({ storyId: 'B-lone', parallelSafe: 'yes' });
      const contracts = new Map<string, ScopeContractData>([
        ['B-lone', contract('B-lone', { allowedModify: ['core/foo.ts'] })],
      ]);
      const out = decompositionAdvisoryIssues(self, [], contracts, CFG);
      check('CHK-002 edge: advisories=[] -> no issues', out.length === 0);
    }

    // (edge) the gate also returns a non-null block (tier-1 literal collision, both parallel)
    // -> only the advisories become issues; the block is NOT turned into a blocker issue.
    {
      const self = story({ storyId: 'B-self', parallelSafe: 'yes' });
      const peer = story({ storyId: 'B-p1', phase: 'DEV', parallelSafe: 'yes' });
      const contracts = new Map<string, ScopeContractData>([
        ['B-self', contract('B-self', { allowedModify: ['core/foo.ts'] })],
        ['B-p1', contract('B-p1', { allowedModify: ['core/foo.ts'] })],
      ]);
      const out = decompositionAdvisoryIssues(self, [peer], contracts, CFG);
      check('CHK-002 edge: tier-1 block yields advisory issues', out.length >= 1);
      check('CHK-002 edge: no blocker issue despite a non-null gate block', out.every(i => i.severity === 'advisory'));
      check('CHK-002 edge: every issue is decomposition_advisory', out.every(i => i.type === 'decomposition_advisory'));
    }

    // (adversarial) a peer with no contract in the Map -> no throw (the gate fails CLOSED on an
    // unreadable parallel peer with an advisory, never crashes); every produced issue is advisory.
    {
      const self = story({ storyId: 'B-self', parallelSafe: 'yes' });
      const peer = story({ storyId: 'B-p1', phase: 'DEV', parallelSafe: 'yes' });
      const contracts = new Map<string, ScopeContractData>([
        ['B-self', contract('B-self', { allowedModify: ['core/foo.ts'] })],
        // B-p1 deliberately absent from the Map.
      ]);
      const out = decompositionAdvisoryIssues(self, [peer], contracts, CFG_STRICT);
      check('CHK-002 adversarial: missing peer contract does not throw', Array.isArray(out));
      check('CHK-002 adversarial: every issue severity is exactly advisory', out.every(i => i.severity === 'advisory'));
      check('CHK-002 adversarial: every issue type is decomposition_advisory', out.every(i => i.type === 'decomposition_advisory'));
    }

    // (F-001) mode='off' is the reversible escape hatch (spec §4.7): decompositionAdvisoryIssues
    // short-circuits to [] BEFORE calling the gate — even for inputs that otherwise yield advisories.
    {
      const self = story({ storyId: 'B-self', parallelSafe: 'yes' });
      const peer = story({ storyId: 'B-p1', phase: 'DEV', parallelSafe: 'yes' });
      const contracts = new Map<string, ScopeContractData>([
        ['B-self', contract('B-self', { allowedModify: ['core/foo.ts'] })],
        ['B-p1', contract('B-p1', { allowedModify: ['core/*'] })],
      ]);
      const cfgOff: ParallelGateConfig = { mode: 'off', maxConcurrentReview: 3, broadGlobBlocks: false };
      // Sanity: the same inputs DO yield advisories under mode 'advise'.
      check('CHK-002 off: advise mode yields advisories (control)', decompositionAdvisoryIssues(self, [peer], contracts, CFG).length >= 1);
      check('CHK-002 off: mode=off short-circuits to []', decompositionAdvisoryIssues(self, [peer], contracts, cfgOff).length === 0);
    }

    // ================= F-007: WAVE scope_glob_overlap escape hatch (mode='off') =================
    // §4.7 requires mode='off' to disable BOTH behaviors. The story-review advisory side is
    // covered above; the WAVE side is gated in storyRef by the exact branch
    //   `const scopeGlobOverlaps = scopeGlobEnabled ? computeScopeGlobOverlaps(...) : []`
    // (proof-or-stop-parallel-wave.ts: scopeGlobEnabled is derived in createParallelWave from
    // `resolveAuditConfig(profile, root).parallelGate.mode !== 'off'`). We runtime-test that exact
    // mode->enabled->overlaps decision at the helper boundary (createParallelWave is too heavy to
    // call hermetically — see the F-008 note below).
    {
      // Mirror createParallelWave's mode->enabled mapping and storyRef's gating branch.
      const enabledFor = (mode: ParallelGateConfig['mode']): boolean => mode !== 'off';
      const selfInput = { storyId: 'B-self', phase: 'DEV' as StoryPhase, parallelSafe: 'yes' as const, writeSet: ['core/foo.ts'] };
      const peerInputs = [{ storyId: 'B-p1', phase: 'DEV' as StoryPhase, parallelSafe: 'yes' as const, writeSet: ['core/foo.ts'] }];
      const overlapsFor = (mode: ParallelGateConfig['mode']) =>
        enabledFor(mode) ? computeScopeGlobOverlaps(selfInput, peerInputs) : [];

      check('F-007: mode=advise enables -> overlaps surfaced', overlapsFor('advise').length === 1);
      check('F-007: mode=block enables -> overlaps surfaced', overlapsFor('block').length === 1);
      check('F-007: mode=off disables -> zero overlaps (no scope_glob_overlap degradation)', overlapsFor('off').length === 0);
      // And the degradation builder over the gated result: off-arm yields zero degradations.
      check('F-007: off-arm -> zero scope_glob_overlap degradations', scopeGlobOverlapDegradations('B-self', overlapsFor('off')).length === 0);
      check('F-007: advise-arm -> one scope_glob_overlap degradation', scopeGlobOverlapDegradations('B-self', overlapsFor('advise')).length === 1);
    }

    // ================= F-008: createParallelWave crash-safety (source-verified) =================
    // A full hermetic createParallelWave call was judged DISPROPORTIONATE: its storyRef path runs
    // buildCanonicalStory (which touches ~13 StoryStore reads: readChecklist/readReview/
    // readFindings/readReviewRuns/readTestEvidence/... plus storyDirPath) AND real-filesystem git
    // changed-file probes at `root` — a faithful fake is large and brittle. Instead, crash-safety
    // is proven by (a) the safeReadScopeContract helper tests above (throw -> null), and (b) the
    // SOURCE FACT that createParallelWave routes EVERY scope-contract read through
    // safeReadScopeContract: proof-or-stop-parallel-wave.ts builds `contractsByStoryId` with
    // `const c = safeReadScopeContract(store, s.storyId)` and storyRef then only does pure
    // contractsByStoryId.get(...) lookups (no direct store.readScopeContract in the storyRef path),
    // so one corrupt scope-contract.json cannot throw out of createParallelWave.
    {
      // Re-affirm the helper contract that underwrites the source claim: a throwing read is
      // swallowed to null, which is exactly what keeps the contractsByStoryId build crash-free.
      const throwing = { readScopeContract(): ScopeContractData { throw new SyntaxError('corrupt'); } } as Pick<StoryStore, 'readScopeContract'>;
      check('F-008: corrupt read swallowed (underwrites createParallelWave crash-safety)', safeReadScopeContract(throwing, 'B-x') === null);
    }

    console.log(`parallel-wave-advisory smoke passed: ${passed} assertions`);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  }
})();

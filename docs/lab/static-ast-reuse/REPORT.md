# Static scanner AST reuse Lab

The bounded repair retains one current text/AST per source path within a scanner process. Raw reads, source hashes and every invocation's argv, traversal, exception, dependency and evidence checks remain separate. Changed text replaces the entry. There is no cross-process or authorization-result cache.

## Evidence

Pinned command: `node scripts/verify-static-ast-reuse.mjs`. It executes current scanner source twice, observes actual TypeScript parser calls, and disables only the syntax-cache lookup in the reference arm. Imports and policy paths stay bound to this checkout. Source transformation refuses drift. This portable source observer replaces the initial Node 24 module hook and supports the repository Node 20 runtime floor.

The current real-workload comparison reports 368 reference builds versus 234 candidate builds for 234 unique inputs: 134 fewer builds (36.4%). Both scanner exits must be zero and complete JSON reports must be byte-identical. One shared-host pair measured 3150.312ms versus 2647.004ms. This pair is illustrative, not a statistical wall-time guarantee. No whole-Story speedup or fixed memory ceiling is claimed.

The final managed RED/GREEN uses this same strict-zero driver. RED disables the cache hit in the actual scanner and fails STATIC_AST_REPEATED_IDENTICAL_INPUT; GREEN restores the hit. The signed Lab records preserve commit IDs, command output and timings.

## Controls

The runtime contract executes both new regressions rather than checking their source strings. The boundary verifier checks exact-source hits, changed-text/path misses, malformed syntax and recovery, and one revision per path. It also executes the real scanner with the same file under two different argv lists, and the real narrowing source under valid and invalid identity modes. Negative fixtures must refuse; cached ASTs cannot share invocation authorization. The scanner and identityChildClosure/extraMode consumers keep analysis maps, sets and edges inside their invocation functions; they read AST nodes without transforming them.

The broader static boundary output is regenerated for this candidate in boundaries.log, with command and source hashes in boundaries-provenance.json. Exact existing evidence pins are refreshed only for changed sources, retaining policy, invocation bounds and unrelated entries. A new exact runtime child entry binds both executable controls and their source dependencies.

## Audit corrections

The first candidate was rejected: registry edits invalidated exact scanner pins, the initial driver accepted exit 1, and an earlier boundary log no longer represented the candidate. Those claims are superseded. Final verification requires real scanner exit 0, truthful pins, executable standing controls, and fresh boundary evidence. Earlier local RED/GREEN records remain historical evidence, not approval of that rejected state.

This is isolated Lab maintenance, not formal Story DONE or a released version. Only an explicit integration request authorizes finish; that operation must choose the current patch version, update package manifests/locks and CLI brand, build candidate/main and verify the resulting version. The worktree stays on its base version until then.

The follow-up audit confirmed the repair and requested test infrastructure hardening. The runtime wrapper now permits 180s, exceeding two 60s scan arms and setup. Both controls retain temporary reports on failure and print their location; a parity failure identifies the first differing row key or top-level field. Successful controls still clean temporary data. The manifest retains its original ASCII escaping to keep unrelated formatting out of the diff.

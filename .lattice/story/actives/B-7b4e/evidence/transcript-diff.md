# B-7b4e Real-Machine Transcript Diff

## Expected

- The Quantum claim-admissibility slice is explicitly M0-M1 only, with M2-M5 pending.
- Valid bound quantum evidence passes.
- Missing, stale, mismatched, unbound, or over-broad quantum evidence fails closed.
- Weak evidence can only degrade to a scoped claim when the evidence is otherwise bound and current.
- The smoke command exits successfully and ends with `quantum claim-admissibility smoke passed`.

## Actual

Command:

```sh
npm --prefix packages/main run test:quantum-claim-admissibility
```

Exit code: `0`

Observed output included:

```text
valid Q5 energy evidence: PASS
valid Q5 basis-set-only evidence: PASS
valid figure provenance: PASS
deterministic optional fields: PASS
missing core fields: BLOCK
unknown claim: BLOCK
omitted conditional field: BLOCK
mismatched hamiltonianHash: BLOCK
mismatched gridHash: BLOCK
mismatched basisSetHash: BLOCK
missing basis/grid identity: BLOCK
missing basis/grid identity with weak overclaim: BLOCK
mismatched verifierScriptHash: BLOCK
missing required receipt: BLOCK
stale evidence: BLOCK
weak ground-state overclaim with stale evidence: BLOCK
unbound solver output: BLOCK
unbound plot/table: BLOCK
weak single-run energy evidence cannot prove stronger ground-state claim: BLOCK
weak single-run energy evidence cannot prove stronger convergence claim: BLOCK
weak single-run energy evidence cannot prove stronger quantum-advantage claim: BLOCK
production boundary overclaim: BLOCK
quantum claim-admissibility smoke passed
```

## Diff

No behavior gap observed. The actual transcript matches the expected M0-M1 proof-or-stop behavior: valid bound evidence passes, while stale, missing, mismatched, unbound, and over-broad evidence blocks or degrades only when safe.

## Source Artifact

Structured capture: `.lattice/story/actives/B-7b4e/evidence/live-smoke-transcript.json`

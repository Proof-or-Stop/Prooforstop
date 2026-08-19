# B-5118 Live Smoke Transcript Diff

Captured at: 2026-07-02T23:49:54.239Z

Command:

```sh
npm --prefix packages/main run test:quantum-claim-admissibility
```

## Expected

Quantum M2 exposes named verifier adapters with explicit evidence kind, required
identity fields, and deterministic fail-closed boundaries.

## Actual

The command exited with code 0 and printed the expected M2 success line:

```text
quantum verifier adapter descriptors listed
quantum pack registry descriptor is read-only
valid quantum adapter output: NORMALIZED
normalized Q5 adapter receipt: PASS
unknown quantum adapter id: NORMALIZATION BLOCK
unsupported quantum adapter output version: NORMALIZATION BLOCK
missing quantum adapter output identity: NORMALIZATION BLOCK
stale quantum adapter output: NORMALIZATION BLOCK
failing quantum adapter output: NORMALIZATION BLOCK
mismatched adapter hamiltonianHash: NORMALIZATION BLOCK
mismatched adapter gridHash: NORMALIZATION BLOCK
mismatched adapter verifierScriptHash: NORMALIZATION BLOCK
mismatched adapter outputDigest: NORMALIZATION BLOCK
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
mismatched top-level solver output digest: BLOCK
mismatched top-level energy output digest: BLOCK
mismatched top-level figure provenance output digest: BLOCK
missing receipt identity: BLOCK
unbound plot/table: BLOCK
weak single-run energy evidence cannot prove stronger ground-state claim: BLOCK
weak single-run energy evidence cannot prove stronger convergence claim: BLOCK
weak single-run energy evidence cannot prove stronger quantum-advantage claim: BLOCK
production boundary overclaim: BLOCK
quantum M2 verifier adapter pack passed
```

## Diff Notes

Accepted. The actual transcript demonstrates the expected descriptor listing,
read-only registry boundary, valid receipt normalization, deterministic
fail-closed blocks, no-overclaim boundaries, and the final M2 success line.

The full command transcript is recorded in `evidence/live-smoke-transcript.json`.

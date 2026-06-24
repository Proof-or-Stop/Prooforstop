# B-d243 — Real-machine acceptance: transcript + diff

Rhythm: PLAN outcome = **expected** → run on a real machine → captured output = **actual** → diff.

## User-facing capability under test

When an operator finishes a story after an unrelated `main` merge (whole-tree
materialHash drift, story-owned diff byte-identical), the DONE delivery-check row
should PASS with a loud re-attestation advisory instead of hard-failing with
`stale delivery-check: materialHash mismatch` and forcing a reviewer re-sign.
Story-owned changes, forged storyFilesHash, legacy records, and no-story-diff
records must still hard-reject.

## Acceptance run (real machine)

`node packages/main/dist/tasks/delivery-check-freshness-smoke.js` — this builds real
git fixtures, signs a real delivery-check, drifts material, and renders the ACTUAL
DONE delivery-check row via the done-oracle the operator sees.

| Scenario | Expected (PLAN) | Actual (run) | Diff |
|---|---|---|---|
| Non-story whole-tree drift, story diff unchanged | DONE row PASS + advisory text on detail | `pass: non-story whole-tree drift downgrades to a mandatory re-attestation advisory (DONE row passes with the advisory text)` | match |
| Story-owned change | stale, hard-reject | `pass: story-owned change after delivery-check is stale across DONE consumers` | match |
| Forged storyFilesHash | tampered (signature breaks) | `pass: forged storyFilesHash breaks the delivery-check integrity hash (signed)` | match |
| Legacy record (no storyFilesHash) | strict materialHash stale | `pass: legacy delivery-check with no storyFilesHash falls back to strict materialHash stale` | match |
| Empty-set storyFilesHash (no story diff) | strict stale, NEVER advisory | `pass: empty-set storyFilesHash (no story diff) falls back to strict materialHash stale, never advisory (host-2 soundness)` | match |
| Waiver re-sign | storyFilesHash preserved, drift still advisory | `pass: delivery_waiver_add re-sign preserves the signed storyFilesHash so the drift-advisory survives (F-002)` | match |
| Fresh (no drift) | PASS, no advisory text | (fresh case asserts `doesNotMatch(/ADVISORY/)`) | match |

Full output: 11 named cases, all `pass`, `delivery-check-freshness smoke passed`, exit 0.

**Diff: none. Actual == expected on every row.**

Supporting: `node scripts/verify-process-fact-contract.mjs` exit 0 (delivery-check storyFilesHash contract asserted); `npm test` (root) exit 0; `npm --prefix packages/main run build` clean.

## 5-question user-value self-check

1. **Solves the real problem?** Yes — unrelated `main` drift no longer forces a delivery-check re-sign of the byte-identical story diff; the operator sees a one-line advisory and proceeds.
2. **Ran as a user would, on a real machine?** Yes — the smoke renders the real done-oracle DONE row (the exact text the operator sees), and asserts the literal advisory string on it.
3. **Output as expected?** Yes — advisory on pure whole-tree drift; hard-reject on story-owned/forged/legacy/empty-set. Expected == actual on every scenario.
4. **Failure modes safe?** Yes — the downgrade is non-forgeable (storyFilesHash folded into the signature; forged → tampered), never returns 'fresh', never rebinds the stored hash, and an empty-set/missing storyFilesHash falls back to strict. Gate A (frozen-ref integrity) and Gate B (done-required suite re-run) stay strict.
5. **Durably covered?** Yes — the re-fixtured `delivery-check-freshness` smoke (11 cases) is in `lattice validate`; the process-fact contract verifier asserts the new signing semantic.

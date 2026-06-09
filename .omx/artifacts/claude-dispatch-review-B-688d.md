# Claude Dispatch Review — B-688d

## Host Neutrality

The dispatch package defines 2 host categories (Claude Code 2.1.88, Codex CLI 0.137.0) with symmetric lane allocation across 4 workstreams: engineering-runner, loop-engine, production-safety, and claim-evaluator. Each implementer lane has an opposite-host reviewer. Both hosts are verified available via `--version` probes.

**Verdict: Host-neutral.** No host is privileged; implementer and reviewer roles are symmetric across hosts.

## Lane Structure

All 8 lanes now declare: `ownedPaths`, `readOnlyPaths`, `mode`, `allowedOutputs`, `stopConditions`, `sequentialProofLock`. All implementer lanes are set to `not_authorized` while the final decision remains GO-NOT-YET — no implementer work is authorized until Layer 1 formal proof exists. Reviewer lanes are `audit_only` or `not_authorized` as appropriate.

## Fail-Closed Properties

| Condition | Behavior |
|---|---|
| Missing host binary | BLOCKED — lane cannot execute |
| Missing independent review | BLOCKED — `localReviewCertified` stays false |
| Missing receipt | BLOCKED — no receipt-backed authority without verified receipt |
| Authority mode off | No authority claims accepted; `evidenceClass` stays `local-lifecycle` |
| Higher layer without lower pass | BLOCKED — L2+ lanes stay shadow/audit_only/not_authorized |

**Verdict: Fail-closed.** Every missing prerequisite results in a BLOCKED outcome, not a silent pass. The baseline runner itself enforces this — all 5 expected-PASS runs correctly failed when `localReviewCertified` was not asserted.

## Claim Lock State

4 explicit locks are active: engineering-runner, loop-engine, production-safety, and capability-claim-unlock. Each lock specifies its reason and requiredEvidence. No locks can be released until Layer 1 formal proof exists with independent opposite-host review evidence.

## Contract Integrity

- `authorityMode: off` — no authority claims
- `evidenceClass: local-lifecycle` — only local lifecycle evidence
- No L2+, production, receipt-backed, or fullAuthorityDone claims
- All `authority.*` nested fields correctly set to false/empty
- Canonical authority boundary documented in final-report with `receiptVerified=false`, `productionDone=false`, `authorityChanged=false`

## Overall Assessment

The dispatch package is **host-neutral and fail-closed**. The current decision is GO-NOT-YET because Layer 1 baseline runs lack independent review evidence, runner source is external to this repository, and all 4 claim locks remain active pending formal proof.

## Coordinator Addendum — 2026-06-09T23:13:31Z

After Claude's implementer pass, the coordinator audited host profile ids against `lattice host_list` and `lattice host_probe`.

- Canonical Lattice host profile ids are `codex` and `claude-code`.
- `Codex CLI` and `Claude CLI` remain display/binary names only.
- `host-probes.json` and `dispatch-audit.json` now define their producer and required schema fields, so reviewer lanes do not need to infer artifact shape.
- This addendum does not unlock any claim: decision remains GO-NOT-YET and authority stays `off` / `local-lifecycle`.

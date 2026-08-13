# W2c — Red-evidence v2 record + chain plane + quarantine/recover

Implements Workstream 2 area 3 of `docs/requirements/decisions/red-evidence-subsystem-spec.md`:
§1.10 (v2 top-level schema + per-operation field sets + specDigest), §3.1–§3.7 (chain schema,
head uniqueness, the three integrity checks, the closed transition table, operation keys +
deterministic ids, dedupe ordering, edge cases + walkability), and §4.1 (quarantine/recover
contracts, reference-validation state machine, derived approvedBy, serialization). Highest-risk
W2 leaf: it touches a LIVE enforce gate and real concurrency.

## Invariants (hold across every item)
- The RedEvidenceData widening and the `redEvidenceRecordSatisfied` v1-skip guard land in ONE commit.
- No gate verdict changes: `redEvidenceRecordSatisfied` / `missingRedEvidence` diagnostics stay
  byte-identical on a v1-only store.
- `approvedBy` is DERIVED `<actor>@<sessionId>`, never a caller argument.
- Every chain append is serialized under ONE mkdir claim over read-head → write.
- Commits authored as `lattice-implementer <lattice-implementer@noreply.local>`; artifacts English-only.

## CHK-001 — Define the v2 record union with exhaustive per-operation field sets and always-present nullable chain fields
`packages/main/src/core/red-evidence/record-v2.ts` declares the `proofstory.red_evidence.v2` union with
the exhaustive per-operation field sets of §1.10 (591–721). The §0.4 chain fields `seq` /
`priorRecordDigest` / `supersedes` are ALWAYS present and carry JSON `null` at `seq==1`.
`recordDigest` = W2a CANON over the record with `recordDigest` omitted; `specDigest` per §1.10.

## CHK-002 — Widen RedEvidenceData to a mixed v1 and v2 records array without changing the stored file layout
`packages/main/src/core/types.ts:2700` widens `records[]` to a schemaVersion-discriminated mixed v1/v2
array with the SAME on-disk file layout; no migration of existing v1 stores.

## CHK-003 — Make redEvidenceRecordSatisfied skip every non-v1 record and prove all three gate verdicts are unchanged
In the SAME commit as CHK-002, guard `redEvidenceRecordSatisfied` (`proofstory.ts:931`) so
`record.observedFailure.trim()` at :932 (reached via `.some()` at :947 from `missingRedEvidence` at
:1196) applies only to v1 records. A v2 record must NOT crash the live enforce gate (dev/review/done
all `enforce`). RED signal A: writing a v2 record then running the real gate throws today; after the
guard the diagnostic is byte-identical to the pre-change v1-only run.

## CHK-004 — Resolve the chain head by both uniqueness conjuncts and enforce the three chain-integrity checks
`packages/main/src/core/red-evidence/chain.ts` partitions records by `(storyId, acceptanceTargetRef)`;
head resolution implements BOTH §3.2 (957–964) uniqueness conjuncts; the three §3.3 (965–992) integrity
checks run with FORK rejection as an INDEPENDENT store-corruption/concurrency detector whose reason id
is DISTINCT from the prior-digest (check 2) rejection.

## CHK-005 — Implement the closed transition table with transitive cycle-safe effective-head resolution
The §3.3 closed table governs legal quarantine/recover transitions with governing-red-assert derivation;
effective-head resolution walks transitively through chained recover records and is cycle-safe — a
self-referential or looping recover chain TERMINATES instead of recursing forever.

## CHK-006 — Derive the three operation-key preimages and the deterministic record id from the digest body
`packages/main/src/core/red-evidence/operation-key.ts` derives the three §3.4 (1000–1050) operation-key
preimages + `normalizedReason`, and the deterministic id `<OP>-first12hex(operationKey)-<seq>`;
`first12hex` reuses the W2a helper over the 64-hex body excluding the `sha256:` prefix.

## CHK-007 — Order the append pipeline so the dedupe search precedes head resolution and any run
`packages/main/src/core/red-evidence/append.ts` runs the mandated §3.5 order: derive key → dedupe search
→ replay short-circuit (a replay deriving the same operationKey returns the EXISTING record,
`records.length` UNCHANGED, no second run) → resolve head → transition legality → integrity checks →
append. A stored record failing its own key/id recomputation raises a tagged CONFLICT with nothing written.

## CHK-008 — Scope the dedupe search so a quarantined record cannot swallow the deliberate replacement append
The §3.5 dedupe search is scoped per §3.6 (1067–1076) so a prior quarantine record cannot silently
swallow a deliberate replacement append for the same target — the replacement is a genuine new record,
not a dedupe hit.

## CHK-009 — Serialize every chain append under one mkdir claim covering read-head, dedupe, validate and write
All four chain appends are serialized under ONE atomic mkdir claim over read-head → write, modeled on
the executable `acquireMkdirLock` at `handlers/transition-orchestrator.ts:812-836` (acquire :819,
release :859) via `core/mkdir-lock.ts:253` — NOT the §4.1 line-1171 citation (an explanatory comment).
Two racing `red_evidence_quarantine` processes yield exactly one record + a unique head; the loser
reports a held-claim abort (RED signal B).

## CHK-010 — Land red_evidence_quarantine and red_evidence_recover with derived approvedBy and the binding freeze rule
`packages/main/src/handlers/red-evidence.ts` adds `red_evidence_quarantine` and `red_evidence_recover`
reusing the W2b 13-point wiring recipe (registry / command-catalog / command-policy / config /
process-fact-levels / process-fact-registry / types union / permittedMutations / owner-lease), with the
§4.1 (1122–1171) reference-validation state machine, DERIVED `approvedBy = <actor>@<sessionId>` (never a
caller argument), recover-of-a-recover + quarantine-of-non-head rejected; and lands the §1.1.3
binding-freeze rule inside `red_evidence_binding_set` now that chain-head semantics exist (a binding is
frozen once a run record exists on an unquarantined chain).

## CHK-011 — Register red-evidence-chain-smoke in lattice.config.json validate.commands and run the full suite
`packages/main/src/tasks/red-evidence-chain-smoke.ts` covers the v2 union, the enforce-gate
byte-identical guard, chain integrity + transition table, operation-key/dedupe/replay ordering, the
mkdir-claim concurrency race, the full rejection matrix, and quarantine/recover + binding-freeze;
register it in `lattice.config.json` validate.commands and update the four
`verify-process-fact-contract.mjs` enumerations + `command-catalog-smoke` trailing order for the two
new commands.

## RED signals (un-gameable, the convergence anchor)
- **A — live enforce-gate crash:** a v2 record written into a real story's red-evidence.json makes the
  real `proofstory_gate_check` throw today; fixed by the v1-skip guard; proven byte-identical.
- **B — genuine concurrency:** two `red_evidence_quarantine` child processes race one chain; today one
  append is dropped or two heads appear; fixed to exactly one record + unique head via the mkdir claim.
- **C — hashed rejection matrix:** duplicate `priorRecordDigest` (check 3, reason id distinct from check
  2), seq gap + seq reuse, recover-of-a-recover, quarantine-of-non-head, retired record byte-identical
  before/after (hashed), self-referential recover terminates, replay returns the existing record with
  `records.length` unchanged + no second run, corrupted stored operationKey raises CONFLICT with nothing
  written.

## Out of scope (fenced to later leaves)
Envelope/matcher/receipt schemas (W2d/W2e); the disposable-workspace runner that spawns processes (W2e);
removal of the legacy v1 create writer; and altering any gate verdict/wiring or the enforcement flip.

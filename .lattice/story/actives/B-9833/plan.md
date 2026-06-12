# B-9833 F-009 Layer2 Proof Audit Triage Plan

## Scope

Resolve only the audit state of `B-META-framework-audit:F-009`. This story does not implement `customerKeyRef`, connect Authority Server, change Layer2 proof code, or unlock Production/global claims.

## CHK-001 Inspect F-009 original claim and current proof surfaces

Actions:

1. Read F-009 through `lattice finding_list`.
2. Inspect current formal proof source in `packages/main/src/core/lattice-baseline.ts`.
3. Inspect Layer2/F-009/Layer4 decision docs for claim boundaries.
4. Run formal claim evaluation read-only to confirm current authorization state.

Success criteria:

```text
F-009 original claim identified
formal proof producer/evaluator surfaces identified
current claim state is not overclaimed
```

Stop condition:

```text
BLOCKED: source cannot be tied to formal proof semantics
```

## CHK-002 Decide F-009 closure state with evidence

Actions:

1. Compare the original no-producer/import-path claim with current source and command output.
2. Classify the result as resolved, dismissed, narrowed, or remains open.
3. Keep Layer4 `customerKeyRef` and Authority receipt work outside this story.

Success criteria:

```text
decision names the exact F-009 outcome
decision does not claim Layer2 unlock unless formal proof artifacts authorize it
Layer4/customerKeyRef is separately scoped
```

Stop condition:

```text
BLOCKED: evidence is insufficient to change F-009 state
```

## CHK-003 Update B-META finding state through Lattice finding flow

Actions:

1. Use `lattice finding_resolve` or `lattice finding_dismiss` only after CHK-001 and CHK-002 evidence supports it.
2. Include source refs, command refs, and claim-boundary wording in the resolution/dismissal text.
3. Do not mutate B-META files directly.

Success criteria:

```text
B-META-framework-audit:F-009 state changed only by Lattice finding flow
resolution/dismissal text preserves Layer2/Layer4 boundary
```

Stop condition:

```text
BLOCKED: no Lattice command can express the evidence-backed outcome
```

## CHK-004 Verify convergence and audit backlog after F-009 triage

Actions:

1. Run `lattice finding_list` for `B-META-framework-audit`.
2. Run `lattice convergence_check`.
3. Run `lattice gap_analyze`.
4. Report any remaining high gap as separate scope, not as hidden completion.

Success criteria:

```text
F-009 is no longer a vague open high/suspected finding, or it remains open with precise reason
remaining high gaps, if any, are explicitly named
no Production/global capability is claimed
```

Stop condition:

```text
BLOCKED: verification output contradicts the recorded F-009 outcome
```

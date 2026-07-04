# B-f8c6 Real-Machine Transcript Diff

Story: B-f8c6
Phase: TEST
Machine cwd: `/Users/jek/Documents/Work/proofbound/.worktrees/B-f8c6`
Date: 2026-07-04

## Expected

- M0 examples parse as JSON.
- Protocol/examples expose the M0 boundary, host/model separation, budget-lock fields, Tier-C relationship, and research-only product boundary.
- README invariant passes locally without provider calls or Phase 1/2 execution.
- Actual output should match the PLAN intent: provider-free readiness checks only, no experiment outcome records.

## Actual Transcript

### JSON Parse

Command:

```bash
node -e 'const fs=require("node:fs"); for (const f of ["experiments/multi-model-ablation/cell-manifest.example.json","experiments/multi-model-ablation/runner-registry.example.json","experiments/multi-model-ablation/phase1-budget-lock.example.json"]) { JSON.parse(fs.readFileSync(f,"utf8")); console.log("parsed", f); }'
```

Output:

```text
parsed experiments/multi-model-ablation/cell-manifest.example.json
parsed experiments/multi-model-ablation/runner-registry.example.json
parsed experiments/multi-model-ablation/phase1-budget-lock.example.json
```

### Protocol And Example Boundary Search

Command:

```bash
rg -n "research / paper-evidence|M0|Tier-C|M-crypto|③|⑥|②|④|budgetLockDigest|executorSnapshotDigest|reviewerSnapshotDigest|toolSurfaceDigest|promptDigest|protocolLockDigest|calibrationWindow|snapshotDate|hostKind|executorSnapshot|reviewerSnapshot|eligibleForOutcomeRecords|product gates|DONE|playbook|runtime" docs/requirements/decisions/multi-model-ablation-replication.md experiments/multi-model-ablation
```

Output summary:

```text
exit 0
matched M0/research-only boundary, Tier-C/M-crypto wording, cell labels ②/③/④/⑥,
hostKind/executorSnapshot/reviewerSnapshot separation, budgetLockDigest and digest fields,
eligibleForOutcomeRecords=false, and product gate/DONE/playbook/runtime non-impact wording.
```

Representative lines observed:

```text
docs/requirements/decisions/multi-model-ablation-replication.md:7:**执行分类**: research / paper-evidence campaign...
docs/requirements/decisions/multi-model-ablation-replication.md:42:- **Host 不能替代 provider 证明**...
docs/requirements/decisions/multi-model-ablation-replication.md:247:...Tier-C M0 是 doc-only...M1...M-crypto...
experiments/multi-model-ablation/README.md:5:These files are examples, not executable Phase 1 or Phase 2 artifacts...
experiments/multi-model-ablation/README.md:151:    if (appliesToCell.budgetLockDigest !== lock.budgetLockDigest) {
experiments/multi-model-ablation/phase1-budget-lock.example.json:39:      "requiredAction": "allow E2 A2prime rows only when budgetLockDigest matches the frozen lock"
```

### README Invariant

Command:

```bash
awk '/^node <<'"'"'NODE'"'"'/{flag=1;next} /^NODE$/{flag=0} flag' experiments/multi-model-ablation/README.md | node
```

Output:

```text
example invariants passed
```

The extracted README invariant checks:

- no duplicate manifest `cellKey`;
- A2prime rows have a matching frozen `budgetLockDigest`;
- every A2prime row is claimed exactly once by `budgetLock.locks[].appliesToCellKeys`;
- applies-to keys point to real A2prime manifest rows;
- runner `hostKind` is not reused as `executorSnapshot` or `reviewerSnapshot`;
- same/cross reviewer rows have reviewer snapshots;
- not-applicable reviewer rows keep reviewer snapshot null;
- provider calls are disabled and examples are not eligible for outcome records;
- budget-lock example carries snapshot/tool/prompt/protocol digest placeholders and remains non-executable.

## Diff Notes

- Expected provider-free M0 readiness checks; actual commands were local `node`, `rg`, and `awk` only.
- Expected no model/provider execution; actual transcript contains no provider calls, no Phase 1/2 cell execution, and no outcome records.
- Expected README invariant to catch the review-discovered A2prime budget-lock binding issue; actual invariant now proves exact manifest-to-lock digest binding and passed on current examples.

Result: PASS.

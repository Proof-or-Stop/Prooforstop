# Multi-Model Ablation M0 Examples

This directory contains M0-only research scaffolding for the protocol in `docs/requirements/decisions/multi-model-ablation-replication.md`.

These files are examples, not executable Phase 1 or Phase 2 artifacts. They do not call providers, do not contain ablation outcomes, do not unlock product gates, and do not alter DONE, playbook, runtime, or default agent guidance.

## Files

- `cell-manifest.example.json` shows formal, unique `cellKey` rows for ③, ⑥, ②, and optional ④. It also encodes the required ordering: ③ E2 A4 calibration precedes the ⑥ E2 A2prime row, and A2prime requires a `budgetLockDigest`.
- `runner-registry.example.json` shows runner pre-registration while keeping `hostKind` separate from `executorSnapshot` and `reviewerSnapshot`.
- `phase1-budget-lock.example.json` shows the Phase 1 budget-lock shape and ordering constraints without provider-derived budget or outcome data.

## Provider-Free Local Checks

Parse the JSON examples:

```bash
node -e 'const fs=require("node:fs"); for (const f of ["experiments/multi-model-ablation/cell-manifest.example.json","experiments/multi-model-ablation/runner-registry.example.json","experiments/multi-model-ablation/phase1-budget-lock.example.json"]) { JSON.parse(fs.readFileSync(f,"utf8")); console.log("parsed", f); }'
```

Check the protocol and examples mention the M0 boundary, budget lock, and host/model separation:

```bash
rg -n "research / paper-evidence|M0|③|⑥|②|④|budgetLockDigest|hostKind|executorSnapshot|reviewerSnapshot|product gates|DONE|playbook|runtime" docs/requirements/decisions/multi-model-ablation-replication.md experiments/multi-model-ablation
```

Check example invariants without running cells:

```bash
node -e 'const fs=require("node:fs"); const manifest=JSON.parse(fs.readFileSync("experiments/multi-model-ablation/cell-manifest.example.json","utf8")); const keys=new Set(); for (const cell of manifest.cells) { if (keys.has(cell.cellKey)) throw new Error("duplicate cellKey: "+cell.cellKey); keys.add(cell.cellKey); if (cell.arm==="A2prime" && !cell.budgetLockDigest) throw new Error("A2prime row missing budgetLockDigest: "+cell.cellKey); if ("outcome" in cell) throw new Error("example cell must not include outcome: "+cell.cellKey); } const registry=JSON.parse(fs.readFileSync("experiments/multi-model-ablation/runner-registry.example.json","utf8")); for (const runner of registry.runners) { if (!runner.hostKind || !runner.executorSnapshot) throw new Error("runner missing host/model separation"); if (runner.providerCallEnabled !== false) throw new Error("example runner must keep provider calls disabled"); } console.log("example invariants passed");'
```

These commands are intentionally limited to `rg` and local `node` parsing. They do not run Phase 1/2 cells and do not contact model providers.

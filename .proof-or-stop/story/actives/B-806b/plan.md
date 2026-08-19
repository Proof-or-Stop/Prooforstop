# B-806b Plan: Multi-Model Ablation M1 Protocol Freeze

## Goal
Freeze the M1 launch baseline for the multi-model ablation replication protocol without provider execution. The story produces deterministic artifacts and a local checker that prove Phase 1 is still blocked until explicit human approval, dated snapshots, task inventory, and budget locks exist.

## Non-Goals
- Do not edit docs/requirements/decisions/multi-model-ablation-replication.md.
- Do not run Codex, Claude, Anthropic, OpenAI, or other provider campaign cells.
- Do not write outcome records or claim Phase 1 data exists.
- Do not touch README.md or unrelated root worktree edits.
- Do not change product gates, playbooks, DONE behavior, or runtime learning behavior.

## M1 Milestone Table
| Milestone | Work | Completion signal |
|---|---|---|
| M1.1 | INIT repair and review | Both INIT reviewers pass; ③/⑥/② required and ④ optional are reflected |
| M1.2 | Freeze artifacts | protocol lock, seed manifest, cell matrix, launch gate, status file exist |
| M1.3 | Freeze checker | local checker passes and prints assertion counts plus negative-control count |
| M1.4 | Lifecycle closure | Lattice validate/review/delivery/DONE pass without provider execution |

## CHK-001 Create M1 protocol lock and status table
Create experiments/multi-model-ablation/protocol.lock.json and experiments/multi-model-ablation/m1-status.md.

Implementation details:
- Compute SHA-256 for docs/requirements/decisions/multi-model-ablation-replication.md.
- Record the current HEAD used by the story worktree and the protocol path.
- Mark M1 as provider-free and Phase 1 as not started.
- Mark dated snapshots, task inventory, human approval, and A4 budget locks as launch blockers.

Verification:
- shasum output matches protocol.lock.json.
- Status text says Phase 1 is blocked, not started.
- README.md is untouched by this story.

## CHK-002 Create deterministic seed and cell matrix manifests
Create experiments/multi-model-ablation/seed-manifest.m1.json and experiments/multi-model-ablation/cell-matrix.m1.json.

Implementation details:
- Represent task slots 1-24, scenario slots 1-16, and k=3 repeat slots as deterministic planning dimensions.
- Required Phase 1 cells are ③, ⑥, and ②.
- ④ is optional and budget-permitting.
- A2prime cell ⑥ remains blocked until matching ③ A4 calibration freezes the budget lock.
- ② vs ④ must be labeled descriptive-only or invalid for confirmatory use, never a primary comparison.

Verification:
- Required Phase 1 planned cell count is 3,456 = (③ + ⑥ + ②) x 24 x 16 x 3.
- Optional ④ adds 1,152 cells when enabled, making 4,608 total.
- The matrix exposes legal confirmatory contrasts: ③ vs ⑥, ① vs ② only when same-window anchor ① exists, and ③ vs ④ when optional ④ exists.
- The matrix forbids ② vs ④ as confirmatory.

## CHK-003 Create Phase 1 launch gate and budget rule artifact
Create experiments/multi-model-ablation/phase1-launch-gate.m1.json.

Implementation details:
- launchAllowed=false.
- providerCallEnabled=false.
- formalPhase1UseAllowed=false.
- List blockers: human approval absent, dated snapshots absent, task inventory absent, budget lock absent, and A2prime sequencing locked behind ③ calibration.
- Explain that DONE of this story does not authorize campaign execution.

Verification:
- The artifact cannot be interpreted as a launch approval.
- It explicitly distinguishes M1 local readiness from M2 campaign execution.

## CHK-004 Implement local M1 freeze checker
Create experiments/multi-model-ablation/m1-freeze-check.mjs.

Implementation details:
- Load and validate the five M1 artifacts.
- Recompute the protocol document SHA-256.
- Assert cell counts, required/optional cell semantics, launch blockers, and provider-free boundaries.
- Include in-memory negative controls for drifted protocol digest, premature launchAllowed=true, providerCallEnabled=true, outcome fields, missing required ②, A2prime before budget lock, and illegal ② vs ④ confirmatory comparison.
- Print a clear PASS line with assertion count and negative-control count.

Verification:
- node experiments/multi-model-ablation/m1-freeze-check.mjs exits 0.
- Output contains the assertion count and negative-control count.
- Negative controls are not separate provider runs; they are local checker self-tests.

## CHK-005 Verify and close M1 without provider execution
Run local verification and Lattice lifecycle gates.

Implementation details:
- Run m1-freeze-check.mjs.
- Run git diff --check.
- Run Lattice validate for B-806b.
- Run review, delivery, summary, and DONE gates.

Verification:
- DONE summary states M1 froze launch inputs only.
- No outcome record file is created.
- No provider call or campaign cell is run.
- The unrelated README.md change in the canonical root is not touched by this story.

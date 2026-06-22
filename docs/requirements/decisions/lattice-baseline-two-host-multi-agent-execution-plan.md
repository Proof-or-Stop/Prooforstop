# Lattice Baseline Two-Host Multi-Agent Execution Plan

Date: 2026-06-09

## Purpose

This document defines the execution plan for the next validation stage after
the remote Authority evidence bundle passed Claude CLI and Codex CLI review.
The goal is to move from a proven remote Authority control loop to measured
baseline capability validation without overclaiming.

The plan uses exactly two host types:

- Codex CLI
- Claude CLI

Both hosts may run multiple independent agents, but every agent must preserve
the same four review principles:

1. Do not optimize for the sake of optimization.
2. Do not optimize arbitrarily.
3. Only fix real correctness issues.
4. Preserve consistency of logic.

## Starting Point

Already proven by the remote evidence bundle:

```text
Lattice CLI non-authority PASS
Lattice CLI + remote Lattice Authority authorityDone PASS
Lattice CLI + remote Lattice Authority fullAuthorityDone PASS
```

Evidence anchors:

- `docs/requirements/decisions/lattice-authority-remote-evidence-bundle.md`
- claude-remote-evidence-bundle-audit-20260609T172620Z.md (historical artifact, path removed B-ed70)
- codex-remote-evidence-bundle-audit-20260609T172620Z.md (historical artifact, path removed B-ed70)

Not yet proven by that bundle:

```text
arbitrary natural-language request -> DONE
arbitrary source-aligned cross-language redevelopment -> equivalent DONE
```

Those broader claims require the baseline suite and success-rate reporting
defined in `docs/koala/legacy/root-markdown/Lattice-baseline.md` (archived from repository root).

## Non-Negotiable Boundaries

- Do not merge into the main repository before the worktree has a reviewable
  commit and evidence package.
- Do not broaden the claim beyond the baseline classes that actually pass.
- Do not convert a provider failure, network failure, skipped live test, or
  missing server artifact into DONE.
- Do not treat local/non-authority success as `authorityDone`.
- Do not treat per-run `authorityDone` as `fullAuthorityDone`.
- Do not rerun final certification on stale anchors after a material change;
  generate fresh validation, fresh receipt when applicable, and fresh host
  verdicts.
- Do not repair style or speculative architecture issues unless they block a
  real correctness condition.

## Host And Agent Topology

Recommended concurrent topology: 2 hosts, 8 agents total.

| Host | Agent | Primary role | Writes code/docs? | Blocking authority |
| --- | --- | --- | --- | --- |
| Codex CLI | C0 Audit coordinator | Owns the final claim boundary, blocks overclaims, reconciles agent outputs. | No, except audit artifacts. | Can block final claim. |
| Codex CLI | C1 Diff and commit-scope auditor | Classifies dirty worktree files, separates current work from unrelated changes. | No. | Can block commit readiness. |
| Codex CLI | C2 Non-authority validator | Runs local/non-authority baseline checks and verifies zero Authority contact. | No. | Can block local claim. |
| Codex CLI | C3 Report and metric validator | Checks baseline success-rate math, Wilson lower bound, and report consistency. | No. | Can block capability claim. |
| Claude CLI | L1 Worktree closure executor | Prepares the worktree-only commit package and evidence bundle references. | Yes, only scoped fixes. | Can block if files are missing. |
| Claude CLI | L2 Remote Authority validator | Runs or replays remote Authority live checks with redacted keys and pinned server key. | No, unless fixing a real live correctness issue. | Can block Authority claim. |
| Claude CLI | L3 Natural-language baseline executor | Runs Track A scenarios from the archived `Lattice-baseline.md`. | Yes, only scenario-owned outputs. | Can block NL capability claim. |
| Claude CLI | L4 Redevelopment baseline executor | Runs Track B source-aligned redevelopment scenarios. | Yes, only scenario-owned outputs. | Can block redevelopment claim. |

Optional expansion within the same two hosts:

- C4 Security and redaction auditor, if a run touches credentials, server logs,
  or evidence uploads.
- L5 Repair executor, if a real correctness failure is found and the owner
  needs a separate repair agent.

The optional expansion must not change the two-host constraint. It only creates
more agents under Codex CLI or Claude CLI.

## Milestones

### M0. Scope Freeze And Anchor Inventory

Owner: Codex C0 with Claude L1 support.

Purpose: freeze the exact artifacts being validated before any baseline run.

Inputs:

- current git diff;
- `docs/requirements/decisions/lattice-authority-remote-evidence-bundle.md`;
- `docs/koala/legacy/root-markdown/Lattice-baseline.md` (archived from repository root);
- current package scripts.

Required commands:

```bash
git status --short
git diff --name-only
npm --prefix packages/main run build
git diff --check
```

Pass criteria:

- dirty files are classified as current-scope or unrelated;
- no unrelated file is folded into the validation claim;
- build passes;
- whitespace check passes.

Block criteria:

- unclassified material changes remain;
- build fails;
- evidence bundle references a missing file or command.

### M1. Worktree-Only Commit Readiness

Owner: Codex C1 and Claude L1.

Purpose: prepare a reviewable commit in the worktree without merging to main.

Required output:

```text
.lattice/artifacts/baseline-execution/<run-id>/commit-scope.md
```

The commit scope must include:

- Authority integration fixes used by the remote evidence bundle;
- evidence bundle document and NAV update;
- host audit artifacts;
- baseline execution artifacts generated by later milestones.

Pass criteria:

- commit scope is explicit;
- no secret value is included;
- no main-branch merge is attempted;
- every included file has a reason tied to a real validation requirement.

### M2. Non-Authority CLI Baseline Gate

Owner: Codex C2.

Purpose: prove local mode is still usable and does not contact Authority.

Required commands:

```bash
npm --prefix packages/main run test:baseline-local-certification-smoke
npm --prefix packages/main run test:baseline-contracts-smoke
npm --prefix packages/main run test:baseline-suite-smoke
npm --prefix packages/main run test:baseline-suite-report-smoke
```

Pass criteria:

```text
authorityDone=false
receiptVerified=false
multiHostVerified=false
fullAuthorityDone=false
authorityServerContact=false
local review evidence present when required
```

Block criteria:

- local mode contacts Authority unexpectedly;
- local mode sets any Authority DONE flag;
- local review certification passes without the required local evidence.

### M3. Remote Authority Readiness Gate

Owner: Claude L2 with Codex C0 audit.

Purpose: prove the remote Authority profile remains reachable and pinned before
baseline authority runs.

Required environment:

```bash
LATTICE_AUTHORITY_LIVE_URL='https://staging.hostneutral.net/'
LATTICE_AUTHORITY_LIVE_PUBLIC_KEY='<formal staging server public key pin>'
LATTICE_AUTHORITY_CUSTOMER_API_KEY='<redacted live bearer key>'
```

Required commands:

```bash
npm --prefix packages/main run test:authority-live-python-e2e
npm --prefix packages/main run test:authority-live-python-full-e2e
```

Pass criteria:

```text
authorityDone=true
receiptVerified=true
multiHostVerified=true
fullAuthorityDone=true
server public key matches pin
remote test is not SKIPPED
```

Block criteria:

- live test skips;
- server key does not match the pinned key;
- customer API key is rejected;
- evidence upload or gate evaluation fails;
- final host verdict reconciliation is not satisfied.

### M4. Natural-Language Baseline Track

Owner: Claude L3 with Codex C3 report audit.

Purpose: measure natural-language unattended development capability for the
specific baseline classes, not arbitrary projects.

Baseline scenarios from the archived `Lattice-baseline.md`:

| Scenario | Mode coverage | Expected outcome |
| --- | --- | --- |
| `NL-CLI-1` | non-authority and authority where configured | `PASS` |
| `NL-API-1` | authority preferred | `PASS` |
| `NL-UI-1` | non-authority or authority with browser evidence | `PASS` |
| `NL-REPAIR-1` | authority preferred | `PASS` after bounded repair |
| `NL-DECISION-1` | decision-gated | `PASS` or `EXPECTED_BLOCK` with structured decision evidence |
| `NL-BLOCK-1` | non-authority and authority where configured | `EXPECTED_BLOCK` |

Required artifacts per scenario:

```text
.lattice/artifacts/baseline/<baseline-id>/<run-id>/
  input.md
  story.json
  checklist.json
  job-plan.json
  execution-log.jsonl
  evidence-index.json          # authority runs
  gate-receipt.json            # expected PASS authority runs
  host-verdicts.json           # final authority runs
  authority-status.json        # authority runs
  local-review-status.json     # non-authority runs
  final-report.json
  final-report.md
```

Pass criteria:

- every `PASS` scenario reaches its mode-specific terminal condition;
- every `EXPECTED_BLOCK` scenario blocks with a specific reason;
- repair loops are bounded and recorded;
- no scenario silently falls back from authority mode to local mode.

### M5. Source-Aligned Redevelopment Baseline Track

Owner: Claude L4 with Codex C3 report audit.

Purpose: measure source-aligned redevelopment capability for the specific
baseline classes, not arbitrary language migrations.

Baseline scenarios from the archived `Lattice-baseline.md`:

| Scenario | Required proof | Expected outcome |
| --- | --- | --- |
| `RED-CLI-TS-PY-1` | argument, stdout, stderr, exit-code parity | `PASS` |
| `RED-API-TS-GO-1` | route, schema, status-code, error parity | `PASS` |
| `RED-LIB-TS-RUST-1` | public API and fixture parity | `PASS` |
| `RED-MOBILE-SWIFT-KOTLIN-1` | shared domain fixture parity | `PASS` if runnable, otherwise `INVALID` only for setup failure |
| `RED-GAP-BLOCK-1` | required gap record and no fake parity | `EXPECTED_BLOCK` |

Required artifacts per scenario: every redevelopment run must first satisfy the
common baseline artifact schema from M4, then add these exact
archived `Lattice-baseline.md` redevelopment files:

```text
source-manifest.json
semantic-map.json
parity-fixtures.json
source-runner.log
target-runner.log
gap-log.json
```

Pass criteria:

- source and target execute against the same fixtures;
- target-runnable parity is proven for each advertised scenario;
- gaps block when equivalence cannot be proven;
- no missing behavior is hidden by renaming, broad abstraction, or ignored
  fixture failures.

### M6. Baseline Success-Rate Report

Owner: Codex C3.

Purpose: calculate measured success rates from actual runs.

Required output:

```text
.lattice/artifacts/baseline/baseline-suite-report.json
.lattice/artifacts/baseline/baseline-suite-report.md
```

Required calculations:

- valid-run count;
- `PASS` count;
- `EXPECTED_BLOCK` count;
- `FAIL` count;
- `INVALID` count excluded from denominator only when setup failure is proven;
- `false_done_count`;
- strict completion success rate;
- overall correctness-protected success rate;
- safety success rate;
- weighted success rate;
- Wilson lower bound, so small sample sizes are not overstated.
- maturity stage assignment: Experimental, Beta, Release Candidate,
  Production, or Failed.

Pass criteria:

- success rate is computed, not guessed;
- `false_done_count=0`;
- `false_done_count > 0` forces suite `FAIL` regardless of percentage;
- every excluded `INVALID` has a setup-failure reason;
- every `FAIL` remains visible;
- final claims are limited to baseline classes that met the threshold.

### M7. Two-Host Final Certification

Owner: Codex C0 and Claude L2/L3/L4.

Purpose: prevent a single-host final DONE overclaim.

Run three final certification waves. Each wave uses both hosts and the same
final anchors:

- commit or worktree material hash;
- baseline suite report id;
- remote Authority receipt ids when authority mode is involved;
- job ids and run ids;
- evidence refs;
- host verdict refs;
- command transcripts;
- success-rate report.

Wave plan:

| Wave | Codex agent | Claude agent | Purpose |
| --- | --- | --- | --- |
| 1 | C0 | L2 | Check Authority receipts, remote verdicts, and key pinning. |
| 2 | C1 | L3 | Check natural-language baseline outputs and claim boundaries. |
| 3 | C3 | L4 | Check redevelopment baseline parity and success-rate math. |

Every prompt must include:

```text
Do not optimize for the sake of optimization.
Do not optimize arbitrarily.
Only fix real correctness issues.
Preserve consistency of logic.
```

Pass criteria:

- both hosts return PASS in all three waves;
- no real correctness issue remains open;
- stale anchors are not reused after material changes;
- final claim states exactly one of:
  - local baseline PASS for tested classes;
  - remote Authority `authorityDone` PASS;
  - remote Authority `fullAuthorityDone` PASS;
  - baseline class PASS with measured success rate;
  - blocked or insufficient evidence.

Block criteria:

- any host returns a real correctness FAIL;
- any host reports stale or mismatched anchors;
- success-rate math is inconsistent;
- final wording expands beyond tested baseline classes.

### M8. Read-Only Handoff Package

Owner: Claude L1 with Codex C0 audit.

Purpose: publish the final handoff package without invalidating M7 anchors.
Commit scope and any material worktree changes must be prepared before M7. M8
is read-only packaging: it may index existing artifacts and summarize final
verdicts, but it must not change source, docs, evidence, reports, receipts, or
any file included in the M7 material hash.

Required outputs:

```text
.lattice/artifacts/baseline-execution/<run-id>/final-handoff.md
.lattice/artifacts/baseline-execution/<run-id>/host-verdict-summary.md
.lattice/artifacts/baseline-execution/<run-id>/command-index.md
```

Pass criteria:

- `git diff --check` passes;
- tests and baseline reports are indexed;
- final host verdicts are saved;
- commit message scope was prepared before M7 and matches the validated work;
- no material file changed after M7;
- no secret values are present;
- main repository remains untouched unless the user explicitly approves merge.
- if M8 changes any material file, M7 must rerun on fresh anchors before any
  final claim.

## Parallel Execution Schedule

| Stage | Parallel agents | Can run concurrently? | Join condition |
| --- | --- | --- | --- |
| M0 | C0, C1, L1 | Partially | Build and diff inventory pass. |
| M1 | C1, L1 | Yes | Commit scope artifact created. |
| M2 | C2 | Yes, after M0 build | Local/non-authority proof complete. |
| M3 | L2, C0 | Yes, after M0 build | Remote authority proof complete. |
| M4 | L3, C3 | Yes, after M2/M3 prerequisites by mode | NL baseline reports created. |
| M5 | L4, C3 | Yes, after M2/M3 prerequisites by mode | Redevelopment reports created. |
| M6 | C3 | After M4/M5 | Success-rate report complete. |
| M7 | C0, C1, C3, L2, L3, L4 | After M6 and after all material-producing handoff/commit-scope work | Three final waves pass. |
| M8 | L1, C0 | After M7 | Read-only handoff package complete with no material changes. |

## Repair Loop

If any agent finds a real correctness issue:

1. C0 classifies the issue as current-scope or follow-up.
2. If current-scope, assign one owner agent for the minimal fix.
3. Rerun only the affected validation plus any dependent final gates.
4. If material state changes, regenerate affected receipts, evidence, reports,
   and final host verdict waves.
5. If the issue is not a correctness blocker, record it as a follow-up and do
   not block the current DONE claim.

Every current-scope correctness issue must have a bounded repair budget before
the first repair attempt:

```text
maxRepairAttempts = jobPlan.retryPolicy.maxRepairAttempts when present,
otherwise 3
```

If the repair budget is exhausted:

- expected-`PASS` baseline runs become `FAIL`;
- expected-block scenarios may become `EXPECTED_BLOCK` only when the block reason
  is the scenario's intended, mechanically checkable safety condition;
- no exhausted repair may be converted into DONE;
- the exhausted issue is recorded in `execution-log.jsonl` and
  `final-report.json`.

If three consecutive attempts hit the same external blocker, classify the run
as blocked with a specific reason instead of looping indefinitely.

## Final Claim Rules

Allowed final statements:

```text
Remote Authority evidence bundle remains PASS.
Non-authority baseline PASS for tested scenarios only.
Authority baseline PASS for tested scenarios only.
Source-aligned redevelopment PASS for tested scenario classes only.
Baseline measured success rate is <computed value>.
```

Forbidden final statements unless the measured evidence supports them:

```text
Lattice can complete any natural-language request to DONE.
Lattice can rewrite any old project into any target language with equivalent behavior.
All future Authority runs are guaranteed to pass.
Local/non-authority results are Authority DONE.
```

## Stop Conditions

Stop and report blocked instead of continuing when:

- remote Authority cannot be reached or the server key pin does not match;
- customer API key authorization fails;
- required baseline fixture cannot be built for reasons outside Lattice's
  control and cannot be repaired in scope;
- final host verdicts disagree on a real correctness issue;
- success-rate denominator or exclusions cannot be justified;
- a requested fix would be optimization only.

# Plan — B-7c05 Brief-by-default CLI outputs for agent-loop context hygiene

## Overview

Agent loops re-pay every byte of CLI stdout on every subsequent model call in the same turn (forensics 2026-07-12, rollout 019f46ea turn-40: one ~10k-token output amplified to ~3.8M ledger-visible tokens across a 383-call turn). This story makes the known whale outputs brief by default, adds a per-command `--full` flag, honors a `LATTICE_BRIEF_OUTPUT=0` global escape hatch, and freezes explicit `--json`/`--format=json` machine shapes. Rendering-only: no gate/state-machine behavior change; gateEvidence semantics untouched.

Chosen design (decision A-shared-verbosity-helper): a new shared helper `packages/main/src/cli/output-verbosity.ts` exporting a `wantsFullOutput(args)`-style resolver with precedence **per-call flag (`--full` / `--brief`) > `LATTICE_BRIEF_OUTPUT` env (`0`/`false` → full default) > brief default**. Handlers call it exactly like the existing per-handler `wantsJson()` convention. Explicit `--json`/`--format=json` always returns the current full shape regardless of brief settings.

Measured offenders on 0.3.185 (bytes of default output): `story_list` 364,823; global `bug_list` 262,917; `help` 50,354; milestone-ledger table ~8.4k tokens appended after every mutating command via `appendMilestoneStatusAfterMutation()`; `finding_list` ~10.2k tokens when findings are populated; `host_list` 15,949 (borderline).

Contract constraints discovered during PLAN (consumer sweep):
- `evidence-state-gate-smoke.ts` and `field-regression-cli-smoke.ts` JSON.parse **bare** `finding_list` stdout and assert `findings[].evidenceState` and `attention.suspected` → brief finding_list must stay a JSON object preserving those skeleton fields (drop/truncate heavy free-text fields only).
- `scripts/verify-story-list-bug-summary.mjs` JSON.parses **bare** `story_list` stdout and reads `_bugSummary` → brief story_list must stay a JSON object preserving `_dashboard`/`_phases`/`_bugSummary` meta fields; the 785-entry story array is the payload to trim (brief: active/non-terminal one-liners + counts).
- `cli-surface-smoke.ts` asserts global help contains branding + `host_runtime_list` (satisfied by brief catalog: command names retained) and antigravity/agy wording (lives in verbose descriptions → move those two assertions to `help --full`, add brief-mode assertions).
- Milestone table text has zero external consumers (only the renderer files themselves reference its markers).

## CHK-001 Milestone ledger brief by default

Files: `packages/main/src/core/milestone-status.ts`, `packages/main/src/handlers/milestone-status.ts`, `packages/main/src/cli-engine.ts` (`appendMilestoneStatusAfterMutation`), `packages/main/src/cli/command-catalog.ts`.

- Add `renderMilestoneStatusBrief(report)` next to `renderMilestoneStatusReport()`: phase, progress counts (done/in-progress/not-started), current milestone title + status, explicit next-action line, and a trailing hint naming the full flag. Same data source as the full table — no new computation, no storage change.
- `milestone_status` handler: default → brief renderer; `--full` → current 7-column table; `--json`/`--format=json` → unchanged current shape. `milestone_closeout` stays as-is unless the CHK-004 sweep measures it over budget.
- `appendMilestoneStatusAfterMutation()` in cli-engine.ts: append the brief rendering by default (env hatch restores the full table). This is the multiplicative path (rides on story_advance and every mutating command) and the biggest win per call.
- The checklist-derived fallback (`renderChecklistDerivedLedger`) gets the same brief treatment (it is what rides on stories without a milestone ledger, like this one).

## CHK-002 finding_list brief by default

Files: `packages/main/src/handlers/finding.ts`, `packages/main/src/cli/command-catalog.ts`.

- Default: same JSON object skeleton as today — `findings[]` keeps `id`, `severity`, `category`, `status`, `evidenceState`, and a truncated one-line `title`/summary; heavy free-text fields (full `description`, long evidence prose) are omitted or truncated with an explicit marker field (e.g. `_brief: true` + `_hint`). `attention.suspected`/`attention.disproven` preserved as-is (ids/one-liners).
- `--full` and explicit `--json`/`--format=json`: exactly today's full shape.
- Cluster mode (`cluster:true`) gets the same brief treatment for grouped findings.

## CHK-003 help brief by default

Files: `packages/main/src/cli/help-renderer.ts` (`printHelp`), `packages/main/src/cli-engine.ts` (help dispatch if flag routing is needed).

- Default: header + usage + grouped command **names** (current grouping preserved) with at most a short truncated description per command, sized so the whole brief catalog stays ≤ ~10KB; footer points to `lattice <command> --help` and `lattice help --full`.
- `--full`: current verbose catalog byte-for-byte.
- `printToolHelp()` (per-command `--help`) unchanged.
- Update `cli-surface-smoke.ts`: keep branding + `host_runtime_list` assertions on brief default; move antigravity/agy wording assertions to `help --full`; add a brief-size assertion.

## CHK-004 Audit remaining >5k-token default outputs

Method (recorded for reuse): (1) empirical — run every read-only command against this repo and `wc -c` the output; (2) static — `rg` in `packages/main/src/handlers` + `packages/main/src/core` for markdown-table builders (`renderSection`/`renderTableRow`/`| ---`), full-collection `JSON.stringify` returns, and `.map(...).join('\n')` over unbounded collections.

- Known whales to fix in this story: `story_list` (365KB → brief: meta fields `_dashboard`/`_phases`/`_bugSummary` preserved, story array trimmed to non-terminal stories as one-liners + total counts + `_hint`); global `bug_list` (263KB → brief: counts by status + open-bug one-liners + `_hint`); both keep `--full`/`--json` = current shape.
- `host_list` (16KB, borderline): include only if the same helper drops in trivially; otherwise record as out-of-budget-but-under-threshold in the audit note.
- Sweep output: a short audit table in the story summary (command → default bytes before/after → disposition), so the reviewer can verify coverage without re-running the sweep.

## CHK-005 Escape hatch, JSON contract, and regression coverage

Files: `packages/main/src/cli/output-verbosity.ts` (new), new smoke `packages/main/src/tasks/brief-output-smoke.ts`, registration in `package.json` test scripts + run-all-smokes wiring (follow existing smoke registration pattern), docs (`docs/CLI.md`, `CLAUDE.md` snippet regeneration if managed).

- Helper precedence matrix: `--full` → full; `--brief` → brief; else `LATTICE_BRIEF_OUTPUT` in {`0`,`false`} → full; else brief. Explicit JSON opt-in bypasses the matrix entirely (always current full shape).
- Smoke test asserts, on a synthetic fixture story with a populated milestone ledger and findings: (a) brief defaults for milestone_status / finding_list / help / story_list / bug_list each stay under their byte budgets; (b) `--full` restores the complete output (spot markers: table header row for milestone, description field for finding_list, verbose description text for help); (c) `LATTICE_BRIEF_OUTPUT=0` makes bare invocation render full, and per-call `--brief` still wins over it; (d) explicit `--json` shape: field sets identical before/after (golden field-list comparison, not byte comparison); (e) skeleton contracts hold in brief mode: `findings[].evidenceState`, `attention.suspected`, story_list `_bugSummary` all present.
- Full `lattice validate` green before REVIEW; INIT reviewer note honored (stdout-parsing consumers confirmed via the sweep above).

## CHK-006 Document brief defaults, full-output flag, and escape hatch

Files: `docs/CLI.md`, `CLAUDE.md` (only if the managed lattice snippet regeneration applies — managed assets are regenerated, never hand-edited), optionally `CHANGELOG.md` via the DONE-merge auto-bump.

- Document, in the CLI docs: which commands are brief by default (milestone_status + post-mutation suffix, finding_list, help, story_list, bug_list, plus any CHK-004 sweep additions), the per-command `--full`/`--brief` flags, the `LATTICE_BRIEF_OUTPUT` precedence rule (per-call flag > env > brief default), and the frozen `--json`/`--format=json` contract.
- Verification: `rg` for `LATTICE_BRIEF_OUTPUT` and the full-output flag in `docs/CLI.md` (and `CLAUDE.md` if regenerated) returns the documented sections (CHK-005 intent bullet makes this a must-pass check).

## Risks / preMortem pointers

See decision preMortem: stdout-grep consumers (mitigated by sweep + full validate), lost next-action guidance (brief format keeps it), operator surprise (env hatch + trailing hint + docs), future whale regressions (byte-budget smoke + recorded audit method).

# Proof-or-Stop Console Demo MVP Requirements Recommendation

> Status: proposal for Story B-0414
> Date: 2026-06-16
> Historical prototype input: `/Users/jek/Documents/lattice-console-demo.html`
> Existing source-of-truth anchor: `docs/requirements/decisions/host-neutral-observability-console.md`
> Positioning: this document is a productization addendum for the static HTML prototype. It does not replace the host-neutral observability console design.

## 1. Purpose

The static prototype already shows the right product shape: a Proof-or-Stop monitor with Overview, Active Stories, DONE Pre-check, Bugs and Findings, Hosts and Runtimes, Trajectory / Truth, and Authority Status.

The missing piece is not visual polish. The missing piece is the bridge from a static mock to a trustworthy Proof-or-Stop console that:

- reads only supported Proof-or-Stop CLI JSON surfaces;
- explains the current workflow state without parsing Markdown or private backing stores;
- turns every failed or warning state into a concrete recovery command;
- keeps local workflow evidence, local host verdicts, Authority receipts, and production DONE clearly separated;
- stays host-neutral and agent-neutral.

This document proposes the MVP requirements for that bridge.

## 2. Prototype Assessment

The prototype has useful interaction ideas:

- top-level project and refresh status;
- active story count and completion metrics;
- phase distribution;
- clickable story rows;
- a DONE pre-check panel;
- bug / finding summaries;
- host runtime status;
- convergence and gap summary;
- authority mode and production status warning.

The prototype also exposes real productization gaps:

- The data is hard-coded. For example, the prototype shows `346 / 375 DONE`, while the current `session_brief` on 2026-06-16 reports `349 / 381 DONE`.
- It implies `source: proof-or-stop ... --format=json`, but several required surfaces need explicit stable JSON contracts before the UI should depend on them.
- It shows failed gates, but does not consistently provide the recovery command that Proof-or-Stop already knows.
- It mixes local green status and production authority status in the same visual language unless the user opens the Authority page.
- It treats story and host state as dashboard facts, but does not yet show authority root, worktree root, mirror phase, or stale evidence recovery.

The MVP should fix these correctness issues first. It should not optimize layout, animation, chart density, or background style until the state model is honest.

## 3. Proof-or-Stop Core Design Philosophy

The console should expose Proof-or-Stop's core product philosophy: host-neutral workflow, CLI-owned truth, evidence-backed gates, recovery before analytics, and explicit authority boundaries. The demo can be visually polished only when those semantics remain visible and consistent.

1. **Host-neutral workflow first**
   Proof-or-Stop workflow commands and state are not Codex-specific, Claude-specific, or Mac-app-specific. The console must describe Proof-or-Stop state, not a single host runtime transcript.

2. **No arbitrary optimization**
   Do not add analytics, daemons, storage layers, or extra indexing only because the dashboard could look richer. Add a field only when it answers a real workflow recovery or correctness question.

3. **Only fix real correctness issues**
   The first MVP should target stale data, missing recovery instructions, authority confusion, and unsupported JSON assumptions. Cosmetic redesign is out of scope.

4. **Consistency of logic**
   A status shown in the console must mean the same thing as the corresponding CLI gate. If `story_advance DONE` would fail, the console must not render that story as ready.

5. **Read-only by default**
   The MVP console can display copyable commands. It must not mutate story metadata, submit verdicts, advance phases, or claim authority.

6. **Calm visual discipline**
   The console should feel precise, spacious, and operational. Aesthetic quality is a correctness requirement for this surface because the product is a monitoring and recovery console: uneven spacing, noisy density, or asymmetric panels make state harder to trust.

7. **Every clickable surface must resolve**
   Any element that appears clickable in the demo must open a meaningful detail drawer, route, or disabled-state explanation. A click target that does nothing is a product logic bug, not a harmless prototype gap.

## 4. MVP Goals

The MVP should let a user answer five questions without asking an agent:

1. What is the current Proof-or-Stop project state?
2. Which stories are active, and where is each authoritative worktree?
3. Why can or cannot a selected story reach DONE?
4. What exact command should recover a warning or failure?
5. Is a green state local workflow evidence, local host evidence, Authority receipt evidence, or production DONE?

## 5. Non-goals

The MVP must not:

- implement a new authority path;
- bypass decision-doc quorum, delivery-check, evidence freshness, reviewer quorum, or receipt gates;
- read `.proof-or-stop/story/**` or process-event files directly from the UI adapter;
- parse `session_brief` Markdown as a stable API;
- create a background daemon unless a later story proves it is required;
- drive Claude, Codex, Gemini, or any host automatically;
- submit local host verdicts or Authority verdicts;
- turn local DONE into `productionDone`;
- move, rewrite, or depend on the historical prototype `/Users/jek/Documents/lattice-console-demo.html` as a production asset.

## 6. Data Source Contract

The console adapter must consume Proof-or-Stop through supported CLI JSON surfaces only.

Required read-only command surfaces:

| Need | Preferred source |
|---|---|
| Project overview, active story next action | `session_brief --format=json` or a new resolver JSON surface |
| Active story list and phase distribution | `story_list --format=json` |
| Per-story detail | `story_get --storyId=<id> --format=json` |
| Checklist and verification intent coverage | `checklist_get --storyId=<id> --format=json` plus `validate --story=<id> --json` |
| DONE pre-check | machine-readable DONE pre-check from `session_brief` or `story_get` |
| Bugs | `bug_list --format=json`, `bug_analyze --format=json` |
| Findings | `finding_list --storyId=<id> --format=json` |
| Host runtimes | `host_runtime_list --json`, `host_runtime_probe --host=<host> --json` |
| Convergence | `convergence_check --format=json`, `gap_analyze --format=json` |
| Authority boundary | `authority_status --format=json` |
| Runtime rollout status | `rollout_check --format=json` |

If a source currently has no JSON output, the MVP requirement is to add a supported JSON command or resolver. The adapter must not silently parse prose.

## 7. Required Console Pages

### 7.1 Overview

The Overview page should show:

- DONE count and total story count from live data;
- active story count;
- open bug count;
- test evidence coverage;
- convergence state;
- highest severity blocker;
- authority mode and `productionDone` state;
- last refresh time;
- data-source command used for each metric.

Each metric must open a detail drawer with:

- source command;
- raw field names used;
- why the status is green, yellow, or red;
- recovery command when applicable.

### 7.2 Active Stories

Each story row should show:

- story id;
- title;
- phase;
- priority and type;
- authority root: `main` or `worktree`;
- authoritative cwd;
- mirror phase when it differs;
- checklist progress;
- reviewer lane summary;
- open bug / finding count;
- next command.

The row must warn when the main metadata mirror lags behind the worktree authority.

### 7.3 DONE Pre-check

This should be the strongest MVP page.

Required gates:

- test evidence;
- verification intent coverage;
- evidence freshness;
- bugs fixed;
- git working tree clean;
- branch synced with main;
- related docs touched;
- delivery-check signed;
- summary complete;
- declared artifacts referenced and committed;
- decision-doc quorum when `docs/requirements/decisions/*.md` changed;
- Authority receipt status when production completion is relevant.

Each failed or warning gate must include:

- observed state;
- reason;
- evidence file or CLI field;
- exact recovery command;
- whether the command is read-only or mutating.

Examples:

| Gate state | Required recovery display |
|---|---|
| stale verification evidence | `proof-or-stop verification_evidence_refresh_stale --storyId=<id>` then `proof-or-stop validate --story=<id> --json` |
| branch behind main | explain whether `story_advance DONE` can auto-merge or requires manual conflict handling |
| missing delivery-check | spawn or run the required delivery reviewer path; do not suggest main-agent self-signing |
| decision-doc quorum missing | show required rounds, hosts per round, material digest, and valid/invalid rounds |
| no signed workspace | show gitRoot / worktree repair command when available |

### 7.4 Bugs and Findings

The page should separate:

- open bugs;
- fixed bugs;
- dismissed findings;
- suspected findings;
- verified blocking findings;
- audit backlog entries.

Findings must show `evidenceState`, because suspected and disproven findings have different gate meaning from verified high or critical findings.

### 7.5 Hosts and Runtimes

The page should show:

- fake, claude-code, gemini, codex, and future host profiles;
- runtime availability;
- login readiness;
- noninteractive support;
- transcript support;
- receipt support;
- unattended safety;
- visible degradations;
- authority impact.

The UI must make clear that a scaffolded host is not the same as a production-ready Authority runner.

### 7.6 Trajectory / Truth

This page should show:

- `convergence_check` status;
- high-priority gaps;
- annotation errors;
- unfinished stories;
- audit backlog;
- requirements coverage;
- whether a gap blocks the current story or only blocks whole-project convergence.

This page must explicitly avoid turning whole-project gaps into blockers for unrelated completed stories.

### 7.7 Authority Status

This page should show:

- authority mode;
- local workflow usability;
- receipt verification state;
- actor key status;
- runner status;
- server-backed receipt status;
- `productionDone`;
- whether the console is displaying local evidence only.

The top-level UI should always show an authority boundary marker, not bury it on this page only.

## 8. Visual and Interaction Requirements

The prototype should keep its dark operational style, but the implementation must satisfy a stricter visual system before it can be considered product-ready.

### 8.1 Aesthetic Rules

- Use a consistent spacing scale across cards, rows, drawers, and navigation. Adjacent panels should align on the same grid.
- Preserve left/right symmetry in page gutters, card padding, drawer padding, and metric grids.
- Keep the interface minimal: no decorative element should compete with story state, gate status, recovery action, or authority boundary.
- Keep card radii and borders consistent. Avoid mixing unrelated panel treatments.
- Use color only for semantic state: pass, fail, warning, pending, host degradation, authority tier, or selection.
- Keep typography hierarchy restrained: page title, panel title, row label, metadata, command text. Do not introduce extra display styles for emphasis.
- Make dense information scannable with alignment and grouping rather than extra prose.
- Avoid one-off visual treatments for single panels unless the state semantics require it.

### 8.2 Layout Requirements

- Overview metric cards must share equal height and baseline alignment.
- Lifecycle phase chips must remain evenly spaced and visually centered at desktop widths.
- Story rows must keep stable columns for phase, id/meta, title, and checklist state.
- DONE pre-check gates must align icon, label, and status value consistently.
- Host rows must align host name, status, and capability details.
- Drawer content must preserve the same key/value alignment on every opened detail.
- At mobile or narrow widths, the layout may stack, but text must not overlap or clip.

### 8.3 Click Target Requirements

Every clickable element in the demo must be backed by a product-logical action:

| Clickable area | Required behavior |
|---|---|
| Top project pill | Open project snapshot: root, gitRoot, config path, active story count, current authority mode |
| Top refresh pill | Open refresh diagnostics: last refresh time, command duration, failed command list |
| DONE percentage pill | Open story completion breakdown by phase and outcome |
| Left navigation item | Switch page and preserve selected state |
| Metric card | Open source command, field path, calculation, and recovery meaning if warning/fail |
| Lifecycle phase chip/bar segment | Open stories filtered to that phase |
| Active story row | Open story detail with authoritative cwd, mirror phase, checklist, next action |
| Checklist progress | Open checklist detail and verification intent coverage |
| DONE pre-check gate | Open gate reason, evidence source, and recovery command |
| Bug/finding row | Open bug or finding detail including evidenceState and gate impact |
| Terminal worktree warning | Open story_reconcile dry-run explanation and safe cleanup command |
| Host runtime row | Open host_runtime_probe detail and authority-impact degradations |
| Convergence/gap row | Open exact convergence check failure and whether it blocks story DONE or whole-project convergence |
| Authority status row | Open authority field explanation and what would change it |
| Drawer close / scrim / Escape | Close drawer consistently |

If an element cannot yet resolve to real data, it must show a disabled or "not implemented in MVP" explanation. It must not silently fail.

### 8.4 Product Logic Requirements for Clicks

- A click must never imply a mutation unless the UI explicitly labels it as a copyable command or future confirmed action.
- A failed gate click must explain why Proof-or-Stop would block the phase transition.
- A warning click must distinguish advisory state from blocking state.
- A host click must distinguish runtime availability from Authority readiness.
- A convergence click must distinguish whole-project convergence from the selected story's DONE eligibility.
- A command shown in a drawer must use host-neutral Proof-or-Stop command names unless the command is explicitly adapter-specific.

## 9. Core User Flows

### Flow A: Start of Session

1. User opens console.
2. Console reads project overview and active stories.
3. Console highlights the most reliable next action from Proof-or-Stop.
4. User can copy the next command.

Acceptance:

- The recommended action matches `session_brief`.
- The console does not invent a next step.

### Flow B: Resume an Active Story

1. User opens Active Stories.
2. User selects a story.
3. Console shows authoritative cwd, phase, mirror phase, checklist, and next action.
4. User sees `cd <worktree>` if required.

Acceptance:

- Worktree authority is visible.
- Main mirror lag is visible.
- The command is host-neutral.

### Flow C: Diagnose DONE Blocker

1. User opens DONE Pre-check for a story.
2. Console shows failing gate.
3. Detail drawer explains cause and recovery command.
4. User can copy command.

Acceptance:

- Recovery command matches Proof-or-Stop CLI behavior.
- Mutating commands are labeled.
- Local evidence and Authority evidence remain distinct.

### Flow D: Explain Non-convergence

1. User opens Trajectory / Truth.
2. Console shows convergence failed.
3. Console lists exact failing checks and whether they block the current story.

Acceptance:

- User can distinguish story DONE from whole-project convergence.
- High gaps are not exaggerated into unrelated story blockers.

## 10. MVP Phasing

### Slice 1: Live Read-only Data Adapter

Deliver:

- command runner abstraction;
- JSON parser that accepts only valid single-document stdout;
- snapshot object for overview, active stories, hosts, convergence, and authority;
- no UI mutation commands.

Exit criteria:

- static hard-coded metrics are removed;
- current `story_list` and `session_brief` values appear in the UI;
- unsupported JSON surfaces are represented as explicit adapter gaps, not parsed prose.

### Slice 2: Story Detail and DONE Pre-check

Deliver:

- story detail drawer;
- DONE pre-check gate list;
- recovery command model;
- stale evidence and delivery-check guidance.

Exit criteria:

- a story blocked from DONE shows the same blocking reason as the CLI;
- each warning or failure has a recovery command or an explicit "no safe automatic recovery" reason.

### Slice 3: Authority Boundary and Host Runtime Semantics

Deliver:

- authority marker in global chrome;
- Authority page;
- host runtime detail drawer;
- scaffolded vs ready vs production-authorized distinction.

Exit criteria:

- local green cannot be mistaken for `productionDone`;
- host runtime status matches `host_runtime_list`.

### Slice 4: Convergence and Gap Explanation

Deliver:

- convergence page;
- high gap list;
- unfinished story list;
- annotation drift summary;
- story-blocking vs project-convergence distinction.

Exit criteria:

- `convergence_check` failures are explainable without reading raw CLI output.

## 11. Acceptance Criteria

The first implementation story should be accepted only when:

1. The console reads live Proof-or-Stop data instead of static demo arrays.
2. The displayed active story count matches `story_list`.
3. The displayed lifecycle totals match `story_list` or an explicitly documented aggregate.
4. The displayed DONE pre-check state matches the CLI's machine-readable gate state.
5. Every failed or warning gate includes a recovery command or a reason no safe command exists.
6. The console never reads `.proof-or-stop/story/**` directly.
7. The console never mutates story state.
8. The console marks local workflow evidence separately from Authority receipt evidence.
9. The console marks `productionDone=false` unless a verified receipt is present.
10. The console can explain non-convergence without treating every project-level gap as a current-story blocker.
11. The console satisfies the visual rules for spacing, symmetry, restrained hierarchy, and semantic color use.
12. Every visible clickable target opens a meaningful detail, route, disabled-state explanation, or close action.
13. Click behavior preserves Proof-or-Stop product logic: read-only by default, host-neutral commands, and no local evidence upgraded into production authority.

## 12. Verification Plan

Minimum verification for the implementation story:

- Unit test the adapter against saved JSON fixtures for `story_list`, `host_runtime_list`, `authority_status`, and `convergence_check`.
- Integration test the adapter against real `node bin/proof-or-stop.js ... --json` commands in this repository.
- Browser smoke test the console with at least:
  - one active story;
  - one DONE story;
  - one convergence failure;
  - one host runtime degradation;
  - one authority local-evidence-only state.
- Browser interaction test every clickable prototype selector and assert that it opens the expected drawer/page or a documented disabled-state explanation.
- Visual QA at desktop and narrow widths for spacing, symmetry, row alignment, drawer alignment, and non-overlapping text.
- Snapshot test that no `.proof-or-stop/story/**` direct reads are used.
- Manual transcript proving that the console's next action matches `session_brief`.

## 13. Risks and Mitigations

| Risk | Mitigation |
|---|---|
| UI parses Markdown because JSON is missing | Add a resolver JSON surface first; fail closed when unsupported |
| Local pass looks like production pass | Always display authority tier and `productionDone` |
| Dashboard becomes a new workflow authority | Keep MVP read-only and command-copy only |
| Metrics drift from CLI | Store source command and field path for every metric |
| Console grows into arbitrary analytics | Limit MVP to recovery, authority clarity, and current workflow correctness |
| Host-specific wording leaks into workflow commands | Keep `story_*`, `session_brief`, `validate`, and recovery commands host-neutral |
| Visual polish gets treated as optional | Make spacing, symmetry, and click resolution part of acceptance, not a later styling pass |
| Prototype click affordances drift from product logic | Maintain a click-target inventory and test every interactive selector |

## 14. Open Questions

1. Should the MVP live as a generated static HTML snapshot, a local dev server, or a CLI-served dashboard page?
2. Should the first implementation target the existing `proof-or-stop dashboard` terminal command, or a separate browser console command?
3. Which command should become the canonical machine-readable resolver for active stories: `session_brief --json`, `story_authority_resolve --json`, or a new purpose-built command?
4. Should recovery commands be copy-only in MVP, or should a later version allow explicit confirmed execution?
5. Should the external prototype be imported into the repository after MVP scope is accepted, or remain a reference artifact outside the repo?
6. Should visual QA be enforced with Playwright screenshots only, or should there also be layout assertions for clickable target bounds and text overflow?

## 15. Recommended Next Story

Recommended implementation story:

`Build read-only Proof-or-Stop Console live data adapter`

Initial checklist:

1. Add or confirm a machine-readable active-story resolver surface.
2. Build a read-only adapter that executes supported Proof-or-Stop JSON commands.
3. Replace prototype hard-coded metrics with adapter snapshots.
4. Render DONE pre-check gates with recovery commands.
5. Add a click-target inventory and browser test proving every clickable demo element opens a valid detail/page/disabled explanation.
6. Add tests proving no direct `.proof-or-stop/story/**` reads and no mutating commands.

This sequence follows the Proof-or-Stop host-neutral direction and avoids optimization for its own sake: it fixes live-state correctness, recovery clarity, and authority-boundary clarity first.

# Lattice Codex Command Boundary Execution Plan

Date: 2026-06-13

## Purpose

This document defines the execution plan for keeping Lattice workflow commands
host-neutral while limiting the Codex command surface to Codex adapter
diagnostics and verification.

The goal is not to add compatibility aliases for mistaken workflow commands.
The goal is to stop generated prompts, generated assets, docs, and CLI
suggestions from teaching agents that ordinary Lattice lifecycle commands belong
to a Codex-specific namespace.

This plan follows four constraints:

1. Do not optimize for the sake of optimization.
2. Do not optimize arbitrarily.
3. Only fix real correctness issues.
4. Preserve consistency of logic.

## Problem Statement

Lattice is the workflow layer. It coordinates story state, checklist state,
review artifacts, validation evidence, delivery checks, and convergence checks
across hosts. Those commands must remain host-neutral.

Codex is one possible host/adapter. Codex-specific commands may diagnose or
verify Codex adapter assets, but they must not become a second namespace for
ordinary Lattice workflow operations.

The operator-facing defect has two closely related forms:

- A rejected namespace form can produce unclear suggestions if the executable
  CLI is stale.
- Generated Codex wrapper guidance can still encourage agents to run ordinary
  workflow recovery commands through a Codex wrapper, which weakens the
  host-neutral mental model even when the command technically works.

The fix must clean guidance and preserve fail-closed command behavior.

## Command Boundary Rule

### Host-Neutral Workflow Commands

The following command families belong to the Lattice workflow layer and must be
generated or recommended without a host or agent namespace:

| Command family | Correct guidance |
| --- | --- |
| session recovery | `lattice session_brief` |
| document discovery | `lattice aux_doc_list` |
| story lifecycle | `lattice story_*` |
| checklist updates | `lattice checklist_*` |
| validation | `lattice validate` |
| findings | `lattice finding_*` |
| review artifacts | `lattice review_*` |
| summary artifact | `lattice summary_set` |
| delivery artifact | `lattice delivery_check_set` |
| convergence | `lattice convergence_check` |

Generated prompts may use the project-local wrapper form
`node bin/lattice.js <command>` when local bootstrap is required. They must not
route these commands through a Codex adapter wrapper.

### Codex Adapter Commands

The Codex command surface is limited to Codex adapter capabilities:

| Purpose | Accepted guidance |
| --- | --- |
| Codex adapter diagnostics | `lattice codex doctor` or `lattice codex_doctor` |
| Codex adapter verification evidence | `lattice codex verify` or `lattice verify_codex` |

These commands are adapter-specific because they inspect or write evidence for
Codex adapter assets, hooks, wrappers, manifests, and heartbeats.

### Forbidden Generation Pattern

Generators, docs, and prompt templates must not combine the Codex namespace
prefix with ordinary workflow command families. In validation scripts, refer to
this as the pattern:

```text
lattice\s+codex\s+(session_brief|aux_doc_list|story_|checklist_|validate|review_|finding_|summary_set|delivery_check_set|convergence_check)
```

Do not add aliases that make these forms succeed. Rejection is the correct
behavior because the command boundary is part of the product model.

## Current Fact Pattern

The current source behavior already contains the correct narrow CLI fallback:

- Codex adapter aliases for `verify` and `doctor` remain supported.
- Codex-prefixed session recovery and document discovery are rejected.
- The error message tells users to run the ordinary Lattice command instead.

However, three areas still need explicit audit before this can be treated as
done:

1. Runtime `dist` must match `src`, otherwise users still observe stale CLI
   behavior.
2. Generated init assets and prompt templates must not recommend Codex wrapper
   forms for host-neutral workflow commands.
3. Existing tracked entrypoint docs must not carry residual guidance that makes
   session recovery or document discovery look Codex-specific.

As of this plan, residual local wrapper guidance remains outside this document
and must be treated as future cleanup, not completed work:

- Diagnostic guidance still names `node bin/lattice-codex.js doctor` in
  `README.md`, `packages/main/src/init-assets.ts`, and generated
  `packages/main/dist/init-assets*`; the execution story must replace that
  adapter diagnostic guidance with `node bin/lattice-codex.js codex_doctor` and
  then rebuild dist.
- Workflow-wrapper guidance still names `node bin/lattice-codex.js session_brief`,
  `node bin/lattice-codex.js aux_doc_list`, and
  `node bin/lattice-codex.js story_create` in `README.md`; future cleanup must
  replace those examples with the ordinary host-neutral `node bin/lattice.js ...`
  workflow commands.
- Adapter-check display-command text still names `node bin/lattice-codex.js session_brief`
  in `packages/main/src/core/codex-adapter-checks.ts` and generated
  `packages/main/dist/core/codex-adapter-checks.js`; future cleanup must either
  narrow that display evidence or update source and regenerated dist together.

This document review only makes the execution plan accurate about those
non-document targets; it does not claim they are already cleaned.

## Non-Goals

- Do not add a broad `lattice codex ...` namespace.
- Do not make mistaken workflow commands succeed through backward-compatible
  aliases.
- Do not rename host-neutral Lattice commands.
- Do not remove Codex adapter diagnostics or verification commands.
- Do not convert legacy `koala` cleanup into this story unless the exact text
  creates the same host-neutral boundary violation.
- Do not claim Authority, unattended, production, or convergence readiness from
  this documentation and prompt cleanup alone.

## Execution Story Shape

Use one small Lattice story for the prompt/template cleanup. If a separate story
is already completing runtime `dist` auto-build after DONE merges, do not
duplicate that work. Treat the runtime build story as a dependency.

Suggested story title:

```text
Keep Codex command guidance limited to adapter diagnostics
```

Suggested checklist:

| Item | Intent | Likely files |
| --- | --- | --- |
| CHK-001 | Add or tighten the host-neutral command boundary in generated templates. | `packages/main/src/init-assets.ts`, generated dist output |
| CHK-002 | Remove existing tracked docs guidance that routes workflow commands through Codex wrappers. | `README.md`, `.lattice-codex/README.md`, `.codex/README.md` if tracked |
| CHK-003 | Add regression coverage for forbidden namespace guidance and allowed adapter commands. | `packages/main/src/tasks/*smoke.ts` |
| CHK-004 | Verify runtime CLI output after build/dist sync. | `packages/main/dist/**`, validation transcript |

The story should use normal Lattice lifecycle phases:

```text
INIT -> INIT_CHECK -> PLAN -> DEV -> REVIEW -> TEST -> DONE
```

## Implementation Plan

### M1. Audit Residual Guidance

Run fixed-string and regex scans over source templates, generated docs,
entrypoint docs, and adapter assets.

Required scan surfaces:

- `AGENTS.md`
- `CLAUDE.md`
- `README.md`
- `.lattice-codex/`
- `.codex/`
- `docs/`
- `packages/main/src/`
- `packages/main/dist/`

Exclude story lifecycle storage and fixtures from manual editing:

- `docs/story/**`
- `tests/fixtures/**`
- `.lattice/story/**` unless using Lattice commands

Use scans that distinguish:

- forbidden namespace forms;
- project-local main wrapper guidance;
- Codex adapter wrapper guidance;
- allowed adapter diagnostics and verification.

Important distinction:

- `lattice codex verify` and `lattice codex doctor` are allowed adapter forms.
- `node bin/lattice.js session_brief` and `node bin/lattice.js aux_doc_list`
  are allowed local workflow forms.
- Codex adapter wrapper guidance should not be used for generic workflow
  session recovery or document discovery.

### M2. Update Templates And Entrypoints

For generated templates, prefer these rules:

- Start/resume session:
  `lattice session_brief`, or `node bin/lattice.js session_brief` when a local
  project wrapper is required.
- Discover docs:
  `lattice aux_doc_list`, or `node bin/lattice.js aux_doc_list` when a local
  project wrapper is required.
- Codex adapter diagnostics:
  `lattice codex doctor`, `lattice codex_doctor`, or
  `node bin/lattice-codex.js codex_doctor`.
- Codex adapter verification:
  `lattice codex verify` or `node bin/lattice-codex.js verify_codex`.

Do not recommend Codex adapter wrappers as the first command for ordinary
workflow recovery. If heartbeat attribution is required, document it as
environment metadata on the host-neutral command rather than as a separate
workflow namespace.

### M3. Preserve CLI Rejection

Keep the CLI behavior fail-closed:

- unsupported Codex-prefixed workflow commands exit non-zero;
- the error states that the Codex adapter namespace only supports adapter
  verification and diagnostics;
- the error suggests the ordinary Lattice command.

This is a product boundary, not only a typo recovery path.

### M4. Build And Dist Sync

After source changes, rebuild the main package so runtime CLI behavior matches
source:

```bash
npm --prefix packages/main run build
```

If the DONE post-merge auto-build story has landed, verify that DONE merges
touching CLI runtime source rebuild `packages/main/dist` or fail visibly with
stale-dist recovery guidance.

### M5. Regression Tests

Add or update smoke coverage for:

- forbidden namespace forms remain rejected;
- rejected forms suggest the correct host-neutral replacement;
- allowed Codex adapter forms still resolve;
- generated templates do not contain forbidden namespace guidance;
- generated templates do not recommend Codex adapter wrappers for generic
  session recovery or document discovery.

The test should avoid broad text bans that would reject legitimate negative
tests. Scope scans to generated assets, docs, and templates, or allow explicit
test-only fixtures.

## Verification Checklist

Run these checks before REVIEW and again before DONE if dist or generated assets
changed.

### Source And Template Scans

The forbidden namespace pattern must have no business guidance hits in generated
templates, project docs, or entrypoint docs. Test files may contain negative
assertions if they clearly verify rejection behavior.

```bash
rg -n --hidden 'lattice\s+codex\s+(session_brief|aux_doc_list|story_|checklist_|validate|review_|finding_|summary_set|delivery_check_set|convergence_check)' \
  AGENTS.md CLAUDE.md README.md docs packages/main/src packages/main/dist .lattice-codex .codex
```

Expected result:

- no hits in `AGENTS.md`, `CLAUDE.md`, `README.md`, `docs/`, or generated prompt
  templates;
- hits in smoke tests are allowed only when asserting rejection/fallback output.

Local Codex wrapper diagnostics guidance must also be checked. The local Codex
wrapper forwards to the main Lattice CLI with Codex activity attribution; a bare
`doctor` argument opens the general Lattice doctor, not Codex adapter
diagnostics. Scan for that exact wrapper/argument combination and replace it
with the adapter diagnostic command.

```bash
rg -n --hidden 'lattice-codex\.js\s+doctor\b' \
  README.md docs packages/main/src packages/main/dist .lattice-codex .codex
```

Expected result:

- no business guidance hits;
- preferred replacement is `node bin/lattice-codex.js codex_doctor`;
- `node bin/lattice-codex.js verify_codex` remains valid for adapter evidence.

### Runtime CLI Behavior

Rejected workflow namespace forms must fail and name the host-neutral
replacement:

```bash
bad_prefix='lattice codex'
$bad_prefix session_brief --help
$bad_prefix aux_doc_list --help
```

Expected:

- non-zero exit;
- replacement guidance for `lattice session_brief`;
- replacement guidance for `lattice aux_doc_list`.

Host-neutral workflow commands must still work:

```bash
lattice session_brief
lattice aux_doc_list
```

Allowed Codex adapter aliases must still work:

```bash
lattice codex doctor --help
lattice codex verify --help
node bin/lattice-codex.js codex_doctor --help
node bin/lattice-codex.js verify_codex --help
```

### Build And Smoke Tests

Run at minimum:

```bash
npm --prefix packages/main run build
npm --prefix packages/main run test:legacy-koala-compatibility-smoke
npm --prefix packages/main run test:session-brief-prompt-sync-smoke
node bin/lattice.js validate --story=<storyId> --json
```

If the story touches Codex adapter assets, also run:

```bash
node bin/lattice.js verify_codex '{"storyId":"<storyId>"}'
```

## Review Checklist

Reviewers should check these points:

1. The fix does not make forbidden workflow namespace forms succeed.
2. The generated guidance teaches host-neutral Lattice workflow commands.
3. Codex adapter commands remain available only for adapter diagnostics and
   verification.
4. Runtime `dist` matches source behavior.
5. Smoke tests cover both positive adapter commands and negative workflow
   namespace commands.
6. The story does not expand scope into unrelated Koala branding cleanup,
   Authority readiness, or production claims.

## Rollback Plan

If the cleanup breaks generated assets or adapter diagnostics:

1. Revert only the template/doc/test changes from the story branch.
2. Keep the CLI rejection behavior intact if it was already correct.
3. Rebuild `packages/main`.
4. Re-run the namespace rejection checks and adapter verification checks.
5. Re-enter REVIEW with the narrower patch.

## Acceptance Criteria

The story is acceptable when all of the following are true:

- Generated prompts and entrypoint docs recommend `lattice session_brief` and
  `lattice aux_doc_list` for workflow recovery.
- Codex-specific guidance is limited to adapter diagnostics and verification.
- Forbidden namespace forms remain rejected and suggest the ordinary workflow
  command.
- Allowed Codex adapter commands still work.
- Source and dist are synchronized.
- Lattice validation passes with fresh evidence.

## No-Overclaim Boundary

This plan repairs command guidance and adapter namespace boundaries. It does not
claim full project convergence, production readiness, Authority readiness, or
unattended readiness.

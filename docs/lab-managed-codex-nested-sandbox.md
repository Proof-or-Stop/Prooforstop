# Managed Codex Nested Sandbox Repair

## Problem

Formal managed Codex reviewers already execute inside Proof-or-Stop's signed,
isolated, read-only Darwin lane. The provider launcher additionally requested
Codex `-s read-only`, causing Codex to install a second macOS seatbelt profile.
Live B-03b7 review runs reproduced `sandbox_apply: Operation not permitted`;
reviewers could not read any required artifact and their proposals were rejected
as malformed.

## Fix

For the `managed_reviewer` Codex launch profile only, request
`danger-full-access` from the nested provider process. The outer signed lane
remains the filesystem enforcement boundary. The separate
`cross_host_review_codex` profile remains `read-only`.

## Verification

- RED: `managed-host-run-process-smoke` expected the managed reviewer launcher
  to delegate isolation to the outer lane and failed on the old `read-only`
  argument.
- GREEN: `managed-host-run-process-smoke` passes with the corrected launcher.
- Isolation regression: `managed-review-scratch-isolation-smoke` passes and
  still proves detached scratch registration, immutable binding, cleanup, and
  preservation of the canonical worktree.

## Measured impact

The failing live reviewers completed zero required file reads. Removing the
nested seatbelt failure restores read-only evidence collection without adding a
second repository checkout or weakening the outer managed-review boundary.

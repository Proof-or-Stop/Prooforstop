---
name: proof-or-stop-test-case-reviewer
description: Legacy compatibility identity; not dispatchable for new stories
model: claude-opus-4-6
tools:
  - Read
  - Bash
  - Glob
  - Grep
---

# Legacy compatibility identity

This prompt is retained so historical role values and prompt assets remain
readable. It is not dispatchable for a new Story and has no mutation or
evidence ownership.

Current PLAN intent authoring uses
`proof-or-stop-verification-intent`; current REVIEW coverage uses
`proof-or-stop-review-test-coverage`. Do not use this identity to write new
evidence or checklist status.

---
name: proof-or-stop-review-docs
description: REVIEW review: documentation-code consistency (narrowed input: only review documentation sections referenced by symbols changed in the diff)
model: sonnet
tools: Read, Grep, Glob, Bash
---
Proof-or-Stop selects this reviewer role body at runtime.
FIRST run: `proof-or-stop review_run_start '{"storyId":"<storyId from dispatch>","agent":"proof-or-stop-review-docs"}'`.
Follow only the exact prompt returned by that command; this bootstrap intentionally contains no role body.

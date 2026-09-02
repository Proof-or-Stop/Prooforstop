---
name: proof-or-stop-review-concept
description: REVIEW review: concept deletion completeness (grep scan for residuals)
model: sonnet
tools: Grep, Glob, Bash
---
Proof-or-Stop selects this reviewer role body at runtime.
FIRST run: `proof-or-stop review_run_start '{"storyId":"<storyId from dispatch>","agent":"proof-or-stop-review-concept"}'`.
Follow only the exact prompt returned by that command; this bootstrap intentionally contains no role body.

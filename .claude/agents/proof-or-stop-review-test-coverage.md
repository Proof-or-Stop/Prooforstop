---
name: proof-or-stop-review-test-coverage
description: REVIEW phase reviewer that audits coverage between verificationIntent and verificationEvidence
model: sonnet
tools: Read, Glob, Grep, Bash
---
Proof-or-Stop selects this reviewer role body at runtime.
FIRST run: `proof-or-stop review_run_start '{"storyId":"<storyId from dispatch>","agent":"proof-or-stop-review-test-coverage"}'`.
Follow only the exact prompt returned by that command; this bootstrap intentionally contains no role body.

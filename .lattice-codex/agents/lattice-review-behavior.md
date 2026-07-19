---
name: lattice-review-behavior
description: REVIEW review: functional correctness (userSees vs actual behavior + edge cases)
model: sonnet
tools: Read, Grep, Glob, Bash
---
Proofbound selects this reviewer role body at runtime.
FIRST run: `lattice review_run_start '{"storyId":"<storyId from dispatch>","agent":"lattice-review-behavior"}'`.
Follow only the exact prompt returned by that command; this bootstrap intentionally contains no role body.

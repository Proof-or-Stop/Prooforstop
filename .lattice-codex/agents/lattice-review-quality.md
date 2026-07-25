---
name: lattice-review-quality
description: REVIEW audit: code quality (dead code / type safety / I/O isolation)
model: sonnet
tools: Read, Grep, Glob, Bash
---
Proofbound selects this reviewer role body at runtime.
FIRST run: `lattice review_run_start '{"storyId":"<storyId from dispatch>","agent":"lattice-review-quality"}'`.
Follow only the exact prompt returned by that command; this bootstrap intentionally contains no role body.

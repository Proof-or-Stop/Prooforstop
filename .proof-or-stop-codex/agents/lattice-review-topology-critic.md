---
name: lattice-review-topology-critic
model: sonnet
description: Independent ProofStory acceptance-topology critic
tools: Read, Grep, Glob, Bash
---
Proofbound selects this reviewer role body at runtime.
FIRST run: `proof-or-stop review_run_start '{"storyId":"<storyId from dispatch>","agent":"lattice-review-topology-critic"}'`.
Follow only the exact prompt returned by that command; this bootstrap intentionally contains no role body.

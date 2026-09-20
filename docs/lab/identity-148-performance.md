# Identity #148 timing and duplicate scheduling

This local Lab depends on original validation repair candidate `7e866ee7f9`.
It is not Story DONE or main integration evidence.

- The real check dispatcher now reports monotonic phase durations on stderr while preserving success, failure and group filtering. The regression executed the actual dispatcher and reproduced zero timing records before the fix, then passed success, failure and skip controls.
- Seven F-060 callbacks were scheduled in both identity-cutover and its mandatory nested identity-sites group. The repair removes only their outer registration; all seven callback bodies and independent identity-sites execution remain unchanged. A scheduling regression executes the actual dispatcher and checks unchanged callback digests against the dependency candidate.
- The exact dispatcher selector contract is updated after checking unchanged filtering semantics. Existing selector, callback-gate, entrypoint, child-group and witness mutation controls still reject drift. The static inventory passes with no review-needed or unexpanded commands; no execution exception was added.
- The first instrumented full diagnostic ran 259 mutation cases but failed nested static validation because the old dispatcher pin was stale. Preserve it as failed evidence, never full GREEN. That run measured 188.589 seconds for the combined active-boundary refusal check and 41.492 seconds for the seven outer F-060 callbacks.
- Full candidate replay remains required. Timing comparisons under concurrent validation are diagnostic, not controlled speedup evidence. Cross-run verifier reuse and snapshot omissions are not enabled. The child-deadline supervisor remains an external prototype and is not integrated.

Evidence and current execution state:
`/Users/jek/Documents/GitHub/Prooforstop/.git/lab-evidence-archives/identity-148-performance-20260920/`.

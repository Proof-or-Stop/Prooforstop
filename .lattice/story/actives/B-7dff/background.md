## Trigger Event

On 2026-08-17 a latency audit of lattice done_prepare measured its wall time from .lattice/activity.jsonl start/end pairs (n=31 runs with validate=true) and split it against done-required-evidence.json receipts. August runs took 1043-4142s. Joining the receipts that fall inside a done_prepare window shows DONE-required validation is only 11-16% of it: B-3434 on 2026-08-16 spent 307s of 1959s there, B-d0b8 on 2026-08-16 spent 247s of 2238s. The remainder is the routine lattice validate step plus git/gate phases.

## Key Insights

The same repository already solved this problem once, for the other suite. Commit c3b8da2c76 (2026-08-12, "enforce auditable keyed parallel suite") moved npm test onto runScheduled with declared resource claims across five classes (git-common-dir, fixed-path, fixed-port, runtime-lock, main-write-lock) and a 4-worker default; the runner records historicalSerialMs 1688918 against a 300000ms enforced budget. The measured effect is visible in the receipt time series: the suite fell from 1368-1533s in late July to a stable 215-296s from 2026-08-13 onward. Routine validate never received the same treatment and is still a sequential for-loop, so it inherited the position of bottleneck.

Per-command evidence already exists and does not need new instrumentation: test-evidence.json stores output.commands[] with durationMs, code, timeoutMs per command. That profile shows a long tail (78 of 99 commands finish under 5s, summing to only 105s) dominated by a handful of slow ones, which is the shape where list scheduling helps most, and it also exposes the ceiling: quorum-submit-smoke.js at 267-271s is 31% of the total on its own.

## Solution Tradeoffs

Option A, extract and reuse the full-suite scheduler: one admission-control implementation, one set of resource-class semantics, and the collision probes in full-suite-resource-sentinel keep covering both callers. Cost is an extraction refactor of task-local code into core, and the risk of perturbing a suite that was stabilised only days ago.

Option B, write a second scheduler local to validation-executor: no risk to npm test, but two divergent notions of what may run concurrently, and the resource-collision guarantees would have to be re-proven separately. Rejected as a duplicated invariant on the evidence path.

Option C, leave it sequential and only reorder done_prepare so cheap gates run before validation: cheaper and genuinely useful, but it does not reduce the cost of a validate run that actually has to happen, and every REVIEW->TEST gate still pays the full 858s. Complementary, not a substitute.

The declaration default is the load-bearing choice. Defaulting an undeclared command to shared/parallel would silently corrupt evidence the first time two commands touched the same .lattice path; defaulting to exclusive only costs latency for commands nobody has classified yet.

## Conversational Texture

The audit started from a plain operator question about how long done_prepare takes and whether anything could be parallelised. The first assumption checked and discarded was that routine validate and npm test were largely running the same tests twice; resolving both command lists down to their script leaves found only four shared entries, so duplication is not the story. The second discarded reading was that the growth from roughly 40s in June to over 1500s in August was suite growth alone; the sharp drop on 2026-08-13 with no membership change points at scheduling, not size. What made the case concrete was that the saving is bounded and measurable rather than aspirational: 858s serial, 271s floor, 3.17x, and the floor has a name.

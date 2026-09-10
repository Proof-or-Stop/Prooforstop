# Historical managed-run duration estimates

Managed status JSON exposes `durationEstimate`; text status labels it
`eta=historical_estimate` or `eta=unavailable`. The hard `deadlineAt` remains
separate. The estimate reports historical median and P90 duration, sample count,
sample run IDs, and the median-based estimated terminal time. It is a description
of comparable successful runs, not a guarantee about the current run. If the
estimate's time has passed, it remains a past historical estimate; it neither
claims imminent completion nor extends the actual deadline.

Submission samples local history once before sealing the immutable spec. Status,
long polling, aggregate waits and heartbeats read that snapshot and never rescan
history. The estimate does not increment generation, count as provider progress,
or grant completion, replacement or review authority. Later GC of historical
runs does not rewrite an already-sampled estimate.

A sample must match host, phase, agent type, profile and lane. Only completed,
replacement-safe runs with intact sealed artifact bindings and consistent owner
and snapshot records qualify. Failed, timed-out, cancelled, future-dated,
nonpositive, over-30-day and corrupted observations are excluded. At least five
comparable samples are required; up to twenty recent qualifying observations
within the bounded scan determine the descriptive quantiles. Other agents,
adapters or profiles cannot substitute for missing history. Old specs without an
estimate explicitly report unavailable.

The collector examines at most 256 directory entries, at most 16 MiB of candidate
artifact sizes, and no artifact larger than 1 MiB. Its 200 ms target is checked
between candidates, so it is not a hard deadline on synchronous filesystem IO.
Binding checks can reread artifacts; the byte limit describes candidate sizes,
not physical read bytes. Directory order is not guaranteed to be chronological;
this bounded local sample is not the globally latest twenty runs. Large or
unreadable histories can therefore produce unavailable. Optional history and
directory-close failures never prevent submitting the actual run.

No UI delivery SLA or reduction in user follow-up questions is established by
this estimator. Terminal notification delivery and its cohort measurements are
separate U-13 work. Synthetic-clock regressions verify grouping and arithmetic;
they are not production duration measurements.

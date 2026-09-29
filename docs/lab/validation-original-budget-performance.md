# Complete validation and the authorized Lab budget

## Current production and Lab budget, 2026-09-20

The explicit follow-up authorization raises the three production registrations to
260000 ms, integrated on main at 3a404ce2d1. The original Lab now consumes those
same registrations. Its 260000-ms acceptance threshold cannot exceed their
production timeout, enforced by `validation-audit-budgets.test.mjs`. Historical
180-second results below remain historical and are not relabeled.

## Historical Lab-only acceptance amendment, 2026-09-19

The user explicitly replaced the 180-second Lab acceptance threshold with
260 seconds for complete targets 16, 69 and 130. The tracked local contract is
`docs/lab/validation-audit-acceptance.json`. This is an acceptance-budget change,
not evidence of further performance improvement or a claim that the former
180-second target was met. Production validation command timeouts are unchanged;
this amendment applies to the Lab measurement and finish replay only.

The original driver, its hashes, and all historical RED/GREEN observations stay
unchanged. The replacement driver is retained under the Git common directory at
`lab-evidence-archives/validation-audit-20260918/remaining-performance-20260918/finish/budget-260/verify-authorized-lab-budget.mjs`.
Its command is registered through the official Lab RED handler. The new target
RED is the actual 180000-ms setting failing the explicitly requested 260000-ms
configuration assertion. GREEN then requires the committed setting plus two
fresh serial runs of each complete target. Commands, selectors, semantic checks,
isolated fixture namespace, diagnostic execution caps and result recording
remain identical. This configuration RED must not be presented as a performance
RED against 260 seconds. No historical failure is relabeled as success.

## Historical 180-second experiment

This local Lab repair covers validation inventory entries 16, 69 and 130. The
original acceptance condition required complete runs within 180 seconds. The prior
900-second configuration permitted complete diagnosis but did not establish a
performance repair. The retained pre-change measurement runs each complete
command twice, serially, in the same private fixture machine namespace, and
requires successful semantic completion before comparing elapsed time with the
original threshold. It records the committed source, exact argv, load averages,
CPU/memory facts, output and exit status. Timeout or missing completion output
is unavailable proof, never the expected performance RED.

The process-fact verifier retains its early runtime-admission refusal barrier.
After that barrier it starts two independent lanes: the actual inventory critic
fixture, and the existing five consumers followed by all three acceptance
closure fixtures. Every child keeps its executable, argv and timeout. Async
execution allows the two disposable workloads to overlap while each timeout
and output drain remains active. Both lanes must settle; failures propagate,
and the final success marker requires nine actual successful completions.
No partial selector, cached assertion result or skipped child supplies a pass.
Output markers and diagnostics remain available; independent output order may
change. The three production command budgets were restored to 180000 milliseconds.
The later user-authorized Lab threshold is described above.

During finish, repeated complete measurements at candidate `6d92619bb4`
exposed insufficient margin: the latest fixed-candidate pair took
186.918/191.068 seconds for #16, 190.446/181.233 for #69, and
184.089/173.565 for #130. All six semantic suites completed successfully;
five exceeded the unchanged 180-second threshold. Neither this failed replay
nor the intervening 176.080-second observer diagnostic is recorded as GREEN.

The follow-up overlaps only the existing reviewer-read and maintenance-preview
boundary subprocesses at their original execution point. They own separate
mkdtemp roots and child-local sessions; shared build reuse still verifies the
current source and output bindings. Each keeps its exact executable, argv,
450-second outer bound and completion selector. Both results settle before
the parent continues, and either failure remains a parent failure. This does
not overlap these children with the later nine-proof group, alter their setup
or body budgets, cache assertions, or change machine-capacity policy.
The actual callback has real success, nonzero exit, missing-selector, timeout,
restored-success and failed/slow-peer drainage controls. The actual admission
mutations must also launch neither boundary subprocess. Fresh complete
measurements, rather than this design description, determine performance PASS.

The admission-order regression observes real synchronous and asynchronous
launches. Both actual invalid-admission mutations must refuse before any
positive workload starts. Separate real child controls exercise the actual
completion callback for success, nonzero exit despite a success marker, missing
selector, timeout and restored success. Failed children cannot increment the
completion count. Reviewed static evidence binds the changed launch sites and
all dependencies; exact identity fixture contexts retain their original token
counts and line bytes.

Before/after measurements and the signed local Lab command record are retained
outside the checkout under the Git common directory's
`lab-evidence-archives/validation-audit-20260918/remaining-performance-20260918/`.
They are bounded maintenance evidence, not Story DONE or release approval.
The measurement driver repeats all three complete registered targets twice;
one driver invocation therefore contains six complete target executions.

# Lab validation-verdict-stickiness

Opened 2026-09-20 from a RED reproduction: a validation PASS on an identity that an
earlier executed run had FAILED on was admitted as fresh evidence. RED marker:
`stale verdict admitted after a failure on the same identity`
(`scripts/verify-validation-verdict-stickiness.mjs`).

## Measured before

`node scripts/report-validation-verdict-flips.mjs --legacy`, run on this repository on
2026-09-20. Every recorded `validation_terminal` predates the compiled-artifact
binding (first 2026-07-17, last 2026-09-16), so all of them are grouped per Story by
the three-part identity they carry: command set, committed material, story files.

| Measure | Count |
|---|---|
| Stories that recorded a validation terminal | 97 |
| Validation terminals (executed / reused) | 928 (707 / 221) |
| Identities | 639 |
| Identities executed more than once | 62 |
| Redundant executions | 68 (51 after a failure, 17 after a pass) |
| Identities with both a failure and a pass | 26 |
| A failure followed by another execution that passed | 26 identities |
| A failure followed by a REUSED pass, nothing executed | 44 identities, 83 reused passes |
| A failure that stopped counting with nothing changed (either) | 60 identities in 41 Stories |

Order of the re-executed identities: fail-pass 23, pass-pass 17, fail-fail 17,
fail-fail-fail 2, fail-pass-fail-pass 1, fail-pass-pass 1, fail-pass-fail 1. In nine of
the 44 reuse cases the reused pass was reported within two minutes of the failure.

Those terminals record neither the compiled artifacts that executed nor why a run
failed, so the history cannot say how many of these failures were infrastructure
failures or ran different compiled bytes. No terminal has been recorded since the
artifact binding landed (0.3.427, 2026-09-20), so there is no measurement after it
yet; the same command without `--legacy` reports it once Stories validate again.

## What changed

- The rule (`core/validation-verdict-stickiness.ts`): an EXECUTED terminal with
  `result: fail` on an identity — command set, committed material, story files and
  compiled artifacts — makes any PASS on that identical identity a flipped verdict,
  whichever came first. Infrastructure failures, reused terminals and terminals
  without the compiled-artifact identity do not stick. Neither does a coverage-only
  failure (`coverage_incomplete`): every required command passed and only required
  verification coverage was missing (`isCoverageOnlyFailure`, read from the record
  about to be published). Every failure the reuse evaluator can republish as a PASS
  once coverage is complete is of this kind; one beside a failed OPTIONAL command is
  too, though its record is not reusable and only a fresh run can recover it. A
  failure that recorded no failure kind is a verdict.
- Four consumers apply it: routine reuse (`verdict-flip-unattested`), evidence
  admission and the DONE-side stored-PASS consumer (`verdict_flip_unattested`), and
  publication (`verdict_flip_refused`). Reuse judges every candidate it can republish
  as a PASS, a coverage-only FAIL included. Both publications - the executed one and
  the reused one, which signs an older record as a fresh PASS without executing
  anything - read one shared refusal (`passPublicationRefusal`). A refusal is a
  persistence failure, so it does not itself become a sticky verdict.
- `validation_terminal` events record `failureKind`, and only failing terminals have
  one. It is derived from the executor's command outcomes
  (`classifyValidationTerminalFailure`), never from a kind the result carries or the
  child prints: infrastructure only when infrastructure is ALL that failed, so a real
  command failure, a failed semantic verdict or blocking worktree pollution beside a
  timeout is still a verdict; coverage-only under the evaluator's predicate; a failure
  nothing explains is a verdict. The signed evidence keeps its own aggregate kind.
- Every recorded run carries its full identity. A Story run whose routine identity
  cannot be built is refused before it launches (`validation_identity_unavailable`);
  it used to execute unbound and record its failure under a fallback digest no later
  identity could match. That fallback is gone: a terminal's command set is the routine
  identity digest. Publication binds a failure as completely as a PASS and refuses any
  result whose material or story files cannot be identified; the terminal writer takes
  that validated identity and looks nothing up again, where it used to recompute the
  hashes and write empty strings when a lookup failed. The material and the story
  files are identified before launch and kept with the identity, so a lookup that
  fails only after the commands ran falls back to them and the executed verdict is
  still recorded. A validate file's printed provider result is normalized without ever
  throwing (`normalizeValidatorResult`, total by construction): one that does not
  parse, whose fields are not of the types the pipeline coerces, that is nested deeper
  than 64 levels or that cannot be serialized again is a recorded validation failure,
  not an exception between the command and its record. Before that, the whole output
  is classified by a closed rule (`classifyValidatorOutput`): the protocol's own key
  names - `provider`, `allPass`, `allPassed`, as JSON keys with escapes decoded - mark
  an attempt wherever they occur; the output is a result only when it holds exactly one
  complete top-level object carrying such a key and no marker outside it; any other
  output that names one - truncated, malformed, repeated, followed by another attempt -
  is a recorded failure; output that names none is plain text for the exit-code wrapper. Admission refuses a stored PASS without its
  identity (`validation_identity_incomplete`); terminals from before the artifact
  binding stay valid history and are simply never matched.
- History is `{ terminals }` or `{ unreadable }`. Only a confirmed absence (`ENOENT`)
  is an empty history. A directory that cannot be located, a denied or non-directory
  lookup, a file that cannot be read, a line that is not a process event (a JSON object
  with a type), a validation terminal whose result or disposition is unknown, or an
  executed failure that claims the compiled-artifact identity without carrying all of
  it is unreadable - a failure that cannot count proves nothing either - and reuse (`validation-history-unreadable`), admission
  (`validation_history_unreadable`) and publication all refuse. Every one of this
  repository's 410 Story directories reads cleanly under it (928 terminals).
- `done_prepare` trusts the reused terminal the verifier appends again: its exact key
  allowlist had not followed the artifact binding. The artifact fields are typed (a
  sha256 digest and a satisfied protection label) and, when `done_prepare` knows the
  reused evidence's identity and protection, bound to exactly those values. The reuse
  path now writes both onto the terminal it appends; it used to omit the protection.
- `scripts/report-validation-verdict-flips.mjs` is read-only. It groups per Story and
  full identity, counts re-executions, flips and a failure followed by an executed or
  a reused pass in log order, reads a Story's own linked worktree copy as well as the
  checkout's, and keeps terminals without the compiled-artifact identity in a separate
  `--legacy` block.

## Verification

Two registered commands, the last two `validate.commands` entries.
`node scripts/verify-validation-verdict-stickiness.mjs` (112 checks, about 5 seconds, the
Lab's RED command) covers the pure rule, both core consumers, the DONE-side consumer
over a fixture Story with signed evidence, corrupt, missing, denied and malformed
histories, the failure classifier, what marks an attempt at a structured validator
result, the report, the `done_prepare` trust decision, the scheduler conflict and the
source guards.
`node scripts/verify-validation-verdict-stickiness-cli.mjs` (70 checks; about 160
seconds on a quiet machine, twelve minutes when every fixture run queued behind other
sessions for the machine's validation capacity; a 900-second budget) runs the built
CLI on disposable fixture projects; it
reserves `packages/main/dist` shared, so it cannot be scheduled beside a rebuild of the
tree it executes. Their six child-process call sites - four runs of the read-only
report and two of the built CLI, all on fixture repositories in a sandbox - are
reviewed in the static-edge manifest (`EX-VERDICT-STICKINESS-01` to `-06`), whose
configuration digest and the dependency digests of the entries that read the
configuration or the two changed handlers are refreshed; `verify-validation-static-edges`
reports `U18_STATIC_PASS` with 1698 exceptions, the 1692 of main and these six.

At RED: 7 failing expectations, 9 controls passed. At GREEN every expectation of both
commands holds. The end-to-end runs use a validate file that reads a switch outside the
repository: FAIL then PASS on
the identical identity is refused with `verdict_flip_refused` and publishes no PASS, a
spoofed `infra_failure` still sticks, PASS then PASS succeeds, the terminal the real
reuse path appends is the one `done_prepare` trusts, a real coverage-only failure
records `coverage_incomplete`, a genuine coverage-only failure still recovers by reuse,
a failed identity laundered through a coverage-only record is refused, a real failure
beside a timeout in a two-command plan sticks and refuses the retry, and an
infrastructure-only timeout is classified alike in evidence and terminal and recovers
on unchanged inputs, a coverage gap beside a failed optional command records
`coverage_incomplete` and recovers by a fresh run on the unchanged identity once a
waiver completes coverage, an identity that cannot be built refuses instead of
returning null, and a plain-text run publishes nothing. With the production source of
an audit's repair reverted, exactly that audit's expectations fail: 10 for the second
(the laundered PASS among them, `exit=0 evidence=PASS/reused`), 12 for the third (the
mixed failure recorded as `infra_failure` among them), 6 for the fourth (the recovery
refused with `verdict_flip_refused` among them), 5 for the fifth, 4 for the sixth (a
failing run with malformed validator output that left no record among them), 4 for the
seventh, 2 for the eighth and 8 for the ninth (a printed failure with exit code zero
and a numeric provider published as `exit=0 evidence=PASS` among them), 6 for the tenth
and 3 for the audit that `finish` ran.

On the final Lab tree the checks that share these code paths pass:
`validation-evidence-reuse-smoke` (its coverage-only recovery included),
`validation-reuse-merge-lineage-smoke`, `verify-validation-terminal-refusal-reasons`,
`verify-reuse-lineage-material-policy`, `verify-reuse-host-session-environment`,
`verify-validation-build-artifact-binding`, `verify-dynamic-test-admission`,
`verify-acceptance-amendment-gates` and the process-fact contract. Of the twenty
verifier scripts that read the changed sources, nine fail, and each fails on untouched
main `0839f9ab0c` with the same first assertion: `verify-declared-environment-receipt`,
`verify-dynamic-fallback-once`, `verify-final-validation-full-plan`,
`verify-historical-receipt-provenance`, `verify-material-hash-resource-plan`,
`verify-proof-or-stop-identity-cutover`, `verify-replacement-receipt`,
`verify-revert-receipt` and `verify-validation-reuse-proof`. So do the four smokes
`done-prepare-auto-closeout`, `done-prepare-closure-heartbeat`,
`done-prepare-merge-rerun` and `validate-execution-lock`. None of them is changed,
repaired or relabelled here.

## Independent audit

The first cross-vendor audit (of `e15d2ffe8c`) was discarded by the Lab tool for an
invalid result shape; its five findings were read from the auditor's output stream and
repaired in `01661fdb26`: the flip was refused only when stored evidence was evaluated
and not at publication (high); the failure kind was copied from what the child printed
(high); an unreadable history read as an empty one (high); the reused-terminal
allowlist accepted the artifact fields by name only (medium); the report merged two
Stories that shared an identity (medium).

The second audit (of `ef02f935e2`, rejected) found two more, repaired together: reuse
checked the history only for a record claiming PASS, so a coverage-only FAIL - which
the evaluator republishes as a PASS once coverage is complete - bypassed both the
sticky failure and the unreadable history, and the reused publication had no check of
its own (high); and the terminal the real reuse path appends lacked the protection
label the new trust predicate requires, which the regression had hidden by building
that terminal by hand (medium). Repairing the first exposed that a coverage-only
failure would itself have stuck and refused the recovery it exists for; it is now its
own failure kind.

The third audit (of `29b65afbdc`, rejected) found four, repaired together: a missing
identity disabled the publication refusal and an identity-less stored PASS was admitted
(high); the aggregate kind called a run infrastructure when one command timed out
beside a real failure, which exempted that failure from stickiness (high); the terminal
took its kind from the result, so a producer that carries the kind only on command rows
left an infrastructure-only timeout sticky (medium); and the history reader took a
denied or non-directory lookup for an absent file and accepted any JSON object as an
event (medium).

The fourth audit (of `52b41f541a`, rejected) found three. A failing run whose identity
could not be built still executed and recorded a terminal under a fallback digest, so
the unchanged retry did not match it (high): such a run is now refused before launch
and the fallback is removed. The coverage-only classification borrowed the reuse
predicate, which also demands no optional failure, so a coverage gap beside a failed
optional command stuck forever (medium): classification and reuse eligibility are now
separate. And a plain-text validate-file run records nothing (medium): that is the
existing contract of that mode, not a gap in this rule - it publishes no PASS either,
so there is nothing to flip - and it is now stated at the branch, pinned by a
regression and listed under the limitations instead of changing what the mode does.

The fifth audit (of `9257ddcf0d`, rejected) found one (high): the terminal writer
recomputed the material and story-files hashes and wrote empty strings when a lookup
failed, so fully bound FAIL evidence could leave a terminal no identity matched, and
the reader skipped it. The writer now records the identity its publication validated,
a failure is refused publication without it, and such a terminal is unreadable history.

The sixth audit (of `04a604e8be`, rejected) found two ways an executed failure left no
record (both high): a material or story-files lookup that failed only after the
commands ran refused the publication and dropped the verdict, and a failing validate
file that printed unparsable provider JSON threw before anything was persisted. The
run is now bound before launch with a fallback at publication, and malformed output is
a persisted validation failure.

The seventh audit (of `1e11b0bd45`, rejected) found that output which parses but whose
status cannot be coerced to a string still threw before the record (high), and that the
report deduplicated lines before resolving the Story, so identical legacy lines in two
Story directories collapsed into one (medium). Normalization now validates every field
the pipeline coerces, and the report keys a copy by Story and line.

The eighth audit (of `c679871e99`, rejected) found one (medium): a list entry nested
thousands of levels deep parses and then overflows the stack when normalization
serializes it. Normalization is now total - any exception is the structured failure -
bounds nesting iteratively and proves the whole result serializable before returning
it. Through the built CLI that payload was already recorded as a failure before this
repair, so the end-to-end case is a control and the defect was in the function alone.

The ninth audit (of `380bd2e4f3`, rejected) found three. A structured candidate was
recognized only when its provider was already a non-empty string, so a printed FAILURE
with exit code zero and a numeric, empty or object-valued provider fell through to the
exit-code wrapper and was published as a PASS (high): a candidate is now anything that
names a provider. The dynamic-authority callers pass their aggregate verdict in the
semantic parameter, which the classifier read as an independent semantic rejection and
so made an infrastructure-only dynamic run a verdict (medium): the classifier is told
when that parameter is an aggregate, which is covered at the classifier and by a source
guard, not by a dynamic-authority fixture. And the regression executed the compiled CLI
without reserving `packages/main/dist` (medium): the end-to-end runs are now their own
command with that reservation and a budget that fits them.

The tenth audit (of `5e56a72353`, rejected) found two (both high): whether the semantic
argument is an aggregate was read from a field a validate file can print, and a
structured result was recognized by the literal text of its provider key, which JSON
lets a validate file write with escapes. The origin now reaches the classifier from the
two dynamic-authority callers through a registry of result objects, a printed dynamic
block is discarded, and a result is recognized from its parsed keys.

The audit that `finish` ran on the prepared 0.3.435 candidate (rejected, candidate
reopened) found one (high): a provider result truncated before its closing brace, or
one that names `allPass` but no provider and does not parse, was still plain text and
passed on exit code zero. An attempt at a structured result is now marked by the
protocol's own key names - `provider`, `allPass`, `allPassed` - in the parsed object or,
where the output does not parse or is truncated, in its text with JSON escapes decoded.
The tenth repair had also taken `status` for a marker, which would have failed every
plain-text validate file whose log prints a JSON object; that is withdrawn, and both
directions are checked as a pure function in the first command.

The second audit that `finish` ran (rejected, candidate reopened) found that detection
still looked at one span: an ordinary object, or a complete passing result, followed by
a truncated failing one was accepted (high). That was the fourth finding about the shape
of a validate file's output, so the detection is no longer a list of shapes but the
closed rule above, over the whole output.

## Limitations

- Any commit changes the committed material and releases the stickiness. The rule
  stops re-running the same thing until it passes, not re-running after a change —
  the boundary every freshness binding here has. There is no override command.
- A re-run after a verdict failure on an identical identity still executes, and only
  its PASS is refused. That is deliberate: reproducing a failure is the first step of
  debugging it, so the run and its output stay available. The executions that followed
  a failure (51 of the 68 measured above) are therefore not removed by this Lab; the
  verdict they could flip is.
- A command the executor kills at its deadline is infrastructure, so a test that hangs
  forever is retried, not stuck; only a command that ran to a failing exit is a verdict.
- The rule covers a Story's routine validation evidence (`test-evidence.json`) and the
  terminals that record its runs, which only a `validate --story=<id> --json` run
  publishes. A focused run and a plain-text validate-file run are dry runs: they
  publish neither, so they neither stick nor count, exactly like running the command
  by hand. DONE-required validation receipts and per-intent verification receipts keep
  their own bindings and are not changed here.
- Only a published run is a verdict of record. A publication that is refused - the
  Story's metadata was already dirty, the record exceeds its size bound, the compiled
  artifacts moved, the metadata commit failed - writes neither evidence nor terminal
  and leaves the metadata as it was: it publishes no PASS, and the next run is judged
  against the same history. That is the standing of running the commands by hand, and
  this Lab does not change it; what can be bound is bound before launch instead.
- A validate file that does not speak the provider protocol is judged by its exit code,
  as it always was. Output that names none of `provider`, `allPass` or `allPassed` is
  plain text - the key `status` alone marks nothing, because ordinary logs print it -
  so a validate file that prints a bare `{"status":"fail"}` and exits zero still
  passes. Treating such output as a failed attempt would fail every plain-text
  validator whose log happens to contain a JSON object.
- The history is the Story's process-events file. Like every other lifecycle fact it is
  protected by the repository's metadata transaction and review, not by this rule: an
  actor who rewrites that file can remove a failure from it.

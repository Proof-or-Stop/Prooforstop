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
  verification coverage was missing, which is the one failure the reuse evaluator
  republishes as a PASS once coverage is complete. The producer classifies it with
  the evaluator's own predicate (`isCoverageOnlyFailure`), from the record it is about
  to publish. A failure that recorded no failure kind is a verdict.
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
- A PASS must carry its full identity. Publication refuses one whose identity cannot
  be formed (`validation_identity_unavailable`) and admission refuses a stored one
  (`validation_identity_incomplete`); terminals from before the artifact binding stay
  valid history and are simply never matched.
- History is `{ terminals }` or `{ unreadable }`. Only a confirmed absence (`ENOENT`)
  is an empty history. A directory that cannot be located, a denied or non-directory
  lookup, a file that cannot be read, a line that is not a process event (a JSON object
  with a type) or a validation terminal whose result or disposition is unknown is
  unreadable, and reuse (`validation-history-unreadable`), admission
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

`node scripts/verify-validation-verdict-stickiness.mjs`, registered as the last
`validate.commands` entry. At RED: 7 failing expectations, 9 controls passed. At GREEN:
108 checks — the pure rule, both core consumers, the DONE-side consumer over a fixture
Story with signed evidence, corrupt and missing histories, the report, the
`done_prepare` trust decision, source guards, and end-to-end runs through the built
CLI on a validate file that reads a switch outside the repository: FAIL then PASS on
the identical identity is refused with `verdict_flip_refused` and publishes no PASS, a
spoofed `infra_failure` still sticks, PASS then PASS succeeds, the terminal the real
reuse path appends is the one `done_prepare` trusts, a real coverage-only failure
records `coverage_incomplete`, a genuine coverage-only failure still recovers by reuse,
a failed identity laundered through a coverage-only record is refused, a real failure
beside a timeout in a two-command plan sticks and refuses the retry, and an
infrastructure-only timeout is classified alike in evidence and terminal and recovers
on unchanged inputs. With the production source of an audit's repair reverted, exactly
that audit's expectations fail: 10 for the second (the laundered PASS among them,
`exit=0 evidence=PASS/reused`) and 12 for the third (the mixed failure recorded as
`infra_failure` among them).

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
  terminals that record its runs. A focused run publishes neither, so it neither sticks
  nor counts; DONE-required validation receipts and per-intent verification receipts
  keep their own bindings and are not changed here.
- The history is the Story's process-events file. Like every other lifecycle fact it is
  protected by the repository's metadata transaction and review, not by this rule: an
  actor who rewrites that file can remove a failure from it.

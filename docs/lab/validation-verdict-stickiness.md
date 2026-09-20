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
  without the compiled-artifact identity do not stick. A failure that recorded no
  failure kind is a verdict. The rule applies only to a record that claims a PASS.
- Four consumers apply it: routine reuse (`verdict-flip-unattested`), evidence
  admission and the DONE-side stored-PASS consumer (`verdict_flip_unattested`), and
  publication, which refuses to write the PASS and reports `verdict_flip_refused`.
  That refusal is a persistence failure, so it does not itself become a sticky verdict.
- `validation_terminal` events record `failureKind`. The validate-file path strips a
  kind printed by the child and derives it from the executor's verdict, so a validate
  file cannot exempt its own failure by printing `infra_failure`.
- History is `{ terminals }` or `{ unreadable }`. A Story with no process-events file
  has an empty history; a directory that cannot be located, a file that cannot be read
  or a line that is not a process event is unreadable, and reuse
  (`validation-history-unreadable`), admission (`validation_history_unreadable`) and
  publication all refuse.
- `done_prepare` trusts the reused terminal the verifier appends again: its exact key
  allowlist had not followed the artifact binding. The artifact fields are typed (a
  sha256 digest and a satisfied protection label) and, when `done_prepare` knows the
  reused evidence's identity and protection, bound to exactly those values.
- `scripts/report-validation-verdict-flips.mjs` is read-only. It groups per Story and
  full identity, counts re-executions, flips and a failure followed by an executed or
  a reused pass in log order, reads a Story's own linked worktree copy as well as the
  checkout's, and keeps terminals without the compiled-artifact identity in a separate
  `--legacy` block.

## Verification

`node scripts/verify-validation-verdict-stickiness.mjs`, registered as the last
`validate.commands` entry. At RED: 7 failing expectations, 9 controls passed. At GREEN:
60 checks — the pure rule, both core consumers, the DONE-side consumer over a fixture
Story with signed evidence, corrupt and missing histories, the report, the
`done_prepare` trust decision, source guards, and an end-to-end run through the built
CLI on a validate file that reads a switch outside the repository: FAIL then PASS on
the identical identity is refused with `verdict_flip_refused` and publishes no PASS, a
spoofed `infra_failure` still sticks, and PASS then PASS succeeds.

On the final Lab tree the checks that share these code paths pass:
`validation-evidence-reuse-smoke`, `validation-reuse-merge-lineage-smoke`,
`verify-validation-terminal-refusal-reasons` (32 checks) and the process-fact contract.
`done-prepare-merge-rerun-smoke` stops in the story-owner-lease heartbeat
(`validation owner lease lost, expired, or transferred`) before it reaches code this
Lab changes, and `done-prepare-auto-closeout-smoke` fails on untouched main with the
same `review_loop_record_error` expectation mismatch it shows here.

## Independent audit

The first cross-vendor audit (of `e15d2ffe8c`) was discarded by the Lab tool for an
invalid result shape; its five findings were read from the auditor's output stream and
repaired in `01661fdb26`: the flip was refused only when stored evidence was evaluated
and not at publication (high); the failure kind was copied from what the child printed
(high); an unreadable history read as an empty one (high); the reused-terminal
allowlist accepted the artifact fields by name only (medium); the report merged two
Stories that shared an identity (medium).

## Limitations

- Any commit changes the committed material and releases the stickiness. The rule
  stops re-running the same thing until it passes, not re-running after a change —
  the boundary every freshness binding here has. There is no override command.
- A re-run after a verdict failure on an identical identity still executes, and only
  its PASS is refused. That is deliberate: reproducing a failure is the first step of
  debugging it, so the run and its output stay available. The executions that followed
  a failure (51 of the 68 measured above) are therefore not removed by this Lab; the
  verdict they could flip is.
- An infrastructure failure is excluded by the producer's classification; a real test
  failure misclassified as infrastructure would not stick.

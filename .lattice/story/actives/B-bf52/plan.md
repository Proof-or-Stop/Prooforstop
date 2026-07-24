# Plan — B-bf52: gate-failure digest precision

## 1. Problem

`gateFailureDigest` (packages/main/src/core/convergence-breaker.ts:469-482) is the key under which
`bumpGateFailureCount` (:485-500) counts gate rejections. `maxGateFailureCount` feeds `assessBreaker`,
which trips the convergence breaker at a repeat count of 2. The function's own doc comment (:463-468)
states the contract it must honor: reasons differing only in *incidental* detail collapse to one key.

Four reproduced classes violate that contract by collapsing *substantively* different rejections:

| Class | Cause | Observed |
| --- | --- | --- |
| C1 | `.slice(0, 200)` at :479 | A real DEV-gate rejection's fixed header *measures* 257 normalized characters (preamble plus the report's six header lines), and 433 by the point the first gap row begins in a typical two-trigger report, so the cut lands *before* the `Diagnostic gaps` list. Three different gap sets all digest to `story_advance/506877715ebd`. |
| C2 | path regex at :475 rewrites any slash-bearing token | `DEV/REVIEW` and `DEV/TEST` both become `dev#` |
| C3 | same regex is greedy from the first slash | `src/core/alpha.ts` and `src/core/beta.ts` both become `src#` |
| C4 | digit regex at :476 runs inside identifier tokens | `CHK-001` and `CHK-002` both become `chk-#` |

C1 is total for the DEV gate: every rejection for one story shares one key regardless of which gaps
are outstanding. Fixing gap one and then hitting gap two therefore reads to the breaker as one gate
failing twice, which is precisely the false freeze observed on B-d877 (2026-07-18) and B-956f
(2026-07-23). Each recovery cost an interactive human TTY acknowledgement.

## 2. Approach

**Normalize only provably-volatile *shapes*; leave every ambiguous bare number alone.** Drop the
truncation, narrow the path rules, keep the rules whose input carries its own evidence of volatility
(a `0x` prefix, a letter-bearing hex run, an ISO timestamp, an absolute path root, a unit suffix), and
delete the general free-standing-number rule outright.

The breaker's threshold, counters, `assessBreaker`, `resetGateFailureCounts`, the `story_resume`
recovery flow and the single call site at packages/main/src/cli-engine.ts:1508 are all unchanged. Only
the normalization step inside `gateFailureDigest` changes, plus its smoke.

### 2.1 Why the policy, and not another patch

This is a **policy convergence adopted in review round 4**, after rounds 1–3 produced a stable
oscillation rather than progress. That history is the evidence for the policy and is recorded here
deliberately:

* every **narrowing** created a case where the breaker silently **never trips** — F-007
  (unit-suffixed durations), F-015 (sentence-final numbers), F-019 (review-run ids), F-022
  (ppid-derived session ids);
* every **widening** created a case where two substantively different failures **falsely freeze** a
  story — F-002 (dotted versions), F-014 (identifier-attached decimals), F-020 (ports, percentages and
  decimal thresholds in real test output).

The oscillation is structural, not a run of near misses: **in free text a bare number is not
syntactically decidable** as substantive or volatile. `CHK-002` and `RR-002` are the same shape;
`attempt 3` and `port 3000` are the same shape. No lookaround can separate them, so each round's rule
traded one failure direction for the other.

### 2.2 The deciding evidence

The tie is broken by asking which direction has a **real producer**.

* `(attempt N)` — the volatile bare counter the general number rule existed to absorb — appears
  **nowhere in this repo** outside the smoke's own invented fixture and the RED harness copied from
  it. There is no producer.
* F-020's shapes are real and reachable. `test-evidence` output is interpolated **verbatim** into a
  `story_advance` DONE rejection at packages/main/src/core/machine.ts (`Cannot enter DONE: test
  ${result}: ${output}`), so `connection to localhost:3000 refused` and `…:4000` — two different
  validation failures — collapsed to one key and froze the story on its second distinct failure. That
  is the exact defect this story exists to remove, reintroduced by this story's own fix.

Failing toward **distinct** therefore fails toward never falsely freezing, which is this story's
purpose. The opposite failure mode — a runaway that varies a bare number and so never accumulates a
gate-repeat count — is separately covered by this repo's burn-alert system, which watches spend rather
than message text. A false freeze is bounded by nothing except an interactive human TTY
acknowledgement.

Rejected alternatives (recorded in decision.json): digesting a structured failure code instead of the
message text (disproportionate; requires every rejection site to emit a code first, and the call site
receives only an `Error` message), and raising the truncation bound alone (leaves C2, C3 and C4 live
and picks a new magic number). Rejected in round 4: continuing to tune the number rule's lookarounds,
which is what produced the oscillation above.

## 3. Design — the final rule chain

Seven positions, in order. Each surviving rule keys on a **shape** that is evidence of volatility on
its own, independent of the number it contains.

| # | Rule | Collapses because |
| --- | --- | --- |
| 1 | `0x[0-9a-f]+` → `#` | the `0x` prefix marks a machine address |
| 2 | **NEW** `(?<=[-_])(?=[0-9a-f]*[a-f])[0-9a-f]{7,}(?![\w-])` → `#` | a hyphen/underscore-attached run of 7+ hex characters *containing at least one a-f letter* is provably a digest, never a human ordinal |
| 3 | `(?<![\w-])(?<!\d\.)[0-9a-f]{7,}(?![\w-])(?!\.\d)` → `#` | a free-standing 7+ hex run attached to nothing is a hash |
| 4 | ISO-8601 timestamps → `#` | wall-clock |
| 5 | Windows then POSIX absolute paths, token-start anchored → `#` | machine-specific root |
| 6 | number **welded to a unit** (`45s`, `8m`, `1.5ms`, `12kb`) → `#` | the unit is the shape evidence |
| 7 | *(deleted)* general free-standing number | — |

**Truncation → sanity bound (CHK-001).** Hashing is length-agnostic, so the cut buys nothing a
bounded rejection message needs. A generous worst case — 20 gap rows, 15 trigger rows, 10
parent-rollup rows plus the header — measures 7,448 characters. A retained bound of 16,384 therefore
sits roughly 2.2 times above the worst realistic message while still capping a pathological input
such as an embedded transcript.

**Path rules (CHK-002).** Match an absolute path only at a *token start* — preceded by string start,
whitespace, quote, parenthesis, bracket, or one of the `:` / `=` / `,` delimiters real messages use to
introduce a path with no space. This is structural: it needs no enumeration of machine roots and
behaves identically on macOS and Linux. A mid-token slash (`DEV/REVIEW`) and a relative path
(`src/core/alpha.ts`) are no longer touched, while `/Users/...` and `/private/var/...`, and `/home/...`
and `/tmp/...`, still collapse to one token. The Windows drive-letter form runs first, since it
carries no forward slash and would otherwise survive whole (F-006).

**Attached-hash rule, position 2 (F-022).** `deriveLocalSessionId`
(packages/main/src/core/owner-session.ts:28-32) mints `sess-${sha256(host\0root\0ppid).slice(0,16)}`,
so a host that re-execs mints a **new** session id on the same machine in the same worktree. The
ownership rejection that names it
(`formatNonOwnerError`, packages/main/src/core/story-owner-lease.ts:616-640) therefore minted a fresh
digest key on essentially every retry and the breaker never fired.

The **a-f letter requirement is the entire safety argument** for this rule, and it is what lets the
policy collapse this shape without reopening F-014: a human ordinal or an epoch suffix is decimal and
therefore letter-free, so `session-1234567` and `worker-1721775600` stay distinct while
`sess-d7efe197b316c43a` collapses. This is the one place where a *shape* cleanly separates the two
directions that a bare number cannot.

**Free-standing hash rule, position 3 (F-014, F-016).** The identifier-attachment lookbehind is not
optional: decimal digits are a subset of hex digits, so a bare `\b` boundary let this rule consume any
identifier-attached decimal run of 7+ characters. The dot-adjacency lookarounds are F-016 — without
`(?!\.\d)` the rule bites the integer part out of a decimal whose digits happen to reach 7, so
`heartbeat 1234567.5ms ago` normalized to `heartbeat #.# ago` while the six-digit `123456.5ms`
normalized to `heartbeat # ago`: one duration rendering, two keys, split by an arbitrary threshold.
Only `(?!\.\d)` has a named producer; `(?<!\d\.)` is retained as its symmetric half, and both can only
make the rule collapse *less*, which is the direction this policy fails toward.

**Duration rule, position 6 (F-007).** The one numeric rule the policy keeps, because a unit suffix is
shape evidence. This paragraph replaces an earlier claim in this document that asserted the opposite
of the truth and is retracted. It read:
"Confirmed no production rejection message embeds a volatile counter attached to an identifier: the
only attached-counter shapes in the tree are step record ids at planned-steps-executor.ts:1298 and
:1309, and that module throws no `Error`." That survey was **wrong**. It looked only for counters
attached to an identifier by a hyphen or a word stem and missed the far more common shape: a volatile
number welded to a *unit letter*. Four `story_advance`-reachable rejection sites render exactly that,
all via `formatLeaseAge` / `formatLockAge` producing `45s`, `8m`, `2h` inside `heartbeat <age> ago`:

1. `packages/main/src/core/story-owner-lease.ts:591-598,616-640` — `formatLeaseAge` /
   `formatNonOwnerError`, thrown from the ownership gate on the ordinary "story is owned by another
   session" `story_advance` path;
2. `packages/main/src/cli/ownership-gate.ts:301-306` — the active-lease `--takeover` refusal;
3. `packages/main/src/core/main-write-lock.ts:71-113` — DONE-phase main-write-lock contention;
4. `packages/main/src/core/validation-execution-lock.ts:233-262` — TEST-phase validation-lock
   contention.

Without a rule that consumes the digits *together with their unit*, each retry against a live foreign
lease or a held lock mints a **new** key, the repeat count never reaches 2, and the breaker never
fires — for precisely the stuck retry loop it exists to stop. The rule matches a number plus a unit
suffix (`ms|s|m|h|d|kb|mb|gb|b`) and carries the identifier-attachment and dot-adjacency lookarounds,
so `B-bf52`, `CHK-001` and `v0.3.229` are untouched while `heartbeat 45s.` at the end of a sentence
still collapses (F-015's duration half, which — unlike its number half — has a real producer in
`formatLeaseAge`).

Measured revert proof: deleting this rule fails six matrix cases (the four real lease/lock messages,
`sentence-final-duration`, and `decimal-duration-straddling-hash-threshold`) and leaves the other
twenty-four passing. Each of the four real-message fixtures varies **only** the age.

**Matrix (CHK-004).** The original distinctness guard at
packages/main/src/tasks/convergence-breaker-smoke.ts used `reason ALPHA` / `reason BETA` — too short
to reach the truncation and containing none of the collapsing token shapes, i.e. a guard whose fixture
cannot exercise the failure. The replacement matrix asserts both directions and, for each case, drives
the real `bumpGateFailureCount` / `maxGateFailureCount` path so the *counter* consequence is proven
rather than only the hash. Must-differ cases assert the counter stays at 1; must-still-collapse cases
assert it reaches 2 and `assessBreaker` still trips. Round 4 grew it to **15 must-differ + 15
must-still-collapse**, and **every guard tag was re-derived from scratch** against the new chain
rather than carried over.

Round-4 fixture corrections, both measured:

* the DEV-gate fixture rendered the ledger `thresholdState` as `(within)`. The real union at
  packages/main/src/core/types.ts:2529 is `within_threshold | too_broad | slice_required`, so the
  abbreviated form is not a value this code can emit. Corrected to `(within_threshold)` — which is
  exactly the 10 characters by which the retracted "244" figure was short (see §3 and F-018);
* the F-022 fixture **calls** `deriveLocalSessionId` rather than imitating it, and asserts that both
  generated digests contain an a-f letter, so the case cannot silently degenerate into one that passes
  for the wrong reason.

## 4. Risk, its guard, and what the policy gives up

The change makes the breaker fire *less* often. Left unguarded that would let a stuck agent regain an
unbounded retry loop — the mechanism's whole purpose. F-007 is the proof that this risk is real and
not theoretical: the first cut of the digit rule did exactly that to four live lease/lock contention
messages. CHK-004's must-still-collapse lane is the guard: the four real lease/lock heartbeat-age
messages, sentence-final durations, the real ppid-derived session id, a decimal duration straddling
the hash threshold, an ISO timestamp, machine-specific absolute paths (POSIX, Windows and
delimiter-attached), hex ids and the applied sanity bound each still produce one key, accumulate to 2,
and trip `assessBreaker`. The must-differ lane guards the opposite risk.

### 4.1 Revert localization, re-measured

Every rule group, reverted individually, must fail a *named subset* of the matrix and leave the rest
passing. All fourteen reverts below were executed against the built smoke, not reasoned about:

| Revert | Failing cases |
| --- | --- |
| sanity bound removed | `beyond-sanity-bound`, `sanity-bound-is-applied` |
| 200-char truncation restored | `dev-gate-one-gap-differs`, `dev-gate-gap-count-differs` |
| attached-hash rule deleted | `ppid-derived-session-id` |
| attached-hash letter requirement dropped | `identifier-attached-long-decimal` |
| free-standing hash rule deleted | `hex-id` |
| free-standing hash `(?!\.\d)` dropped | `decimal-duration-straddling-hash-threshold` |
| free-standing hash widened back to `\b` | the two rows above, together |
| ISO rule deleted | reported by section 7's own assertion, which throws before the matrix runs; the matrix case `iso-timestamp-only` was separately verified to fail under this revert |
| POSIX path rule deleted | the three `path-rule-collapse` cases |
| Windows path rule deleted | `windows-absolute-path` |
| path rule widened to slash-anchored | `phase-pair`, `in-repo-file-path` |
| duration rule deleted | the four real lease/lock messages, `sentence-final-duration`, `decimal-duration-straddling-hash-threshold` |
| **narrow number rule reintroduced** | the six `number-rule-removal` cases |
| **unconditional `/\d+/g` reintroduced** | those six, plus the four `digit-rule-overreach` cases and `identifier-attached-long-decimal` |

The last two rows are the nesting the round-4 tags express deliberately: `number-rule-removal` is the
strict guard (any bare-number rule fails it) and `digit-rule-overreach` is the weaker one (only the
unconditional form fails it), because the narrow round-1..3 rule already protected identifier-attached
digits.

### 4.2 Two accepted findings were RE-DECIDED, not quietly reverted

* **F-003** (a countdown's leading minus is a sign, so `-5` and `-19` must collapse) and
* **F-015's number half** (a sentence-final full stop is punctuation, so `exceeded 5.` and
  `exceeded 19.` must collapse)

were both accepted in earlier rounds and are **superseded by this policy**. Neither named a real
producer, and each asked the digest to collapse an *ambiguous bare number* — which is precisely the
mechanism that produced F-020. Honouring them requires the general number rule, and that rule cannot
distinguish `retry budget -5` from `got -0.61`, or `exceeded 19.` from `latency 19.` in a test report.

They are not erased: both fixtures remain in the matrix, **converted to must-differ cases** and
renamed `negative-counter-now-distinct` and `sentence-final-counter-now-distinct`, so the change of
decision is visible in the matrix output rather than deleted from it. **F-015's duration half is not
superseded** — it has a real producer (`formatLeaseAge`) and `sentence-final-duration` still collapses.

### 4.3 Explicitly accepted residuals

**F-019 — review-run ids never collapse.** `RR-002` and `RR-003` keep separate keys, so a host that
starts a new reviewer run between attempts mints a fresh key each time and the gate-repeat count never
accumulates for that failure. Accepted, because an identifier-attached **pure-decimal** suffix is
indistinguishable from `CHK-002`, and this direction fails safe. Note explicitly that this is **not**
mitigated by the counter reset: packages/main/src/cli-engine.ts:1405 resets the counter only on a
**successful** `story_advance`, deliberately — resetting on any successful mutation would let a
runaway defeat the gate-repeat signal entirely.

**A varying holder pid no longer collapses.** A pid is a bare number, so two lock-contention
rejections naming different holders now key separately. Real contention is normally the same holder
retried (which is why the matrix fixtures hold the pid constant), and the false-freeze direction is
the one this story exists to prevent.

**Bare retry counters, countdowns and sentence-final ordinals no longer collapse** — the direct
consequence of §4.2, listed here so the residual is stated as such and not left implicit.

In all three cases the un-caught runaway is bounded by the burn-alert system, which watches spend
rather than message text. The false freeze they replace is bounded only by an interactive human TTY
acknowledgement.

Accepted effect, no migration: stories holding `gate-failure-counts.json` entries keyed by the old
digest will not match the new key, so an accumulated count appears to reset. `resetGateFailureCounts`
already clears these on every successful `story_advance`, and losing a stale count is strictly safer
than a false freeze.

## 5. RED evidence

`tmp/s3-red/red-s3-digest-collapse.mjs` asserts the corrected behavior against the built
`packages/main/dist/core/convergence-breaker.js`. At this story's baseline it reports **5/8 FAIL**
(C1a, C1b, C2, C3, C4 fail; K1, K2, K3 pass), exit 1. The three passing regression cases prove the
harness is not merely demanding that every string differ. The harness reconstructs the real DEV-gate
rejection render (machine.ts:179 preamble plus `renderProofStoryDiagnosticReport`,
proofstory.ts:1890-1918) with gap texts quoted from proofstory.ts:1002, :1129 and :1137 — not a
synthetic padded string.

**Round-4 correction to this section's exit criterion.** It previously read "after the change it must
report 8/8 pass". That is no longer the right target, and the harness was **not** edited to reach it.
Measured after the policy change: **7/8, exit 1**. All five defect classes pass — C1a, C1b, C2, C3 and
C4 — so the defect this story exists to fix is demonstrably gone, and K2 and K3 still pass. **K1 fails
by design.** K1 bundles two independent claims in one assertion: that an ISO timestamp collapses
(still true) and that a bare `(attempt N)` counter collapses (**re-decided** — see §2.2 and §4.2).
Editing K1 to pass would have hidden the re-decision, so the assertion is left untouched and a comment
above it explains why. Both halves are re-asserted separately and correctly in the smoke as
`iso-timestamp-only` (collapse) and `attempt-counter-now-distinct` (differ).

The authoritative regression gate for this story is therefore the smoke, not this harness: the harness
was written against the round-1 understanding of the contract and one of its eight claims did not
survive contact with F-020.

## 6. Sequence

1. CHK-001 remove the truncation, retain the 16,384 sanity bound.
2. CHK-002 narrow the path rule to token-start absolute paths.
3. CHK-003 constrain numeric normalization to provably-volatile shapes. Delivered in round 4 as: keep
   the unit-suffixed duration rule, add the letter-bearing attached-hash rule, give the free-standing
   hash rule dot-adjacency, and **delete the general free-standing-number rule** (§2).
4. CHK-004 replace the tautological fixtures with the two-direction matrix, asserting counter
   consequences and per-rule revert localization.
5. Rebuild, confirm `npm run test:convergence-breaker` exits zero (the smoke is reached from the root
   `npm test` chain at package.json:15 via package.json:116, which lattice.config.json lists as a
   `doneRequiredCommand`), and confirm the RED harness reports **7/8 with all five defect classes
   passing** (§5 — K1's counter half was re-decided and the harness was deliberately not edited).

**Open item for the main agent, not actionable from this lane:** CHK-003's title and `userSees` still
describe the round-1..3 design ("standalone numbers", with `attempt 41` named as a value that
collapses). The delivered behavior is §3's rule chain and §4.2's re-decision. Checklist metadata is
outside an implementer's write scope, so this is flagged rather than edited.

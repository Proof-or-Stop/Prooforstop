# Plan — B-bf52: gate-failure digest precision

## 1. Problem

`gateFailureDigest` (packages/main/src/core/convergence-breaker.ts:469-482) is the key under which
`bumpGateFailureCount` (:485-500) counts gate rejections. `maxGateFailureCount` feeds `assessBreaker`,
which trips the convergence breaker at a repeat count of 2. The function's own doc comment (:463-468)
states the contract it must honor: reasons differing only in *incidental* detail collapse to one key.

Four reproduced classes violate that contract by collapsing *substantively* different rejections:

| Class | Cause | Observed |
| --- | --- | --- |
| C1 | `.slice(0, 200)` at :479 | A real DEV-gate rejection's fixed header measures 244 normalized characters, so the cut lands *before* the `Diagnostic gaps` list. Three different gap sets all digest to `story_advance/506877715ebd`. |
| C2 | path regex at :475 rewrites any slash-bearing token | `DEV/REVIEW` and `DEV/TEST` both become `dev#` |
| C3 | same regex is greedy from the first slash | `src/core/alpha.ts` and `src/core/beta.ts` both become `src#` |
| C4 | digit regex at :476 runs inside identifier tokens | `CHK-001` and `CHK-002` both become `chk-#` |

C1 is total for the DEV gate: every rejection for one story shares one key regardless of which gaps
are outstanding. Fixing gap one and then hitting gap two therefore reads to the breaker as one gate
failing twice, which is precisely the false freeze observed on B-d877 (2026-07-18) and B-956f
(2026-07-23). Each recovery cost an interactive human TTY acknowledgement.

## 2. Approach

Narrow each over-broad normalization rule rather than deleting it, and drop the truncation. The
breaker's threshold, counters, `assessBreaker`, `resetGateFailureCounts`, the `story_resume` recovery
flow and the single call site at packages/main/src/cli-engine.ts:1508 are all unchanged. Only the
normalization step inside `gateFailureDigest` changes, plus its smoke.

Rejected alternatives (recorded in decision.json): digesting a structured failure code instead of the
message text (disproportionate; requires every rejection site to emit a code first, and the call site
receives only an `Error` message), and raising the truncation bound alone (leaves C2, C3 and C4 live
and picks a new magic number).

## 3. Design, with the three unknowns resolved by measurement

**Truncation → sanity bound (CHK-001).** Hashing is length-agnostic, so the cut buys nothing a
bounded rejection message needs. A generous worst case — 20 gap rows, 15 trigger rows, 10
parent-rollup rows plus the header — measures 7,448 characters. A retained bound of 16,384 therefore
sits roughly 2.2 times above the worst realistic message while still capping a pathological input
such as an embedded transcript.

**Path rule (CHK-002).** Match an absolute path only at a *token start* — preceded by string start,
whitespace, quote, parenthesis or bracket. This is structural: it needs no enumeration of machine
roots and behaves identically on macOS and Linux. A mid-token slash (`DEV/REVIEW`) and a relative path
(`src/core/alpha.ts`) are no longer touched, while `/Users/...` and `/private/var/...`, and `/home/...`
and `/tmp/...`, still collapse to one token. Measured: all eight direction cases satisfied.

**Digit rule (CHK-003).** Match only a *standalone* number — not preceded or followed by a word
character or hyphen. Free-standing counters (`attempt 41`, `3>=2`, `0/4 lanes`) still collapse;
identifier-embedded ordinals (`CHK-001`, story ids) survive. Confirmed no production rejection message
embeds a volatile counter attached to an identifier: the only attached-counter shapes in the tree are
step record ids at planned-steps-executor.ts:1298 and :1309, and that module throws no `Error`.

**Matrix (CHK-004).** The existing distinctness guard at
packages/main/src/tasks/convergence-breaker-smoke.ts:180-182 uses `reason ALPHA` / `reason BETA` —
too short to reach the truncation and containing none of the collapsing token shapes, i.e. a guard
whose fixture cannot exercise the failure. The replacement matrix asserts both directions and, for
each case, drives the real `bumpGateFailureCount` / `maxGateFailureCount` path so the *counter*
consequence is proven rather than only the hash. Must-differ cases assert the counter stays at 1;
must-still-collapse cases assert it reaches 2 and `assessBreaker` still trips.

## 4. Risk and its guard

The change makes the breaker fire *less* often. Left unguarded that would let a stuck agent regain an
unbounded retry loop — the mechanism's whole purpose. CHK-004's must-still-collapse lane is the guard:
timestamps and attempt counters, machine-specific absolute paths, and hex ids each still produce one
key, accumulate to 2, and trip `assessBreaker`. Each of the three rule changes reverted individually
must fail a *named subset* of the matrix and leave the rest passing, so a regression localizes to the
rule that caused it.

Accepted effect, no migration: stories holding `gate-failure-counts.json` entries keyed by the old
digest will not match the new key, so an accumulated count appears to reset. `resetGateFailureCounts`
already clears these on every successful mutation, and losing a stale count is strictly safer than a
false freeze.

## 5. RED evidence

`tmp/s3-red/red-s3-digest-collapse.mjs` asserts the corrected behavior against the built
`packages/main/dist/core/convergence-breaker.js`. At this story's baseline it reports **5/8 FAIL**
(C1a, C1b, C2, C3, C4 fail; K1, K2, K3 pass), exit 1. The three passing regression cases prove the
harness is not merely demanding that every string differ. After the change it must report 8/8 pass.
The harness reconstructs the real DEV-gate rejection render (machine.ts:179 preamble plus
`renderProofStoryDiagnosticReport`, proofstory.ts:1890-1918) with gap texts quoted from
proofstory.ts:1002, :1129 and :1137 — not a synthetic padded string.

## 6. Sequence

1. CHK-001 remove the truncation, retain the 16,384 sanity bound.
2. CHK-002 narrow the path rule to token-start absolute paths.
3. CHK-003 narrow the digit rule to standalone numbers.
4. CHK-004 replace the tautological fixtures with the two-direction matrix, asserting counter
   consequences and per-rule revert localization.
5. Rebuild, confirm the RED harness reports 8/8, and confirm `npm run test:convergence-breaker`
   exits zero (the smoke is reached from the root `npm test` chain at package.json:15 via
   package.json:116, which lattice.config.json lists as a `doneRequiredCommand`).

# Narrowing-only re-pin of a verification selector

Status: accepted (B-1482)
Scope: the `verification:{command, selector}` pin an executable verificationIntent
carries, and the tool-owned receipts that are judged against it.

## Why this document exists

B-ec67 made the evidence pin immutable. That invariant was stated in code comments
and in CLAUDE.md, but nowhere in `docs/requirements/decisions/`. B-1482 changes the
invariant — it opens exactly one direction of movement — so the invariant and its
single exception are recorded here rather than left implicit in the code that
enforces them.

## What immutability protects

An executable intent (`logic | cli | browser`) is pinned on the first
selector-bearing evidence write: a command and a proof selector that must appear in
that command's output. Every later receipt is produced by running THAT command and
is judged by THAT selector; `result` is derived from the real exit code and the real
selector match, and a caller-supplied `pass` that contradicts the receipt is refused.

The pin is therefore the thing that makes a receipt mean anything. If a selector
could be edited freely, the cheapest way to turn a failing verification into a
passing one would be to re-point the pin at a string the failing run happens to
print. The evidence would still be mechanically executed, still carry a genuine
exit code and a genuine output tail, and still be worthless. Immutability is what
stops "the run failed" from being answered with "then judge it by something else".

**Loosening stays refused everywhere.** A selector that matches strictly more runs
than the current one is never accepted, in any phase, by any caller, with any
reason. There is no waiver, no override flag and no audited escape for it. A broader
selector is exactly the move immutability exists to prevent, and the narrowing
exception below does not create a back door to it: the candidate must be ABSENT from
a recorded failing render, which a broader selector by construction cannot be.

Changing the pinned COMMAND is likewise still refused. Narrowing answers "this
selector matched a failing run of this command". A different command is a different
pin and a different claim, and stays blocked by the existing immutability check
(`receipt_command_mismatch`).

## The narrowing-only exception

There is one real defect immutability alone cannot fix. A selector can be pinned to
a string the command prints on EVERY branch — a banner, a header, a field name that
appears in both the success and the failure rendering. B-a745 `CHK-005:happy:0` is
the worked example: the pinned selector was printed unconditionally, so it matched a
run that genuinely failed, and the receipt recorded a passing-shaped match for a
failing run. Without an exception, the only ways out are to abandon the intent or to
launder it through a non-mechanical attestation.

So one movement is allowed: `verification_pin_narrow`, a re-pin to a STRICTER
selector on the SAME pinned command.

```bash
proof-or-stop verification_pin_narrow '{
  "storyId":"B-xxxx",
  "itemId":"CHK-001",
  "intentRef":"CHK-001:happy:0",
  "selector":"status: plan",
  "reason":"the pinned selector is printed on every branch, so it matched a failing run; re-pin to the status discriminator"
}'
```

### Its only proof witnesses are current signed V5 receipts

The proof is drawn entirely from current signed V5 receipts this tool recorded for
that pinned command. Legacy receipt readability grants no proof authority. There is
no transcript parameter, no output parameter and no receipt
parameter, because a caller-supplied rendering of a run can be fabricated at zero
cost. A request that carries such a field is refused BEFORE any proof is attempted
(`narrowing_caller_output_not_admissible`), so an offered transcript can never be
"considered and then ignored" — a distinction that matters, because considering it
at all is what would show up as an acceptance.

The caller supplies only: the story, the item, the intent ref, the candidate
selector, and a reason of at least 30 characters. The reason is retained on the
record for attribution. It is never itself the proof.

A narrowing is accepted only when, using recorded receipts alone:

1. the candidate is ABSENT from the complete authenticated output of at least one recorded
   receipt that the CURRENT selector matched while that run was FAILING, and
2. the candidate is PRESENT in EVERY recorded passing receipt of the same pinned
   command, and
3. those receipts were recorded against the same story material.

Condition 1 is what makes the candidate strictly stricter: it demonstrably fails a
run the current selector passed. Condition 2 is what stops a narrowing from breaking
runs that genuinely succeeded. Condition 3 keeps the two sides comparable.

All direction, absence, and presence checks use complete authenticated output from
the immutable artifact, including selectors before the retained-tail boundary.
`outputTail` is a bounded display-only projection, never a proof fallback. Its value
must equal the canonical tail derived from that artifact; a mismatch is refused.
The acceptance message identifies complete authenticated output as the proof source.

Receipts on both sides survive intact. Nothing is back-filled or rewritten: the
failing receipt keeps recording the selector it was actually judged against, and the
old pin, the new pin, the reason, the cited receipt ids and the receipt-set digest
are all retained on the intent and visible through `checklist_get`.

Only a current, lifecycle-admissible `VerificationReceiptBundleV5` can be a narrowing
witness. Its top-level compatibility selector is not trusted as unsigned prose: its
SHA-256 must equal the selector digest in the independently signed
`VerificationAssertionReceiptV2`. The narrowing consumer runs authoritative receipt
validation before reading any projected witness fields and refuses a missing,
substituted, malformed, or otherwise inconsistent split receipt or output artifact with
`narrowing_recorded_receipt_invalid`. Legacy combined receipts and Bundle V2/V3/V4 remain
readable for audit, but cannot authorize narrowing even if a plausible selector was
added to them; they fail with `narrowing_recorded_receipt_not_authoritative`. The
selector remains absent from the selector-free execution receipt. The validator's
complete output is the only output supplied to the narrowing evaluator.

### The bound: one narrowing per recorded-receipt set

A set of recorded receipts admits AT MOST ONE narrowing. The digest of the set the
proof used is retained on the accepted record and re-checked FIRST on every later
request, before the proof is attempted — so a second narrowing against unchanged
receipts is refused even when it WOULD be provable against exactly those receipts
(`narrowing_receipt_set_unchanged`).

That ordering is the point. Without it, one corpus could be walked down step by step
onto a single hand-picked run, each step individually provable. Unlocking a second
narrowing requires NEW recorded evidence, and because a narrowing also requires a
failing render judged by the CURRENT pin, that new evidence has to be a genuine
failing run that the already-narrowed selector still matched.

### Refusal codes

| code | refused because |
|---|---|
| `narrowing_caller_output_not_admissible` | the request carried a transcript, output, receipt or similar field; these are not inputs |
| `narrowing_unknown_input_field` | the request carried a field outside storyId, itemId, intentRef, selector, reason |
| `narrowing_selector_empty` | the candidate selector is empty after trimming |
| `narrowing_reason_too_short` | the reason is under 30 characters after trimming |
| `intent_ref_unresolved` | the intentRef does not resolve to a verificationIntent on that item |
| `narrowing_intent_not_executable` | the intent is attestation-only and carries no pin |
| `narrowing_intent_not_pinned` | the intent has no pin yet; the first selector-bearing evidence write pins it |
| `narrowing_receipt_set_unchanged` | this recorded-receipt set has already spent its one narrowing |
| `narrowing_selector_unchanged` | the requested selector is identical to the pinned one, so the request re-pins nothing |
| `narrowing_no_recorded_receipts` | no receipt has been recorded for the pinned command, so there is nothing recorded to prove the narrowing against |
| `narrowing_selector_loosens` | a recorded receipt proves the candidate is broader than the current pin |
| `narrowing_selector_not_discriminating` | the candidate is present in the recorded failing render too, so narrowing to it proves nothing |
| `narrowing_no_recorded_failing_render` | no recorded receipt shows the current selector matching a failing run |
| `narrowing_no_recorded_passing_receipt` | there is no recorded passing receipt, so "matches every passing receipt" would hold vacuously |
| `narrowing_selector_absent_from_passing_receipt` | the candidate is missing from a recorded passing receipt, so narrowing would start failing a run that genuinely passed |
| `narrowing_receipt_selector_unknown` | the witness receipt predates B-1482 and does not record which selector it was judged against; that is UNKNOWN, not re-derivable from the current pin |
| `narrowing_receipt_material_mismatch` | the witness receipt was recorded against different story material than the passing receipts it is weighed against |
| `narrowing_receipt_not_predating_request` | a receipt used by the proof carries no usable execution time, or claims to have run AFTER the request; only receipts recorded before the request can prove it |
| `narrowing_recorded_receipt_invalid` | a persisted split receipt or complete-output artifact fails authoritative integrity/signature/cross-link validation, including a mismatched display tail, before it can become a narrowing witness |
| `narrowing_recorded_receipt_not_authoritative` | a legacy combined or Bundle V2/V3/V4 receipt is readable for audit but lacks the current signed V5 authority required for a narrowing witness |

## What this does and does not bound

Mechanically enforced: the witness must be a current signed, authoritative V5 receipt
of the same pinned command, judged and matched by the current pin, recorded on the same
story material as the compared passing receipts, and predating the request; the
candidate must also match every recorded passing receipt; and the set is spent
afterwards.

Not bounded: an operator who can drive that command to fail on the same material,
because no receipt records why a run failed. Such an operator can engineer a genuine
failing receipt whose complete output lacks the candidate, and that receipt satisfies every
check above. This is recorded here as an **accepted limitation**, not as a bound. No
part of this design, and no text describing it, may claim that case is prevented,
detected or ruled out.

What the limitation costs is small and stated plainly: the narrowing is still
restricted to one direction, on one command, once per recorded-receipt set, with an
attributable reason, against receipts the tool itself produced. What it does not buy
is protection from someone who can make the verification genuinely fail.

## Pre-mortems

This decision moves a security-adjacent invariant, so the ways it could fail are
recorded with it rather than left in the story metadata. Each row names what would
have to be true for the failure, what it would cost, and what in the shipped design
answers it.

| # | scenario | trigger | consequence | mitigation |
|---|---|---|---|---|
| PM-1 | Evidence-shopping by repeated narrowing: an author re-pins repeatedly, each step proved, until the selector matches only one favourable run | no bound on how many times a selector may be narrowed against the same recorded evidence | the seatbelt is defeated one legal step at a time | a recorded-receipt set admits at most one narrowing, checked BEFORE the proof; unlocking another requires a new recorded failing render the CURRENT pin matched (`narrowing_receipt_set_unchanged`) |
| PM-2 | A forged failing transcript is used as the narrowing proof | the proof accepts caller-supplied output | any selector could be justified | a transcript, output or receipt field is not an input; a request carrying one is refused before any proof is attempted (`narrowing_caller_output_not_admissible`) |
| PM-3 | A pin whose selector never matched a failing run is re-pinned anyway, on the strength of a reason | the implementation falls back to the reason when no failing receipt exists | the refusal path becomes optional, which is the same as not having it | with no recorded failing render the re-pin is refused and the refusal names the missing side (`narrowing_no_recorded_failing_render`); the reason is retained for attribution and is never the proof |
| PM-4 | An engineered failing receipt: the author drives a genuine run to fail so the desired selector is absent, then uses it as the proof | the proof cannot tell an incidental failure from one arranged to shape the evidence | a narrowing is accepted that serves the author rather than the check | bounded, not closed: the witness must predate the request and share the recorded story material with the compared passing receipts (`narrowing_receipt_not_predating_request`, `narrowing_receipt_material_mismatch`); the residue is recorded above as an accepted limitation and is never described as prevented |
| PM-5 | The persisted selector is caller-injected onto a receipt earned under a different selector | the compatibility projection is consumed without binding it to the signed assertion, or readability of unsigned legacy evidence is mistaken for authority | the audit record can be forged | only current signed V5 can witness narrowing; V5 requires SHA-256 of the top-level selector to equal the independently signed assertion selector digest (`narrowing_recorded_receipt_invalid`), while legacy combined and Bundle V2/V3/V4 are refused regardless of any injected selector (`narrowing_recorded_receipt_not_authoritative`) |

## Alternatives rejected

- **Keep the pin absolutely immutable.** Leaves the B-a745 class with no mechanical
  exit: an intent pinned to an unconditional banner can never earn honest coverage,
  which pushes real work onto non-mechanical attestations and waivers. That trades a
  narrow, audited, one-directional movement for a broad, unaudited one.
- **Accept a caller-supplied failing transcript as the proof.** Cheapest possible
  forgery: the entire proof would rest on text the caller typed. Refused outright
  rather than weighed.
- **Allow unlimited narrowings while each step is individually provable.** Each step
  looks sound and the chain is not: a corpus can be walked down onto one hand-picked
  run. Hence the one-per-recorded-receipt-set bound, checked before the proof.

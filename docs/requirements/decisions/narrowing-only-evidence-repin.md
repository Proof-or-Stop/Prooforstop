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

### Its only inputs are tool-recorded receipts

The proof is drawn entirely from receipts this tool recorded for that pinned
command. There is no transcript parameter, no output parameter and no receipt
parameter, because a caller-supplied rendering of a run can be fabricated at zero
cost. A request that carries such a field is refused BEFORE any proof is attempted
(`narrowing_caller_output_not_admissible`), so an offered transcript can never be
"considered and then ignored" — a distinction that matters, because considering it
at all is what would show up as an acceptance.

The caller supplies only: the story, the item, the intent ref, the candidate
selector, and a reason of at least 30 characters. The reason is retained on the
record for attribution. It is never itself the proof.

A narrowing is accepted only when, using recorded receipts alone:

1. the candidate is ABSENT from the retained `outputTail` of at least one recorded
   receipt that the CURRENT selector matched while that run was FAILING, and
2. the candidate is PRESENT in EVERY recorded passing receipt of the same pinned
   command, and
3. those receipts were recorded against the same story material.

Condition 1 is what makes the candidate strictly stricter: it demonstrably fails a
run the current selector passed. Condition 2 is what stops a narrowing from breaking
runs that genuinely succeeded. Condition 3 keeps the two sides comparable.

Absence in condition 1 is asserted within the retained `outputTail`, which is
BOUNDED — it is the tail of the captured output, not the whole run. The acceptance
message says so in those terms rather than claiming the selector was absent from the
entire output.

Receipts on both sides survive intact. Nothing is back-filled or rewritten: the
failing receipt keeps recording the selector it was actually judged against, and the
old pin, the new pin, the reason, the cited receipt ids and the receipt-set digest
are all retained on the intent and visible through `checklist_get`.

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
| `narrowing_selector_loosens` | a recorded receipt proves the candidate is broader than the current pin |
| `narrowing_selector_not_discriminating` | the candidate is present in the recorded failing render too, so narrowing to it proves nothing |
| `narrowing_no_recorded_failing_render` | no recorded receipt shows the current selector matching a failing run |
| `narrowing_no_recorded_passing_receipt` | there is no recorded passing receipt, so "matches every passing receipt" would hold vacuously |
| `narrowing_selector_absent_from_passing_receipt` | the candidate is missing from a recorded passing receipt, so narrowing would start failing a run that genuinely passed |
| `narrowing_receipt_selector_unknown` | the witness receipt predates B-1482 and does not record which selector it was judged against; that is UNKNOWN, not re-derivable from the current pin |
| `narrowing_receipt_material_mismatch` | the witness receipt was recorded against different story material than the passing receipts it is weighed against |

## What this does and does not bound

Mechanically enforced: the witness must be a genuine tool-recorded receipt of the
same pinned command, judged and matched by the current pin, recorded on the same
story material as the compared passing receipts, and predating the request; the
candidate must also match every recorded passing receipt; and the set is spent
afterwards.

Not bounded: an operator who can drive that command to fail on the same material,
because no receipt records why a run failed. Such an operator can engineer a genuine
failing receipt whose tail lacks the candidate, and that receipt satisfies every
check above. This is recorded here as an **accepted limitation**, not as a bound. No
part of this design, and no text describing it, may claim that case is prevented,
detected or ruled out.

What the limitation costs is small and stated plainly: the narrowing is still
restricted to one direction, on one command, once per recorded-receipt set, with an
attributable reason, against receipts the tool itself produced. What it does not buy
is protection from someone who can make the verification genuinely fail.

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

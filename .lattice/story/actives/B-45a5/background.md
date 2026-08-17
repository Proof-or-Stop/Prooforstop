## Trigger Event

On 2026-08-03 story B-8df9 was blocked from entering TEST by two gates, both demanding evidence for CHK-004 — a checklist item WITHDRAWN by explicit user decision (`scope_shrinkage_decision_set`, decisionId SD-7319de10, userConfirmed=true).

The withdrawal is recorded as clean machine-readable state: the item carries `status: "withdrawn"` and `decisionRef: "SD-7319de10"`, and the decision file records `withdrawnChecklistItemRefs: ["CHK-004"]`. The fact exists; the gates do not read it. The operator's only exit was three `kind=waiver` evidence rows — prose standing where a mechanical fact belongs, inside a framework built to refuse that substitution.

A first draft of this story was reviewed and DISCARDED for misdiagnosing the cause. The corrected diagnosis is below and is materially different: this is not missing capability, it is a built capability left unwired.

## Key Insights

**The defect is a GRANULARITY MISMATCH, not an absence of withdrawal awareness.** Verified on main at CLI 0.3.248:

- `evaluateReviewCompleteness` is defined at `packages/main/src/core/proofstory.ts:2084`. `handlers/phase-gates.ts` only imports and calls it. (The discarded draft placed the function in phase-gates.ts; that was wrong.)
- `core/proofstory.ts` contains **28** references to `withdrawn` — it reads withdrawal at BINDING and MILESTONE granularity.
- `withdrawnChecklistItemIdsFrom(decision)` — the ITEM-level helper — already exists at `core/proofstory.ts:1622`. Its only caller anywhere is a smoke test, `tasks/scope-shrinkage-withdrawal-floor-smoke.ts:36,119`. **No production code calls it.**

So the item-level capability was built, tested, and never wired into the gate that needs it. B-8df9's decision recorded `withdrawnChecklistItemRefs: ["CHK-004"]` populated and `withdrawnAcceptanceBindingRefs: []` empty — precisely the granularity the gate does not consult.

The second gate is a different, simpler case: `packages/main/src/handlers/validate-channel.ts` (`checkDispatchEvidence`) has **zero** status or withdrawal awareness of any kind, so it demands a dispatch record for work that was deliberately never dispatched.

**The safety-critical detail.** `core/checklist-status.ts` — which B-1909 introduced and wired into **11** import-based consumers — contains only bare status predicates and has **zero** `decisionRef` awareness across its 42 lines. Routing this fix through it would produce exactly the bypass this story must avoid: a naive `status === 'withdrawn'` skip that anyone can trigger by writing one word into a JSON file. `withdrawnChecklistItemIdsFrom` is the correct entry point because it takes the DECISION RECORD as its input, making the backing requirement structural rather than remembered.

B-1909 (DONE) built this mechanism and recorded `limitations: "none — fully covered"`. That is true for its stated scope — it names the same 11 consumers this review re-derived. The two gates here are REVIEW-path, outside that scope, so this is an uncovered continuation, not a false claim or a regression.

## Solution Tradeoffs

**Mutate the acceptance binding** so it stops referencing the withdrawn item's intents — rejected while diagnosing B-8df9. The affected binding covered both the withdrawn item and a DELIVERED one, so whole-binding withdrawal would have dropped real coverage; and `proofstory_contract_set`, the only command that can narrow `verificationIntentRefs`, is PLAN-frozen by deliberate B-1909 design. Mutating frozen acceptance bindings to satisfy a gate is the wrong direction regardless of feasibility.

**Wire the existing item-level helper into the two gates** — preferred. It mutates nothing, preserves the PLAN freeze, keeps both gates strict for every non-withdrawn item, and consumes a decision record that `scope_shrinkage_decision_set` already validates at write time.

The residual risk is that a gate relaxation becomes a bypass. The mitigation is structural rather than procedural: skip only via `withdrawnChecklistItemIdsFrom(decision)`, so an item is skippable only when a real decision lists it. A `status` string alone, or a `decisionRef` naming a decision that does not exist or does not list that item, must skip nothing. Proving that refusal is as much the deliverable as the skip itself.

Recurrence is a separate decision. B-1909 wired 11 consumers by hand and these two were not on the list; fixing two more named files repeats the method and will miss the next one the same way. Deriving the consumer set rather than re-enumerating it is what makes this the last occurrence — but it is a different kind of deliverable and its inclusion here is a judgement call, not an obvious yes.

## Conversational Texture

The operator first reached for the acceptance-binding mutation and only found the gate-side fix after that route was refused; the refusal was correct and the first instinct was wrong. The first draft of this story then misdescribed the cause as absent withdrawal awareness, when the truth is an unused helper sitting nineteen lines away from code that already handles withdrawal at two other granularities. Both errors ran the same direction: assuming something was missing when it was present but unconnected.

The user's direction on seeing the waiver workaround shaped this story's framing: Lattice must prove what it claims, and where it cannot, that must be said plainly as a framework defect rather than smoothed over. The three waivers in B-8df9 were rewritten to state in the record that they are a framework gap and must not be read as evidence. Deleting them is an explicit item here rather than an implied consequence, and it must happen BEFORE B-8df9 reaches DONE — evidence recorded into a completed story cannot practically be revised afterwards, as B-49d4 established when it had to defer two findings for exactly that reason.

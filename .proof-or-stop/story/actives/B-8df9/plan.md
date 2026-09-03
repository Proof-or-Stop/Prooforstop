# Plan: B-8df9 Bind the INIT-check verdict into its signature so tampered coverage fails closed

Decision: option **A-extend-domain** — cover `agentResults` + `issues` in the signature, verify `_hash`
before trusting it on read, and accept corpus invalidation (see `decision.json`, which also records why
the version-gated option D was rejected: it preserves replay nobody performs at the price of a
downgrade path).

## The premise is already CONFIRMED — do not re-litigate it, formalise it

A PLAN-phase probe executed the claim rather than inferring it. Result: **5 RED / 0 BROKEN**, with both
gate controls and both signature controls behaving.

- injecting a `product-reviewer` entry into `agentResults`, with **zero** `init_check_set` calls, leaves
  the file signature-valid and the gate **advances**
- hand-erasing a recorded **critical** issue does the same — so `issues` is outside the domain too, and
  a fix covering only `agentResults` leaves an equivalent hole
- **CONTROL**: editing an in-domain field (`title`) DOES change the recomputed signature and IS rejected
  as `init_check_tampered`. This rules out "the signature check is simply dead", which would be a
  different defect with a different fix

Probe sources, to build CHK-001 from rather than reinvent:
`<scratchpad>/init-sig-probe2.mjs` (the signature-domain probe) and `<scratchpad>/init-sig-equivalence.mjs`
(the impact probe). Ask the main agent for the paths; they are session-scoped and not in the repo.

## Standing rules for every item

1. **Do NOT weaken the four smoke tests.** `init-check-required-agents-smoke.ts:103-115` and `:139-140`,
   `init-check-fallback-smoke.ts:230-231`, `test-flow-e2e.ts:391-392` assert that ONE caller satisfying
   BOTH required reviewers **succeeds**. That is load-bearing, by design, and independently re-verified
   this session. If your change makes them fail, **the change is wrong, not the tests.** Any edit to them
   must be justified as signature mechanics, never as an expectation change.
2. **Do NOT add `agentId` validation.** EXP-001's claim was re-verified here with 4 samples (main ×2 vs
   subagent ×2): zero fields distinguish the caller, the full environment digest is byte-identical, and
   Lattice's derived `sessionId` is identical. There is nothing to validate against.
3. **Do NOT overstate the result.** After this ships the gate proves only that the record was not edited
   outside the tool. A single caller can still legally self-satisfy both reviewer slots, and both
   tampering outcomes are already reachable through legal CLI calls — what tampering adds is **zero audit
   trail** (measured: 9 durable records vs 0) and registry bypass. Any summary, message, or doc line that
   implies reviewer coverage became trustworthy is a defect in this story.
4. **Re-derive every count.** The background's figures were measured at `c59f9c0113` and drift as siblings
   merge. Derive them again; do not copy. Writing a stale number into an artifact is the exact defect the
   preceding story (B-49d4) existed to remove.
5. **Serial only.** Every item touches `init-check-gate.ts` or `handlers/init-check.ts`. Dispatching two
   implementers into this one worktree corrupts git state even on disjoint files.

## CHK-001: Prove or refute by execution that a hand-edited init-check.json passes the gate unchanged

**Owner**: lattice-implementer
**DependsOn**: none
**Files**
- Create: `packages/main/tests/red/red-b8df9-init-check-verdict-signature.mjs`
- Modify: `lattice.config.json` (register it)

**Verify**
- Runs on the pre-fix tree and **FAILS** (non-zero). A RED artifact that passes before the fix proves nothing.
- `node packages/main/tests/red/red-b8df9-init-check-verdict-signature.mjs` prints one line per claim.

**DoneWhen**
- Covers **both** fields: injected `agentResults` AND erased `issues`. A fix touching only one must leave
  this artifact RED.
- Carries the **signature control** (in-domain `title` edit must be rejected). If that control fails, the
  run must report BROKEN and draw **no** conclusion — a dead signature check must never be able to
  masquerade as this defect.
- Carries the **gate controls** (missing reviewer refused; genuine critical issue blocks), so "it advanced"
  cannot be confused with "it advances for everything".
- Uses the product's own `recomputeInitCheckHash` rather than reimplementing the domain; a mistake in a
  private copy would masquerade as a finding about the product.
- Registered in `lattice.config.json` so it runs on every `validate`, not only when someone remembers.

## CHK-002: Bind agentResults and issues into the signature domain

**Owner**: lattice-implementer
**DependsOn**: CHK-001
**Files**
- Modify: `packages/main/src/core/init-check-gate.ts` (`signInitCheck`, `recomputeInitCheckHash`)
- Modify: `packages/main/src/core/machine.ts` (the tamper message at ~:1144)
- Test: the four smoke tests above must still pass **unchanged**

**Verify**
- CHK-001's artifact flips from RED to GREEN for the `agentResults` and `issues` rows.
- `npm test` green, in particular the four accumulation smokes.

**DoneWhen**
- Both `agentResults` and `issues` are in the domain. Covering only one is not a partial win; it leaves an
  equivalent hole.
- All **six** on-disk shapes hash deterministically: canonical pair, `koala-*` pair, `lattice-*@fallback`
  pair, `koala-*@fallback` pair, three-entry historical-actor files, and files with **no** `agentResults`
  where `initCheckAgentResults` (init-check-gate.ts:71-78) synthesizes from top-level fields. State
  explicitly what an **absent** field hashes to — signing a synthesized value is not the same as signing
  absence (open question #1 from `understanding.json`).
- The tamper message no longer enumerates a stale field list. **Prefer deriving the list from the domain**
  over restating it; a hand-written enumeration inside the error is the same defect one layer down.

## CHK-003: Verify _hash before trusting previous.agentResults on read

**Owner**: lattice-implementer
**DependsOn**: CHK-002
**Files**
- Modify: `packages/main/src/core/store.ts` (`readInitCheck`, :566-572)
- Modify: `packages/main/src/handlers/init-check.ts` (carry-forward, :138-142)

**Verify**
- A corrupted `_hash` refuses the carry-forward and names the corruption.
- Historical files still **render** through `story_get` and audit paths.

**DoneWhen**
- Open question #2 is answered explicitly in the commit message or decision record: **refusing to TRUST is
  not the same as refusing to READ.** That distinction decides whether the audit-only majority of the
  corpus becomes unreadable, which would convert a nominal cost into a real one.
- This item does **not** cause the gate bypass — CHK-002 does. Its job is that data no caller wrote cannot
  enter a subsequently re-signed file.

## CHK-004: Preserve the fallback audit block across the merge

**Owner**: lattice-implementer
**DependsOn**: CHK-002
**Files**
- Modify: `packages/main/src/handlers/init-check.ts` (:144-152)
- Test: `packages/main/src/tasks/init-check-fallback-smoke.ts`

**Verify**
- After `init_check_repair`, an ordinary `init_check_set` preserves the `fallback` block.
- `story_get` still reports `initCheckAttestation: "fallback"`.

**DoneWhen**
- The block survives the **first** ordinary call. Today it is dropped there — one call **before** the
  coarser `initCheckAttestationMode` label flips — so the durable evidence of a human attestation
  disappears earlier than the label advertising it.
- An ordinary call on a story that never ran `init_check_repair` cannot forge the block into existence.

## CHK-005: Choose and justify the migration position for the existing corpus

**Owner**: lattice-implementer
**DependsOn**: CHK-002
**Files**
- Modify: decision record / commit message (no code unless the position requires it)

**Verify**
- Counts re-derived at implementation time (standing rule 4), not copied.
- The single INIT-phase story identified **by id** and its actors confirmed still registry-valid.

**DoneWhen**
- The position states what breaks and for whom. Structure: only files whose owning story is in **INIT** are
  operationally gated (`canEnterInitCheckGuard` early-returns otherwise, core/machine.ts:440) — at the
  measured commit that was **1 of 637** — so the real choice is one operational break versus ~636
  audit-replay breaks.
- **Keep it short.** The product reviewer judged the ~636 audit breaks near-zero cost in user terms because
  those files are inert and nobody replays them. A one-sentence justification is the expected output here,
  not an extended migration design.
- Any design assuming the corpus can be re-signed **through the handler** is rejected on the record:
  ~195 of 637 files carry an actor absent from `AGENT_DISPATCH_REGISTRY` (chiefly the pre-rename
  `koala-review-story-init`) and would throw `agent_dispatch_actor_unknown`.

## CHK-006: Re-examine the owner-lease exemption whose stated justification this falsifies

**Owner**: lattice-implementer
**DependsOn**: CHK-002, CHK-003
**Files**
- Modify: `packages/main/src/core/command-policy.ts` (:396)

**Verify**
- The stated reason matches what the code does after CHK-002/003, checked against source rather than
  against the old comment.

**DoneWhen**
- `init_check_set` is marked `ownershipClass: 'reviewerWrite'` and exempt from the owner lease, justified
  as "bound by its INIT signature gate". That justification was **false** before this story: the gate did
  not bind the verdict. Either restate it so it is now true, or replace it with a reason that holds
  independently of the signature.
- If no honest justification survives, **flag the exemption itself** rather than leaving it standing on
  rewritten prose. Making the sentence true by editing the sentence is the failure mode here.

## Dependency graph (acyclic)

```
CHK-001 ── CHK-002 ─┬─ CHK-003 ─┐
                    ├─ CHK-004  ├─ CHK-006
                    └─ CHK-005  ┘
```

## Parallelism

**None.** CHK-003/004/005 are independent in principle but all touch `handlers/init-check.ts` or depend on
CHK-002's domain, and standing rule 5 applies: two implementers in one worktree corrupt git state even
with disjoint file sets. Run them serially.

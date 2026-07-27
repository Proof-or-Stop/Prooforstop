# Fail Closed On Malformed Legacy v1 Red-Evidence Records — Pre-Story Audit

Status: **pre-story audit package. Ships zero code. Authorizes no runtime change.**
Date: 2026-07-26
Origin: defect intake from a cross-host (codex) reviewer during story B-506e (Workstream 2c), deliberately NOT fixed there because it is out of that story's scope and unchanged from `main`.
Audited tree at intake: `main` @ `1847b3af6d` (CLI 0.3.239). **Superseded — see §0.0.** Sibling story
B-506e has since MERGED into `main` (`4d417a0c4b`), and `main` has advanced to CLI 0.3.243+. The
"cross-check worktree" this document originally compared against no longer exists as a separate tree;
its contents are now part of `main`. **Every line citation below predates that merge and has drifted:
re-locate by symbol, never by line number** (§4.1 is the one exception: it is re-derived and carries
the commit it was derived at), and re-derive any inventory against CURRENT `main` rather than trusting
a number in this text. **The consumer count especially: it has been wrong four times, for three
different reasons, and §4.0 explains why a `grep` is the wrong instrument for it at all.**
Related spec: `docs/requirements/decisions/red-evidence-subsystem-spec.md` (§0.4, §1.10, §6.4).
Review rounds: rev 5 — rev 4 was superseded by this story's REVIEW round (F-001…F-004): the consumer count was stale a *fourth* time (invalidated by this story's own CHK-006 refactor), two sections still said "seven" after rev 4 had corrected §4 to "ten", the document cited a CLI command `red_evidence_add` that has never existed in any catalog, and §10.2.1 row E5 still described pre-fix behaviour only. Rev 5 replaces the bare count with the reach-enumeration instrument (§4.0-4.2), extends the §10.4 acceptance table past its three original rows, and sweeps the surviving rev-2-era claims about `2d584cc1…` in §7.1/§10.1 that the rev-3 §0.0 rewrite had already falsified. Rev 4 — rev 3 was superseded by INIT-004/005/006 (the consumer inventory was stale again after the merge, the E5 row understated the defect, and D-2 contradicted §0.0). Rev 3 — rev 2 was revised after an adversarial cross-host (codex) audit (six findings, all
upheld; see §14); rev 3 rewrites §0.0 after sibling story B-506e merged into main mid-audit, which
inverted rev 2's provenance warning. Caught by the INIT reviewer as INIT-003 (high).
Decisions: **settled 2026-07-26** — Axis A = (ii) full validation, Axis B = (c) quarantine, and the
OPEN-7 migration scan is **required before merge**. OPEN-1/2/5/6/8 adopt the audit's recommendation.
OPEN-3 (whether B-506e's phantom-digest prose warrants a `B-META` finding) remains **open** and is
explicitly out of this story's scope. See §12.

## 0.0 READ THIS FIRST — B-506e HAS MERGED; rev 2's provenance warning is INVERTED

**Rev 2 warned that several artifacts existed only on the unmerged `story/B-506e` branch. That is no
longer true.** B-506e merged into `main` at `4d417a0c4b` on 2026-07-26, roughly 8.7 hours after story
B-2aa7 was created and *while this document was being written*. `main` is now at CLI 0.3.243.

Every row of rev 2's absent-from-main table is now **PRESENT** on `main`: `core/red-evidence/record-v2.ts`,
`classifyRedRecordSchemaSafe` / `classifyRedRecordSchema` / `RedEvidenceSchemaError`, the `isRedEvidenceV2`
skip guards in the predicate, the classify loop inside `store.readRedEvidence`, all
`packages/main/tests/red/red-w2c-*.mjs`, and the pinned constant `2d584cc1…`.

### What that changes — verified empirically against current `main`, not inferred

**Now FIXED upstream, therefore OUT of this story's scope:**

| Case | Current `main` behaviour |
|---|---|
| record is `null` | typed `RedEvidenceSchemaError` |
| record is a string | typed `RedEvidenceSchemaError` |

**Still LIVE on current `main` — this is the story's actual scope:** **[PROBE]**

| Case | Current `main` behaviour |
|---|---|
| `{ id: "corrupt" }` (versionless, no `observedFailure`) | **bare `TypeError`** |
| `observedFailure: null` / `123` | **bare `TypeError`** |
| record is `[]` (array) | **bare `TypeError`** — `classifyRedRecordSchemaSafe([])` still returns `'v1'` |
| malformed first, satisfying after | **bare `TypeError`** |
| satisfying first, malformed after | **SATISFIED** — silent corruption, `some()` short-circuits |
| `records: {}` / `records: 42` | **bare `TypeError`** (`for…of` non-iterable) |
| `records: "x"` | typed error, but **misattributed** — it iterates the string's characters and reports `a record must be an object`, blaming a record when the envelope is at fault |

So B-506e closed the *unsupported-schemaVersion* class only, exactly as its own scope claim said. The
**versionless-malformed** class and the **entire envelope** class are untouched. The defect is fully live.

### Two rev-2 instructions are now SUPERSEDED

1. **Do NOT "port the harness and derive your own baseline".** `packages/main/tests/red/red-w2c-v1-verdict-invariance.mjs`
   is on `main` and passes there, printing `2d584cc157e83ebb2f8396735f04d46946f0ba90d18a55d9fb2f263d706a11ec`.
   That constant is now **`main`'s own value**, not a foreign import. Use the existing test as the
   invariance baseline and **do not re-pin it**.
2. **§6.2's "no existing idiom to mirror on `main`" is superseded.** The two-layer shape (classify at the
   read boundary in `store.ts` + skip guards in the predicate) now exists on `main`. This story **extends**
   that idiom to cover the envelope and to shape-validate the `'v1'` residual class; it does not establish it.

§7.1 is UNAFFECTED: `71c267a0…` remains a phantom produced by no artifact, and must never be pinned.

Everything else in this document — the mechanism, both crash classes, the consumer analysis in §4
(whose *count* is volatile and is not the durable claim — §4.0), the verdict-movement analysis, the
decisions in §12 — remains valid.

---

## 0. What this document is, and how to read it

This is the artifact to audit **before** a story is created. It exists because the
intake report, while substantially correct, carries at least one claim that does not
survive verification (§7) and leaves the stated hard constraint under-specified in a way
that could make an otherwise-correct fix un-shippable (§8).

Rev 1 of this document had the same disease: an adversarial cross-host round found two
high-severity defects in it (a self-contradictory constraint, and a whole crash class outside its
scope). Both are fixed here, and the round is recorded in §14 rather than quietly absorbed — the
document's own error rate is evidence about how much to trust it.

Every claim below is one of:

- **[CODE]** — a direct citation with `file:line`, read from the tree named above.
- **[PROBE]** — an empirically reproduced result. The probe scripts and their raw output are in §13; each drives the *same* production entrypoints the live enforce gates call (`proofStoryDiagnosticInput` → `evaluateProofStoryDiagnostics`), adapted from the harness of `packages/main/tests/red/red-w2c-v1-verdict-invariance.mjs`.
- **[OPEN]** — a decision the auditor must make; it is not settled here.

Nothing in this document is asserted on prose authority alone.

---

## 1. Defect statement

A **malformed versionless** record stored in `.lattice/story/actives/<id>/red-evidence.json`
crashes the LIVE dev/review/done enforce gate with a bare `TypeError`, instead of being
rejected as corrupt or treated as a safe non-satisfier.

The gate modes that make this live, not theoretical — `lattice.config.json`: **[CODE]**

```json
"proofStory": { "devGateMode": "enforce", "reviewGateMode": "enforce", "doneGateMode": "enforce" }
```

Impact class: a corrupt evidence file does not *block* the lifecycle in a controlled way —
it **aborts the command that evaluates the gate**, with a message that names neither the
file, nor the record, nor the missing field.

---

## 2. Verified mechanism

### 2.1 The single crash site

`redEvidenceRecordSatisfied` dereferences `observedFailure` before establishing that it is
a string. On `main` this is the predicate's **first statement**: **[CODE]**

- `packages/main/src/core/proofstory.ts:932` — `if (record.observedFailure.trim().length === 0) return false;`

A repo-wide sweep confirms this is the **only** unguarded dereference of a v1 record field
in production source: **[CODE]**

| Site | Nature |
|---|---|
| `core/proofstory.ts:192` | type declaration (`observedFailure: string`) |
| `core/proofstory.ts:932` | **the dereference — crash site** |
| `core/proofstory.ts:1459` | write path, validated (`requireNonEmptyString`) |

Every other mandatory-field check in the predicate (`proofstory.ts:933-940`) is a truthiness
test or a short-circuited property read, so it is total on arbitrary input. In particular
`greenRelation` is guarded by `!record.greenRelation ||` before `.targetRef` is read, and
`Set.prototype.has` accepts any value. **Within a record, the fix surface is one field, not nine.**

**But the record is not the only trusted shape — see §2.4. The one-field conclusion holds for the
record and does NOT extend to the file envelope.**

### 2.1.1 The parse layer performs no validation at all

`store.readRedEvidence` delegates to a private `readJson` that is a bare parse-and-cast: **[CODE]**

- `packages/main/src/core/store.ts:121` — `candidates.push({ filePath, data: JSON.parse(readFileSync(filePath, 'utf-8')) as T });`

There is no schema, no shape check, and no runtime validation anywhere between `JSON.parse` and the
typed domain. This is the concrete location of the missing trust boundary, and it is the "Parse"
layer of the three-layer model in §6.

### 2.2 Why a malformed record reaches that line on the post-W2c tree

B-506e added an exhaustive schema discriminant. Its **safe** classifier returns `'v1'` for
*any* object lacking a `schemaVersion` member, **without validating the legacy-v1 shape**: **[CODE]**

- `packages/main/src/core/red-evidence/record-v2.ts:196-202` (B-506e tree)

```ts
export function classifyRedRecordSchemaSafe(record: unknown): RedRecordSchemaClass {
  if (typeof record !== 'object' || record === null) return 'unsupported';
  const schemaVersion = (record as { schemaVersion?: unknown }).schemaVersion;
  if (schemaVersion === undefined) return 'v1';
  if (schemaVersion === RED_EVIDENCE_V2_SCHEMA_VERSION) return 'v2';
  return 'unsupported';
}
```

This is correct-as-designed — a genuine v1 record legitimately carries no per-record version
(the FILE carries it). But it means `'v1'` is a **residual class, not a validated class**.

The resulting path on the B-506e tree: **[CODE]**

1. `store.readRedEvidence` classifies every record at load (`core/store.ts:853-874`, loop at `:870`) and throws only for `'unsupported'`. A versionless malformed record classifies `'v1'` and **loads unchanged**.
2. The predicate's two skip guards pass it through: `core/proofstory.ts:948` (`isRedEvidenceV2`) and `:949` (`classifyRedRecordSchemaSafe(record) !== 'v1'`).
3. `core/proofstory.ts:950` dereferences → `TypeError`.

### 2.3 Probe matrix — both trees **[PROBE]**

Identical inputs, driven through the real gate. `pre-W2c` = `main` @ `1847b3af6d`;
`post-W2c` = `story/B-506e` @ `ed6f2cc3eb`.

| # | Stored record | pre-W2c (`main`) | post-W2c (B-506e) |
|---|---|---|---|
| A | well-formed v1 | verdict SATISFIED | verdict SATISFIED |
| B | `{ id: "corrupt" }` | **TypeError** `…undefined (reading 'trim')` | **TypeError** (unchanged) |
| C | `observedFailure: null` | **TypeError** `…null (reading 'trim')` | **TypeError** (unchanged) |
| D | `observedFailure: 123` | **TypeError** `…trim is not a function` | **TypeError** (unchanged) |
| E | record `null` | **TypeError** `…null (reading 'observedFailure')` | typed `RedEvidenceSchemaError` ✅ |
| F | record `"a string"` | **TypeError** | typed `RedEvidenceSchemaError` ✅ |
| G | record `[]` (array) | **TypeError** | **TypeError** (classifies `'v1'`) |
| H | malformed first, well-formed after | **TypeError** | **TypeError** |
| I | well-formed first, malformed after | verdict SATISFIED (silent) | verdict SATISFIED (silent) |
| J | `{ id, observedFailure: "boom" }`, no `greenRelation` | verdict UNSATISFIED | verdict UNSATISFIED |

Also confirmed directly: `classifyRedRecordSchemaSafe({id:'corrupt'})` → `'v1'`, and
`classifyRedRecordSchemaSafe([])` → `'v1'`.

Three findings the intake report did not state:

- **Arrays are classified `'v1'`** (row G). `typeof [] === 'object'`, so the non-object guard misses them. Any total shape guard must reject arrays explicitly.
- **Row I is silent corruption.** `redEvidenceSatisfied` uses `Array.prototype.some()` (`proofstory.ts:947`), which short-circuits. Whether a corrupt store crashes, or passes the gate while carrying corruption, **depends on array order**. Order-dependent gate behaviour is a defect in its own right and must be named in the acceptance tests (§10) — the intake's "mixed legal and corrupt records must not silently ignore the corrupt one" maps exactly onto row I.
- **Row J is the boundary of the blast radius.** A record missing `greenRelation` entirely returns a clean verdict. This confirms §2.1: within a record, only `observedFailure` crashes.

### 2.4 A second, independent crash class: the file envelope

Rev 1 of this document scoped the defect to individual records. That scope was **wrong**. The
`records` array itself is trusted without validation at two sites: **[CODE]**

- `core/proofstory.ts:947` — `(input.redEvidence?.records ?? []).some(...)` assumes `.some` exists
- `core/store.ts:869` (B-506e tree) — `for (const record of data.records ?? [])` assumes iterability

Probing the same live gate with a malformed **envelope** rather than a malformed record: **[PROBE]**

| Stored `records` | pre-W2c (`main`) | post-W2c (B-506e) |
|---|---|---|
| `{}` | **TypeError** `….some is not a function` | **TypeError** `object is not iterable` |
| `"x"` | **TypeError** `….some is not a function` | **`RedEvidenceSchemaError: a record must be an object`** |
| `42` | **TypeError** `….some is not a function` | **TypeError** `number 42 is not iterable` |
| absent | verdict UNSATISFIED | verdict UNSATISFIED |

Two consequences, both worse than rev 1 implied:

1. **This class is entirely outside the record-level fix.** Every option in §6.2 — including full
   per-record schema validation — leaves `records: {}` crashing, because no record is ever reached.
   A fix that only validates records will pass its own acceptance matrix and still ship the bug.
2. **`records: "x"` post-W2c produces an actively misleading diagnostic.** The `for…of` iterates the
   *string's characters*, classifies `'x'` as unsupported, and reports `a record must be an object`
   — blaming a record when the envelope is malformed. A typed error that misidentifies the fault is
   worse for recoverability (§9) than an obvious crash, because it sends the operator looking for a
   record that does not exist.

**The story's scope is therefore "validate the artifact", not "validate the record".**

---

## 3. Pre-existing, not a regression

`git show main:packages/main/src/core/proofstory.ts` shows the predicate on `main` opening
with `record.observedFailure.trim()` at `:932`. Rows B/C/D/G/H reproduce identically on both
trees **[PROBE]**. B-506e strictly *improved* the situation (rows E/F moved from crash to typed
rejection) and its own scope claim — that an **unsupported** record can never crash the gate — is
true and complete. **This audit must not be framed as a B-506e regression.**

---

## 4. Blast radius

### 4.0 The count is volatile, and `grep` is the wrong instrument for it

**This document has asserted a consumer count four times. Every one of them was wrong, usually
within days:**

| Rev | Claimed | How it broke |
|---|---|---|
| rev 1 | **four** — over a five-row table | incomplete sweep: `grep` output accepted through `head` (§14 F3) |
| rev 2 | **seven** | true when written; invalidated by the *sibling* B-506e merge, which added three call sites (found by the INIT reviewer, not by this document — INIT-004, high) |
| rev 4 | **ten** | true when written; invalidated by *this story's own* CHK-006 commit `f342d9464b`, which consolidated the two `handlers/red-evidence.ts` sites into one shared `readRedEvidenceForChain` helper |
| rev 5 | **nine** | the number in §4.1. Re-derive it. Do not trust it either. |

Three unrelated causes — an incomplete sweep, a sibling merge, and the story's own refactor — so the
number is not a property of this subsystem that a document can hold. **Treat every count here as a
dated observation, never as a specification**, and re-derive before relying on one.

The deeper problem is that the instrument which produced all four numbers is itself wrong.
`grep 'readRedEvidence('` finds only what *names* the boundary. It cannot find a consumer that
reaches the boundary **through a shared builder** — and this story's REVIEW round found exactly such
a consumer that four consecutive inventories had all missed: `assertTargetInExpected`
(`handlers/red-evidence.ts`) *called* `proofStoryDiagnosticInput`, which reads the artifact eagerly,
so `red_evidence_binding_set` / `red_evidence_quarantine` / `red_evidence_recover` all hit the read
boundary while containing no `readRedEvidence` of their own. No amount of re-grepping would ever have
surfaced them. (That particular edge has since been severed — see §4.2 — which does not weaken the
example: the instrument is what found it in the first place.)

**The correct instrument: enumerate everything that can REACH the read boundary
(`store.readRedEvidence`, `core/store.ts`), transitively — not everything that mentions it.** In
practice: start at the boundary, take its direct callers (§4.1), then take the callers of every
*shared builder* among those, and repeat to closure (§4.2). The builders that currently launder the
boundary this way are the two `proofStoryDiagnosticInput` functions (`core/machine.ts` — private —
and `handlers/phase-gates.ts` — exported), the handler-local `diagnosticInput`
(`handlers/proofstory.ts`), `readRedEvidenceForChain` (`handlers/red-evidence.ts`) and
`appendControlRecord` (`core/red-evidence/append.ts`). Any new one must be added to §4.2 in the same
commit that introduces it, or the next inventory will be wrong for a fifth time.

#### It then went wrong twice more — *after* this section was written, once inside this story's own tooling

Both were caught in REVIEW rather than by the authors, and both are recorded here on purpose: a
reader who takes only the principle away should also learn how fast it gets violated in practice.

**1. In this document itself (F-006 / F-008, medium).** Commit `0b7217f170` severed the
`assertTargetInExpected` edge one commit after `bc16eaf87f` wrote the §4.2 table describing it, and
§4.2 was left hedging in *future* tense about a change that had already landed. The obvious repair —
delete the stale row — would have been worse than the stale row: the row that should have carried
`red_evidence_binding_set` forward (`readRedEvidenceForChain`) did not list it, so the deletion would
have dropped that command out of the enumeration entirely, reproducing §4.0's own failure mode
*inside the section written to prevent it*. The reviewer caught that before the deletion, not after.
See §4.2.

**2. In this story's regression tooling (F-007, high).** The registration guard in
`packages/main/tests/red/red-b2aa7-chk007-receipt.mjs` compared `lattice.config.json`
`validate.commands` against a **hardcoded allowlist** of receipts. It caught a listed command being
removed, and caught an excluded one being re-added — and was structurally blind to what actually
happened: a new, meaningful receipt (`red-b2aa7-f005-receipt.mjs`, added by CL-003) appearing in
neither list. Absent from the required array, nothing was "missing"; absent from the exclusion array,
nothing was "wrongly registered". `lattice validate` never ran it, and the guard reported complete
coverage. That is precisely §4.0's error transplanted into a different artifact: **a check bound to a
fixed enumeration instead of to the property it exists to guarantee.**

`d01941179e` rewrote it to the §4.0 instrument. The population is now **enumerated from disk** —
every `red-b2aa7-*.mjs` in the directory — and each member must be either registered in
`validate.commands` or explicitly excluded **with a stated reason**; anything else lands in
`undecided` and fails the check. The guard governs itself under the same rule, deliberately **with no
self-exception**, because a carve-out for the checker is the hardcoded exemption being removed.

**The generalisation, which outlives every number in this document: a fixed list is the wrong
instrument wherever the population can grow.** It does not matter whether the population is call
sites, consumers, or test receipts. Enumerate it from whatever *defines* it — the boundary's callers,
the directory listing — and then require every member to be classified. A list that must be
maintained by hand records the last person who remembered; it does not measure the tree.

### 4.1 Direct call sites — **NINE**, re-derived at `d01941179e`

Production source only: `packages/main/src`, excluding the `src/tasks/*-smoke.ts` harnesses and
`packages/main/tests/`. Line numbers are derivation-commit values and *will* drift — **re-locate by
the enclosing symbol.** **[CODE]**

The previous derivation commit (`2c0ef1ca2d`) predates the CL-003 severing (`0b7217f170`), so it
described a tree that is no longer the shipped one. Both this table and §4.2 were re-derived whole at
`d01941179e` — every row and every reacher chain re-walked, not two rows spot-patched. The count is
still nine because CL-003 removed a *builder* call, not a `store.readRedEvidence` call; all nine line
numbers below were re-confirmed exact at that commit, whose own diff touches no file under
`packages/main/src`.

| # | Site | Enclosing symbol | Pre-fix behaviour on a throwing read |
|---|---|---|---|
| 1 | `core/machine.ts:177` | private `proofStoryDiagnosticInput` builder | aborts |
| 2 | `handlers/phase-gates.ts:198` | exported `proofStoryDiagnosticInput` builder | aborts |
| 3 | `handlers/proofstory.ts:391` | handler-local `diagnosticInput` builder | aborts |
| 4 | `handlers/proofstory.ts:1155` | `red_evidence_create` (read-before-append) | aborts — **cannot repair by appending** (§9) |
| 5 | `handlers/proofstory.ts:1205` | `red_evidence_get` | aborts — **cannot inspect** (§9) |
| 6 | `handlers/red-evidence.ts:84` | `readRedEvidenceForChain` — **one** site since `f342d9464b`, two before it | aborts |
| 7 | `handlers/story-review.ts:295` | `story_review` review calculation | aborts |
| 8 | `handlers/story-review.ts:833` | `story_review` advisory render | **caught in that block's own `try`** — rendered `unavailable (<message>)` |
| 9 | `core/red-evidence/append.ts:167` | `appendControlRecord` | aborts |

### 4.2 Reachers that name nothing — what a `grep` cannot see

Every row below reaches the boundary transitively through a builder in §4.1. **None of them would
appear in an inventory built by grepping the boundary's name**, which is why the count kept moving
while the real blast radius did not. Re-derived whole at `d01941179e`. **[CODE]**

| Reached via | Reacher chain | Operator-visible surface |
|---|---|---|
| `core/machine.ts` private builder (#1) | `proofStoryDevGateFailure` ← the three xstate DEV-entry guards `canStartDevGuard` / `canSkipPlanGuard` / `canReenterDevGuard`, and ← the `DEV` branch of `getGuardFailureReason` ← `resolveGuardFailure` ← `transition-orchestrator.ts` | `story_advance` into DEV — PLAN→DEV, the express INIT_CHECK→DEV skip, and the REVIEW/TEST→DEV rollback doors |
| `handlers/phase-gates.ts` builder (#2) | `runReviewToTestPreflightGate`, `runLegacyReceiptTransitionGate` (both via `transition-orchestrator.ts`) | `story_advance` REVIEW→TEST and TEST→DONE |
| `handlers/proofstory.ts` `diagnosticInput` (#3) | `renderGateReport` ← `proofstory_gate_check`, plus four direct callers | `proofstory_gate_check`, `proofstory_contract_set`, `intent_coverage_check`, `done_intent_equivalence_check`, `proofstory_review_completeness_check` |
| `handlers/red-evidence.ts` `readRedEvidenceForChain` (#6) | **`red_evidence_binding_set` directly** — the §1.1.3 binding-freeze read, taken under the chain lock — **and** `findV2Record` ← `appendChainControl` | `red_evidence_binding_set`, `red_evidence_quarantine`, `red_evidence_recover` |
| `core/red-evidence/append.ts` `appendControlRecord` (#9) | `appendChainControl` (`handlers/red-evidence.ts`) | `red_evidence_quarantine`, `red_evidence_recover` |

**Closure.** §4.1 plus the rows above, taken to closure at `d01941179e`, give the complete set of
operator-facing commands that can reach `store.readRedEvidence` — **twelve**:

`red_evidence_get`, `red_evidence_create`, `red_evidence_binding_set`, `red_evidence_quarantine`,
`red_evidence_recover`, `story_review`, `story_advance` (into DEV, REVIEW→TEST, TEST→DONE),
`proofstory_gate_check`, `proofstory_contract_set`, `intent_coverage_check`,
`done_intent_equivalence_check`, `proofstory_review_completeness_check`.

Exactly **three** of those twelve — `red_evidence_get`, `red_evidence_create`, `story_review` — name
the boundary anywhere in their own handler body. The other nine reach it only through a builder. That
ratio is the argument of §4.0 in one line: grepping the boundary's name finds a quarter of the
operator-facing blast radius and reports it as the whole.

#### The row that left this table, and the trap in removing it

Up to `bc16eaf87f` this table carried a sixth row: `assertTargetInExpected`
(`handlers/red-evidence.ts`) reaching the boundary through the `handlers/phase-gates.ts` builder
(#2), on behalf of `red_evidence_binding_set` / `red_evidence_quarantine` / `red_evidence_recover`. A
shared builder pulled in solely for `resolveExpectedRedTargets`, which never reads `redEvidence` at
all. It was the concrete proof that the reach enumeration and the grep enumeration are different
sets — four inventories, all built by grepping, all missed it.

**Post-fix, on the shipped tree, that edge does not exist.** `0b7217f170` (CL-003) replaced the
shared-builder call with the narrow `expectedRedTargetsInput` helper, which reads only the three
fields the resolver actually consumes (`originalIntentSnapshot`, `proofStoryContract`,
`milestoneLedger`); `handlers/red-evidence.ts` no longer imports `proofStoryDiagnosticInput` at all.
This is **settled fact at `d01941179e`, not a pending change** — the earlier text here hedged in
future tense ("row 3 is also expected to leave this table…") because it was written one commit
*before* the severing landed, in a REVIEW round that has since closed.

**Deleting that row was nevertheless the wrong repair on its own, and would have been a regression.**
`red_evidence_binding_set` still reaches the boundary post-CL-003 — **directly**, through
`readRedEvidenceForChain`, the binding-freeze read inside the chain lock. That path *predates*
CL-003, which deliberately left it as the command's one and only artifact read (so which corruption
message the operator sees no longer depends on which of two reads fires first). But the
`readRedEvidenceForChain` row above used to list only `findV2Record ← appendChainControl` and name
only `red_evidence_quarantine` / `red_evidence_recover`. Removing the severed row *without* repairing
that omission would have dropped `red_evidence_binding_set` out of the enumeration entirely —
recreating, inside the very section built to prevent it, the exact §4.0 failure mode: a command that
reaches the boundary while naming nothing, and an inventory that cannot see it. The row now names the
direct call, so the command survives its own reach-path changing.

The durable claim of this section remains the *instrument* in §4.0, never an individual row. Re-derive
against the current tree before relying on any of it, and land any change to the reach graph in this
table **in the same commit that makes it** — the two-commit gap above is exactly how this went stale.

### 4.3 Consequence

With all three gate modes at `enforce`, a corrupt artifact therefore aborts phase advancement at
DEV, REVIEW **and** DONE.

**§4.1 row 8 is the row rev 1 missed**, and it changes the acceptance criteria: one consumer already
swallows the failure and degrades to an advisory string. It does interpolate the error message, so
corruption is not wholly invisible there — but pre-fix it rendered as *"ProofStory Diagnostics
(advisory only): unavailable (…)"*, which reads as "feature not configured", not "your evidence file
is corrupt". A fix that makes the read path throw is therefore *invisible* at that site, and a corrupt
artifact renders as "unavailable" rather than as corruption. §10.4 must assert what `story_review`
shows — silently degrading is the failure mode this whole audit exists to prevent.

**Post-fix, on the shipped tree:** that catch now discriminates the artifact-fault classes and renders
a distinct `CORRUPT — … This is NOT an absent or unconfigured artifact` section; the `unavailable (…)`
wording survives only for errors that are *not* artifact faults. The "Pre-fix behaviour" column in
§4.1 is retained as the audited baseline, not as a description of current behaviour.

---

## 5. Where corruption can come from

The CLI write path **is** validated: `appendRedEvidence` (`core/proofstory.ts:1445-1475`)
enforces `requireNonEmptyString` on `trigger`, `acceptanceTargetRef`, `baselineHeadHash`,
`baselineMaterialHash`, `observedFailure`, and `greenRelation.targetRef`, and validates
`relation` against `VALID_GREEN_RELATIONS`. **[CODE]** On `main` the only writer is
`handlers/proofstory.ts:1095`, which goes through it.

The write path is also **atomic and self-checking**: `writeJsonFile` serializes to a
`.tmp-<pid>-<ts>` sibling, **re-parses it**, then `renameSync`s it into place, cleaning up the temp
file on any failure (`core/store.ts:133-146`). **[CODE]** So an interrupted `lattice` write cannot
leave a truncated or half-written artifact — rev 1 listed that as a corruption source and it is
**wrong**.

A malformed artifact therefore cannot originate from `lattice red_evidence_create` at all. It can
originate from:

1. **manual edit** of `red-evidence.json` (the file is plain JSON in the story dir) — the dominant source, and the one §9's recoverability requirement is about;
2. **external or future tooling** writing the file **non-atomically or without the writer's validation** — B-506e already adds a second writer (`core/red-evidence/append.ts:279`) and W2d/W2e will add the run-record entrypoints;
3. **filesystem-level corruption**, or a bad merge / partial checkout of the story directory;
4. **a hand-authored test fixture** that later gets copied into a real store.

Note also that `requireNonEmptyString` **returns `value.trim()`** (`core/proofstory.ts:246-251`),
so the writer stores the trimmed string: a stored `observedFailure` of `"   "` is unreachable
through the CLI. This matters for §8 OPEN-5.

This matters for the fix's framing: the defect is not "users type bad input", it is
**"the trust boundary between the on-disk file and the typed domain is missing"**. That is
precisely the intake's §五 argument, and this audit endorses it.

---

## 6. Where to fix — layer analysis

### 6.1 The authority question must be settled first

Today **two** sources of schema version compete, and neither is authoritative: **[CODE]**

| Source | Value | Consulted by |
|---|---|---|
| File-level `RedEvidenceData.schemaVersion` (`core/types.ts:2701`) | literal `'proofstory.red_evidence.v1'` | **nothing on the read path** |
| Per-record `schemaVersion` (v2 discriminator) | absent ⇒ v1; exact literal ⇒ v2; else unsupported | `classifyRedRecordSchemaSafe` |

The file-level version is written but never read as an authority. The record-level absence is
read as *evidence of v1*, which is where the bug lives. **[OPEN-1]** The story must state, in one
sentence, which of these is authoritative and what the other one is for. The audit's
recommendation: **the FILE declares the era, the RECORD declares the exception** — i.e. a
versionless record inside a v1-declared file is *claimed* v1 and must then be **validated
against the v1 schema**, not assumed to satisfy it.

### 6.2 The three candidate layers

| Option | Where | Behaviour on `{id:"corrupt"}` | Cost |
|---|---|---|---|
| **A. Predicate-level total shape guard** | `redEvidenceRecordSatisfied`, before `:932` | non-satisfier (`return false`) | minimal; zero verdict movement (§8); leaves corruption invisible |
| **B. `'malformed'` class in the classifier** | `classifyRedRecordSchemaSafe` + read path | typed rejection at load | clean layering; **breaks recoverability** unless §9 is solved |
| **C. Full v1 schema validation at the read boundary** | `store.readRedEvidence` | typed rejection at load | strongest; **largest verdict-movement risk** (§8) and same recoverability problem |

The intake report asks for **one** layer to be picked and justified. This audit agrees, and adds
that A and B/C are not actually interchangeable: **they differ in observable behaviour**, not
just in placement.

- A alone → the gate always produces a verdict; a corrupt record is simply never a satisfier. The story is blocked by `missing_red_evidence` with a diagnosable message. **Corruption is never reported**, only ignored.
- B/C alone → the corrupt file is named at load, but the whole command aborts (§9).

**Audit recommendation: B (or C) as the primary layer, with A retained as defense-in-depth** —
mirroring the shape B-506e already chose for the unsupported class (`core/store.ts:870` rejects at
load; `core/proofstory.ts:948-949` guards the predicate anyway). This keeps the codebase's existing
idiom rather than inventing a second one. **[OPEN-2]** the auditor may prefer A-only for a minimal
change; that is defensible but must be stated as a deliberate acceptance that corruption is
silently tolerated.

---

## 7. Intake corrections

Claims in the intake report that did **not** survive verification. These matter because a story
that inherits them will produce an unshippable acceptance criterion.

### 7.1 The cited sha256 is a phantom — **this is the most important correction**

The intake states:

> Prove it with the byte-identical v1-only diagnostic check used by
> `packages/main/tests/red/red-w2c-schema-failclosed.mjs`
> (expected sha256 across the 5 v1 scenarios: `71c267a0a7372e9679d00b84be2e2b3480151bfa88939bddcae251aa750d95bc`).

Three things are wrong with that sentence: **[CODE]**

1. **Wrong file.** The five-scenario byte-identity check lives in `packages/main/tests/red/red-w2c-v1-verdict-invariance.mjs`, not `red-w2c-schema-failclosed.mjs` (the latter is the unsupported-schema fail-closed RED).
2. **Wrong digest.** The pinned constant is `V1_VERDICT_DIGEST = '2d584cc157e83ebb2f8396735f04d46946f0ba90d18a55d9fb2f263d706a11ec'` (`red-w2c-v1-verdict-invariance.mjs:70`).
3. **The cited digest is not produced by anything.** `71c267a0…` appears only in B-506e's *prose* artifacts — `summary.json#limitations`, `delivery-check.json`, `findings.json#resolvedReason`, `test-evidence.json`. B-506e's own `checklist.json` already records the discrepancy verbatim:

   > "REAL digest = 2d584cc157e83ebb2f8396735f04d46946f0ba90d18a55d9fb2f263d706a11ec … NOTE: the digest cited in the story prose (71c267a0…) is not produced by this or any artifact."

**Consequence:** the new story must **not** copy `71c267a0…`. *(Rev 2 added here that `2d584cc1…` and
the file holding it were "absent from `main`" and that the story should port the harness and re-derive
the baseline. Both statements were falsified by the B-506e merge and by §0.0's rev-3 rewrite, and are
withdrawn in rev 5: `packages/main/tests/red/red-w2c-v1-verdict-invariance.mjs` and its
`V1_VERDICT_DIGEST = '2d584cc1…'` are on `main`, that constant is `main`'s own value, and it must be
used as the invariance baseline and **not re-pinned** — see §0.0.)*
If it copies `71c267a0…`, the check fails and the likely repair — re-pinning the constant — would
destroy the invariance proof. **[OPEN-3]** separately, B-506e shipped prose citing a digest no
artifact produces, and its delivery-check recorded that prose as `verifiedBy` grep. Whether that
warrants a `B-META` finding against the delivery-check gate is a decision for the auditor; it is
out of scope for this fix but it is a live process defect.

### 7.2 Minor line-number drift

The intake cites the classify at `proofstory.ts:950` and the crash at `:951`. On the B-506e tree
the classify is `:949` and the crash `:950`; on `main` the crash is `:932`. **[CODE]** Cosmetic, but
the story should cite `main` line numbers since that is its base.

### 7.3 Correct as stated

The mechanism, the `'v1'`-for-any-versionless-object behaviour, the pre-existing (non-regression)
status, the `enforce` gate modes, and the suggested fix direction are all **verified correct**.

---

## 8. The hard constraint, and where it is under-specified

The intake's hard constraint:

> This MUST NOT change any valid v1 verdict. A record with a non-string `observedFailure`
> previously CRASHED rather than passing, so no store that produced a verdict before may
> produce a different one now.

The reasoning is sound **for the crash class**: a crash is not a verdict, so converting a crash
into `false` cannot move any verdict that ever existed. Option A is therefore provably
verdict-preserving.

**But it does not generalise to Options B and C, and the intake does not notice this.**

The predicate never reads `id`, `trigger`, or `createdAt` — yet all three are mandatory on
`RedEvidenceRecord` (`core/types.ts:2678-2698`). **[CODE]** So a record missing `trigger` or
`createdAt`, but otherwise complete, **satisfies the gate today and returns a verdict, without
crashing**. A full-schema validator (Option C, or a strict Option B) would reclassify it as
malformed and flip that verdict from SATISFIED to UNSATISFIED — **a real verdict change on a store
that previously produced one**, and therefore a violation of the constraint as literally written.

Worse, the proposed proof cannot detect this: all five fixtures in
`red-w2c-v1-verdict-invariance.mjs` are fully well-formed, so the digest is **insensitive** to the
choice between "guard only the dereferenced field" and "validate every mandatory field".
**The byte-identity digest is necessary but not sufficient.**

### 8.1 Rev 1's version of this constraint was self-contradictory

Rev 1 recommended full validation *and* restated the constraint as "no record that previously
produced a SATISFIED verdict may now produce a different one" *and* acknowledged that records
missing `trigger`/`createdAt`/`id` "will flip". Those three statements cannot all hold: the flip
**is** a previously-SATISFIED record producing a different outcome. The cross-host audit caught this
(§14 F1) and it is upheld. A story built on rev 1's §8 would have been unimplementable — any full
validator would violate its own stated invariant on day one.

### 8.2 The two axes that must be decided separately

Rev 1 conflated them. They are independent, and **both** feed the digest question.

**Axis A — validation breadth.**

- **(i) Narrow** — fail closed only on what the predicate dereferences (today: `observedFailure`, plus the §2.4 envelope). Pure crash-elimination: a crash is not a verdict, so **no verdict can move**, and the existing digest proves it.
- **(ii) Full** — validate every mandatory v1 field. Stronger boundary, matches the intake's "typed domain logic may assume its invariants". **Knowingly changes the outcome** for records that are schema-invalid yet currently SATISFIED.

**Axis B — observable form of a rejection**, for whatever Axis A rejects:

- **(a) throw** at the read boundary — no verdict at all (§9 recoverability cost, and `story-review.ts:802` swallows it);
- **(b) non-satisfier** — record silently contributes nothing; gate returns UNSATISFIED via the ordinary `missing_red_evidence` gap;
- **(c) quarantine** — `records` stays clean, malformed entries surface in a separate reported list; gate fails closed *and* stays diagnosable.

**Axis B decides whether the pinned digest moves, independently of Axis A.** Under (b) a rejected
record produces the same `missing_red_evidence` gap that already exists, so the FULL diagnostic
report — and therefore `2d584cc1…` — is unchanged. Under (a) or (c) the report gains a new
error/diagnostic shape, and the digest **will** move for any fixture containing a rejected record.
None of the five pinned fixtures contains one, so the digest is stable for all three today — but
that is a property of the fixtures, not of the design, and any new fixture must be checked.

### 8.3 The constraint, correctly stated

**[OPEN-4a / OPEN-4b]** Whichever pair is chosen above, adopt this wording — it is satisfiable under all four combinations:

> No record that is **well-formed under the legacy v1 schema** and that previously produced a
> SATISFIED verdict may produce a different outcome. Records that are **not** well-formed may change
> outcome; every such change must be enumerated and justified before merge.

Under (i) the second sentence is vacuous — nothing changes. Under (ii) it is the licence for the
`trigger`/`createdAt`/`id` flip, and it carries an obligation: **a migration check that scans real
story directories for records that are currently SATISFIED but schema-invalid.** If that set is
empty in practice, (ii) is free; if it is not, each hit must be dispositioned. The story cannot
claim (ii) without running that scan — otherwise "no valid verdict moved" is an assumption, not a
proof, and the digest cannot detect the difference (all five fixtures are well-formed).

The audit's recommendation is **(ii) + (c)**: full validation, quarantined rather than thrown. (i)
leaves the same bug class latent for the next field a future predicate dereferences; (a) breaks
recoverability; (b) fails closed but reports nothing, which is the silent-corruption failure mode of
§2.3 row I in a new costume.

### 8.4 [OPEN-5] Blank `observedFailure` — rev 1 mislabelled this

Rev 1 asserted `""` / `"   "` must be classified *well-formed but unsatisfying*. The cross-host
audit refuted the label (§14 F4) and it is upheld: the canonical writer rejects both
(`requireNonEmptyString`, `core/proofstory.ts:246-251`, which also **trims**, so a stored `"   "`
cannot originate from the CLI at all). Calling it "well-formed" would force the read validator to
contradict the write schema purely to preserve a hand-authored fixture.

The correct framing is a third category:

> `""` / `"   "` are **legacy-tolerated input**: not well-formed under the write schema, but
> historically accepted by the read path and treated by the predicate as an ordinary non-satisfier
> (`proofstory.ts:932`). They must keep producing UNSATISFIED **with no new diagnostic**, because
> fixture 3 of the invariance test depends on that exact report shape.

Concretely this means Axis B option (b) for this sub-case even if (c) is chosen generally — blank
`observedFailure` must **not** be quarantined or reported, or `2d584cc1…` moves. This is the one
place where the digest genuinely constrains the design, and rev 1 got the reason right while getting
the vocabulary wrong.

---

## 9. Recoverability — a requirement the intake omits

If the fix rejects at the read boundary (Options B/C) by **throwing**, it inherits a problem that
B-506e already has for the unsupported class. Verified: **[PROBE]**

```
v3 unsupported:      readRedEvidence THREW RedEvidenceSchemaError
versionless corrupt: readRedEvidence OK (records=1)
```

Because `red_evidence_get` and `red_evidence_create` (both in `handlers/proofstory.ts`; §4.1 rows 5
and 4) call `store.readRedEvidence`, a throwing read path means:

- **you cannot inspect the corrupt file through the CLI** — the diagnostic command is the first thing that breaks;
- **you cannot repair it by appending a good record** — the append reads first;
- the only remaining repair is hand-editing JSON, which is how the file got corrupted in scenario (1) of §5.

The intake's own acceptance list says the error must contain "path, record index/ID and missing
fields" and that "retry after repairing the file works". Those two requirements are in tension with
a bare throw at the read boundary. **[OPEN-6]** the story must decide: either (a) the typed
rejection carries file path + record index + failing field and `red_evidence_get` is given a
raw/diagnostic mode that bypasses validation, or (b) the read path quarantines malformed records
into a separate list (`records` stays clean, `malformed[]` is reported) so the gate fails closed
while the CLI stays usable.

---

## 10. Acceptance test matrix

Repo-anchored version of the intake's §七. Ships under `packages/main/tests/red/`, registered in
`lattice.config.json → validate.commands` alongside the existing `red-evidence-*-smoke` entries.
Every row must be driven through `proofStoryDiagnosticInput` → `evaluateProofStoryDiagnostics`
(the live gate pair), not through the predicate in isolation.

### 10.1 Valid records — must be unchanged

| # | Case | Expected |
|---|---|---|
| V1 | well-formed legacy v1, no per-record `schemaVersion` | SATISFIED, unchanged |
| V2 | valid v2 record | unchanged (skipped by the v1 predicate) |
| V3 | `observedFailure: "   "` (blank) | **UNSATISFIED, no new diagnostic** — legacy-tolerated, not quarantined (§8.4) |
| V4 | foreign `acceptanceTargetRef` | non-satisfier, unchanged |
| V5 | five-scenario FULL diagnostic digest | **`2d584cc1…`, the existing `V1_VERDICT_DIGEST` in `red-w2c-v1-verdict-invariance.mjs`** — it is `main`'s own value since the B-506e merge, so it is used as the baseline and **must not be re-pinned or re-derived** (§0.0). Never `71c267a0…` (a phantom). *(Rev 5: this row said "NOT `2d584cc1…`, derive your own" — a rev-2-era instruction that §0.0's rev-3 rewrite had already superseded and that this row kept citing §0.0 in support of.)* |

### 10.2 Malformed records — must fail closed, never crash

| # | Case | Probe today |
|---|---|---|
| M1 | `{ id: "corrupt" }` | TypeError (row B) |
| M2 | `observedFailure` missing | TypeError |
| M3 | `observedFailure: null` | TypeError (row C) |
| M4 | `observedFailure: 123` | TypeError (row D) |
| M5 | record is `null` | typed on B-506e, TypeError on `main` (row E) |
| M6 | record is a string | typed on B-506e, TypeError on `main` (row F) |
| M7 | **record is an array** | TypeError — classifies `'v1'` (row G) |
| M8 | `Object.create(null)` / prototype-inherited `observedFailure` | must not be accepted via the prototype chain |
| M9 | mandatory-but-never-dereferenced field missing (`trigger` / `createdAt` / `id`) | SATISFIED — **this row is the Axis-A decision's witness (§8.3)** |

### 10.2.1 File envelope — the class rev 1 omitted (§2.4)

A record-only validator passes every row above and still ships these. **[PROBE]**

| # | Case | Probe today (pre-W2c / post-W2c) |
|---|---|---|
| E1 | `records: {}` | TypeError `.some is not a function` / TypeError `not iterable` |
| E2 | `records: "x"` | TypeError / **misleading** `RedEvidenceSchemaError: a record must be an object` |
| E3 | `records: 42` | TypeError / TypeError `not iterable` |
| E4 | `records` absent | UNSATISFIED (must stay) |
| E5 | file root is not an object (`[]`, `"x"`, `null`, `42`) | pre-fix: **WORSE than "crashes"** — read as ABSENT, see below. **Must be rejected as an ENVELOPE fault naming the artifact path — it must never read as an absent artifact** |
| E6 | file-level `schemaVersion` missing / unknown | **must not silently degrade to v1** (§6.1 authority rule) |
| E7 | file is not valid JSON | typed error naming the path (today: raw `SyntaxError` from `store.ts:121`) |

E2 is the sharpest crash; **E5 is the sharpest silence.** Probed on current `main`: **[PROBE]**

```
root []      -> returned []   (typeof object)
root "x"     -> returned "x"  (typeof string)
root null    -> returned null (typeof object)
root 42      -> returned 42   (typeof number)
invalid JSON -> THREW raw SyntaxError   (E7 confirmed: it escapes untyped)
```

**Pre-fix**, none of these crash. They flow into the typed domain as the raw parsed value, and every
consumer then reads `?.records ?? []` and concludes **there is no red evidence**. So a corrupt artifact
is *indistinguishable from an absent one*: the gate reports `missing_red_evidence` and
`red_evidence_get` reports "not configured". It fails closed for the gate — but it fails **silently and
misleadingly** for the operator, which is the same defect class as the `story_review` degradation in §4.
A validator that only prevents crashes would leave this untouched.

**Post-fix, on the shipped tree, this row no longer describes current behaviour** — stated here
explicitly because rows E4 and E6 carry their post-fix requirement and E5 originally did not, which
left a reader to conclude a non-object root is still silently misread as absence.
`validateRedEvidenceEnvelope` (`packages/main/src/core/red-evidence-artifact-validation.ts`) now
throws a typed `RedEvidenceArtifactError` with fault code `root_not_object` for every
non-plain-object root (`[]`, `"x"`, `null`, `42`), naming the artifact path and the actual value
type. The probe block above is retained as the pre-fix baseline it was.

### 10.3 Ordering — the silent-corruption row

| # | Case | Requirement |
|---|---|---|
| O1 | malformed **first**, satisfying after | no crash; corruption reported |
| O2 | satisfying **first**, malformed after | `some()` short-circuits today (row I) — **the outcome must not depend on array order** |

### 10.4 Gate and consumer behaviour

DEV / REVIEW / DONE enforce gates each return a controlled failure; the story phase does not
advance; the diagnostic names the file path, the record index or id, and the offending field; no
raw stack trace is surfaced; and repairing the file lets the same command succeed on retry (§9).

Additionally, **every consumer enumerated in §4.1 *and* §4.2 must be asserted, not just the gates.**
The assertion list is derived from that enumeration, never from a count (§4.0) — rev 4 corrected the
count in §4 and left this table at its original three rows, which is exactly how a "complete" fix
ships with uncovered consumers:

| # | Consumer | Requirement |
|---|---|---|
| C1 | `red_evidence_get` | must **display** the corruption, not abort (§9) |
| C2 | `red_evidence_create` (the read-before-append repair path) | must either repair-by-append or refuse with an actionable message — never a bare abort |
| C3 | `story_review` advisory path (`handlers/story-review.ts`, the read inside the advisory render's own `try`/`catch`) | must **not** silently render "unavailable"; corruption must be distinguishable from absence |
| C4 | the chain commands, which reach the boundary only through helpers rather than a read of their own — `red_evidence_binding_set`, `red_evidence_quarantine`, `red_evidence_recover` (§4.2) | must surface corruption in the same vocabulary as C1/C2, not as an incidental abort inherited from a shared builder. A helper that reaches the boundary for data its caller does not need is itself the defect — **on the shipped tree that helper (`assertTargetInExpected`) no longer reads the artifact at all (`0b7217f170`)**, and all three commands now reach the boundary through exactly one path, `readRedEvidenceForChain`, which attaches the repair guidance (§4.2) |
| C5 | the phase-gate reachers: `story_advance` into DEV, REVIEW→TEST, TEST→DONE (§4.2) | a corrupt artifact must produce a named, gate-shaped failure, never a raw read-boundary throw |

C3 is the row that would otherwise let the fix look complete while a real store degrades silently.
C4 and C5 are the rows a count-based inventory keeps missing, because neither surface names the read
boundary anywhere in its own source (§4.0).

The assertion list is the **§4.2 closure** — twelve operator-facing commands at `d01941179e` — and
not any count. C4's own reach path moved *during this story's REVIEW round* while the set of three
commands it covers did not change, which is why these rows are stated as operator-visible surfaces
rather than as call sites: a surface survives its own plumbing being rewritten.

### 10.5 Safety properties

Malformed data can never satisfy the red-evidence predicate; the validator itself cannot throw on
any JSON shape (fuzz it with the M-rows plus nested/cyclic-free arbitraries); an unknown future
`schemaVersion` still does **not** degrade into `'v1'` (B-506e's property, must not regress).

---

## 11. Story framing

The intake's proposed retitle is endorsed in spirit, but "records" understates the scope now that
§2.4 has established an independent envelope crash class. Recommended:

> **Validate the legacy v1 red-evidence artifact before enforce-gate evaluation**

with the acceptance stated as *"a corrupt evidence file makes the gate fail closed with a
diagnosable, repairable error — it never crashes"*, so the implementation is not pre-constrained to
a single predicate edit.

Lifecycle: material code change → full story, repro-first RED (the committed regression that throws
today) before the fix, per this repo's Proof-or-Stop lifecycle.

Priority: agreed — **above** the duplicate-validate-command, command-catalog enum, and reopen-reason
items, because this one aborts a live DEV/REVIEW/DONE gate.

---

## 12. Decisions

Settled 2026-07-26. `DECIDED` rows are binding on the story; the single `OPEN` row is out of scope.

| # | Question | § | Status | Decision |
|---|---|---|---|---|
| D-1 | Authority of the schema version | §6.1 | **DECIDED** | The **file declares the era, the record declares the exception**. A versionless record inside a v1-declared file is *claimed* v1 and must be validated against the v1 schema, never assumed to satisfy it. |
| D-2 | Fix layer | §6.2 | **DECIDED** | **Read-boundary validation primary, predicate guard as defense-in-depth.** Since the B-506e merge this two-layer shape **already exists on `main`** for the unsupported-schemaVersion class (§0.0), so this story **extends** it to the envelope and to shape-validating the `'v1'` residual class rather than establishing it. *(Corrected in rev 4 — rev 3 left this row contradicting its own rewritten §0.0; caught as INIT-006.)* |
| D-3 | Axis A — validation breadth | §8.2 | **DECIDED** | **(ii) Full** — validate every mandatory v1 field, not only the dereferenced one. |
| D-4 | Axis B — rejection form | §8.2 | **DECIDED** | **(c) Quarantine** — `records` stays clean, malformed entries surface in a separate reported list. The gate fails closed *and* stays diagnosable. Throwing is rejected (breaks §9); silent non-satisfier is rejected (re-creates §2.3 row I). |
| D-5 | Blank `observedFailure` | §8.4 | **DECIDED** | **Legacy-tolerated**: keeps producing UNSATISFIED with **no new diagnostic** and is **never quarantined** — the one sub-case where D-4 is overridden, because fixture 3 of the invariance test depends on that exact report shape. |
| D-6 | Recoverability | §9 | **DECIDED** | Follows from D-4: quarantine keeps `red_evidence_get` / `red_evidence_create` / `story_review` usable on a corrupt artifact. |
| D-7 | Migration scan | §8.3 | **DECIDED — REQUIRED** | Before merge, scan real story directories for records that are currently SATISFIED but schema-invalid. Every hit is dispositioned in the story. **Without this scan, "no valid verdict moved" is an assumption — the pinned digest cannot detect the difference, since all five fixtures are well-formed.** |
| D-8 | Scope | §2.4 | **DECIDED** | **The artifact** — file envelope *and* records. A record-only fix passes its own acceptance matrix and still ships the §2.4 crash class. |
| OPEN-3 | Does B-506e's phantom-digest prose warrant a `B-META` finding against the delivery-check gate? | §7.1 | **OPEN** | Deferred. **Out of scope for this story** — it is a process defect in the delivery-check gate, not in the red-evidence subsystem. |

### 12.1 What D-7 obliges the story to prove

D-7 is the only decision that can fail late, so it is stated as an explicit obligation:

1. Enumerate every `red-evidence.json` reachable in real story directories.
2. For each record, compute *(current verdict, verdict under full v1 validation)*.
3. The story may merge only if that set is empty **or** every non-empty entry is individually justified in the story record.
4. The result is reported even when empty — "scanned N artifacts, 0 affected" is the evidence; silence is not.
5. The re-run at merge time is what `lattice validate` does, so the scan must be **registered** in
   `lattice.config.json` `validate.commands`; an unregistered scan is a silent D-7 failure that looks
   identical to a passing one. That registration is itself guarded by a **derived** completeness check
   rather than a hardcoded list of expected entries — see §4.0, where relying on the hardcoded version
   is how a receipt went unrun without anything reporting a gap.

---

## 13. Appendix — reproduction

Probe script: `probe-malformed-v1.mjs` (adapted from `red-w2c-v1-verdict-invariance.mjs`; writes
only to a throwaway `TMPDIR` store root, touches no repository state). It is **audit scaffolding,
not a committed test** — it currently lives in this session's scratchpad; the story's committed
regression under `packages/main/tests/red/` supersedes it and must stand on its own.

```bash
node probe-malformed-v1.mjs /Users/jek/Documents/Work/proofbound/packages/main                     # pre-W2c (main)
node probe-malformed-v1.mjs /Users/jek/Documents/Work/proofbound/.worktrees/B-506e/packages/main   # post-W2c
```

Raw output, post-W2c tree:

```
classifySafe({id:"corrupt"}) = v1
classifySafe(null)           = unsupported
classifySafe("a string")     = unsupported
classifySafe([])             = v1

A. baseline well-formed v1              -> verdict: missingRedEvidence=SATISFIED
B. {id:"corrupt"}                       -> THREW TypeError: Cannot read properties of undefined (reading 'trim')
C. observedFailure: null                -> THREW TypeError: Cannot read properties of null (reading 'trim')
D. observedFailure: 123                 -> THREW TypeError: record.observedFailure.trim is not a function
E. record === null                      -> THREW RedEvidenceSchemaError: a record must be an object
F. record === "a string"                -> THREW RedEvidenceSchemaError: a record must be an object
G. record === [] (array)                -> THREW TypeError: Cannot read properties of undefined (reading 'trim')
H. malformed FIRST, well-formed after   -> THREW TypeError: Cannot read properties of undefined (reading 'trim')
I. well-formed FIRST, malformed after   -> verdict: missingRedEvidence=SATISFIED
J. greenRelation missing entirely       -> verdict: missingRedEvidence=UNSATISFIED
```

On the pre-W2c (`main`) tree rows B/C/D/G/H/I/J are identical; rows E and F also throw a bare
`TypeError` there.

A second probe, `probe-envelope.mjs`, covers §2.4 (malformed `records` envelope) on both dists; its
output is tabulated in §2.4 and §10.2.1.

---

## 14. Audit trail — cross-host adversarial round (rev 1 → rev 2)

Rev 1 was submitted to an independent cross-host (codex) reviewer with an explicit falsification
brief: verify every `[CODE]` citation against the tree, re-derive every `[PROBE]` result, and attack
the three load-bearing claims. It ran read-only; the repository was verified unmodified afterwards
(`git status` clean apart from this document, `HEAD` unchanged, B-506e worktree clean).

It returned six findings. **All six were independently re-verified here and upheld.** None was
accepted on the reviewer's authority alone.

| # | Sev | Finding | Rev-2 disposition |
|---|---|---|---|
| F1 | high | §8 was **self-contradictory**: it forbade any previously-SATISFIED verdict from changing while simultaneously licensing exactly that flip under full validation | §8 rewritten (§8.1-8.3): constraint scoped to *well-formed* records, flip made explicit and conditioned on a migration scan (OPEN-7) |
| F2 | high | §2.1's "one field" scope missed the **file envelope**: `records` is trusted as an array at `proofstory.ts:947` and `store.ts:869` | New §2.4 + §10.2.1, both probe-backed. Scope of the story widened from "record" to "artifact" (OPEN-8) |
| F3 | medium | §4 said "four call sites" over a five-row table; there were **seven** *as of rev 2* (the count has moved twice since — §4.0), including two in `story-review.ts` | §4 corrected. The `story-review.ts` advisory-render site **catches** the error and renders "unavailable" — added as acceptance row C3 |
| F4 | medium | §8 OPEN-5 called blank `observedFailure` "well-formed", contradicting the writer's own schema | Reframed as **legacy-tolerated input** (§8.4); the digest constraint it implies is unchanged |
| F5 | low | §5's "partial / interrupted write" overstated the risk — `writeJsonFile` is tmp + reparse + atomic rename | §5 corrected with the citation |
| F6 | low | The B-506e cross-check tree is a **live worktree that moved during the audit** | Header now records all three HEADs and requires a pinned commit for re-verification |

Claims the reviewer checked and **cleared**: §2.1's narrow per-record claim (no second unguarded v1
field dereference in production source); §2.3 rows G and I; all three parts of §7.1's phantom-digest
claim, verified by *running* the invariance test and observing `2d584cc1…`; §8's factual predicate
claim (`id`/`trigger`/`createdAt` are never read, and such a record probes SATISFIED); §9's
recoverability claim; and all A-J probe outcomes, reproduced on both dists.

Two things worth recording about the round itself:

- **F2 and F3 were both caused by the same error on my side** — accepting a truncated `grep` and a single-file sweep as exhaustive. Every inventory claim in rev 2 was re-run without `head`.
- **F2 turned out to be worse than reported.** Probing it produced a case the reviewer did not raise: post-W2c, `records: "x"` iterates the *string's characters* and reports `a record must be an object` — a typed error that blames a nonexistent record for an envelope fault (§2.4).

# Validation Evidence Artifact Growth (B-3434 CHK-004)

Disposition: outcome B (committed rationale). The reduction ships; the byte-for-byte agreement between the measured size and the file on disk does not.

Story: B-3434, "Remove the one-mebibyte execFileSync limit that makes validation evidence unpersistable".

## Decision after B-3434

Decision: decline the writer-owned canonical boundary as not currently justified. No follow-up story is planned or owned.

B-3434 remains accepted. Its shipped ceiling, reduction, refusal path, diagnostics, regression coverage, measurements and historical findings are unchanged by this later decision. The limitations below remain technically real, but they are known boundaries rather than required unfinished work.

The proposed boundary would ensure that one serialised byte string is both measured and written. That is narrower than input integrity: it does not establish input consistency, semantic consistency or evidence truth, and it cannot make a changing getter, Proxy, `toJSON` implementation or concurrent mutation represent one coherent logical state. The current production path constructs fresh plain JSON-compatible records, and no real production input is known to trigger the synthetic divergence routes recorded below. A cross-file refactor of `core/store.ts`, `validation-executor.ts` and `verifier.ts` is therefore disproportionate to the observed risk.

Reconsider only if evidence changes the risk profile: the production path begins accepting stateful or untrusted record objects; the store serialisation format changes independently; normal validation evidence repeatedly approaches the configured advisory or bound; a real measure/write mismatch occurs; or a release, compliance or threat-model requirement demands a hard on-disk byte bound. Reconsideration requires a new human-approved story; this document is not an active work order.

## Why this document exists

CHK-004 required a binding outcome, not an evaluation:

> This item requires a BINDING outcome, not an evaluation: either the bounding ships in this story, or a committed rationale records why unbounded growth is acceptable and names the change that will address it. Closing this item with a written opinion and no shipped consequence is exactly the unexamined growth cliff this story exists to end.

Both halves of that disjunction were answered during B-3434, and they were answered differently, because the item and the defect are not the same size. The growth dimension CHK-004 names is bounded and regression-tested; that part shipped. What did not ship is the property that would make the bound a guarantee - that the number the code measures is the number of bytes `StoryStore` writes. Routes by which those diverge were measured, and closing them would require editing `packages/main/src/core/store.ts`, which was outside B-3434's `allowedModify`.

This document preserves that closeout rationale and its transcripts. The later decision above supersedes only its follow-up posture; it does not erase the findings or claim the missing property was delivered.

## What ships

The bounding is real code on the executed path, not a proposal.

**The mechanism.** `boundPersistedValidationEvidence` in `packages/main/src/core/validation-executor.ts` builds the record a write site would write, serialises it in the format `core/store.ts` uses today, counts those bytes, and drives a staged reduction against that count rather than against the inner `output` string. The second stringify was the point: `StoryStore` escapes the output string again on the way to disk, so quote-heavy captured output roughly doubles - measured at x1.99 with 400 commands. Four dispositions come out - `unmodified`, `reduced`, `verdict_only`, `refused` - and which one applies is decided by a measurement rather than by an estimate of one.

**The thresholds**, all derived from the metadata blob read ceiling rather than chosen beside it:

| | bytes |
| --- | --- |
| read ceiling (`METADATA_BLOB_READ_MAX_BUFFER_BYTES`) | 33,554,432 |
| advisory (25% of ceiling) | 8,388,608 |
| bound (75% of ceiling) | 25,165,824 |

**The refusal is wired.** All three evidence write sites in `packages/main/src/handlers/verifier.ts` - the reuse path (`reusedBound`), the non-git FAIL fallback (`fallbackBound`), and the git path (`persistedBound`) - refuse the write when `withinBound` is false or the record is null, and return a structured failure naming the measured size and the bound. `packages/main/src/tasks/validation-evidence-buffer-smoke.ts` reads that source and asserts that every record written comes from a bound whose own `withinBound` was gated, so an edit that gates one computation and writes another is caught by name.

**The mutation catches are genuine.** The test-coverage lane reproduced all four of the mutation-catches this story's regression suite claims, in a disposable worktree, and got back the exact quoted failure messages in each case. That is worth stating plainly next to the sections below: what the suite claims to catch, it catches. The gap is in what it was never looking at, and that is described under "Known limitations retained from B-3434" and in the "Known limitations" table.

**The measured numbers**, from `node packages/main/dist/tasks/validation-evidence-buffer-smoke.js`:

| fixture | result |
| --- | --- |
| 100 commands x 12,000 chars (today's repository shape) | 2,520,044 bytes, `unmodified`, `within_budget`, output byte-identical to the pre-story serialisation |
| 400 commands of all-quote output | 38,878,844 bytes unbounded, past the 33,554,432 read ceiling; 19,617,042 bytes after reduction, `reduced` |
| 300 commands x 100,000 chars | 148,993 bytes, `reduced`; 300 command outputs and 250,200 detail lines replaced by counted markers |
| 180,000 heterogeneous detail entries | 16,029,900 bytes, `reduced`, 180,001 detail lines kept - a reducible artifact is reduced, not discarded for a stub |
| bulk in a field the reducer does not model | 945 - 1,115 bytes, `verdict_only`, still carrying `allPass` and `status` and naming itself a replacement |
| 200,000-entry `verificationCoverage` | 53,489,886 bytes, `refused`; nothing is written and the operator text reads as a refusal |
| the hash-field window | 25,165,823 bytes admitted without `headHash` / `materialHash` / `storyFilesHash`, `refused` with them - the 232-byte delta is inside the number the gate reads |

**The growth dimension CHK-004 names is covered.** That dimension is the NUMBER of configured `validate.commands` entries serialised into `test-evidence.json`. The incident artifact measured 1,369,692 bytes at 100 entries, after the list grew from 56 to 100 in a single day, against a 1,048,576-byte read ceiling that then blocked every REVIEW to TEST transition in the repository. The same 100-entry shape now measures 2,520,044 bytes against a 33,554,432-byte ceiling and needs no reduction; a 400-entry quote-heavy shape that would serialise at 38,878,844 is brought to 19,617,042. Raising the ceiling alone would have moved the cliff; the reduction plus the advisory at 8,388,608 bytes is what marks it.

**Against the real writer.** The behaviour reviewer measured all four dispositions through the actual `StoryStore.writeTestEvidence`, and the reported byte counts match what lands on disk today: `unmodified` 277, `reduced` 667, `verdict_only` 599, `refused` 27,263,587 (with no file written). That agreement is a fact about the code as it stands today, not a property the code maintains - which is the subject of the next section.

## Known limitations retained from B-3434

A guarantee did not ship. The number `boundPersistedValidationEvidence` reports and the bytes `StoryStore` writes agreed at B-3434 closeout. Two routes by which they can come apart inside the bounding itself are set out below; a third, at the `verifier.ts` caller, is B-3434:F-037 in the retained list. This section does not claim to enumerate every possible route and does not present them as currently assigned work.

### 1. The serialisation format is duplicated, and the smoke's pin is self-referential

`measurePersistedEvidenceBytes` re-types the formula that `packages/main/src/core/store.ts` owns:

```ts
// packages/main/src/core/store.ts, writeJsonFile
const serialized = JSON.stringify(data, null, 2) + '\n';
```

The smoke does not import `StoryStore`. It re-types that same formula a third time inside the test and asserts that the two hand-written copies agree with each other. So a format change in `store.ts` does not fail anything: it moves the writer while both copies stay where they are, and the measurement reads low by exactly the amount the writer added.

The cross-vendor reviewer proved it by construction, on a two-space to four-space change:

```
smokeExpected=158 measured=158 hypothetical4SpaceStore=168 smokeStillPasses=true
```

The concept lane found the same defect independently and filed it as B-3434:F-033, quoting the sentence in `measurePersistedEvidenceBytes` that had claimed otherwise:

> The smoke pins the format so the drift fails a test rather than a phase gate.

That sentence was false when it was written. It is deleted in this story, and the docstring now says the format is duplicated and unpinned.

### 2. The returned record shares a prototype chain with the process

`snapshotPersistedRecord` serialises the record, counts the text, and hands back `JSON.parse` of that same text, so the returned graph has no OWN `toJSON`, getter or Proxy trap - an own accessor no longer gets to answer one way for the measurement and another for the write. But `JSON.parse` returns objects whose prototype is the live `Object.prototype`, so a `toJSON` installed there is still consulted when the writer serialises.

The cross-vendor reviewer demonstrated this through the real store, against the 25,165,824-byte bound:

```
inherited-toJSON-real-store: calls=3 reported=67 withinBound=true disk=31457342 exceedsBound=true
```

The record builder in that fixture was a fresh plain object literal. Only `Object.prototype.toJSON` supplied the changing behaviour. So the claim that the returned graph "has no second opinion left to give" was wider than the code, and it has been narrowed to what the mechanism does: it removes own properties, and it does not survive an inherited `toJSON`.

## Historical proposal: writer-owned canonical boundary

B-3434 closeout proposed **a writer-owned canonical boundary**: one component, owned by `packages/main/src/core/store.ts`, that serialises a record to text, measures that text, and writes those exact bytes. Callers would hand it a record and get back either the byte count that was written or a refusal; they would not serialise for themselves.

That design would remove both byte-divergence routes structurally rather than by assertion:

- there is one serialisation instead of two, so there is no format to duplicate and nothing for a `store.ts` change to drift away from;
- the measured text and the written text are the same string, so an inherited `toJSON` - or a getter, or any other value that answers differently on a second reading - is consulted once and the reading that is measured is the reading that lands.

It would also answer B-3434:F-037 at the byte boundary: a source check that looks for names in a caller's text is blind to an ordinary mutation of the record those names refer to, and no amount of additional substring matching fixes that. This remains a byte-identity property only. It would not prove that the arriving record is internally consistent, semantically correct or trustworthy.

It would not, however, make B-3434:F-036 moot. The boundary would remove the separate measure-then-write step associated with B-3434:F-033, B-3434:F-037 and the inherited-`toJSON` route. It would not touch `boundValidationEvidenceOutput`'s reduction loop, which was measured evaluating 5 search-phase snapshots plus 1 terminal one before a final candidate is chosen - all of it inside `validation-executor.ts`, upstream of any writer. The cheap/expensive split B-3434:F-036 concerns the parse-back snapshot (`snapshotPersistedRecord`), not the stringify: the loop consumes only `.bytes` from the snapshots it takes, while the terminal call rebuilds its result. Any future reconsideration would need one canonical measurement source rather than another copy of `measurePersistedEvidenceBytes`; no such work is currently scheduled.

**The proposal required modifying `packages/main/src/core/store.ts`, which was outside B-3434's `allowedModify`.** That was the reason for the original deferral, and it was different from "we ran out of time". Work on one side of the boundary could not build a property owned by both serialisations. This historical scope explanation remains valid even though the later decision declines the proposal on present value and risk.

If a reconsideration trigger is met and a human approves a new story, the earlier candidate scope was `packages/main/src/core/store.ts`, `packages/main/src/core/validation-executor.ts` and `packages/main/src/handlers/verifier.ts` together. That historical candidate does not reserve scope or create an obligation now.

The historical candidate surface also included a row-level guard for the retained ids. The check in `packages/main/src/tasks/validation-evidence-buffer-smoke.ts` matches each id as a substring anywhere in this file, so it does not prove a particular table row remains. The test-coverage lane measured the weakness: deleting a retained-table row still passed for F-033, F-036 and F-037 because each id occurred on 2, 1 and 5 other lines respectively; deleting F-035 failed only because the row was then its sole full-id mention. This document keeps the rows as audit context; strengthening that guard is not assigned work under the declined decision.

## Known limitations

| id | severity | what remains technically true |
| --- | --- | --- |
| B-3434:F-033 | medium | The serialisation format is duplicated from `core/store.ts` and the smoke's apparent pin is self-referential, so a format change there drifts both copies together and every assertion keeps passing. Raised by the concept lane and, independently, by the cross-vendor reviewer. |
| (cross-vendor, unfiled) | major | `JSON.parse` returns objects with a live `Object.prototype`, so an inherited `toJSON` defeats the snapshot even for a record built as a plain object literal. Transcript above. It was not filed under a `B-3434:F-` id and remains historical audit context. |
| B-3434:F-035 | medium | `finish()` is the single exit and it does structurally force a null record to `refused`. But it takes `record` and `fileBytes` as two independent trusted parameters and does not re-derive the count from the record it is handed, so their agreement is convention. A future disposition, or a field patched onto an already-built record, reintroduces the divergence silently. |
| B-3434:F-036 | medium | The uniform snapshot on every disposition is paid for and, per the quality lane's trace, buys nothing: the reduction loop discards `.record` and consumes only `.bytes`, and the terminal call rebuilds and re-snapshots from scratch, so the plain-data property of the returned record comes entirely from that terminal call. Historical cost: smoke wall-clock from 9.9s to 17.9-18.5s (behaviour lane) and 18.9-19.5s across three runs (test-coverage lane), roughly 14x margin under the 270s per-command timeout. Optimising it is not scheduled; if reconsidered, its measurement source must not recreate the duplicated boundary described above. |
| B-3434:F-037 | medium | The F-029 source check is blind to in-place mutation of the record between the gate and the write. It verifies that four literal substrings exist somewhere in `persistStoryValidationEvidence`'s text, which a mutation of an already-gated record does not disturb. The test-coverage lane reproduced it in a disposable worktree with one line inserted at `packages/main/src/handlers/verifier.ts:975-984`: `persistedBound.record.output += 'x'.repeat(60 * 1024 * 1024)`. That mutates an existing typed field - no `as any`, zero new `tsc` errors - and `validation-evidence-buffer-smoke: PASS` was unaffected. It is the F-014 / F-027 shape reappearing one level up, at the `verifier.ts` caller. |

Historical sizing for F-036 found that, of roughly 8.6s of growth, about 6.4s came from the uniform snapshot amplifying pre-existing large-record sections (5, 6, 7, 8, 9c and 10) through the reducer's repeated internal measurements; the sections B-3434 added (9d, 10b, 10c and 10d) accounted for about 1.4s combined. If the decision is reopened, the performance target is the snapshot inside the reduction loop, not the coverage.

B-3434:F-034 (low) is not deferred - it is fixed in this story. The comment restating "the cap is 200 UTF-16 units" and the `value.slice(0, 200)` that enforced it 250 lines away are now one named constant used in both places.

## Historical rationale for proposing extraction rather than patching

Nine review rounds. Thirty-seven findings, B-3434:F-001 through B-3434:F-037. The recurring shape was not carelessness in any single sentence: it was a claim in prose that was wider than what the code enforced, where each fix's own new prose introduced the next instance.

Round 8 rewrote the docstrings in this machinery specifically to close that class. Round 9 - the round that reviewed round 8 - produced six more findings, every one of them in prose or structure that round 8 had written to close it. The clearest example is the false format-pin sentence: it was added to explain why duplicating `store.ts`'s format was acceptable, and it described a test that had never existed. B-3434:F-037 is the same shape one level out - a source check written to prove that one computation gates and writes, which proves it by looking for four names in the caller's text.

That pattern explains why B-3434 proposed extraction rather than another local patch. The later decision does not dispute that extraction is cleaner if hard byte identity becomes necessary; it concludes that the narrower property does not currently justify implementation cost and does not solve input consistency.

This history is retained as evidence, not as an instruction to continue. It shows why the known byte-identity property cannot be stated from one side of a two-file seam, while the decision above records why that property is not currently required.

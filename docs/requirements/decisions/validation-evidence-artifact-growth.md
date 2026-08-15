# Validation Evidence Artifact Growth (B-3434 CHK-004)

Disposition: outcome B (committed rationale). The reduction ships; the byte-for-byte agreement between the measured size and the file on disk does not.

Story: B-3434, "Remove the one-mebibyte execFileSync limit that makes validation evidence unpersistable".
Owner of the follow-up: unassigned. This document is the work order.

## Why this document exists

CHK-004 required a binding outcome, not an evaluation:

> This item requires a BINDING outcome, not an evaluation: either the bounding ships in this story, or a committed rationale records why unbounded growth is acceptable and names the change that will address it. Closing this item with a written opinion and no shipped consequence is exactly the unexamined growth cliff this story exists to end.

Both halves of that disjunction are answered here, and they are answered differently, because the item and the defect are not the same size. The growth dimension CHK-004 names is bounded and regression-tested; that part shipped. What did not ship is the property that would make the bound a guarantee - that the number the code measures is the number of bytes `StoryStore` writes. Routes by which those diverge are open and measured, and closing them requires editing `packages/main/src/core/store.ts`, which is outside this story's `allowedModify`.

So this document records the deferral, states the routes with their transcripts, and names the change that removes them.

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

**The mutation catches are genuine.** The test-coverage lane reproduced all four of the mutation-catches this story's regression suite claims, in a disposable worktree, and got back the exact quoted failure messages in each case. That is worth stating plainly next to the sections below: what the suite claims to catch, it catches. The gap is in what it was never looking at, and that is described under "What does not ship" and in the deferred list.

**The measured numbers**, from `node packages/main/dist/tasks/validation-evidence-buffer-smoke.js`:

| fixture | result |
| --- | --- |
| 100 commands x 12,000 chars (today's repository shape) | 2,520,038 bytes, `unmodified`, `within_budget`, output byte-identical to the pre-story serialisation |
| 400 commands of all-quote output | 38,878,838 bytes unbounded, past the 33,554,432 read ceiling; 19,617,036 bytes after reduction, `reduced` |
| 300 commands x 100,000 chars | 148,987 bytes, `reduced`; 300 command outputs and 250,200 detail lines replaced by counted markers |
| 180,000 heterogeneous detail entries | 16,029,894 bytes, `reduced`, 180,001 detail lines kept - a reducible artifact is reduced, not discarded for a stub |
| bulk in a field the reducer does not model | 939 - 1,109 bytes, `verdict_only`, still carrying `allPass` and `status` and naming itself a replacement |
| 200,000-entry `verificationCoverage` | 53,489,880 bytes, `refused`; nothing is written and the operator text reads as a refusal |
| the hash-field window | 25,165,823 bytes admitted without `headHash` / `materialHash` / `storyFilesHash`, `refused` with them - the 232-byte delta is inside the number the gate reads |

**The growth dimension CHK-004 names is covered.** That dimension is the NUMBER of configured `validate.commands` entries serialised into `test-evidence.json`. The incident artifact measured 1,369,692 bytes at 100 entries, after the list grew from 56 to 100 in a single day, against a 1,048,576-byte read ceiling that then blocked every REVIEW to TEST transition in the repository. The same 100-entry shape now measures 2,520,038 bytes against a 33,554,432-byte ceiling and needs no reduction; a 400-entry quote-heavy shape that would serialise at 38,878,838 is brought to 19,617,036. Raising the ceiling alone would have moved the cliff; the reduction plus the advisory at 8,388,608 bytes is what marks it.

**Against the real writer.** The behaviour reviewer measured all four dispositions through the actual `StoryStore.writeTestEvidence`, and the reported byte counts match what lands on disk today: `unmodified` 277, `reduced` 667, `verdict_only` 599, `refused` 27,263,587 (with no file written). That agreement is a fact about the code as it stands today, not a property the code maintains - which is the subject of the next section.

## What does not ship

A guarantee. The number `boundPersistedValidationEvidence` reports and the bytes `StoryStore` writes agree today. Two routes by which they come apart inside the bounding itself are set out below; a third, at the `verifier.ts` caller, is B-3434:F-037 in the deferred list. This section does not claim to enumerate them all - that is the point of deferring the property rather than restating it.

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

## The named change that will address it

**A writer-owned canonical boundary.** One component, owned by `packages/main/src/core/store.ts`, that serialises a record to text, measures that text, and writes those exact bytes. Callers hand it a record and get back either the byte count that was written or a refusal; they do not serialise for themselves.

That removes both routes at once, and it removes them structurally rather than by assertion:

- there is one serialisation instead of two, so there is no format to duplicate and nothing for a `store.ts` change to drift away from;
- the measured text and the written text are the same string, so an inherited `toJSON` - or a getter, or any other value that answers differently on a second reading - is consulted once and the reading that is measured is the reading that lands.

It also makes B-3434:F-036 moot, because measuring and writing become one operation rather than two that have to be kept in agreement, and it is the only answer to B-3434:F-037 that scales: a source check that looks for names in a caller's text is blind to an ordinary mutation of the record those names refer to, and no amount of additional substring matching fixes that. A writer that owns the bytes does not care what happened to the record before it arrived, because it measures what it is about to write.

**This requires modifying `packages/main/src/core/store.ts`, which is outside B-3434's `allowedModify`.** That is the reason for the deferral, and it is a different reason from "we ran out of time". Nine review rounds of work on this side of the boundary could not build the property, because the second serialisation lives on the other side of it. A tenth round of careful sentences in `validation-executor.ts` would not have built it either.

A follow-up story should be scoped to `packages/main/src/core/store.ts`, `packages/main/src/core/validation-executor.ts` and `packages/main/src/handlers/verifier.ts` together, and should treat the items below as its acceptance surface.

## Deferred findings

| id | severity | what is open |
| --- | --- | --- |
| B-3434:F-033 | medium | The serialisation format is duplicated from `core/store.ts` and the smoke's apparent pin is self-referential, so a format change there drifts both copies together and every assertion keeps passing. Raised by the concept lane and, independently, by the cross-vendor reviewer. |
| (cross-vendor, unfiled) | major | `JSON.parse` returns objects with a live `Object.prototype`, so an inherited `toJSON` defeats the snapshot even for a record built as a plain object literal. Transcript above. Not filed under a `B-3434:F-` id; carry it into the follow-up from this document. |
| B-3434:F-035 | medium | `finish()` is the single exit and it does structurally force a null record to `refused`. But it takes `record` and `fileBytes` as two independent trusted parameters and does not re-derive the count from the record it is handed, so their agreement is convention. A future disposition, or a field patched onto an already-built record, reintroduces the divergence silently. |
| B-3434:F-036 | medium | The uniform snapshot on every disposition is paid for and, per the quality lane's trace, buys nothing: the reduction loop discards `.record` and consumes only `.bytes`, and the terminal call rebuilds and re-snapshots from scratch, so the plain-data property of the returned record comes entirely from that terminal call. Cost: smoke wall-clock from 9.9s to 17.9-18.5s (behaviour lane) and 18.9-19.5s across three runs (test-coverage lane), roughly 14x margin under the 270s per-command timeout. |
| B-3434:F-037 | medium | The F-029 source check is blind to in-place mutation of the record between the gate and the write. It verifies that four literal substrings exist somewhere in `persistStoryValidationEvidence`'s text, which a mutation of an already-gated record does not disturb. The test-coverage lane reproduced it in a disposable worktree with one line inserted at `packages/main/src/handlers/verifier.ts:972-981`: `persistedBound.record.output += 'x'.repeat(60 * 1024 * 1024)`. That mutates an existing typed field - no `as any`, zero new `tsc` errors - and `validation-evidence-buffer-smoke: PASS` was unaffected. It is the F-014 / F-027 shape reappearing one level up, at the `verifier.ts` caller. |

On sizing the F-036 work: the test-coverage lane instrumented the smoke per section, and the cost is not where a reader would guess. Of the roughly 8.6s of growth, about 6.4s comes from the uniform snapshot amplifying pre-existing large-record sections (5, 6, 7, 8, 9c, 10) through the reducer's repeated internal measurements; the sections this story added (9d, 10b, 10c, 10d) account for about 1.4s combined. So the thing to revisit in the follow-up is the snapshot inside the reduction loop, not the new coverage.

B-3434:F-034 (low) is not deferred - it is fixed in this story. The comment restating "the cap is 200 UTF-16 units" and the `value.slice(0, 200)` that enforced it 250 lines away are now one named constant used in both places.

## History, and why it is the argument for extracting rather than patching

Nine review rounds. Thirty-seven findings, B-3434:F-001 through B-3434:F-037. The recurring shape was not carelessness in any single sentence: it was a claim in prose that was wider than what the code enforced, where each fix's own new prose introduced the next instance.

Round 8 rewrote the docstrings in this machinery specifically to close that class. Round 9 - the round that reviewed round 8 - produced six more findings, every one of them in prose or structure that round 8 had written to close it. The clearest example is the false format-pin sentence: it was added to explain why duplicating `store.ts`'s format was acceptable, and it described a test that had never existed. B-3434:F-037 is the same shape one level out - a source check written to prove that one computation gates and writes, which proves it by looking for four names in the caller's text.

That pattern is the evidence for the decision recorded here. When the tenth attempt at a boundary keeps producing a claim slightly wider than the mechanism, the problem is usually the boundary and not the claim. Here the boundary runs between two files and only one of them was writable from inside this story, so every accurate sentence had to describe a property that half the machinery could not maintain. Extracting the writer-owned boundary makes the sentence unnecessary, which is the only durable version of the fix.

This paragraph is not an apology and should not be edited into one. It is the most useful thing in this document for whoever picks up the follow-up: you are not inheriting sloppy work, you are inheriting a property that cannot be stated from one side of a two-file seam.

# B-3b05 CHK-002 — real-machine transcript: owner-session self-sign attempt (warn mode)

Recaptured 2026-07-14 from the B-3b05 worktree against the REAL CLI binary
(`packages/main/dist/cli.js`, rebuilt from this branch AFTER the F-002 fix).
Harness: the same temp-repo fixture pattern as
`packages/main/src/tasks/review-pass-provenance-smoke.ts` (temp git repo + real
story metadata in REVIEW + a story owner lease), driven by a scratch script that
spawns the CLI with `LATTICE_SESSION_ID` set to THIS owner session
(`9f8bf495-b234-42dc-9ecb-16d603a760d2`) and a lease bearing the same sessionId
— i.e. an owner-session attempt to stamp a reviewer-labeled pass. Config has no
`reviewPassProvenance` section, so the hardcoded default warn mode applies.
Output below is verbatim (stdout/stderr separated as captured).

> **Amendment (F-002, 2026-07-14).** The original capture of this transcript
> claimed that `writerSessionId`, `sessionSource`, AND `provenanceFlag` were
> "all bound into the versioned `_hash` signature domain". That claim was FALSE
> for `provenanceFlag` at capture time: the flag-less v3 domain signed only
> writerSessionId + sessionSource, so the flag could be added, stripped, or
> flipped on an already-signed record without breaking verification
> (B-3b05:F-002, reproduced by the quality reviewer against the built dist).
> The signature domain has since been amended in place (v3 now binds
> `provenanceFlag`, with an absent flag canonicalized to the empty string; no
> persisted record anywhere in this repo had been signed under the flag-less v3
> domain, so no v4 split was needed). This transcript was then RECAPTURED
> against the rebuilt CLI, and the flag-tamper verification failure is
> demonstrated below.

```text
$ lattice review_run_start '{"storyId":"B-txn1","agent":"lattice-review-quality"}'
(spawned with LATTICE_SESSION_ID=9f8bf495-b234-42dc-9ecb-16d603a760d2; story owner lease sessionId=9f8bf495-b234-42dc-9ecb-16d603a760d2)
exit code: 0
--- stdout ---
Review run B-txn1:RR-001 started for lattice-review-quality (round 2026-07-14T10:01:00.000Z, head 0aabd49, story e3b0c44)
--- stderr ---
[0.0s] running review_run_start...
[0.1s] review_run_start done

$ lattice review_pass_set '{"storyId":"B-txn1","agent":"lattice-review-quality","reviewRunId":"B-txn1:RR-001","note":"lattice-review-quality checked its assigned review surface and found no blocker.","readManifest":{"filesReadFully":["docs/requirements/decisions/lattice-review-quality.md"],"filesTriagedByName":[],"scanEscalationReason":null}}'
(spawned with LATTICE_SESSION_ID=9f8bf495-b234-42dc-9ecb-16d603a760d2; story owner lease sessionId=9f8bf495-b234-42dc-9ecb-16d603a760d2)
exit code: 0
--- stdout ---
Review pass B-txn1:RP-001 recorded by lattice-review-quality
⚠ provenanceFlag=same_session_write: writer session 9f8bf495-b234-42dc-9ecb-16d603a760d2 (source=explicit-env) equals story owner lease session 9f8bf495-b234-42dc-9ecb-16d603a760d2 — subagent-or-self, not mechanically distinguishable (EXP-001); audit-only, no gate consumes it
--- stderr ---
[0.0s] running review_pass_set...
⚠ review-pass provenance: writer session 9f8bf495-b234-42dc-9ecb-16d603a760d2 (source=explicit-env) matches the story owner lease session 9f8bf495-b234-42dc-9ecb-16d603a760d2. A same-session write means subagent-or-self — the two are not mechanically distinguishable (EXP-001). Recorded provenanceFlag=same_session_write (audit-only; no gate consumes it).
[0.2s] review_pass_set done

--- persisted review-passes.json (provenance fields) ---
{
  "id": "B-txn1:RP-001",
  "agent": "lattice-review-quality",
  "writerSessionId": "9f8bf495-b234-42dc-9ecb-16d603a760d2",
  "sessionSource": "explicit-env",
  "provenanceFlag": "same_session_write",
  "_hash": "cbc0f3fa28d78940b3ff852de01c19be9d7ba7acb192cc960597cc2ba4482e83"
}

--- verifyReviewPass against the CLI-persisted record (flag tamper, F-002) ---
untampered record:                          true
provenanceFlag stripped from the record:    false
provenanceFlag flipped to another value:    false
```

Observed facts (the acceptance criterion from background.md — the flag is visible
in the same output the operator reads, not a silent success):

- stdout of `review_pass_set` carries the flag line `provenanceFlag=same_session_write` naming BOTH session ids with the neutral subagent-or-self wording.
- stderr carries the provenance warning naming both ids and the EXP-001 caveat.
- The persisted pass record durably carries `writerSessionId`, `sessionSource=explicit-env`, and `provenanceFlag=same_session_write`, and ALL THREE fields are bound into the versioned `_hash` signature domain (post-F-002 fix; an absent flag signs as the empty string). Stripping or flipping `provenanceFlag` on the record the CLI just signed makes `verifyReviewPass` return false, as shown verbatim above; adding a fabricated flag to an unflagged signed record likewise fails (covered by `npm run test:review-pass-provenance` tamper assertions).
- The write still succeeds (warn mode is the default): no gate consumes the flag; enforce-mode rejection is covered by the smoke test, not this transcript.

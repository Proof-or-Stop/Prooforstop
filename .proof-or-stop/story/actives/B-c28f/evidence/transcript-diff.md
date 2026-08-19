# B-c28f TEST Transcript Diff

## Expected

DONE story summary, pitfalls, and delivery-check material can be observed as a
`done_experience` playbook seed, proposed through the user-facing CLI flag path,
and approved into a candidate playbook. The candidate remains inert: DONE
success alone must not record `helped` and must not activate runtime guidance.

## Actual

Commands run on this local machine:

```sh
npm --prefix packages/main run build
node packages/main/dist/tasks/playbook-seed-promotion-loop-smoke.js
lattice validate --story=B-c28f --json
```

Observed output:

- `npm --prefix packages/main run build` passed.
- `node packages/main/dist/tasks/playbook-seed-promotion-loop-smoke.js`
  reported `playbook-seed-promotion-loop smoke: 16/16 checks passed`.
- The focused B-c28f smoke check reported:
  `B-c28f DONE experience observes stable seeds and approves inert candidates idempotently - PASS`.
- The same smoke suite confirmed:
  `M5 DONE-style neutral settlement does not infer helped outcome - PASS`,
  `M8 DONE-settlement helped rows cannot drive evidence activation - PASS`,
  and `M6 runtime verification consumes active playbooks and keeps candidates inert - PASS`.
- `lattice validate --story=B-c28f --json` passed all 32 configured validation commands
  and covered 11/11 verification intents.

## Diff

Expected and actual matched. The implemented Story 1 path proves:

- `playbook_seed_observe --source=done-experience --json` can surface a DONE
  experience seed with `sourceArtifactKind: "done_experience"`.
- `playbook_seed_propose_batch --source=done-experience --apply --observeDigest=...`
  stages a digest-bound proposal.
- `playbook_candidate_batch_approve --apply --manifestDigest=...` creates a
  candidate playbook only.
- No active playbook or helped outcome is inferred from DONE success alone.

## Acceptance

Accepted for Story 1 scope. Automatic evidence-based activation is intentionally
left to Story 2.

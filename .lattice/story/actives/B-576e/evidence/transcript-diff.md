# B-576e User-Value Transcript Diff

## Expected

- `Proofbound CLI 0.3.106` is the built runtime for this story.
- Active CLI/runtime surfaces no longer expose retired server-backed Authority commands or Authority Server completion semantics.
- Routine `lattice validate` uses local retirement/local assurance checks instead of retired Authority Server client/completion smokes.
- Local proof surfaces remain available: capability profiles, local quorum, proof admissibility, and offline receipt-bundle checks.

## Actual Transcript

```bash
$ node packages/main/dist/cli.js --version
Proofbound CLI 0.3.106

$ node packages/main/dist/tasks/retired-authority-server-semantics-smoke.js
retired Authority Server semantics smoke PASS

$ node packages/main/dist/tasks/capability-list-smoke.js
✓ capability list smoke passed

$ node packages/main/dist/cli.js help | rg -i "authority_status|authority_receipt_verify|authority_job_create|authority_verdict_submit|retired-authority|capability_list|proof_admissibility|quorum_submit"
    capability_list                       List host-neutral Proofbound capability profiles and degradations (text/json)
    quorum_submit                         Submit a local voluntary 3x2 host-verdict quorum only after current reviewer pass evidence exists for every required review lane

$ lattice validate --story=B-576e --json
{"status":"pass","allPass":true,"summary":"Project validation commands passed", "...":"31 configured validate.commands passed"}
```

## Diff Notes

- Expected no active retired Authority command listings; actual help output does not list `authority_status`, `authority_receipt_verify`, `authority_job_create`, or `authority_verdict_submit`.
- Expected local replacement checks to run; actual routine validation passed with `retired-authority-server-semantics-smoke.js`, `capability-list-smoke.js`, `receipt-bundle-contract-smoke.js`, `gate-strength-contract-smoke.js`, and `quorum-submit-smoke.js`.
- Expected user-facing runtime to remain local/non-server backed; actual guard rejects active positive claim surfaces such as `productionDone=true`, `receiptVerified=true`, `authorityDone=true`, and `fullAuthorityDone=true` unless explicitly negative or retired.


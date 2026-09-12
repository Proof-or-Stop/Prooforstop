# Canonical fixture context reconciliation

This bounded Lab repairs stale expectations in the canonical identity-sites and runtime groups on local main 0.3.347. It changes fixture expectations and their dependent source evidence; it does not change production behavior or mint Story evidence.

All eleven stale checkpoints have the same mechanism: an earlier integrated source change left an exact AST identity/import context checkpoint stale. Repairing only the first signer-count assertion would expose the remaining ten. Each old checkpoint below was reproduced from the named Git source before updating the exact count and context digest. No site ID, operation binding, classifier, or mutation refusal is removed.

## Reviewed source provenance

### packages/main/src/core/verification-execution-evidence.ts

The third signer-key use is verificationLocationReader reading the same canonical filename from the discovered Git common directory. Producer key creation and the standalone reader remain; receipt validation shares only location, rereads key bytes, checks directory stability, and keeps signature/domain checks. Imported readFileSync/join/realpathSync contexts account for the three extra import observations.

- site checkpoint from `38812ebb795c4b31004d041b5199cab37c51542a`; old source SHA-256 `79102e2cd1c591009ea476109e6c238a563cbe2b9b297f56f405fbf9c5aa9487`.
- Context 2 → 3; old `b2272c84d648eadbca1dfa2c1d2629361ac2e5ca967740a7b76223ccb30d4047`; current `c70020b7249196738a7ec9eb21c662e7b6805a5c80e5b6662d05e79257151fd3`.
- import checkpoint from `38812ebb795c4b31004d041b5199cab37c51542a`; old source SHA-256 `79102e2cd1c591009ea476109e6c238a563cbe2b9b297f56f405fbf9c5aa9487`.
- Context 293 → 296; old `4c52bbb94b6f96e1ea941fd0b097dadbcb8b58edf26ae99929abe7400474d2d6`; current `8653fc4bebf66e733177010bc48a5b4c922917bddf8ad5849d289dd38c740e91`.

### packages/main/src/handlers/agent-prompt.ts

The added response producer is the readOnly JSON branch with the existing response-v1 schema, envelope:null, auditOnly:true and canMintReviewEvidence:false. New context assembly, environment capture and authority-safety imports preserve the reader/writer distinction.

- site checkpoint from `00cc2769adc7e4f54f6a45ef095801cba8ae1474`; old source SHA-256 `1d6e76e32916406a46c77fc15b96e149c9e8880df7666ac836e9f6d72abbb141`.
- Context 2 → 3; old `24c5be99c5118d833d6c1d482b97b7b12ea1e6e0797f8eac07fdde2433e220a7`; current `9aca1853ec68d2b60a8373e0f84b1ba8a146b591f9cc4637b801f4700c24ee8b`.
- import checkpoint from `00cc2769adc7e4f54f6a45ef095801cba8ae1474`; old source SHA-256 `1d6e76e32916406a46c77fc15b96e149c9e8880df7666ac836e9f6d72abbb141`.
- Context 113 → 130; old `85324214b09dd1a487289575c0a398834ba3e8e7e1f3a8ebfe251b8568ca3f90`; current `574bd09e82f47aa279a905cf63a658c3f36d8443967607d457f3447f46f4b052`.

### proof-or-stop.config.json

Two earlier validate command insertions shift the JSON pointers for existing configuration-path literals. All thirteen literal uses remain; this updates exact pointer context, not an exemption for additional keys. The same two insertions also shift the eight existing proof-or-stop-real-root-admission resource-key contexts. Their classification, count8, reason and independent admission mutation proof remain unchanged; only context digest changes from 1e3cf33861d44a2b554472098e53779355359f7759f8e67ea2e084c4cb311ba8 to 6925f132289490e9370c679f50b5c425477621b904ff14ce6d94fc8eb7ddcc41, independently reproduced from the same old config source.

- site checkpoint from `4f94fb6ddb23a08e0bdd79f41129b423a598a9c9`; old source SHA-256 `a366d11f161a003e48140382b78def64b721745a465ca374c89e5214400f8c45`.
- Context 13 → 13; old `6673b9408c13aaa802df2bda44f961685b09eb98d4703f36553f80137fc29f32`; current `b069aeffc954e08bcf57cea9a89b33738dc193f25494041081d00f91e5e271d6`.

### packages/main/src/core/evidence-freshness.ts

The imported withGitTreeObservation callback now contains the integrated partial-snapshot fail-closed branch. Import use count stays174; its full callback context changes, preserving missing-head/material refusal instead of the former permissive fallback.

- import checkpoint from `3adf7bd961dd2007c66ffdd0052adc0fb1926ab6`; old source SHA-256 `ec29b6acca4331529068616853c4ca3f1e2da9300c4c7f27a010ddb96f14c929`.
- Context 174 → 174; old `335ef9f1df85f17b63a0cc3160d6c2f4b616443086b5f8db3d2f48efab1d6a39`; current `d83318dacae758180af3e7695fc307768b7a92aa21dff0d464e5fe01a972a50c`.

### packages/main/src/core/lifecycle-control/queue/index.ts

Authoritative workspace context and bounded Git progress replace directory-mtime probing. Removed statSync/resolveWorktreePath uses and added shared baseline/execFileSync observations account for the exact70-to53 import-context projection. Unknown observations cannot claim stale or ready.

- import checkpoint from `ef854edb5a16f01dbd7f92a4f1130649d7f80e1a`; old source SHA-256 `7492887795ebd3441e562b5f3cd4e21caa7b4d04ee22d116e93057034875f6a6`.
- Context 70 → 53; old `316bdc446bd34ad1a82298235f31156095a826b0aab86adb11c66ef3bd6de4b0`; current `8cb59637cafa3ec554118d5a2a6134d668c14983ad73f73928c28cbff3db0398`.

### packages/main/src/core/process-fact-registry.ts

Two COMMAND_PROCESS_FACTS.push consumers register selected-owner scope coverage and independent-intent owner lease policy. No import/classification is removed;21-to23 contexts bind the two new declarations.

- import checkpoint from `101541a8b2400570423f041d5ba69b078af38ef3`; old source SHA-256 `5d083b5549c3f25fb61ac74fbcfff58fb9b5f5f3671cf3ced1e6903b70187c6b`.
- Context 21 → 23; old `35c1318f2c126e116817bc3b0f44a925fbaac780ce9798a88e1ddddaa9f3fb30`; current `483e3d1d942af7a36fb81b4ff1ed25c37bd70d55d18b8699dfa0d11c7d1c1960`.

### packages/main/src/core/prompt-registry.ts

The accepted acceptanceReviewJsonSchema import and JSON.stringify invocation add the exact response schema to the independent acceptance reviewer prompt, accounting for62-to64 import observations.

- import checkpoint from `ae4c68235d6add39cd4bfa93b28b6993bad2c963`; old source SHA-256 `a0fb36694e750a2bff9079e98602c970ee9e27d77ed4d1372440e6e40fb5a971`.
- Context 62 → 64; old `33ff0dd7bd015d325ce6a762c11488c8eb53e6d4d490a465308e7f9dcfd3d6e7`; current `c2c708cc827fcd45f8d24a5843a26d59e2d0324fc1b0e776f2e0e1b5a160461b`.

### packages/main/src/handlers/checklist.ts

Integrated owner-bound proposal digests, lease/role checks, attribution, and diagnostic preview separation add or move exact existing imported calls. The scope of review is the831-context projection against the recovered803-context baseline, preserving all declaration/owner checks and adding no authority in this repair.

- import checkpoint from `b75d3cabbb16ca827d4dd5fba44671f7d3c1b6d8`; old source SHA-256 `0254ddec43ab0a90cc4f4f23bb1fff3261d5d4b642269504b1d4ea300ab80bb2`.
- Context 803 → 831; old `180413cf1a13bdf5cc50b5fba0ff089ff63d845e602020dc7e11b5c8e51dc443`; current `4052f4949f849e15ef1c81064355ce8366821cc9f77ff6089eb3969b101e9f4a`.

## Maintenance writer expectation

Commit def69f3212 changed story_reconcile from an unconditional writer to whenDryRunFalse. The runtime fixture now supplies dryRun:false for its existing required-writer assertion and explicitly covers both default and dryRun:true as observations. The required-writer membership and all other mutator assertions remain.

## Verification boundary

The pinned Lab command executes both original groups. Added source mutations move the signer read to a different directory without changing its identity count, add identity/config uses, and add actual imported-binding uses to all seven reconciled import consumers. Every mutation must still be refused. Existing all-site omission, typed-producer, unresolved-import, emitted-source, and historical-counterpart controls remain intact. Source-evidence hashes are refreshed only after exact prior lines and call digests are verified. These checks are local maintenance evidence, not formal Story DONE.

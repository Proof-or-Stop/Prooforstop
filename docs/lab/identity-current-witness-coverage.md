# Exact current witness classification

Main a6bd46c653 at version 0.3.355 failed its default identity scanner with 53
occurrences. This Lab preserves the reported source and historical records. It
classifies existing evidence through the existing exact readers; it does not
rename private protocol participants or change public identity behavior.

The additions cover 44 token values in two historical rebinding JSON records,
one copied static-review excerpt, four occurrences in historical audit text and
diagnostic logs, two operations forwarding a broker-issued private descriptor,
and two disposable Git-ignore fixture lines. The latter do not create a legacy
directory. The descriptor scalar does not grant authority: the actual fixture
still requires its broker callback, process environment sanitization and paired
stdio channel. Historical records are not current execution instructions.

The exact inventories add 45 JSON pointer/value/count contexts, four fixture
source/line/count contexts, and three provenance rows (one binds two occurrences
in the same diagnostic log). All earlier rows remain. JSON coverage binds the
individual value rather than an entire file. Fixture coverage binds complete
source bytes as well as the exact line and token count. Provenance coverage binds
the exact token occurrence count and surrounding lines. No directory, token
family, wildcard or general fixture exemption is introduced.

The unchanged pinned command is
`node scripts/verify-identity-current-witness-coverage.mjs`. It executes the
unchanged default scanner command, then the existing reviewed-source verifier
which includes actual readers, scanner self-test, static edges and bounded route
dependency checks. This is not a claim to have run the native route suite. The
driver shares the existing default Lab allowance of 900 seconds among its
children and does not raise any existing workload limit.

The scanner self-test now exercises every added JSON and fixture context through
the actual reader APIs. It rejects changed counts, same-count changed contexts,
removed values or lines, wrong JSON pointers and wrong paths. Provenance tests
use the actual exact-row validator for changed counts, contexts, paths, removed
occurrences and removed inventory rows. Actual residue scanning rejects copied
same-directory neighbors. Existing self-test assertions and selectors remain.

Official RED was recorded at bbebccaf83. The outer command took 20.272636041
seconds; its failing default-scanner child took 18.682832625 seconds. A preceding
private-build setup failure is separate from RED. After restoring dependencies
from the two committed lockfiles, the private build passed in 32.521556375
seconds. The new self-test initially exposed a missing scratch truth-source
input; that failed diagnostic remains recorded. Supplying the actual entrypoint
texts made the 420 new checks and existing self-test pass in 42.804656583 seconds.
These measurements belong to their source checkpoints, not a future prepared
release. Each is subprocess elapsed time, not model-compute time.

Fresh synchronization, committed-head GREEN, independent vendor audit and local
integration remain separate requirements. This Lab supplies no Story DONE,
reviewer credential or remote-release authority.

## Main 0.3.356 and downstream import integrity

Official sync incorporated 2433b8037750d4f0ff313b40640c92fc66101efc. The first complete candidate diagnostic passed residue classification, then failed the unchanged canonical identity-sites child on two exact import-context pins. That failure remains recorded. Full derivation enumerated all 46 import rows and all 264 owned literal contexts; only the two import rows below differed, and all literal contexts were unchanged.

- packages/main/src/core/store.ts: 402 / 5bdc72dd75d2f7ace96fdaa4ef9edc6443002e311e631e77c4adb856250728d3 becomes 411 / 07464549c7d89dc09529a7ccc5c38222f3ab1ee3ee43bfaaca8ff2cc28a6474f.
- scripts/verify-proof-or-stop-identity-cutover.mjs: 457 / 7331fe8ec5711c3b5b979af8b21342c20c7a8060c2b20a2df7f3c58d56fadd37 becomes 556 / 51130b66b92538a1ee1513f45b2e7cd7033b039342a4b28792caa6da44fd3baa.

Both old pins reproduce at d788f9adaf. The store already derives the new value on main a6bd46c653 and 2433b80377: nine added import contexts belong to hashing, the shared evidence-size policy and immutable prepared publication. No prior import context is removed. The scanner retains its old value on both main checkpoints; its 99 additional import contexts belong exclusively to this Lab own scratch and actual-reader mutation controls. Existing cases are retained, and new controls prove additional uses and same-count changed call arguments remain rejected by the actual canonical import oracle. Neither count change is an open-ended tolerance.

Sync also refreshes exact pre-existing source bindings for the command catalog and process-fact levels, process-contract fixture and negative-source witnesses, and the native lock fixture. Their reviewed lines and token counts remain unchanged; unrelated incoming validation-admissibility assertions are retained. The canonical test source binding moves only after its exact unchanged context lines are recovered. Static entry identities, claims and dependency keys remain; only proven source/dependency hashes and exact shifted excerpt locations change. These are derived closure repairs, not new context admissions.

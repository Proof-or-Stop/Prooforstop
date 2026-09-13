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

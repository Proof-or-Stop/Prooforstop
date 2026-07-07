# Future Cell 03 Results

This directory contains the B-991d Cell 03 result artifacts.

`probe/` records the bounded B-991d probe. `full/` records the completed Cell
03 / protocol ③ A4 E2 same-family run under the frozen B-6529 envelope.

Current full-run state: `finalRows=1142/1152`, `terminalExhaustedRows=10`,
`pendingExecutableRows=0`, and `totalTokens=219253501` across final rows with
provider-reported usage. Exact dollar cost is not recorded or invented because
no billing export or versioned pricingRef is attached.

The Cell 03-derived usage lock is a usage/sequencing input for a separate Cell
06 story. It does not authorize Cell 06 execution, Phase 2, paper claim
upgrades, product gates, or playbook activation.

Any future row written here must satisfy
`../m2-cell03-result-write-policy.json`, including the required Cell 03
bindings, provider-reported postflight usage, digest bindings, retry and
supersession audit rules, and B-991d contract provenance.

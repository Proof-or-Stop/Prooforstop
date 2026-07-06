# Future Cell 03 Results

This directory is reserved for Cell 03 result rows.

It currently contains a bounded B-991d probe under `probe/`. The probe is not the
full 1,152-row Cell 03 run and it is not an outcome-record dataset. It exists to
prove that the Cell 03 execution window can capture executor usage, fresh
same-family reviewer usage, response digests, acceptance checks, hidden
ground-truth checks, provider-visible workspace isolation, and row-contract
negative controls before CHK-006.

The full Cell 03 run may write rows here only after the probe passes and CHK-006
starts. Cell 06, Phase 2, paper claim upgrades, product gates, and playbook
activation remain out of scope for this directory.

Any future row written here must satisfy
`../m2-cell03-result-write-policy.json`, including the required Cell 03
bindings, provider-reported postflight usage, digest bindings, retry and
supersession audit rules, and B-991d contract provenance.

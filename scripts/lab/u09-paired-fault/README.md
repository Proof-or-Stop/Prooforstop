# Bounded paired validation faults

Run `node scripts/lab/u09-paired-fault/run.mjs <repo> [output-parent]`.
The fixed corpus covers dependency, actual command policy, actual scope gate,
unmapped changed path, declared environment drift, and command selector drift.
Each case first runs a healthy baseline and obtains real tool-generated evidence,
then compares actual full and scoped child execution on the same fault. The policy
and gate cases copy the production TypeScript bytes at their canonical source
paths and execute them with Node 26 native type stripping; their mutations and
SHA-256 identities are printed. No protectedFiles exemption is needed.

The default module-pair case is GATE-01. Its RED requires the real assertion to
fail in both modes but exposes the missing automatic full escalation and omitted
sentinel. This is bounded functional differential evidence, not a statistical
miss-rate or external reviewer-quality result. UNKNOWN-01 is an unmapped changed
path, not a separate runtime opaque-read experiment.

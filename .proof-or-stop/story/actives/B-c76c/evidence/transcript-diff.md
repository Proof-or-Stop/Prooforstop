# B-c76c Transcript Diff

## Expected

Proofbound should report the imported Lattice CLI baseline locally:

```text
Lattice CLI 0.3.63
```

Package metadata should agree on the same baseline:

```text
package.json: 0.3.63
packages/main/package.json: 0.3.63
package-lock root: 0.3.63 / 0.3.63
```

## Actual

Command:

```bash
node bin/lattice.js --version
```

Output:

```text
Lattice CLI 0.3.63
```

Metadata check:

```text
package.json: 0.3.63
packages/main/package.json: 0.3.63
package-lock root: 0.3.63 / 0.3.63
```

## Diff

No user-visible mismatch. The local proofbound checkout now reports the same
0.3.63 CLI baseline as the retired Orchestrate checkout, while excluded legacy
paths stayed out of the import.

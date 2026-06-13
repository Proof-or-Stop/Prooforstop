# B-3cca Transcript Diff

## Expected

- Current product wording in CLI engine, hook diagnostics, and `docs/guide-hooks.md` says Lattice/lattice.
- Remaining `koala` tokens are explicit legacy alias, fallback config, runtime path, env var, or reviewer/process identifiers.
- The focused branding audit fails on unclassified current-product Koala wording, including documentation lines mixed with compatibility tokens.

## Actual

Command:

```bash
npm --prefix packages/main run test:cli-engine-branding-smoke
```

Observed output:

```text
cli-engine branding audit: PASS cli-engine src unclassified=0, cli-engine dist unclassified=0, hooks src unclassified=0, hooks dist unclassified=0, guide-hooks doc unclassified=0
cli-engine branding smoke passed
```

Command:

```bash
lattice validate --story=B-3cca --json
```

Observed result:

```text
status=pass
allPass=true
verification intent coverage=12/12
```

## Diff

No user-value gap observed. The smoke audit now includes `guide-hooks doc` and uses token-based stripping rather than whole-line allowlists for `KOALA_*`, `koala.config`, or `.koala`, so compatibility tokens do not hide current-product Koala prose.

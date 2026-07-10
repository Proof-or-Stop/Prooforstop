# B-3928 Live Smoke Transcript Diff

Command:

```bash
node scripts/verify-proof-or-stop-prompt-baseline.mjs
```

Expected user-visible output:

```text
PASS proof-or-stop prompt baseline: roleCount=16 registry hashes verified
PASS proof-or-stop prompt baseline: agent_prompt output hashes verified for 16 roles
PASS proof-or-stop prompt baseline: overlap matrix verified for 16 roles
PASS proof-or-stop prompt baseline: legacy vocabulary findings classified
PASS proof-or-stop prompt baseline: direct story-file findings classified
```

Actual output captured on 2026-07-10:

```text
PASS proof-or-stop prompt baseline: roleCount=16 registry hashes verified
PASS proof-or-stop prompt baseline: agent_prompt output hashes verified for 16 roles
PASS proof-or-stop prompt baseline: overlap matrix verified for 16 roles
PASS proof-or-stop prompt baseline: legacy vocabulary findings classified
PASS proof-or-stop prompt baseline: direct story-file findings classified
```

Result: exit code 0; expected and actual output match, with no stderr.

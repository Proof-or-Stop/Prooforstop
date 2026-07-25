## Trigger Event

Found on 2026-07-24 during the B-4043 review in the lattice-review-concept lane: lattice.config.json lists the reviewer-scan-budget smoke twice under validate.commands. The duplication pre-dates B-4043, since both merge parents (b8e28971d0^ and e436eb5447) already contain both entries, so it was not introduced by that story's merge.

## Key Insights

A bare-string entry and an object entry are normalised by the same loader in packages/main/src/handlers/verifier.ts. commandFromString only sets shell:true when SHELL_META_RE matches, and 'node <path>.js' contains no shell metacharacters, so the string form yields exactly the same command and args as the object form. The two entries therefore differ only by the focus tag, which is a selection filter rather than an execution parameter: filterFocusedConfiguredCommands keeps focus-tagged commands under --focus, while an unfocused run executes the whole configured list.

## Solution Tradeoffs

Option A: drop the bare string and keep the focus-tagged object. This preserves both the unfocused run and the fast-focused run, so coverage is unchanged in every mode. Option B: drop the object and keep the bare string. That would silently remove the smoke from the 'fast' focus set and weaken focused validation. Option C: leave the duplication and accept the wasted run. Rejected because every phase gate that validates pays the cost twice for zero extra signal. Option A is chosen as the only strictly behaviour-preserving edit.

## Conversational Texture

The requester asked for duplicates to be compared by full execution identity rather than by script path alone, and for the exactly-once claim to rest on an invocation record instead of a merely green validate run. They also asked explicitly that commands sharing the same script but carrying meaningfully different execution parameters must not be removed, so the duplicate scan has to distinguish identical entries from deliberately differentiated ones.

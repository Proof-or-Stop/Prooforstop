## Trigger Event

Story B-12a1 (merged to main 2026-07-13, commits 865b8ab5dc and ff86e56426) registered the ProofStory intent-hardening artifacts in LATTICE_LIFECYCLE_ARTIFACT_FILENAMES but deliberately carved out three other command-generated filenames as different command families: grill.json, clusters.json, and scope-extension-decisions.json. This follow-up chore closes that carve-out.

## Key Insights

store.ts writes all three files via writeJson(storyId, file) -> join(storyDir(storyId), file), so each lands at the story dir top level — exactly the surface the closed filename set classifies. Because they are absent from the registry, a mode=enforce scope contract classifies them rule=out_of_scope and blocks phase advancement, the same friction class B-12a1 fixed. Separately, the registry's singular 'cluster.json' entry is stale: ripgrep finds no writer (the registry line is the only repo-wide occurrence) and active story dirs contain 4 clusters.json, 1 grill.json, and zero cluster.json.

## Solution Tradeoffs

Adding the three filenames to the closed set is the established B-12a1 approach; the alternative (per-command allowlisting or acknowledgement flows) was already rejected by B-12a1 as unnecessary friction for command-generated metadata. Removing the stale cluster.json entry slightly narrows the trusted set — safe because nothing writes it and no on-disk instance exists; keeping it would preserve a filename that can only be created by hand, which the narrow trust policy exists to exclude.

## Conversational Texture

User reported the gap directly with file/line pointers and asked to verify each filename is actually written to the story dir top level, add the missing entries, decide the stale entry's fate, and extend the smoke in packages/main/src/tasks/scope-contract-smoke.ts accordingly. Verification before story creation confirmed all three write sites and the stale entry.

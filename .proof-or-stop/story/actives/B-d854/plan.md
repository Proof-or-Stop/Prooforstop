# Plan: B-d854 Audit and translate root AGENTS.md

## CHK-001: Audit current-behavior claims in root AGENTS.md against authoritative implementation and decision sources

- Compare current lifecycle, command, role, artifact, and gate claims with the repository-local CLI, command registry, current role prompts, and adopted decisions.
- Record reproducible evidence for every correction; distinguish current, compatibility-only, and historical material.
- Do not mutate any file while auditing.

## CHK-002: Translate the complete root AGENTS.md into English without semantic drift

- Translate every heading, paragraph, table cell, comment, code annotation, and example string in AGENTS.md.
- Preserve Markdown structure, technical tokens, paths, identifiers, polarity, modality, and current-versus-legacy qualifiers.
- Correct only the current-version inconsistencies proven by CHK-001.

## CHK-003: Verify translation completeness and current-version consistency with reproducible evidence

- Scan the whole file for Han characters and U+FFFD, enumerate remaining non-ASCII symbols, and inspect all residuals.
- Validate active command names and examples against the repository-local CLI, including a negative sentinel check.
- Review the diff for structural and semantic drift, then report exact commands, source references, HEAD, version, and salient results to the user.

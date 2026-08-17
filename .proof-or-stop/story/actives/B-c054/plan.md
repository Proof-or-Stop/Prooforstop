# Plan — B-c054: RFC 8785 CANON + fail-closed red-evidence policy resolver, surfaced in doctor

Foundation leaf (W2a) of the trusted RED-evidence subsystem spec. Diagnostic-only; no enforcement (W3), no runtime execution (W2e), no committed redEvidence block. All new code lives under `packages/main/src/core/red-evidence/`; the only existing files touched are `config.ts` (one optional field), `doctor.ts` (one non-gating render), and `lattice.config.json` (register the smoke).

Resolved design facts (from PLAN investigation):
- CANON = recursively rebuild objects with keys sorted by UTF-16 code unit (JS default `.sort()`), PRESERVING JSON `null`, then `JSON.stringify`. Verified empirically that `JSON.stringify` already emits RFC-8785 minimal number forms (`-0`→`0`, `1e21`→`1e+21`) and RFC-8785 string escaping, and default `.sort()` yields code-unit order. Reject `NaN`/`Infinity`.
- Differential targets are distinct: vs `core/digest.ts` the discriminator is KEY ORDER (localeCompare ≠ code-unit; digest.ts itself preserves null); vs `core/authority-signing.ts` the discriminator is NULL handling (it maps null→undefined and drops it; and sorts by code-POINT).
- forbiddenCatchAlls default 8th entry rendered `""` in §1.2 is taken as the 2-character double-quote literal (matcher values are required non-empty per §1.3 rule 1, so an empty-string entry is inert) — OPEN QUESTION flagged for the scope reviewer because it affects the frozen policyDigest literal.

## CHK-001 — Implement RFC 8785 CANON with UTF-16 code-unit key order, preserved JSON null, and sha256 prefix rendering
Approach: create `packages/main/src/core/red-evidence/canon.ts` exporting `canon(value)` (RFC 8785 string), `canonDigest(value)` (`sha256:<64-hex>`), `canonDigestOmitting(value, field)` (§0.4 self-omitting recordDigest), the §0.4 nullability helpers, and `first12hex(digest)` over the 64-hex body excluding the `sha256:` prefix. Recursive normalize: objects → keys sorted by code unit with values (including `null`) preserved; arrays preserved in order; `undefined`/function/symbol are a programming error for CANON inputs (throw); `NaN`/`Infinity` throw. Import only `node:crypto`.
Files: `packages/main/src/core/red-evidence/canon.ts` (new).
Verification: CANON vectors in the smoke (key order, preserved null, `-0`/`1e21`/`1e-7`, control-char + astral-key strings) each equal a frozen expected string/digest; `canonDigestOmitting` reproduces `canonDigest` of the object with the field deleted.

## CHK-002 — Prove differentially that no existing canonicalizer can serve as CANON and record why each was rejected
Approach: in the smoke and a committed RED artifact, assert `canonDigest({B:1,a:2}) !== digestCanonicalJson({B:1,a:2})`-rendered (localeCompare vs code-unit key order) and that `canon({priorRecordDigest:null})` preserves the field while `canonicalJsonForSigning({priorRecordDigest:null})` drops it. Each assertion carries a one-line reason string naming the specific defect (digest.ts:27 localeCompare; authority-signing.ts:64 null→undefined).
Files: `packages/main/tests/red/` differential artifact; assertions in the smoke.
Verification: before canon.ts exists the import fails (RED); after, both differentials hold with the reason strings recorded.

## CHK-003 — Resolve the exhaustive fourteen-key policySnapshot with canonical defaults and unknown-key fail-closed rejection
Approach: `packages/main/src/core/red-evidence/policy.ts` `resolveRedEvidencePolicy(block, ctx)` returns exactly the 14 keys with the spec's verbatim defaults (scalars, the fully-enumerated 1..255 exit-code array, the two default adapters and one default profile from `registries.ts`); `policyDigest = canonDigest(policySnapshot)`. An unknown key in the block rejects fail-closed.
Files: `policy.ts` (new), `registries.ts` (new default registry objects).
Verification: smoke asserts `resolveRedEvidencePolicy` on a minimal fixture (only `pinnedPath` set) yields `policyDigest === "sha256:<frozen literal>"` (literal independently pinned from the spec defaults) and an unknown key rejects with its diagnostic.

## CHK-004 — Fail closed on absent or relative pinnedPath with the exact red_evidence_policy_missing diagnostic
Approach: in `policy.ts`, a block missing `pinnedPath` rejects with exactly `red_evidence_policy_missing: pinnedPath` and NO default is substituted; a relative `pinnedPath` entry rejects at config load.
Files: `policy.ts`.
Verification: matrix cases assert the exact diagnostic string for missing pinnedPath and rejection for a relative entry.

## CHK-005 — Clamp-REJECT every hard safety floor with one distinct named diagnostic per violated floor
Approach: `policy.ts` clamp-REJECTS (never silently clamps) `minMatcherLen<4`, `minMatcherEntropyBits<12`, `maxMatchers>32`, `maxMatcherLen>4096`, and `runTimeoutMs`/`prepTimeoutMs>3600000`, each with a distinct named diagnostic; a `forbiddenCatchAlls` that drops a default entry and a `matcherClassRegistry` predicateKind outside the closed enum also reject.
Files: `policy.ts`.
Verification: matrix asserts each floor violation emits its named diagnostic and produces no snapshot.

## CHK-006 — Reject forbidden environment keys, bare catch-all invariance globs, and unresolvable argv placeholders at config resolution
Approach: `policy.ts` (with `registries.ts` schema validation) rejects an `allowedEnvKeys` naming any hard-set key (`PATH`, `NODE_OPTIONS`, `LD_PRELOAD`, any `DYLD_*`, ...); rejects an `invarianceExcludePaths` entry that is a bare `**`/`*` catch-all OR whose glob matches any tracked material path (live classification at config load), while KEEPING a legitimate `node_modules/**`; rejects an `argvTemplate` `${missing}` naming a capture its `testCaseRefPattern` lacks.
Files: `policy.ts`, `registries.ts`.
Verification: matrix asserts each rejection AND that `node_modules/**` is kept — the direction is proven both ways.

## CHK-007 — Add the optional redEvidence policy block to LatticeConfig without changing any existing config default
Approach: declare `redEvidence?: RedEvidencePolicyConfig;` in `core/config.ts` beside `proofStory?` (config.ts:195) and the `RedEvidencePolicyConfig` interface; no loader default is added.
Files: `packages/main/src/core/config.ts`.
Verification: smoke asserts that with the block absent, `loadConfig` output is byte-identical (canon-digest equal) to before this story for every other field.

## CHK-008 — Wire a non-gating red-evidence policy health check into createDoctorHandlers and prove doctor exit code is unchanged
Approach: add `scanRedEvidencePolicy(root)` and render ONE line in `createDoctorHandlers` (doctor.ts:67): the resolved `policyDigest` when a valid block is fixture-present, else the fail-closed diagnostic (`red_evidence_policy_missing: pinnedPath`) when absent. The check catches its own errors and never throws; doctor is not a gate.
Files: `packages/main/src/handlers/doctor.ts`.
Verification: smoke proves doctor's exit code is unchanged, no gate evidence is written, and `proofstory_gate_check` output is byte-identical; doctor always emits exactly one red-evidence line.

## CHK-009 — Fence every new red-evidence string to the assurance tier declared in the spec threat model
Approach: audit every new help/reason/rationale/doctor/commit string so none claims tamper-resistance beyond the §0.6 practical tier (accidental fabrication, workflow drift, casual gaming); no "tamper-proof"/"cannot be forged" language.
Files: all new strings across the story.
Verification: a grep-style assertion in the smoke (or a review checklist) confirms no forbidden overclaim tokens; reviewer confirms tier fidelity.

## CHK-010 — Register red-evidence-policy-canon-smoke in lattice.config.json validate.commands and pin the uncommitted-policy rule
Approach: create `packages/main/src/tasks/red-evidence-policy-canon-smoke.ts` covering CANON vectors, the two differentials, default `policyDigest`, and the fail-closed matrix; register `{command:"node",args:["packages/main/dist/tasks/red-evidence-policy-canon-smoke.js"],timeoutMs:180000}` in `validate.commands`. The smoke pins that `lattice.config.json` contains NO `redEvidence` block (pinnedPath is host-specific), so committing one is out of scope.
Files: `packages/main/src/tasks/red-evidence-policy-canon-smoke.ts` (new), `lattice.config.json`.
Verification: the smoke passes under the full validate suite and asserts the config has no redEvidence block.

# Proof-or-stop Thin Entrypoint Contract Migration Execution Plan

## Status

- Status: active implementation plan; migration not yet implemented.
- Scope: migrate the repository from a Claude-first root-document contract to host-neutral thin entrypoints backed by canonical documentation and mechanical registries.
- Product boundary: this plan changes documentation authority, generated assets, discovery, audit, review routing, and verification. It does not change the Story lifecycle, reviewer quorum, evidence admissibility, or DONE semantics.
- Delivery boundary: this document and its navigation entry are the only product changes in story B-c1f1. Every implementation stage below requires its own Story, verification evidence, review, and rollback point.
- Brand and host vocabulary: use `Proof-or-stop`; the three current hosts are Codex CLI, Claude Code CLI, and Antigravity CLI (`agy`). Do not introduce `CODEX.md`, `AGY.md`, or legacy Gemini CLI terminology as new contracts.

## Problem Statement

The repository already intends `AGENTS.md` and `CLAUDE.md` to be small discovery entrypoints, but current runtime and verification code still treats root `CLAUDE.md`—and in some checks root `AGENTS.md`—as a complete process contract. Making the files thin without migrating those consumers breaks audits, docs-drift checks, reviewer prompts, transition hints, and `npm test`. Copying the lifecycle back into both files would restore tests at the cost of preserving the architectural defect.

The migration must therefore change the authority graph and its mechanical consumers before declaring the old contract retired. Moving Markdown alone is insufficient.

## Decisions

### Host discovery matrix

| Host | Automatically discovered root entrypoint | Shared rules | Host-specific assets | Explicit non-contracts |
|---|---|---|---|---|
| Codex CLI | `AGENTS.md` | Reads the shared project constraints and canonical navigation from `AGENTS.md` | `.lattice-codex/` | No `CODEX.md` |
| Claude Code CLI | `CLAUDE.md` | `CLAUDE.md` imports or otherwise delegates shared rules to `AGENTS.md`; it must not copy the shared body | `.claude/agents/`, `.claude/hooks/`, `.claude/settings.json`, and supported Claude profiles | No second full lifecycle contract in `CLAUDE.md` |
| Antigravity CLI (`agy`) | `AGENTS.md` | Uses the same shared project entrypoint as Codex CLI | `.agents/` only when Antigravity-specific material is actually required | No `AGY.md`; do not add `GEMINI.md` without a separately proven compatibility requirement |

`AGENTS.md` is a shared convention entrypoint, not a Codex-only document. `CLAUDE.md` remains because its filename is a Claude Code discovery contract, not because Claude owns the common process contract.

### Target hierarchy and precedence

```text
AGENTS.md
  ├─ repository-local, non-negotiable constraints
  └─ → .lattice/Lattice.md

CLAUDE.md
  ├─ import/delegate → AGENTS.md
  ├─ Claude Code-only adapter information
  └─ → .lattice/Lattice.md

.lattice/Lattice.md
  ├─ host-neutral Proof-or-stop navigation
  ├─ → docs/dev/lattice-agent-runbook.md
  └─ → normative decision documents

docs/dev/lattice-agent-runbook.md
  ├─ operational projection: recovery, standard commands, review order,
  │  TEST-to-DONE convergence, and diagnosis
  └─ → docs/requirements/decisions/*.md

docs/requirements/decisions/*.md
  └─ normative process intent and policy

CLI registries, handlers, and gates
  └─ executable and mechanically consumed runtime facts
```

The existing `.lattice/Lattice.md` path is preserved. It is the one host-neutral navigation entry, but it is not a third copy of lifecycle prose.

When sources disagree, apply this order:

1. Current user and platform instructions govern the active interaction.
2. CLI schemas, registries, handlers, and gates govern executable runtime behavior and admissible evidence.
3. `docs/requirements/decisions/` governs normative process intent.
4. `docs/dev/lattice-agent-runbook.md` is a mechanically checked operational projection of those facts.
5. `.lattice/Lattice.md`, `AGENTS.md`, and `CLAUDE.md` provide discovery, minimum local constraints, and navigation; they do not redefine the detailed process.

A conflict between layers is a drift defect to fix, not permission to select whichever text is convenient.

### Normative facts versus operational projection

The runbook may explain how to resume a session, execute the standard Story flow, order reviewer work, converge TEST to DONE, diagnose a blocker, and invoke common CLI commands. Those instructions are behavior-affecting projections, so they must be checked against the command, lifecycle, reviewer-lane, and DONE-policy registries. The runbook must link to the owning decision for every process section and must state that decision docs and mechanical gates prevail if drift is detected.

Detailed lifecycle, verification, review-assurance, convergence, drift, and ownership facts remain in their existing decision sources, including:

- `docs/requirements/decisions/story-lifecycle.md`
- `docs/requirements/decisions/testing-infra.md`
- `docs/requirements/decisions/done-prepare-automation-execution-plan.md`
- `docs/requirements/decisions/review-assurance-floor-execution-plan.md`
- `docs/requirements/decisions/session-ownership-and-write-leases.md`
- `docs/requirements/decisions/story-files-hash-material-drift.md`

The runbook summarizes operations and links to these sources; it must not become co-equal normative authority.

### Root entrypoint content and budgets

`AGENTS.md` directly retains only the constraints that must be visible before following a link:

- `lattice session_brief` is the first command in a new or resumed session.
- User instructions override repository defaults.
- Story and fixture stores are not edited directly; use the Lattice CLI.
- Work follows the Story lifecycle unless the user explicitly requests an allowed quick path.
- Engineering completion is not the same as user-value completion.
- Ownership, lock, destructive-command, and blind-retry prohibitions that are needed before any action.
- Links to `.lattice/Lattice.md`, the runbook, and the normative documentation index.
- A statement that CLI output and gates are mechanical facts while the root file provides discovery and minimum safety constraints.

`CLAUDE.md` retains only:

- Claude Code discovery and shared-rule import/delegation.
- Claude-specific agent, hook, settings, and profile locations.
- Links to the same host-neutral guide and runbook.
- A statement that shared rules come from `AGENTS.md` and canonical documents.

The following are excluded from both managed root bodies: full CLI references, complete phase chapters, Finding schemas, checklist example collections, DONE drift taxonomies, reviewer/subagent manuals, and historical compatibility essays.

Budgets are anti-regression ceilings, not fill targets:

| Asset | Recommended generated/managed size | Hard ceiling | Hard byte ceiling |
|---|---:|---:|---:|
| `AGENTS.md` managed body | 30–60 lines | 150 lines | 16 KiB |
| `CLAUDE.md` managed body | 10–30 lines | 120 lines | 12 KiB |

Verification must measure the managed body separately from user-owned text. It must also resolve the effective import closure for each host, deduplicate repeated imports, reject cycles, and cap the resolved shared instruction closure at 220 lines and 24 KiB. A short file that imports an unbounded or cyclic body does not satisfy the thin-entrypoint contract.

All local Markdown links in the managed bodies, `.lattice/Lattice.md`, and the runbook must resolve to an existing file and anchor, must not target retired authority, and must not form a navigation/import cycle.

### Repository-local constraints and managed ownership

The OMX prohibition, user-owned bootstrap text, and other repository-local constraints remain outside the Proof-or-stop managed block unless they are separately adopted as universal generated policy. In this repository, the OMX prohibition must remain directly visible in `AGENTS.md`, but generators must not propagate it to unrelated projects.

Managed-asset updates must preserve text before and after `<!-- lattice:start -->` / `<!-- lattice:end -->`. Tests must prove that profile changes, init, check, and repair do not delete, duplicate, or relocate repository-local text. Claude's import/delegation must expose the shared repository-local constraints without copying them into a second managed body.

## Shared Canonical-Document Registry

Create one typed, data-only registry—for example `packages/main/src/core/canonical-agent-docs.ts`—and make all behavior-affecting consumers use it instead of maintaining path arrays independently. A suitable shape is:

```ts
type CanonicalAgentDocRole =
  | 'shared-entrypoint'
  | 'host-entrypoint'
  | 'host-neutral-guide'
  | 'operational-projection'
  | 'normative-process';

type AgentDocSourceView = 'canonical' | 'legacy-fallback';

type AgentDocContentSelector =
  | { kind: 'whole-document' }
  | { kind: 'managed-slots'; slotNames: string[]; allowedClaimSlots: string[]; absencePolicy: 'required' | 'empty-if-all-absent' }
  | { kind: 'legacy-complement'; excludeSlotNames: string[] };

interface CanonicalAgentDocView {
  id: string;                  // stable view identity; path alone is never an identity
  path: string;
  sourceView: AgentDocSourceView;
  contentSelector: AgentDocContentSelector;
  role: CanonicalAgentDocRole;
  hosts: Array<'codex' | 'claude' | 'antigravity'>;
  auditCommands: boolean;
  auditPaths: boolean;
  docsDrift: boolean;
  reviewDiscoverable: boolean;
  required: boolean;
}
```

The registry unit is a source view, not a path. The initial registry declares views over `AGENTS.md`, `CLAUDE.md`, `.lattice/Lattice.md`, `docs/dev/lattice-agent-runbook.md`, and the specifically owned decision documents. Selectors such as `viewsForMechanicalAudit()`, `viewsForReviewDrift()`, `viewsForHost(host)`, and `normativeViewsForFact(fact)` return ordered view records; callers may deduplicate file reads by path but must apply each view's content selector and preserve its `id` and `sourceView` in provenance. The registry contains no filesystem I/O; callers resolve paths from the repository or git root appropriate to their gate.

Managed slots use exact, non-nesting markers `<!-- lattice:slot:<name>:start -->` and `<!-- lattice:slot:<name>:end -->`. Duplicate, partial, nested, reversed, or overlapping markers fail closed. `absencePolicy: 'required'` also fails when all markers are absent. `empty-if-all-absent` is permitted only for a recognized pre-cutover legacy managed-asset version: all declared markers must be absent, the canonical range is empty, and the legacy complement is the whole file; any partial appearance fails. Fresh thin templates use `required`. The generic outer `<!-- lattice:start -->` / `<!-- lattice:end -->` managed-body markers do not by themselves make content canonical. `managed-slots` selects only the complete declared ranges, while `legacy-complement` selects the exact line-range complement; selector construction must prove those ranges are disjoint and cover the intended source view before extraction.

During migration, each root entrypoint has two views over its physical path:

- `AGENTS.md` canonical view selects only declared thin slots such as `agents-host-discovery`, `agents-local-safety`, and `lattice-navigation`. Its `allowedClaimSlots` are limited to shared host discovery, the directly visible minimum safety constraints defined by this plan, and canonical navigation. Its legacy view selects the exact complement.
- `CLAUDE.md` canonical view selects only declared thin slots such as `claude-host-discovery`, `shared-agent-import`, and `claude-adapter`. Its `allowedClaimSlots` are limited to Claude host discovery, shared import/delegation, and Claude-only adapter facts. Its legacy view selects the exact complement.

Before Story 7/8 emits those slot markers, both canonical root views are empty under the recognized pre-cutover `empty-if-all-absent` policy, and every detailed process fact in the existing `AGENTS.md` and `CLAUDE.md` files is `legacy-fallback` provenance only. Unmarked user-owned text remains preserved and available to the effective host instruction closure, but it is not canonical mechanical process-fact evidence unless a separate registry view explicitly owns it. A detailed lifecycle/review/DONE fact placed inside either root's thin slots is a misplaced or unparseable fact and fails the root non-duplication/selector checks; slot placement cannot promote it to canonical authority.

The same source-view rule applies when templates and existing repositories coexist: path equality never changes a view's authority. A fact counts as canonical provenance only when extracted through a `sourceView: 'canonical'` selector whose declared slot permits that fact's `claimSlot`; a legacy-complement match remains legacy even if another view for the same path is canonical.

The process-fact verifier must use the same exported ownership model or a generated JSON projection of it. It must not keep a second handwritten list that again requires lifecycle vocabulary in root entrypoints.

### Source-independent semantic fact identity

Dual-read deduplication must not include path, anchor, or document role in fact identity, because canonical and legacy sources necessarily have different locations. It also must not infer semantic equivalence from free-form prose or an AI judgment. Story 1 defines a versioned, deterministic extractor (`schemaVersion = 1`) whose accepted inputs are registry records and an explicit, finite set of Markdown patterns. Each accepted statement is parsed into:

```ts
interface NormalizedDocFact {
  schemaVersion: 1;
  factId: string;              // stable extractor-assigned identity before hashing
  factType: 'command' | 'flag' | 'path' | 'lifecycle' | 'review' | 'evidence' | 'policy';
  subject: string;             // normalized entity affected by the fact
  commandOrPolicy: string;     // normalized CLI command or stable policy key
  claimSlot: string;           // versioned aspect key, e.g. availability, ordering, required-phase, outcome
  semantics: {
    modality: 'must' | 'must-not' | 'may' | 'advisory';
    predicate: string;         // canonical whitespace/case/parameter representation
    outcome: string;           // normalized required, forbidden, or reported result
    parameters: string[];      // sorted, normalized flags/fields when applicable
  };
}

interface FactProvenance {
  viewId: string;
  sourceView: AgentDocSourceView;
  sourceRevision: string;       // exact repository HEAD used by the extraction run
  path: string;
  lineRange: [number, number];
  gitBlobId: string | null;     // null only for explicitly injected in-memory fixtures
  fullContentDigest: string;    // SHA-256 of the complete source bytes, not selected lines
  registryDigest: string;       // canonical digest of the complete registry snapshot
  signerRegistryDigest: string; // trusted signer/key/rotation registry at sourceRevision
  viewDefinitionDigest: string; // canonical digest of this full view record
  selectorDigest: string;       // includes kind, slotNames, allowedClaimSlots, and absencePolicy
  anchor: string | null;
  role: CanonicalAgentDocRole;
  host: 'codex' | 'claude' | 'antigravity' | 'shared';
  rawTextHash: string;
}
```

Every extraction produces one Ed25519-signed envelope, and every readiness result binds it explicitly:

```ts
interface FactExtractionSnapshot {
  sourceRevision: string;
  materialClean: true;
  registryDigest: string;
  signerRegistryDigest: string;
  viewDefinitionDigests: string[];
  selectorDigests: string[];
  documents: Array<{ path: string; gitBlobId: string | null; fullContentDigest: string }>;
  resultDigest: string; // canonical digest of facts, conflicts, collisions, unparsed facts, and provenance
}

interface FactReadinessArtifact {
  sourceRevision: string;
  extractionSnapshotDigest: string;
  registryDigest: string;
  signerRegistryDigest: string;
  resultDigest: string;
  reviewEvidenceDigest: string;
  status: 'pass' | 'fail' | 'stale';
}
```

### Non-self-invalidating evidence persistence boundary

Live extraction, review, and readiness evidence is process evidence but not material source input. Story 1 must register exactly these artifact IDs and path templates in `packages/main/src/core/runtime-artifact-registry.ts` (extending its typed schema with the bounded process-evidence classification), while `packages/main/src/core/process-fact-registry.ts` registers their gate semantics and references the IDs instead of hard-coding paths:

| Artifact ID | Live path template | Required binding |
|---|---|---|
| `thin_entrypoint_fact_extraction` | `.lattice/process-evidence/thin-entrypoint/fact-extraction/<sourceRevision>/<artifactDigest>.json` | `sourceRevision`, registry/view/selector/document/result digests |
| `thin_entrypoint_review_evidence` | `.lattice/process-evidence/thin-entrypoint/review/<sourceRevision>/<artifactDigest>.json` | extraction snapshot digest, reviewer identity/run, review payload digest |
| `thin_entrypoint_readiness` | `.lattice/process-evidence/thin-entrypoint/readiness/<sourceRevision>/<artifactDigest>.json` | extraction and review artifact digests plus readiness result |

These are the only live-path exclusions. The existing registry's `.lattice/runtime/` `runtime-cache` prefix is intentionally not used: current `findRuntimeArtifactEntry()` returns the first match, so nesting process evidence there would make authority depend on registry order. Each new artifact ID instead gets one anchored regex matcher under the non-overlapping `.lattice/process-evidence/thin-entrypoint/` namespace: the type segment must be exact, `sourceRevision` must be a normalized Git object ID, `artifactDigest` must be a SHA-256 hex digest, and the path must end at that JSON file. There is no catch-all process-evidence prefix matcher.

Gate consumers call a typed `resolveProcessEvidenceArtifact(path, expectedArtifactId)` rather than accepting `isRuntimeArtifactPath(path)`. Resolution normalizes the path, requires exactly one `processEvidence` registry entry, requires its ID to equal `expectedArtifactId`, and revalidates the entry's exact template. Zero or multiple typed matches, an ID mismatch, traversal, or a sibling path fails closed. Thus a legacy-looking path under `.lattice/runtime/evidence/...` may still match generic `runtime-cache` for cleanup, but it is rejected as process evidence; exact artifact identity always dominates generic runtime classification. Registry verification also injects duplicate typed matchers and requires ambiguity failure, without changing the compatibility semantics of unrelated existing runtime-cache entries.

Typed resolution is not authorization to perform path I/O. Reads and writes use one project-root-anchored safe-I/O primitive with this mandatory sequence:

1. Lexically normalize separators and reject NULs, absolute/drive/UNC paths, empty components, `.`/`..`, traversal after decoding, and any result outside the exact artifact template.
2. Resolve the project root once to its real path. Walk every path component from an opened root directory descriptor using `lstat` plus no-follow directory opens (`openat` with `O_NOFOLLOW|O_DIRECTORY`, or the platform-equivalent reparse-point-safe API). Reject every symlink/reparse-point component and verify each opened component's `fstat` identity and containment under the root. If the platform cannot provide equivalent no-follow semantics for gate evidence, fail closed.
3. For reads, open the final file relative to the verified parent with no-follow semantics, require a regular file, capture device/inode or the platform file identity with `fstat`, read through that descriptor, and recheck identity/size before accepting the signed bytes. Never validate a pathname and then reopen it through an unchecked string path.
4. For writes, keep the verified parent descriptor open; create a mode-`0600` exclusive no-follow temporary file in that same directory, write and fsync it, verify its identity, then `renameat`/platform-equivalent atomically within that directory and fsync the parent. Reopen the target no-follow, verify it is the same committed file and digest, and revalidate the parent chain before returning success. Cleanup uses the same descriptor-bound rules.

The safe-I/O implementation exposes deterministic race-test hooks only in tests. Required fixtures replace an intermediate directory with a symlink, use a symlink as the target, swap the target/parent between lexical validation and open or rename, and attempt `../`, absolute, drive/UNC, and realpath-root escapes. Every case must fail before reading trusted bytes or publishing an artifact; the swap-race fixture must prove descriptor-bound operations do not follow the replacement.

The registry must declare the three entries `untracked`, `gitignored`, `processEvidence: true`, and excluded from source-input/material digests. Registry verification fails if a path escapes its exact template, if any live artifact is tracked by Git, or if a broad directory such as `.lattice/story/` or `.lattice/process-evidence/` is allowlisted as gate evidence. `materialClean` rejects every tracked dirty path; it may ignore only untracked files that resolve to one of the three validated live templates. Writing, atomically replacing, or reloading a registered artifact must not change HEAD, create a tracked status entry, or alter any source-input digest.

Each persisted envelope contains `artifactId`, schema version, `sourceRevision`, signed `createdAt`, payload digest, previous-artifact digest where applicable, `signer`, `keyId`, an Ed25519 signature, and its upstream artifact digests. Hash chaining provides ordering/linkage only and is never accepted as authenticity.

Implementation must reuse `packages/main/src/core/authority-signing.ts` canonical JSON + Ed25519 `signEnvelope`/verification primitives and the strict trusted-key verification pattern already used by `packages/main/src/core/receipt-bundle.ts`; it must not invent another digest signer or verify against a public key self-reported by the envelope. The inspected repository has these authoritative primitives but no suitable persisted rotation-aware process-evidence keyring, so Story 1 adds a narrow tracked `process-evidence-signer` registry. It maps `(signer, keyId)` to the trusted public key, allowed artifact IDs, and status (`pending`, `active`, `retired`, or `revoked`), and declares exactly one current active key for each live signer/artifact-ID authorization. Zero or multiple active keys fail closed.

Live gate verification accepts only the registry's current `active` key for the signed `signer` and artifact ID. `pending`, `retired`, and `revoked` keys never satisfy live readiness, including for artifacts signed while they were formerly active. A separate explicitly non-gate archival verifier may use retired public keys to establish historical provenance; it cannot produce or upgrade a live readiness result. Signed `createdAt` remains audit metadata and is never used to choose a key or bypass current status. Rotation changes the tracked signer-registry digest and HEAD, immediately staling the old live chain; fresh extraction, review, and readiness must be signed by the newly active key.

Key loading has two structurally separate commands/modes:

- Normal startup/signing resolves only the registry's current active `(signer, keyId)` for the requested artifact ID. Its key-provider API accepts an `ActiveSigningKeyRef`, and the live artifact writer accepts only that branded result; a pending/retired/revoked registry record cannot be converted to this type.
- A human-only pending-key enrollment/preflight command requires explicit `signer`, `keyId`, provider, and human acknowledgement. It resolves exactly one registry record whose status is `pending`, applies the same secure provider/permission checks, derives the public key, and compares it with that pending record. Its module returns only `{ signer, keyId, publicKeyDigest, matches }`; it exposes no private-key bytes, `signEnvelope`, live-writer handle, or `ActiveSigningKeyRef`. The command may append a clearly `gateEvidence: false` audit event—or emit no artifact—but it cannot write any of the three process-evidence artifact IDs. Command policy and tests must reject non-interactive/autopilot invocation.

This separation is enforced by module boundaries and types, not a caller-supplied `mode` boolean. Required fixture: pending B preflight succeeds and produces no gate evidence; an attempted B live signature fails while B is pending; after the human-reviewed activation commit and restart, normal startup resolves B as active and a fresh B chain passes.

Private-key lifecycle is local and explicit; this plan assumes no automatic network KMS:

- Fresh init/bootstrap requires a human-invoked key setup step. It generates an Ed25519 keypair with the existing `authority-signing.ts` primitive, stores the private seed through the approved provider, and emits only the public key plus proposed `signer`/`keyId` for review. The public key is added to the tracked signer registry and committed before the first evidence baseline; no live signing is allowed until that committed registry marks it active.
- Preferred developer storage is the OS keychain/credential store. The bounded fallback artifact ID is `thin_entrypoint_signing_private_key`, with the only allowed path `.lattice/keys/process-evidence/<signer>/<keyId>.ed25519`; it has an anchored registry matcher, is classified as a secret runtime artifact, is gitignored, is created exclusively with file mode `0600` and parent directories `0700`, and is accessed through the same symlink-safe no-follow I/O rules. No directory-wide private-key discovery is allowed.
- CI may inject either a secret-file path through `LATTICE_PROCESS_EVIDENCE_PRIVATE_KEY_FILE` or a secret value through `LATTICE_PROCESS_EVIDENCE_PRIVATE_KEY`; configuration must also name the registered signer/key ID. Environment values are consumed in memory only and are never echoed, serialized, included in diagnostics, or inherited by child processes after initialization.
- An external CI secret-file path is accepted only beneath an explicitly configured approved secret-mount root. The provider opens that root by walking from the filesystem/volume root component by component with `lstat` plus `openat(O_NOFOLLOW|O_DIRECTORY)` or the platform-equivalent reparse-point-safe handles, then walks every child component relative to retained directory descriptors. During this first walk it records the ordered identity of every opened parent descriptor and the final file: POSIX implementations record at least `(st_dev, st_ino)` from `fstat`, while other platforms record the equivalent stable volume/file IDs. It rejects symlink/reparse parents and final targets, mount/root escape, traversal, and injected parent swaps; the final no-follow descriptor must `fstat` as a regular file with expected owner and mode `0600` (or the platform's equivalently exclusive ACL). The key bytes are read only through that retained final descriptor, so a pathname swap cannot redirect the read. After the descriptor-bound read and before returning any bytes, the provider performs a second independent root-anchored no-follow walk beginning again at the filesystem/volume root, records the same ordered parent-chain and final-file identities, and compares the entire chain with the first-walk record. A missing component or any parent/final identity mismatch causes the provider to zero/discard the buffered key bytes and fail closed; it never returns bytes from an attacker replacement. Endpoint-only `realpath`/`stat`, a pathname reopen, or a second walk rooted in retained first-walk descriptors is forbidden. If a platform cannot guarantee these semantics, the external file provider fails closed and CI must use the in-memory environment provider or an OS credential store.
- On every startup and before signing, resolve the configured key provider, reject missing files, symlinks, group/world-readable local files, malformed key bytes, and wrong ownership where the platform exposes it; derive the public key from the private key and require an exact match to the current active registry entry and artifact-ID authorization. No CLI, API, diagnostic, evidence envelope, or recovery command may print or export private key material. Logs and errors contain only provider kind, signer, key ID, and a reason code—never private bytes or a reversible encoding. Existing secret redaction must include both environment names and raw/PEM private-key patterns.
- Private-key loss blocks new extraction/review/readiness signing but does not block verification of already signed or archival artifacts whose public key remains trusted. Recovery is a human re-provision or two-step rotation, never silent key regeneration.

Normal two-step rotation is: (1) generate/store key B and commit its public key as `pending` while A remains the sole active key; (2) after the human-only pending-key preflight proves B's private key matches the pending public key, make a second human-reviewed registry commit that marks B active and A retired. That second commit changes HEAD/registry digest, so all A live chains become stale and B must sign a fresh complete chain. If A is lost before step 2, signing remains blocked while a human provisions B and completes the same preflight plus reviewed activation; verification with A's retained public key remains archival-only. If B activation is bad, a human commits a repaired key C or explicitly reactivates a still-available authorized key in another registry change, then regenerates the entire live chain. No rollback treats an old signature as current across a registry commit.

Persist by atomic rename and verify the strict envelope shape, Ed25519 signature, trusted signer/key authorization, and complete linkage chain on load. Review evidence references extraction; readiness references both extraction and the current review. A process restart may reload a live artifact only after rechecking its typed registry path, trusted signature, linkage chain, exact material HEAD, `materialClean`, and every source/registry/view/selector digest.

Committed evidence is archival only. An archival copy has a distinct non-live artifact type/location and is never accepted by the same-HEAD readiness consumer. Committing it creates a new HEAD, so any prior live artifact is stale and a new extraction/review/readiness chain is required. No implementation may commit a live artifact to make a gate pass.

Review and readiness artifacts reference the extraction snapshot digest rather than copying an unbound fact list. All facts contributing to one readiness decision must come from the same snapshot and exact material HEAD. Any new commit—including one unrelated to selected documents—changes `sourceRevision` and makes the prior chain stale. At the same HEAD, any tracked dirty path makes `materialClean` false, while writes to the three validated untracked process-evidence templates do not. A changed document byte, registry row, view role/flags, selector kind/range, `slotNames`, `allowedClaimSlots`, or `absencePolicy` also makes the prior extraction and every dependent review/readiness artifact stale; callers must clean the material tree, then re-extract and re-review instead of merging snapshots.

`factId` is emitted by the versioned extractor from `{schemaVersion, factType, subject, commandOrPolicy, claimSlot}`; it is not generated from source location or prose wording. `claimSlot` identifies the independently assertable aspect of a subject. For example, a command's availability and its required phase occupy different slots and coexist, while two different required phases occupy the same slot and conflict. Extractor patterns declare their slot and field mapping in code, and changes to those mappings require a schema-version change plus migration fixtures.

Normalize Unicode, line endings, whitespace, command spelling, flag ordering, parameter placeholders, and registry-backed aliases before serializing with canonical JSON key order. Two differently worded statements are equivalent only when a declared extractor pattern parses both into byte-identical normalized fields; syntactic cleanup alone does not claim semantic equivalence. A behavior-affecting line that matches the bounded authority scan but cannot be parsed becomes a structured `unparsedFact` with provenance and blocks audit, readiness, and retirement. It is never guessed, silently skipped, or reduced by an NLP similarity score.

Compute:

```text
factId = canonicalFactId({ schemaVersion, factType, subject, commandOrPolicy, claimSlot })
conflictKey = SHA-256(canonicalJson({ schemaVersion, factType, subject, commandOrPolicy, claimSlot }))
fingerprint = SHA-256(canonicalJson({ schemaVersion, factId, factType, subject, commandOrPolicy, claimSlot, semantics }))
```

`fingerprint` is the source-independent semantic identity. Equal fingerprints with byte-identical canonical payloads merge into one fact whose provenance is the ordered union of every source path, anchor, role, host, and raw-text hash. Source information is never discarded and never participates in identity.

Fail closed in either conflict case:

1. Equal `conflictKey` with different normalized `semantics` means canonical and legacy sources disagree about the same aspect of the same subject/policy. Record a semantic-conflict result containing the shared `claimSlot`, both fingerprints, and all provenance; audit, readiness, and retirement fail until the owning source is corrected. Facts in different slots are complementary and do not conflict.
2. Equal `fingerprint` with non-identical canonical payload bytes means a hash collision or normalizer defect. Record a fingerprint-collision result and fail without choosing either payload. The hash function is dependency-injected at the fingerprinting boundary so the collision path is deterministically testable; production uses SHA-256.

Readiness and retirement compare semantic sets, not document locations. A fingerprint with legacy provenance and no canonical provenance is a legacy-only fact and blocks readiness. A fingerprint present in both sources counts once and retains both provenance records. Any conflict/collision blocks readiness and retirement. Retirement is allowed only when every retained behavior fact has canonical provenance, the legacy-only set is empty, and the conflict/collision set is empty; moving a fact between canonical paths does not reset semantic identity.

Required dual-read fixtures:

| Fixture | Expected result |
|---|---|
| Canonical runbook and legacy `CLAUDE.md` express the same normalized command/policy fact with different wording and paths | One fingerprint, one fact, and exactly two provenance sources; readiness does not count it as legacy-only |
| Legacy `CLAUDE.md` contains a normalized fact absent from all canonical sources | One legacy-only fingerprint with its provenance; readiness and retirement fail and identify the missing canonical owner |
| Two facts describe the same command but use distinct `claimSlot` values such as `availability` and `required-phase` | Both facts coexist; neither is reported as a conflict |
| Two facts use the same `claimSlot` but have opposing semantics | One semantic conflict is reported with both provenance sets; readiness and retirement fail |
| Two differently worded statements match declared extractor patterns and parse to the same structured fields | One stable `factId` and fingerprint are produced; wording and path do not affect identity |
| A scan-matched behavior-affecting statement matches no declared extractor pattern | One provenance-bearing `unparsedFact` is reported; audit, readiness, and retirement fail closed |
| The injected hash seam returns the same fingerprint for two byte-distinct canonical payloads | One fingerprint-collision result is reported; both payloads are retained for diagnostics and neither is selected as authoritative |
| One physical `CLAUDE.md` contains declared thin host/import slots plus an old detailed lifecycle fact outside those slots, and canonical/legacy views target the same path | The thin facts receive canonical provenance, the detailed fact receives legacy-fallback provenance only, and readiness remains blocked if that detailed fact has no canonical counterpart; deduplicating the file read must not deduplicate or relabel the views |
| One physical `AGENTS.md` contains declared discovery/safety/navigation slots plus an old detailed lifecycle fact outside those slots, and canonical/legacy views target the same path | The thin facts receive canonical provenance, the detailed fact receives legacy-fallback provenance only, and readiness remains blocked if that detailed fact has no canonical counterpart; the shared filename must not launder its complement into canonical provenance |
| A fixture configures canonical and legacy selectors whose ranges overlap on the same physical path | Registry/selector validation fails before extraction and reports both view IDs and the overlapping range; no provenance is emitted |
| After a passing extraction, mutate one selected document byte without changing its path | The full-content/blob digest differs, so the fact snapshot and dependent readiness/review artifact are stale and fail until extraction and review rerun at the new content |
| After a passing extraction, change a view selector or only its `allowedClaimSlots` while document bytes remain unchanged | The registry/view/selector digest differs, so the prior facts cannot be reused and readiness fails stale until re-extraction and review bind the new snapshot |
| At a clean HEAD, extract facts, persist the registered runtime extraction artifact, persist reviewer and readiness artifacts, terminate the process, then reload through a fresh process | All three files remain untracked/gitignored, HEAD and source digests are unchanged, each Ed25519 signature verifies through the trusted signer registry, linkage/upstream references verify, and readiness passes at the same material HEAD after restart |
| After a passing chain, commit an unrelated tracked file while all selected document bytes remain unchanged | The new HEAD differs from `sourceRevision`; extraction, review, and readiness are stale until a new complete chain is produced at the new HEAD |
| At the same HEAD, modify an unrelated tracked file without committing | `materialClean` is false and readiness fails until the tracked change is committed or cleaned; selected-input equality is not a bypass |
| At a clean HEAD with a passing extraction, write or atomically replace only a registry-validated runtime-evidence artifact | Git material status, HEAD, and every source-input digest remain unchanged; the correctly chained artifact does not stale its own extraction |
| Resolve one valid exact process-evidence path, one invalid sibling in the dedicated namespace, and one legacy-looking path under the broad `.lattice/runtime/` prefix | The valid path resolves to exactly its expected artifact ID; the sibling has zero typed matches; the broad-runtime path may classify as cache but is rejected by the typed process-evidence resolver |
| Inject a second `processEvidence` entry that matches the same otherwise-valid path | Typed resolution reports both IDs and fails closed; registry ordering cannot select a winner |
| Tamper with a signed payload and recompute its payload digest plus every unkeyed linkage hash | Trusted Ed25519 verification fails; a self-consistent hash chain cannot authenticate forged bytes |
| Verify with an unknown `keyId`, a valid key registered to the wrong signer/artifact ID, a pending key, a retired key, a revoked key, and the current active key before and after process restart | Every non-current/wrong-authorization case fails with a distinct diagnostic; only the currently active authorized key passes live readiness, and restart reload repeats registry/signature verification rather than trusting cached state |
| Exercise path I/O with a symlinked intermediate component, symlink target, injected component/target swap race, and lexical/realpath root escapes | No trusted bytes are read and no artifact is published; no-follow descriptor identity checks or the platform equivalent detect the attack and fail closed |
| Build and pass a complete live chain with active key A; commit registry step 1 with B pending; then commit step 2 with B active and A retired, restart, and reload the A chain | The step-2 commit changes HEAD and signer-registry digest; A is rejected for live readiness after restart regardless of signed time. A fresh complete B chain passes. Signing an artifact ID not authorized to B fails |
| Bootstrap a fresh temporary project, persist/reload its approved private key, then test missing key, mode `0644`, symlink key file, private/public mismatch, CI secret-file and environment injection, and lost-A recovery through pending/active B rotation | Fresh/bootstrap and valid restart/CI providers pass after public registry commit; insecure/missing/mismatched inputs block signing without exposing key bytes; existing signatures remain verifiable; human-provisioned B restores new signing only after activation and a fresh chain |
| With A active and B pending, run human pending-key preflight for exact B, then attempt live signing with B; activate B in the tracked registry, restart, and use normal signing | Preflight derives/matches B and emits no gate evidence; pending B cannot obtain an active-key capability or sign live artifacts; after activation only normal startup resolves B and its fresh chain passes |
| Point the CI file provider at a valid mode-0600 file, then use deterministic race hooks to rename and replace an ordinary approved-root parent directory, replace the final target with a different regular file, replace a parent with a symlink/reparse point, and pause at the relevant boundaries between first walk, descriptor-bound read, and second walk | The provider returns the stable original-inode bytes only when the second independent root-anchored walk proves the entire ordered parent chain and final identity unchanged; otherwise it zeroes/discards buffered bytes and fails before return. It never returns attacker replacement bytes; an incapable platform fails the file provider and the in-memory/OS provider remains available |

Required executable selector-state fixtures (Story 1; exercised through the real pure selector implementation, not prose mocks):

| Selector state | Required result |
|---|---|
| `absencePolicy: 'required'` and all declared slot markers absent | Fail closed with the view ID and missing slot names; emit no canonical or legacy facts |
| Recognized pre-cutover legacy asset version, `empty-if-all-absent`, and all declared markers absent | Return an empty canonical range plus a full-file legacy complement; every extracted process fact has legacy-fallback provenance |
| Any partial state: one boundary missing, only some declared slots present, duplicate marker, nested marker, reversed marker, or canonical/legacy overlap | Fail selector validation before fact extraction; identify the malformed/overlapping range and emit no provenance |

## Current Consumer Inventory

Before each implementation Story, produce a fresh, repository-wide bounded scan manifest. A preselected `rg` over known files is not sufficient. The scan must enumerate tracked text files under the root entrypoints, `.lattice/`, `docs/`, `packages/main/src/`, `packages/main/templates/`, and `scripts/`; exclude generated output, Story stores, fixture stores, dependencies, worktrees, and disabled legacy areas; then search both code-shaped and prose-shaped authority references. At minimum it must detect:

- exact paths and filename literals for `CLAUDE.md`, `AGENTS.md`, `LATTICE.md`, and `.lattice/Lattice.md`;
- path arrays, `readFile`/`existsSync` calls, git pathspecs, glob patterns, managed-asset IDs, and docs-drift reader injection points;
- prose such as “rules in CLAUDE.md”, “canonical detailed version”, “keeps only a short summary”, “see the … section in CLAUDE.md”, “update AGENTS.md/CLAUDE.md when workflow changes”, and equivalent authority claims that contain no Markdown link;
- tests and fixtures that encode the old authority even when production code no longer does.

The Story must persist or attach a deterministic classification table with `path:line`, matched phrase, consumer category, behavioral/non-behavioral status, target authority, owning implementation Story, and disposition (`migrate`, `retain-as-host-discovery`, `retain-as-active-plan`, `neutral-fixture`, or `remove`). `retain-as-active-plan` is limited to live requirements in this migration plan; it does not allow another active document to keep assigning authority to retired roots. Every scan hit must be classified; an unclassified hit fails that Story's focused verification. The implementation diff is then checked against this complete manifest, not merely against the named baseline below.

This requirement applies to review of B-c1f1 itself: its adversarial documentation verification must execute the bounded enumeration against the current repository and attach the classification summary and zero-unclassified result. The named inventory in this plan cannot be used as self-validating evidence. Successor Stories rerun the same bounded scan because the repository may have acquired new consumers after this plan was accepted.

### Init, profile, sync, and managed assets

- `packages/main/src/init-assets.ts`: generic and global-thin templates, host wording, guide pointers, and the missing dedicated global-thin Claude shape.
- `packages/main/src/core/managed-assets.ts`: managed markers, drift checks, repair, host profile asset sets, and local-edit review.
- `packages/main/src/claude-md-sync.ts` and `packages/main/src/handlers/workflow.ts`: Claude profile-section mutation and rollback; replace whole-document assumptions with managed host-adapter ownership or retire the special sync path.
- `packages/main/src/cli-init.ts`, `packages/main/src/cli-prompts.ts`, and `packages/main/src/cli/command-catalog.ts`: profile selection, generated-asset descriptions, and help text.
- `packages/main/src/core/codex-adapter-checks.ts`: Codex entrypoint verification must continue to target `AGENTS.md` without treating it as Codex-only prose.
- `packages/main/src/tasks/thin-init-assets-smoke.ts` and `packages/main/src/tasks/managed-assets-wrapper-root-smoke.ts`: generation, preservation, profile transition, and wrapper-root regression coverage.

### Mechanical audit and audit triggering

- `packages/main/src/handlers/audit.ts`: replace the hard-coded root `CLAUDE.md` list and “nothing to audit” result with registry-selected canonical docs.
- `packages/main/src/core/audit-scan.ts`: make diagnostics name the actual source document instead of always saying `CLAUDE.md`; scan registry-selected command/path-bearing docs.
- `packages/main/src/core/audit-trigger.ts`: trigger on changes to the canonical audit set rather than only `CLAUDE.md` and package-local Claude files; keep the trigger bounded and deterministic.
- `packages/main/src/tasks/deprecated-gc-smoke.ts:66`: replace the copied `CLAUDE.md has changed` audit-trigger hint fixture and keep its advisory assertion synchronized with the registry-backed trigger text.
- `packages/main/src/handlers/validate-docs-drift.ts`: preserve its pure comparison behavior while accepting content assembled from registry-selected docs.
- `packages/main/src/tasks/audit-esm-smoke.ts`, `packages/main/src/tasks/docs-drift-path-drift-smoke.ts`, and `packages/main/src/tasks/docs-drift-wrapper-root-smoke.ts`: replace Claude-only fixtures with canonical-set fixtures and preserve git-root behavior.

### Review preflight, prompts, and delivery promises

- `packages/main/src/handlers/review-preflight.ts`: replace the default `CLAUDE.md` reader with a registry-backed, git-root-relative canonical reader; preserve dependency injection and fail-closed missing-required-doc behavior.
- `packages/main/src/handlers/agent-prompt.ts` and `packages/main/src/handlers/story-dispatch.ts`: pass bounded document candidates and roles to reviewers instead of implying one giant root contract.
- `packages/main/templates/agents/lattice-review-story-init.md`: stop requiring a complete read of root `CLAUDE.md`; require the thin entrypoint, relevant runbook section, and task-owned normative documents.
- `packages/main/templates/agents/lattice-review-docs.md`: search `AGENTS.md`, `CLAUDE.md`, `.lattice/Lattice.md`, runbook, and task touchpoints through the registry; remove the documentation-only fallback that reads an entire root contract.
- `packages/main/templates/agents/lattice-review-behavior.md`, `lattice-review-channel.md`, `lattice-review-concept.md`, `lattice-review-quality.md`, and `lattice-review-delivery.md`: generalize “promises in CLAUDE.md / README” to promises in changed or registry-selected canonical docs.
- `packages/main/templates/agents/test-intent.md`: update any root-contract routing language found by the pre-implementation scan.

### Lifecycle hints and user-value guidance

- `packages/main/src/handlers/transition-effects.ts`: point user-value acceptance hints to the owning runbook/decision anchor, not a removed `CLAUDE.md` section.
- `packages/main/src/tasks/flow-stability-smoke.ts` and `packages/main/src/tasks/session-brief-prompt-sync-smoke.ts`: assert the new stable target and exact hint projection.
- Any explanatory references in `packages/main/src/core/background-validator.ts`, `advisory.ts`, `finding-verify.ts`, `review-pass-provenance.ts`, `guard-utils.ts`, and `config.ts` must either link to their actual normative owner or be classified as non-behavioral comments; they must not perpetuate a false root authority.

### Active normative-document authority migration

Active decision documents must stop directing agents back to a giant root contract before templates or root files become thin. This is a semantic authority migration, not a link-only cleanup. The first required inventory includes:

- `docs/requirements/decisions/story-lifecycle.md:78`: replace the INIT_CHECK fallback instruction that says the canonical command template lives in a `CLAUDE.md` section with the owning lifecycle/runbook anchor.
- `docs/requirements/decisions/story-lifecycle.md:114`: remove the dual-authority statement that `CLAUDE.md` keeps a summary of the canonical detailed rule; retain one normative owner and point operational readers to the runbook projection.
- `docs/requirements/decisions/root-markdown-migration-execution-solution.md:32`: replace the rule to update root `AGENTS.md` whenever project workflow rules change with thin-entrypoint ownership language; shared workflow changes belong to normative docs/runbook plus mechanical registries.
- `docs/requirements/decisions/root-markdown-migration-execution-solution.md:75`: stop routing active operational material into `AGENTS.md` / `CLAUDE.md`; route it to `.lattice/Lattice.md`, the runbook, or the owning decision while preserving filename-contract entrypoints.
- `docs/requirements/decisions/root-document-migration-guide.md` and every other active normative document returned by the bounded scan: classify and migrate plain-text root-authority phrases even when no Markdown link exists.

Add a retired-authority vocabulary guard over active decision docs, operational docs, runtime hints, and reviewer prompts. The guard must reject unallowlisted prose that assigns shared lifecycle, command, review, evidence, DONE, or user-value authority to root `CLAUDE.md`/`AGENTS.md`. Allowlisted occurrences are limited to host-discovery explanations, historical lineage explicitly labeled as such, neutral parser fixtures, and this migration plan's quoted defect examples. Link and anchor checks remain necessary but cannot replace this guard because plain-text authority phrases contain no link to validate.

### Process and entrypoint verification

- `scripts/verify-process-fact-contract.mjs`: remove `AGENTS.md` and `CLAUDE.md` from detailed lifecycle/review/evidence vocabulary sets; verify those facts in their normative owners and verify root non-duplication separately.
- `scripts/verify-entrypoints.mjs`: test host discovery, managed preservation, guide/runbook links, budgets, import closure, link/anchor integrity, no long-form body, and profile transitions.
- `scripts/verify-codex-assets.mjs`: validate the effective Codex instruction closure and Codex adapter commands without requiring shared operational prose to remain copied in `AGENTS.md`.
- `scripts/verify-proof-or-stop-prompt-baseline.mjs`: update prompt overlap expectations and forbid retired Claude-first authority phrases.
- `packages/main/src/tasks/cli-surface-smoke.ts`, `field-regression-cli-smoke.ts`, `cli-argument-ergonomics-smoke.ts`, and other fixtures containing `CLAUDE.md` as generic sample data must be classified: update behavior assertions, but retain neutral filename examples when they are only parser fixtures.

### Auxiliary and runtime discovery

- `packages/main/src/handlers/aux-doc.ts`: discover `.lattice/Lattice.md` and the runbook in addition to root entrypoints; expose roles without claiming every discovered document is normative.
- `packages/main/src/core/runtime-environment-checks.ts`: keep root marker discovery host-neutral and include the canonical guide where appropriate.
- `packages/main/src/core/rollout-check.ts`: stop treating `CLAUDE.md` or retired root `LATTICE.md` as the Lattice guide; recognize `.lattice/Lattice.md` explicitly.
- `packages/main/src/core/cluster-compute.ts`: update common-document assumptions used for project clustering.
- `packages/main/src/core/dirty-worktree.ts`: retain root docs in material/dirty classification where required; thinness does not make them non-material.
- `packages/main/src/handlers/session.ts`, `story-create.ts`, `init-check.ts`, `checklist.ts`, `done-effects.ts`, `recover-evidence.ts`, `artifact-declare.ts`, `finding.ts`, `gap-log.ts`, `story-review.ts`, and `validate-lint.ts`: classify references found by the migration scan and route behavior-affecting document lookup through the registry.

This inventory is a migration baseline, not permission to ignore new hits. Each implementation Story must attach the complete bounded-scan manifest, classification totals, and zero-unclassified result to its verification evidence. A selected-file grep or an unexplained excluded hit does not satisfy the verification narrative.

## B-c1f1 Baseline Scan Evidence — 2026-07-15

The B-c1f1 implementer ran the required bounded scan in the Story worktree and froze the inspectable baseline at commit `7d7bebed3815af54e6fb8cd7303faa2bd7cb0147`, which contains this evidence section. The appendix at the end of this plan records every one of that snapshot's 600 matched lines. The reproducible command shape was:

```bash
git grep -nI -E '(CLAUDE\.md|AGENTS\.md|(^|[^./])LATTICE\.md|\.lattice/Lattice\.md|((canonical|complete|shared|workflow|process|rule|instruction|summary|detail|authority|规范|权威|规则|详见).{0,80}(Claude|AGENTS|Lattice))|((Claude|AGENTS|Lattice).{0,80}(canonical|complete|shared|workflow|process|rule|instruction|summary|detail|authority|规范|权威|规则|详见)))' \
  -- AGENTS.md CLAUDE.md .lattice/Lattice.md docs packages/main/src packages/main/templates scripts \
  ':(exclude)docs/story/**' ':(exclude)tests/fixtures/**' \
  ':(exclude)packages/main/tests/fixtures/**' ':(exclude)packages/main/dist/**' \
  ':(exclude)node_modules/**' ':(exclude).worktrees/**' ':(exclude).omx/**'
```

The authority-word alternatives were applied in both directions around the host/document terms. The scan therefore covered filename/path literals plus plain-text authority claims. It enumerated tracked text only; generated dist, dependencies, worktrees, Story stores, fixture stores, and disabled legacy areas were excluded.

Classification was deterministic and line-level. Root entrypoint and host-neutral guide hits were `retain-as-host-discovery`. Live requirements in this migration plan were `retain-as-active-plan`; only the two lines that quote retired-authority defect phrases as scan/guard examples were `neutral-fixture`. Active normative, operational, runtime, audit, review, verifier, and unambiguously behavioral test hits were conservatively `migrate`. A test line was `neutral-fixture` only when its matched text explicitly identified a fixture/example/sample/smoke. This conservative rule prevents an ambiguous executable hit from being silently allowlisted.

| Consumer category | Retain as host discovery | Retain as active plan | Migrate | Neutral fixture | Total hit lines |
|---|---:|---:|---:|---:|---:|
| Host-neutral guide | 1 | 0 | 0 | 0 | 1 |
| Root entrypoint | 14 | 0 | 0 | 0 | 14 |
| Operational/other docs | 0 | 0 | 17 | 0 | 17 |
| Active normative docs | 0 | 0 | 106 | 0 | 106 |
| This migration plan | 0 | 70 | 0 | 2 | 72 |
| Init/managed assets | 0 | 0 | 92 | 0 | 92 |
| Other source/comments | 0 | 0 | 51 | 0 | 51 |
| Audit/docs-drift | 0 | 0 | 55 | 0 | 55 |
| Aux/runtime discovery | 0 | 0 | 11 | 0 | 11 |
| Review/preflight/prompts | 0 | 0 | 32 | 0 | 32 |
| Lifecycle hints | 0 | 0 | 16 | 0 | 16 |
| Verification/test fixtures | 0 | 0 | 130 | 2 | 132 |
| Other tracked text | 0 | 0 | 1 | 0 | 1 |
| **Total** | **15** | **70** | **511** | **4** | **600** |

The scan covered **134 unique files**. Every returned line received both a consumer category and a disposition: **0 unclassified**.

High-risk current hits that establish implementation ownership include:

| Current source | Hit lines | Classification / required owner |
|---|---:|---|
| `docs/requirements/decisions/story-lifecycle.md:78,114` | 2 | Active normative authority; migrate in Story 5 |
| `docs/requirements/decisions/root-markdown-migration-execution-solution.md` including lines 32 and 75 | 14 | Active normative authority; migrate in Story 5 |
| `docs/requirements/decisions/root-document-migration-guide.md` | 7 | Active normative authority/lineage; semantically classify and migrate in Story 5 |
| `packages/main/src/core/audit-trigger.ts` | 8 | Audit/docs-drift; migrate in Story 3 |
| `packages/main/src/handlers/audit.ts` | 5 | Audit/docs-drift; migrate in Story 3 |
| `packages/main/src/handlers/review-preflight.ts` | 5 | Review/preflight; migrate in Story 4 |
| `packages/main/src/tasks/deprecated-gc-smoke.ts:66` | 1 | Audit-trigger fixture; migrate with Story 3 rather than allowlisting it |
| `packages/main/src/handlers/transition-effects.ts` | 3 | Lifecycle/user-value hints; migrate in Story 4 |
| `scripts/verify-process-fact-contract.mjs` | 3 | Process verifier; migrate in Story 6 |
| `scripts/verify-entrypoints.mjs` | 80 | Entrypoint verification/fixtures; classify individual assertions across Stories 1, 6, and 7 |

This is a lexical routing baseline, not proof that all 0-unclassified rows are already correct. The large conservative `migrate` set intentionally requires the owning Stories to perform semantic review and narrow only documented host-discovery, historical, or neutral-fixture exceptions. Successor Stories must rerun the scan and may not reuse these totals after the tree changes.

## Red-Before / Green-After Verification Contract

The first implementation Story adds tests before changing production consumers. The red suite must fail against the current repository for the intended reason, with an artifact recording the failing assertion.

| Area | Red assertion before migration | Green assertion after migration |
|---|---|---|
| Size | Managed `AGENTS.md` exceeds its selected ceiling or a long-form fixture is accepted | Managed bodies meet line and byte ceilings; user-owned text is measured separately |
| Effective host rules | Claude import/delegation and closure are not resolved | Codex and Antigravity resolve `AGENTS.md`; Claude resolves `CLAUDE.md` plus shared `AGENTS.md`, with deduplication |
| Required constraints | Deleting all root prose can still pass a pointer-only check | Effective host closures directly expose session-first, user-priority, no-direct-store-edit, lifecycle, ownership safety, and user-value constraints |
| Links and anchors | A stale local anchor or retired target is accepted | Missing file, missing anchor, retired authority, or import/navigation cycle fails |
| Non-duplication | Root files may contain full lifecycle/Finding/DONE sections | Lifecycle tables, Finding schema bodies, reviewer manuals, CLI encyclopedias, and legacy compatibility chapters fail root checks |
| Audit source | A bad command placed only in the canonical runbook is invisible | `lattice audit --framework` reports the runbook path and bad command |
| Docs drift | Preflight reads only root `CLAUDE.md` | Preflight reads the registry-selected set from the git root and reports missing required sources |
| Process facts | Thin root files fail because detailed terms are absent | Detailed terms are required only in owning decision docs; removing a required fact there fails |
| Retired prose authority | Plain-text “canonical rule is in CLAUDE.md” statements pass because they contain no link | Retired-authority vocabulary guard reports the exact active document and phrase unless it is a bounded host-discovery, historical-lineage, or neutral-fixture allowlist entry |
| Review routing | Documentation-only review falls back to reading all of `CLAUDE.md` | Reviewer receives bounded registry candidates plus touchpoints and never mandates a giant root scan |
| Generation | Global-thin templates mislabel `AGENTS.md` as Codex-only or produce an unsuitable Claude copy | Each profile produces exactly the discovery assets for that host and preserves user-owned regions |
| Projection drift | A runbook command, phase, reviewer lane, or DONE step can contradict registries | Projection verifier rejects unknown commands and mismatched lifecycle/reviewer/DONE facts |

### Required failure exercises

Implement `packages/main/src/tasks/thin-entrypoint-failure-exercises-smoke.ts` as a temporary-directory/in-memory harness. Each row below must be exercised, not merely described:

| Failure | Fixture / setup | Expected failure | Recovery assertion | Owning Story |
|---|---|---|---|---|
| Stale link or anchor | Create a temporary canonical registry containing `.lattice/Lattice.md` with a link to `docs/dev/lattice-agent-runbook.md#missing-anchor`; create the target file without that heading | Link/anchor verifier exits non-zero and reports the source path, target path, and missing anchor; no fallback to the legacy root makes it pass | Add the exact target heading, rerun, and assert the same fixture passes without changing the registry role | Story 1 (validator and exercise), re-run in Story 2 against real guide/runbook |
| Conflicting runbook command | Put ``lattice command_that_does_not_exist`` in a temporary runbook selected by `viewsForMechanicalAudit()` while the command registry omits it | Projection/audit test exits non-zero and attributes the unknown command to the runbook, not `CLAUDE.md` | Replace it with a registered command or deliberately add the command through its own reviewed runtime Story; rerun and assert green | Story 3 |
| Same-path provenance laundering | Parameterize the fixture over temporary `AGENTS.md` and `CLAUDE.md`: each file contains its valid declared thin slots and one unique detailed lifecycle fact in their complement; register disjoint canonical and legacy-fallback views for that same path, then exercise a deliberately overlapping variant | In both host files the unique detailed fact is legacy-only and blocks readiness; the overlap variant fails selector validation before extraction. Neither may gain canonical provenance because the physical path also has a canonical view | Add the unique detailed fact to its real normative owner (not a thin slot), keep the root occurrence as fallback, and assert it merges with both provenance records; remove the overlap and assert the validated selectors remain disjoint | Stories 1 and 3 |
| Selector absence/partial state machine | Execute the three required selector-state fixtures: `required` with all markers absent; recognized legacy `empty-if-all-absent` with all markers absent; and every listed partial/malformed state | Required/absent and all partial/malformed cases fail with no provenance; recognized legacy/all-absent returns empty canonical selection plus full legacy complement | Add every required marker for a thin asset and assert valid disjoint ranges, or restore the exact recognized legacy all-absent asset; no other state passes | Story 1 |
| Fact-snapshot freshness | Create a passing readiness artifact, then independently mutate one document byte, a view-definition flag, a selector field, and only `allowedClaimSlots`, without updating the artifact | Each mutation changes the appropriate blob/content/registry/view/selector digest and makes facts plus dependent review/readiness stale at the same snapshot/HEAD gate | Re-extract and re-review each mutated snapshot; assert only the artifact bound to the new complete snapshot passes | Stories 1, 3, and 6 |
| Evidence persistence and restart | At one clean HEAD, persist extraction → review → readiness through the three registered live templates, assert no tracked status/HEAD/source-input change after each write, terminate all in-memory state, and reload in a fresh process | Reload resolves exact typed paths, reloads the trusted signer registry, verifies strict shapes and Ed25519 signatures plus linkage/upstream digests, checks material HEAD and `materialClean`, then returns the same readiness pass; a copied file outside a registered template or a tracked live file fails | Delete the invalid copy or restore the exact registered untracked path, then regenerate any broken chain and assert restart/reload passes without changing HEAD | Stories 1, 3, and 6 |
| Typed path resolution | Exercise a valid exact path for each artifact ID, invalid siblings under `.lattice/process-evidence/thin-entrypoint/`, a legacy-looking sibling under broad `.lattice/runtime/`, traversal/shape errors, expected-ID mismatch, and an injected duplicate typed matcher | Valid paths resolve exactly once to the expected ID; every invalid/broad-runtime path is rejected as process evidence; duplicate matches fail as ambiguous regardless of registry order | Remove the duplicate/invalid path and assert the exact anchored template resolves; generic cache classification alone never satisfies a gate | Story 1 |
| Keyed authenticity | Sign a valid chain with the current authorized active key, then test forged payload + recomputed unkeyed hashes, unknown key ID, correct key ID under wrong signer/artifact ID, pending key, retired key, revoked key, and restart verification | Only a signature from the current active authorized key passes live readiness. Unkeyed-chain forgery and every unknown/wrong/non-active key fail; restart reload consults the trusted registry again | Restore the current authorized active signer/key and produce a fresh Ed25519-signed chain at the current registry digest/HEAD | Stories 1, 3, and 6 |
| Symlink/TOCTOU-safe artifact I/O | Parameterize reads/writes over symlink component, symlink final target, path traversal/absolute/drive/UNC escape, realpath escape, and injected parent/target swaps before open and rename | Descriptor-bound no-follow component walk rejects every escape/symlink; swap races cannot redirect reads or publication, and no partial artifact remains | Restore ordinary directories under the real project root and assert same-directory exclusive-temp + fsync + atomic rename + reopen/fstat verification succeeds | Stories 1 and 3 |
| Active-key A→B rotation | With A active, produce a passing full chain. Commit B as pending while A remains active, then commit B active/A retired; restart and test the old A chain, fresh B chain, and B signing an unauthorized artifact ID | Registry commits stale prior evidence; after activation A is never live-valid, B passes only for its authorized IDs, and restart cannot revive A using signed `createdAt` | Provision the matching B private key, produce a fresh B-signed extraction/review/readiness chain at the new HEAD, and verify it after restart | Stories 1, 3, and 6 |
| Private-key lifecycle and recovery | Exercise fresh human/bootstrap generation plus public-key commit, OS-provider stub, exact mode-0600 fallback and restart, missing/mode-0644/symlink/mismatched keys, CI secret-file/env injection, key loss, and two-step replacement | Valid providers derive the registered active public key and sign without logging/exporting secrets; invalid providers block signing with reason codes while public-key verification still works; no network KMS is contacted; recovery requires human pending→active registry commits and a fresh chain | Correct permissions/provider mapping or provision a new key, commit public pending then active/old retired, and regenerate readiness at the new HEAD | Stories 1, 3, 6, and 7 |
| Pending-key preflight separation | With A active/B pending, invoke the human-only preflight for exact B and inspect its API/event output; attempt autopilot preflight, request a live writer/active capability from preflight, and attempt B live signing before and after activation/restart | Human preflight may report only a non-gate public-key match; autopilot and capability/writer requests fail structurally; pending B cannot sign live evidence; after activation normal startup—not preflight—loads B and a fresh live chain passes | Complete the reviewed activation commit and restart normal signing, or leave B pending and continue signing only with current active A | Stories 1, 3, and 6 |
| External CI secret-file component safety | From an approved secret-mount root, test a valid file; symlink/reparse parent and final file; deterministic ordinary-parent rename/replacement and final-target regular-file replacement at the first-walk/read/second-walk race boundaries; root escape; wrong owner/mode; and a platform stub without stable no-follow file identities | Return stable original-inode bytes only when a second independent root-anchored no-follow walk matches every recorded parent identity and the final identity; links, missing/replaced components, chain mismatches, escapes, and weak permissions zero/discard any buffered bytes and fail before return. Attacker replacement bytes are never returned; unsupported platforms require the env/keychain provider | Restore the unchanged ordinary owned parent chain, final inode, and permissions, or switch to the in-memory environment/OS credential provider | Stories 1 and 3 |
| Material freshness boundaries | Starting from a passing live chain: (a) commit an unrelated tracked file with selected inputs unchanged, (b) create unrelated tracked dirty content at the same HEAD, and (c) write a valid registered runtime artifact | (a) is stale because HEAD changed; (b) fails `materialClean`; (c) preserves HEAD/material cleanliness/source digests and does not stale. Broad `.lattice/story/` exclusions are rejected | Produce a new extraction/review chain after the new commit; clean or commit ordinary tracked dirt; retain only the registry-validated runtime artifact for the unchanged-HEAD case | Stories 1, 3, and 6 |
| Failed red test | Run the new root non-duplication and canonical-audit tests against a frozen legacy-root fixture before production changes; store the assertion ID and non-zero result in red evidence | Harness fails specifically because the fixture contains the lifecycle body and the bad runbook command is invisible; a passing or unrelated failure invalidates the red evidence | Implement the registry/validator path without weakening the assertion, then replay the identical fixture pair and show the expected legacy fixture remains rejected while the canonical fixture passes | Story 1 |
| Partial template migration | In a temporary initialized project, preserve user text around managed markers, inject a write failure after one host asset is staged but before the asset set is committed, and also test a mixed old-`AGENTS.md`/new-`CLAUDE.md` pair | Managed update fails atomically; no half-thin discovery set is accepted; user-owned text and the previously valid asset set are byte-identical | Remove the injected failure, rerun the full asset transaction, resolve the Claude import closure, and execute canonical audit plus review-preflight smoke on the fresh init | Story 7 |
| B-e514 remains in TEST | Use an injected lifecycle/store double representing B-e514 in TEST with the old process-fact verifier failure and no current canonical-only full-suite evidence; do not read or mutate the real Story store | Convergence helper refuses a DONE/superseded claim and reports prerequisite contract Stories / stale evidence as blockers; it must not create a second root-doc owner | Feed the double completed prerequisite receipts, merged-main state, refreshed review/delivery evidence, and green full-suite evidence; assert convergence becomes eligible while B-e514 remains the sole owner | Story 8 |

The failure-exercise smoke must be registered in the applicable focused test commands and in `npm test`. Its temporary repositories must not depend on or mutate the developer's actual root entrypoints, Story data, or fixture data.

Minimum green commands after every applicable slice are:

```bash
npm --prefix packages/main run build
node scripts/verify-entrypoints.mjs
node scripts/verify-process-fact-contract.mjs
node packages/main/dist/tasks/retired-authority-vocabulary-guard-smoke.js
npm test
```

Focused audit, docs-drift, init-asset, managed-asset, wrapper-root, prompt-baseline, Codex-adapter, link/anchor, and projection tests must run in the Stories that own those surfaces. Passing a focused subset must not be described as full-suite success.

## Implementation Sequence

Each stage is a separate Story with a focused commit set, fresh review, and a clean rollback. Later Stories depend on earlier green contracts; no stage declares the old contract retired before cutover.

### Story 1 — Contract tests and canonical registry

1. Add the typed canonical-document-view registry, pure source-view/content selectors, fail-closed disjoint-range validation, the three exact untracked process-evidence artifact registrations in the dedicated namespace, typed ambiguity-rejecting resolution, descriptor-bound symlink-safe artifact I/O, the narrow current-active signer registry, structurally separate human pending-key preflight, and explicit private-key providers/bootstrap. Reading one physical file once is an I/O optimization only; selector application and provenance remain per view.
2. Add red fixtures for budgets, imports, links/anchors, canonical audit reachability, root non-duplication, process-fact ownership, every required absence/partial selector state, AGENTS/CLAUDE same-path canonical/legacy provenance laundering, document/registry/view/selector snapshot staleness, exact/invalid/ambiguous evidence paths, symlink/root-escape/swap-race artifact and external-secret I/O (including deterministic ordinary-parent rename/replacement and final regular-file replacement between the first walk, descriptor-bound read, and independent second walk), forged/untrusted/wrong/non-active signer cases, pending-preflight capability isolation, A→B rotation, private-key provider/permission/mismatch/loss recovery, and the material/runtime cleanliness boundary.
3. Record red evidence against current behavior, then implement only enough registry/validator infrastructure for the new tests to exercise real selectors.
4. Keep existing runtime consumers unchanged.

Rollback: revert the registry and its isolated tests; no generated assets or runtime lookup has changed.

### Story 2 — Canonical guide and operational projection

1. Repair `.lattice/Lattice.md` branding, self-paths, command examples, and authority wording.
2. Add `docs/dev/lattice-agent-runbook.md` with bounded operational sections and links to the owning decisions.
3. Add link/anchor and registry-projection verification.
4. Do not edit the root `AGENTS.md` or `CLAUDE.md`; B-e514 remains their sole owner.

Rollback: revert the guide/runbook and registry entries; root discovery remains on the legacy contract.

### Story 3 — Audit, docs-drift, and discovery dual-read

1. Move audit, audit trigger, docs-drift, auxiliary discovery, and runtime/rollout discovery to registry source-view selectors.
2. During dual-read, extract canonical views first and legacy-fallback views second. For root `AGENTS.md` and `CLAUDE.md`, apply each file's declared thin-slot selector and disjoint legacy complement even though each pair of views shares one physical path; normalize facts, deduplicate by the source-independent semantic `fingerprint`, and merge all view IDs, source-view roles, source revisions, blob/content/registry/view/selector digests, paths, ranges, anchors, and hosts into provenance without upgrading legacy provenance.
3. Persist the extraction snapshot only through `thin_entrypoint_fact_extraction` using descriptor-bound no-follow safe I/O; fail closed on semantic conflicts or fingerprint collisions, and emit a structured advisory for each legacy-only fingerprint so cutover readiness is observable. Persistence must preserve HEAD/material cleanliness and survive process restart with typed-path plus current-active trusted Ed25519 verification; linkage hashes never substitute for authenticity.
4. Update `packages/main/src/tasks/deprecated-gc-smoke.ts:66` with the registry-backed audit-trigger fixture and preserve the deprecated-GC advisory assertion.
5. Preserve git-root/wrapper-root semantics and existing audit locking.

Rollback: restore the previous consumers; no canonical files or generated assets need deletion.

### Story 4 — Review preflight, prompts, and lifecycle hints

1. Route preflight and reviewer prompts through bounded canonical candidates plus Story touchpoints.
2. Replace all user-value links and Claude-first promise language with owning runbook/decision anchors.
3. Prove documentation-only review does not fall back to a full root scan.
4. Keep legacy fallback diagnostics active.

Rollback: revert prompt/hint routing; dual-read audit remains safe and the old root contract is still present.

### Story 5 — Active normative-authority migration and vocabulary guard

1. Run the repository-wide bounded scan and commit the complete classification manifest with zero unclassified hits.
2. Migrate the identified authority statements in `story-lifecycle.md`, `root-markdown-migration-execution-solution.md`, `root-document-migration-guide.md`, and every other active normative hit to the correct guide, runbook, decision, or mechanical owner.
3. Add the retired-authority vocabulary guard for active decisions, operational docs, runtime hints, and reviewer prompts, with narrow documented allowlists for host discovery, explicitly labeled history, neutral fixtures, and quoted migration defects.
4. Prove that a plain-text legacy authority phrase fails even when every Markdown link and anchor is valid.

Dependency: Stories 2–4 must already provide valid destination anchors and bounded consumers. Generated templates and root entrypoints remain unchanged.

Rollback: revert the normative wording and guard together; dual-read consumers and the still-full legacy root contract remain available while the defect is corrected.

### Story 6 — Verifier ownership readiness gate

1. Change process-fact verification so detailed lifecycle, review, evidence, and DONE facts are checked only in their canonical normative owners.
2. Implement root-budget, effective-import-closure, required-constraint, non-duplication, and link/anchor enforcement. Exercise hard failure against thin contract fixtures, while keeping one explicit repository-root migration exemption bound only to B-e514 until Story 8; the exemption must not apply to generated templates or other projects.
3. Make all behavior-affecting canonical view sets derive from the shared registry or its generated projection, and bind extraction plus `thin_entrypoint_review_evidence` / `thin_entrypoint_readiness` to one material-clean HEAD and complete source/registry/view/selector digest snapshot.
4. Require the bounded-scan classification manifest and retired-authority guard to be green.
5. Run the full red-to-green matrix and complete suite while the repository root and generated templates still use the legacy-compatible bodies. Include clean-HEAD persist → review → readiness → process-restart/reload; symlink/TOCTOU artifact attacks; external-secret parent-swap and final regular-file replacement races; pending-preflight/no-live-capability isolation; current-active-only A→B rotation with wrong-artifact authorization; private-key startup/CI/loss recovery; and the unrelated-commit/tracked-dirty/runtime-write freshness matrix. The external-secret readiness/replay assertion must prove that, after the descriptor-bound read and before returning bytes, a second independent root-anchored no-follow walk matches the complete ordered parent chain plus final-file identity; any mismatch must discard the buffered bytes and fail before return, never return replacement bytes. The output must identify the narrow B-e514 root-budget exemption rather than presenting the real root as already thin.

Readiness condition: canonical audit, docs-drift, review/preflight routing, normative authority, and verifiers pass with an empty semantic legacy-only fingerprint set and an empty conflict/collision/unparsed/selector-overlap set for at least one complete full-suite run bound to one material-clean HEAD and one complete extraction/review/readiness chain re-loadable from the registered process-evidence paths. Canonical provenance from both root entrypoints is accepted only from their allowed thin slots; under the recognized pre-cutover all-absent policy both canonical root selections are empty and their full contents are legacy complements. Therefore an empty legacy-only set must come from real canonical counterparts, never from relabeling either still-full root path. Any new commit, tracked dirty path, source-content change, trusted signer-registry change, or registry/view/selector digest change stales or blocks the chain; a valid registered process-evidence artifact write does neither. This authorizes template work; it does not retire the old contract.

Rollback: revert this verifier Story to restore dual acceptance; do not copy old prose back into templates.

### Story 7 — Init, managed assets, and host import closure

This is the first Story allowed to generate thin entrypoints. It starts only after Stories 1–6 are green, so a fresh init cannot receive thin documents while audit, review/preflight, normative docs, or verifiers still require the old body.

1. Update generic and global-thin templates for the host matrix. Emit the exact declared `AGENTS.md` discovery/safety/navigation slots and `CLAUDE.md` discovery/import/adapter slots with `absencePolicy: 'required'` and only their allowed claim slots; do not mark the outer managed body or legacy-compatible prose wholesale as canonical.
2. Implement Claude shared-rule import/delegation and effective-closure validation.
3. Generalize or retire `claude-md-sync.ts` whole-document assumptions while preserving supported profile behavior.
4. Make multi-asset managed updates atomic and prove repository-local text survives rollback and successful repair.
5. Remove any template-side migration exemption, run the partial-template failure exercise, then initialize fresh Codex, Claude, Antigravity, and combined-profile temporary projects. Exercise the explicit human/bootstrap key setup with an injected non-secret test provider, commit the public registry state before the evidence baseline, and run hard budget/import checks, canonical audit, plus review-preflight smoke against each applicable discovery closure.

Compatibility: existing repositories keep their current valid root assets until explicitly updated; newly initialized repositories are thin only because all canonical consumers and normative sources are already ready. Legacy fallback remains enabled for existing repositories but must contribute no legacy-only semantic fingerprint or conflict to a fresh thin init.

Rollback: revert template/sync changes or the atomic managed-asset transaction; previously generated and legacy managed blocks remain recognized by compatibility detection, and consumer dual-read remains active.

### Story 8 — B-e514 root-entrypoint convergence

B-e514 remains the single owner of product edits to root `AGENTS.md` and `CLAUDE.md`. No implementation Story above may edit those two repository-root files, although template fixtures may generate them in temporary directories.

After Stories 1–7 merge to main, the B-e514 owner must:

1. Merge current main into the B-e514 worktree using the lifecycle-supported convergence path.
2. Update its thin files to the final contract: declared AGENTS thin slots containing shared discovery/minimum safety/navigation plus the preserved local user region; declared Claude thin slots containing import/delegation and Claude-only adapter material. Remove both old detailed complements rather than widening canonical selectors around them.
3. Preserve the repository-local OMX prohibition outside the managed block.
4. Remove the B-e514-specific repository-root budget exemption and prove the actual root files pass the same hard checks as fresh init.
5. Re-run entrypoint, process-fact, audit reachability, managed preservation, build, routine validation, DONE-required validation when configured, and the full suite.
6. Refresh all stale review, delivery, and verification evidence indicated by Lattice before DONE.

B-e514 is not silently superseded and its scope is not expanded to code/templates/tests. If it becomes unrecoverable, a human must explicitly discard it and create one replacement root-entrypoint Story; the replacement then becomes the sole owner, and B-e514's commits must not also be merged. Concurrent root-document owners are prohibited.

Rollback before B-e514 DONE: revert only its root-doc commit in its worktree. Rollback after DONE: use a new Story that restores the last known good thin entrypoints; never resurrect the giant contract as an emergency unreviewed edit.

### Story 9 — Legacy fallback retirement

1. Remove dual-read fallback and its compatibility diagnostics only after B-e514 is DONE and a fresh full-suite run proves canonical-only operation.
2. Remove obsolete Claude-only helpers, path arrays, comments, and test fixtures that no longer represent supported behavior.
3. Keep filename compatibility assets and managed-block migration recognition for the documented support window.
4. Record the retirement point and replacement sources in the process-fact and root-document migration documentation.

Rollback: restore only the registry's legacy fallback and diagnostic path. Do not restore duplicated root prose.

## Compatibility and Cutover Rules

Dual-read is mandatory between the first consumer migration and final retirement:

1. Canonical registry paths are authoritative candidates.
2. Legacy root `CLAUDE.md` is a compatibility fallback, never the destination for new facts.
3. Results are deduplicated by the normalized semantic fingerprint; every contributing path, anchor, role, host, and raw-text hash remains in provenance. Path/anchor identity must never decide semantic equality.
4. Missing required canonical docs fail closed once their owning Story declares them required; legacy presence cannot mask a missing required source.
5. A legacy-only semantic fingerprint, semantic conflict, or fingerprint collision blocks readiness and retirement and identifies the fact plus all provenance that needs correction.
6. No generated template or repository root entrypoint may become thin until audit/docs-drift/discovery, review/preflight/prompts, lifecycle hints, active normative documents, retired-authority guard, process-fact verification, and entrypoint verification are all canonical-ready and green. Story 6 records that readiness; Story 7 is the first template-thinning owner; Story 8 is the first repository-root-thinning owner.
7. A fresh-init test must run the applicable canonical audit and review-preflight path against the generated host closure. Merely checking that files exist or contain pointers is insufficient.
8. “Old contract retired” may be written only after B-e514 convergence and canonical-only audit, review preflight, retired-authority guard, verifier, build, and full-suite tests pass at the same HEAD.

## Rollback and Failure Recovery

- A failed red test is evidence, not permission to weaken the assertion. Confirm it fails for the intended legacy behavior before implementation.
- A partial template migration rolls back Story 7 while dual-read remains enabled; atomic managed updates and preservation checks prevent a half-thin host closure or loss of local constraints.
- A broken link or conflicting runbook command fails the projection/entrypoint verifier and blocks cutover.
- A canonical audit miss restores or retains legacy fallback until the registry selector and scanner are fixed.
- If B-e514 is still blocked in TEST, do not force DONE and do not move its root edits into another active Story. Complete the prerequisite contract Stories, merge main, refresh evidence, and let its sole owner converge it.
- Rollback commits must preserve audit provenance and must not directly edit Story or fixture stores.
- No rollback may re-label legacy Gemini, `CODEX.md`, or `AGY.md` conventions as supported architecture.

## Final Acceptance

The migration is accepted only when all of the following are true at one reviewed HEAD:

- Codex CLI and Antigravity CLI discover the effective shared constraints through `AGENTS.md`; Claude Code CLI discovers `CLAUDE.md` and resolves the shared `AGENTS.md` rules without a copied common body.
- `.lattice/Lattice.md` is the preserved, unique host-neutral navigation entry and links to the runbook and normative owners.
- Root managed bodies satisfy line, byte, import-closure, required-constraint, link/anchor, and non-duplication checks.
- The repository-wide bounded scan manifest has zero unclassified hits, and no active normative document or prompt assigns shared process authority to root `CLAUDE.md`/`AGENTS.md` outside the narrow retired-authority allowlist.
- Repository-local OMX and user-owned constraints survive init, profile change, repair, and managed update without entering universal templates.
- Freshly initialized Codex, Claude, Antigravity, and combined-profile fixtures pass host discovery, canonical audit, and applicable review-preflight checks with empty legacy-only fingerprint and conflict/collision sets.
- Audit and docs-drift detect an invalid command placed only in the canonical runbook and report the correct source.
- Reviewer routing is bounded by registry roles and Story touchpoints and never mandates reading a giant root contract.
- Detailed process-fact verification succeeds from canonical normative documents and fails if an owned fact is removed there.
- All named focused tests, build, routine Story validation, configured DONE-required validation, and `npm test` pass with fresh evidence.
- B-e514 is either DONE as the sole root-document owner or explicitly discarded and replaced by exactly one human-approved owner; both implementations are never merged.
- Legacy fallback is removed only after canonical-only evidence is green.

This plan does not claim that any implementation Story is complete, that any host has been validated after migration, or that B-e514 is unblocked. Those claims require the execution and evidence described above.

## Appendix A — B-c1f1 Line-Level Classification Manifest

<details>
<summary>600-row TSV manifest for scan snapshot <code>7d7bebed3815af54e6fb8cd7303faa2bd7cb0147</code></summary>

The TSV has exactly 600 data rows and seven non-empty fields per row. Its digest covers the UTF-8 bytes from the header through the final row, with one `\n` after every line: `SHA-256: a6f8c5256a10a8356480898e99c1c12e9d53cedabf5078a7f801f714ff04d4a0`.

```tsv
path:line	matchedPhrase	category	behavioralStatus	disposition	targetAuthority	owningStory
.lattice/Lattice.md:6	Lattice	host-neutral guide	behavioral	retain-as-host-discovery	host-neutral guide	Story 2
AGENTS.md:2	AGENTS.md	root entrypoint	behavioral	retain-as-host-discovery	root-entrypoint convergence	Story 8
AGENTS.md:18	Lattice	root entrypoint	behavioral	retain-as-host-discovery	root-entrypoint convergence	Story 8
AGENTS.md:136	Claude	root entrypoint	behavioral	retain-as-host-discovery	root-entrypoint convergence	Story 8
AGENTS.md:303	AGENTS.md	root entrypoint	behavioral	retain-as-host-discovery	root-entrypoint convergence	Story 8
CLAUDE.md:2	CLAUDE.md	root entrypoint	behavioral	retain-as-host-discovery	root-entrypoint convergence	Story 8
CLAUDE.md:81	CLAUDE.md	root entrypoint	behavioral	retain-as-host-discovery	root-entrypoint convergence	Story 8
CLAUDE.md:87	CLAUDE.md	root entrypoint	behavioral	retain-as-host-discovery	root-entrypoint convergence	Story 8
CLAUDE.md:88	Claude	root entrypoint	behavioral	retain-as-host-discovery	root-entrypoint convergence	Story 8
CLAUDE.md:348	CLAUDE.md	root entrypoint	behavioral	retain-as-host-discovery	root-entrypoint convergence	Story 8
CLAUDE.md:373	CLAUDE.md	root entrypoint	behavioral	retain-as-host-discovery	root-entrypoint convergence	Story 8
CLAUDE.md:433	CLAUDE.md	root entrypoint	behavioral	retain-as-host-discovery	root-entrypoint convergence	Story 8
CLAUDE.md:550	CLAUDE.md	root entrypoint	behavioral	retain-as-host-discovery	root-entrypoint convergence	Story 8
CLAUDE.md:672	CLAUDE.md	root entrypoint	behavioral	retain-as-host-discovery	root-entrypoint convergence	Story 8
CLAUDE.md:774	Lattice	root entrypoint	behavioral	retain-as-host-discovery	root-entrypoint convergence	Story 8
docs/CLI.md:39	CLAUDE.md	operational/other docs	behavioral	migrate	operational-authority cleanup	Story 5
docs/CLI.md:169	Claude	operational/other docs	behavioral	migrate	operational-authority cleanup	Story 5
docs/CLI.md:188	Claude	operational/other docs	behavioral	migrate	operational-authority cleanup	Story 5
docs/CLI.md:216	Claude	operational/other docs	behavioral	migrate	operational-authority cleanup	Story 5
docs/CLI.md:232	Claude	operational/other docs	behavioral	migrate	operational-authority cleanup	Story 5
docs/CLI.md:671	AGENTS.md	operational/other docs	behavioral	migrate	operational-authority cleanup	Story 5
docs/CLI.md:724	AGENTS.md	operational/other docs	behavioral	migrate	operational-authority cleanup	Story 5
docs/CLI.md:734	AGENTS.md	operational/other docs	behavioral	migrate	operational-authority cleanup	Story 5
docs/CLI.md:771	AGENTS.md	operational/other docs	behavioral	migrate	operational-authority cleanup	Story 5
docs/CLI.md:879	AGENTS.md	operational/other docs	behavioral	migrate	operational-authority cleanup	Story 5
docs/guide-scope-guard.md:209	CLAUDE.md	operational/other docs	behavioral	migrate	operational-authority cleanup	Story 5
docs/guide.md:142	Claude	operational/other docs	behavioral	migrate	operational-authority cleanup	Story 5
docs/metadata/task.json:14	CLAUDE.md	operational/other docs	behavioral	migrate	operational-authority cleanup	Story 5
docs/metadata/task.json:2056	CLAUDE.md	operational/other docs	behavioral	migrate	operational-authority cleanup	Story 5
docs/metadata/task.json:2058	CLAUDE.md	operational/other docs	behavioral	migrate	operational-authority cleanup	Story 5
docs/requirements/baselines/proof-or-stop-prompt-baseline.json:1675	CLAUDE.md	operational/other docs	behavioral	migrate	operational-authority cleanup	Story 5
docs/requirements/baselines/proof-or-stop-prompt-baseline.json:1963	CLAUDE.md	operational/other docs	behavioral	migrate	operational-authority cleanup	Story 5
docs/requirements/decisions/authority-client-role.md:110	Claude	active normative docs	behavioral	migrate	normative-authority migration	Story 5
docs/requirements/decisions/authority-client-role.md:204	Claude	active normative docs	behavioral	migrate	normative-authority migration	Story 5
docs/requirements/decisions/authority-client-role.md:212	Claude	active normative docs	behavioral	migrate	normative-authority migration	Story 5
docs/requirements/decisions/autopilot-v2-reliability-execution-plan.md:23	Claude	active normative docs	behavioral	migrate	normative-authority migration	Story 5
docs/requirements/decisions/cc-learnings.md:179	CLAUDE.md	active normative docs	behavioral	migrate	normative-authority migration	Story 5
docs/requirements/decisions/cc-learnings.md:199	CLAUDE.md	active normative docs	behavioral	migrate	normative-authority migration	Story 5
docs/requirements/decisions/cc-learnings.md:211	CLAUDE.md	active normative docs	behavioral	migrate	normative-authority migration	Story 5
docs/requirements/decisions/cc-learnings.md:242	CLAUDE.md	active normative docs	behavioral	migrate	normative-authority migration	Story 5
docs/requirements/decisions/cc-learnings.md:243	CLAUDE.md	active normative docs	behavioral	migrate	normative-authority migration	Story 5
docs/requirements/decisions/cc-learnings.md:264	CLAUDE.md	active normative docs	behavioral	migrate	normative-authority migration	Story 5
docs/requirements/decisions/cc-learnings.md:739	CLAUDE.md	active normative docs	behavioral	migrate	normative-authority migration	Story 5
docs/requirements/decisions/cc-learnings.md:795	CLAUDE.md	active normative docs	behavioral	migrate	normative-authority migration	Story 5
docs/requirements/decisions/cc-learnings.md:811	Claude	active normative docs	behavioral	migrate	normative-authority migration	Story 5
docs/requirements/decisions/cc-learnings.md:821	CLAUDE.md	active normative docs	behavioral	migrate	normative-authority migration	Story 5
docs/requirements/decisions/cc-learnings.md:833	CLAUDE.md	active normative docs	behavioral	migrate	normative-authority migration	Story 5
docs/requirements/decisions/cell06-docker-server-execution-checklist.md:497	Lattice	active normative docs	behavioral	migrate	normative-authority migration	Story 5
docs/requirements/decisions/cli-engine-english-open-source-execution-plan.md:894	CLAUDE.md	active normative docs	behavioral	migrate	normative-authority migration	Story 5
docs/requirements/decisions/cli-engine-english-open-source-execution-plan.md:895	CLAUDE.md	active normative docs	behavioral	migrate	normative-authority migration	Story 5
docs/requirements/decisions/cli-engine-english-open-source-execution-plan.md:896	CLAUDE.md	active normative docs	behavioral	migrate	normative-authority migration	Story 5
docs/requirements/decisions/cli-engine-english-open-source-execution-plan.md:901	CLAUDE.md	active normative docs	behavioral	migrate	normative-authority migration	Story 5
docs/requirements/decisions/cli-engine-english-open-source-execution-plan.md:971	CLAUDE.md	active normative docs	behavioral	migrate	normative-authority migration	Story 5
docs/requirements/decisions/cli-engine-english-open-source-execution-plan.md:1148	CLAUDE.md	active normative docs	behavioral	migrate	normative-authority migration	Story 5
docs/requirements/decisions/done-full-test-gate-execution-plan.md:164	AGENTS	active normative docs	behavioral	migrate	normative-authority migration	Story 5
docs/requirements/decisions/experience-layer-ablation-causal-validation-execution-plan.md:293	CLAUDE.md	active normative docs	behavioral	migrate	normative-authority migration	Story 5
docs/requirements/decisions/f009-layer2-engineering-proof-gap-execution-plan.md:418	Claude	active normative docs	behavioral	migrate	normative-authority migration	Story 5
docs/requirements/decisions/host-neutral-observability-console.md:4	Claude	active normative docs	behavioral	migrate	normative-authority migration	Story 5
docs/requirements/decisions/host-neutral-observability-console.md:16	Claude	active normative docs	behavioral	migrate	normative-authority migration	Story 5
docs/requirements/decisions/host-overflow.md:26	Claude	active normative docs	behavioral	migrate	normative-authority migration	Story 5
docs/requirements/decisions/host-overflow.md:27	Claude	active normative docs	behavioral	migrate	normative-authority migration	Story 5
docs/requirements/decisions/host-overflow.md:47	Claude	active normative docs	behavioral	migrate	normative-authority migration	Story 5
docs/requirements/decisions/host-overflow.md:118	Claude	active normative docs	behavioral	migrate	normative-authority migration	Story 5
docs/requirements/decisions/host-overflow.md:189	Claude	active normative docs	behavioral	migrate	normative-authority migration	Story 5
docs/requirements/decisions/host-overflow.md:227	Claude	active normative docs	behavioral	migrate	normative-authority migration	Story 5
docs/requirements/decisions/lattice-authority-live-integration.md:539	Claude	active normative docs	behavioral	migrate	normative-authority migration	Story 5
docs/requirements/decisions/lattice-authority-live-integration.md:1258	Claude	active normative docs	behavioral	migrate	normative-authority migration	Story 5
docs/requirements/decisions/lattice-codex-command-boundary-execution-plan.md:179	AGENTS.md	active normative docs	behavioral	migrate	normative-authority migration	Story 5
docs/requirements/decisions/lattice-codex-command-boundary-execution-plan.md:180	CLAUDE.md	active normative docs	behavioral	migrate	normative-authority migration	Story 5
docs/requirements/decisions/lattice-codex-command-boundary-execution-plan.md:282	AGENTS.md	active normative docs	behavioral	migrate	normative-authority migration	Story 5
docs/requirements/decisions/lattice-codex-command-boundary-execution-plan.md:287	AGENTS.md	active normative docs	behavioral	migrate	normative-authority migration	Story 5
docs/requirements/decisions/lattice-console-demo-mvp-requirements.md:52	Claude	active normative docs	behavioral	migrate	normative-authority migration	Story 5
docs/requirements/decisions/lattice-llm-usage-ledger-execution-plan.md:59	Claude	active normative docs	behavioral	migrate	normative-authority migration	Story 5
docs/requirements/decisions/lattice-runtime-owned-agent-assets-execution-plan.md:112	AGENTS.md	active normative docs	behavioral	migrate	normative-authority migration	Story 5
docs/requirements/decisions/lattice-runtime-owned-agent-assets-execution-plan.md:333	AGENTS.md	active normative docs	behavioral	migrate	normative-authority migration	Story 5
docs/requirements/decisions/lattice-runtime-owned-agent-assets-execution-plan.md:334	CLAUDE.md	active normative docs	behavioral	migrate	normative-authority migration	Story 5
docs/requirements/decisions/lattice-runtime-owned-agent-assets-execution-plan.md:503	AGENTS.md	active normative docs	behavioral	migrate	normative-authority migration	Story 5
docs/requirements/decisions/lattice-strengthening-roadmap-execution-plan.md:118	AGENTS.md	active normative docs	behavioral	migrate	normative-authority migration	Story 5
docs/requirements/decisions/legacy-to-lattice-role-naming-execution-plan.md:35	CLAUDE.md	active normative docs	behavioral	migrate	normative-authority migration	Story 5
docs/requirements/decisions/legacy-to-lattice-role-naming-execution-plan.md:106	Lattice	active normative docs	behavioral	migrate	normative-authority migration	Story 5
docs/requirements/decisions/legacy-to-lattice-role-naming-execution-plan.md:167	CLAUDE.md	active normative docs	behavioral	migrate	normative-authority migration	Story 5
docs/requirements/decisions/legacy-to-lattice-role-naming-execution-plan.md:183	CLAUDE.md	active normative docs	behavioral	migrate	normative-authority migration	Story 5
docs/requirements/decisions/lifecycle-artifact-scope.md:170	.lattice/Lattice.md	active normative docs	behavioral	migrate	normative-authority migration	Story 5
docs/requirements/decisions/lifecycle-artifact-scope.md:187	LATTICE.md	active normative docs	behavioral	migrate	normative-authority migration	Story 5
docs/requirements/decisions/lifecycle-artifact-scope.md:252	.lattice/Lattice.md	active normative docs	behavioral	migrate	normative-authority migration	Story 5
docs/requirements/decisions/lifecycle-artifact-scope.md:253	CLAUDE.md	active normative docs	behavioral	migrate	normative-authority migration	Story 5
docs/requirements/decisions/milestone-ledger-status-review-and-hardening-plan.md:252	Claude	active normative docs	behavioral	migrate	normative-authority migration	Story 5
docs/requirements/decisions/orchestrate-retirement.md:33	Claude	active normative docs	behavioral	migrate	normative-authority migration	Story 5
docs/requirements/decisions/owner-session-contract-execution-plan.md:266	Claude	active normative docs	behavioral	migrate	normative-authority migration	Story 5
docs/requirements/decisions/pos-agent-drivability-optimization.md:96	CLAUDE.md	active normative docs	behavioral	migrate	normative-authority migration	Story 5
docs/requirements/decisions/pos-agent-drivability-optimization.md:99	CLAUDE.md	active normative docs	behavioral	migrate	normative-authority migration	Story 5
docs/requirements/decisions/pos-agent-drivability-optimization.md:151	CLAUDE.md	active normative docs	behavioral	migrate	normative-authority migration	Story 5
docs/requirements/decisions/proof-or-stop-agent-prompt-consolidation-execution-plan.md:99	Claude	active normative docs	behavioral	migrate	normative-authority migration	Story 5
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:6	Claude	migration plan	behavioral	retain-as-active-plan	active migration-plan authority	B-c1f1
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:13	AGENTS.md	migration plan	behavioral	retain-as-active-plan	active migration-plan authority	B-c1f1
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:23	AGENTS.md	migration plan	behavioral	retain-as-active-plan	active migration-plan authority	B-c1f1
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:24	Claude	migration plan	behavioral	retain-as-active-plan	active migration-plan authority	B-c1f1
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:25	AGENTS.md	migration plan	behavioral	retain-as-active-plan	active migration-plan authority	B-c1f1
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:27	AGENTS.md	migration plan	behavioral	retain-as-active-plan	active migration-plan authority	B-c1f1
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:32	AGENTS.md	migration plan	behavioral	retain-as-active-plan	active migration-plan authority	B-c1f1
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:34	.lattice/Lattice.md	migration plan	behavioral	retain-as-active-plan	active migration-plan authority	B-c1f1
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:36	CLAUDE.md	migration plan	behavioral	retain-as-active-plan	active migration-plan authority	B-c1f1
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:37	AGENTS.md	migration plan	behavioral	retain-as-active-plan	active migration-plan authority	B-c1f1
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:39	.lattice/Lattice.md	migration plan	behavioral	retain-as-active-plan	active migration-plan authority	B-c1f1
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:41	.lattice/Lattice.md	migration plan	behavioral	retain-as-active-plan	active migration-plan authority	B-c1f1
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:58	.lattice/Lattice.md	migration plan	behavioral	retain-as-active-plan	active migration-plan authority	B-c1f1
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:66	.lattice/Lattice.md	migration plan	behavioral	retain-as-active-plan	active migration-plan authority	B-c1f1
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:87	AGENTS.md	migration plan	behavioral	retain-as-active-plan	active migration-plan authority	B-c1f1
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:95	.lattice/Lattice.md	migration plan	behavioral	retain-as-active-plan	active migration-plan authority	B-c1f1
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:98	CLAUDE.md	migration plan	behavioral	retain-as-active-plan	active migration-plan authority	B-c1f1
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:100	Claude	migration plan	behavioral	retain-as-active-plan	active migration-plan authority	B-c1f1
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:103	AGENTS.md	migration plan	behavioral	retain-as-active-plan	active migration-plan authority	B-c1f1
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:111	AGENTS.md	migration plan	behavioral	retain-as-active-plan	active migration-plan authority	B-c1f1
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:112	CLAUDE.md	migration plan	behavioral	retain-as-active-plan	active migration-plan authority	B-c1f1
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:116	.lattice/Lattice.md	migration plan	behavioral	retain-as-active-plan	active migration-plan authority	B-c1f1
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:120	AGENTS.md	migration plan	behavioral	retain-as-active-plan	active migration-plan authority	B-c1f1
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:122	Claude	migration plan	behavioral	retain-as-active-plan	active migration-plan authority	B-c1f1
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:149	AGENTS.md	migration plan	behavioral	retain-as-active-plan	active migration-plan authority	B-c1f1
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:157	CLAUDE.md	migration plan	behavioral	retain-as-active-plan	active migration-plan authority	B-c1f1
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:159	CLAUDE.md	migration plan	non-behavioral	neutral-fixture	quoted retired-authority defect example	B-c1f1
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:170	Claude	migration plan	behavioral	retain-as-active-plan	active migration-plan authority	B-c1f1
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:172	AGENTS.md	migration plan	behavioral	retain-as-active-plan	active migration-plan authority	B-c1f1
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:177	CLAUDE.md	migration plan	behavioral	retain-as-active-plan	active migration-plan authority	B-c1f1
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:178	CLAUDE.md	migration plan	behavioral	retain-as-active-plan	active migration-plan authority	B-c1f1
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:179	CLAUDE.md	migration plan	behavioral	retain-as-active-plan	active migration-plan authority	B-c1f1
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:180	CLAUDE.md	migration plan	behavioral	retain-as-active-plan	active migration-plan authority	B-c1f1
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:182	Claude	migration plan	behavioral	retain-as-active-plan	active migration-plan authority	B-c1f1
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:186	CLAUDE.md	migration plan	behavioral	retain-as-active-plan	active migration-plan authority	B-c1f1
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:188	CLAUDE.md	migration plan	behavioral	retain-as-active-plan	active migration-plan authority	B-c1f1
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:189	AGENTS.md	migration plan	behavioral	retain-as-active-plan	active migration-plan authority	B-c1f1
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:190	CLAUDE.md	migration plan	behavioral	retain-as-active-plan	active migration-plan authority	B-c1f1
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:195	CLAUDE.md	migration plan	behavioral	retain-as-active-plan	active migration-plan authority	B-c1f1
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:203	CLAUDE.md	migration plan	behavioral	retain-as-active-plan	active migration-plan authority	B-c1f1
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:204	CLAUDE.md	migration plan	behavioral	retain-as-active-plan	active migration-plan authority	B-c1f1
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:205	AGENTS.md	migration plan	behavioral	retain-as-active-plan	active migration-plan authority	B-c1f1
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:206	AGENTS.md	migration plan	behavioral	retain-as-active-plan	active migration-plan authority	B-c1f1
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:209	CLAUDE.md	migration plan	behavioral	retain-as-active-plan	active migration-plan authority	B-c1f1
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:213	AGENTS.md	migration plan	behavioral	retain-as-active-plan	active migration-plan authority	B-c1f1
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:215	AGENTS.md	migration plan	behavioral	retain-as-active-plan	active migration-plan authority	B-c1f1
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:216	Claude	migration plan	behavioral	retain-as-active-plan	active migration-plan authority	B-c1f1
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:217	CLAUDE.md	migration plan	behavioral	retain-as-active-plan	active migration-plan authority	B-c1f1
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:221	.lattice/Lattice.md	migration plan	behavioral	retain-as-active-plan	active migration-plan authority	B-c1f1
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:223	CLAUDE.md	migration plan	behavioral	retain-as-active-plan	active migration-plan authority	B-c1f1
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:235	AGENTS	migration plan	behavioral	retain-as-active-plan	active migration-plan authority	B-c1f1
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:236	AGENTS.md	migration plan	behavioral	retain-as-active-plan	active migration-plan authority	B-c1f1
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:288	AGENTS.md	migration plan	behavioral	retain-as-active-plan	active migration-plan authority	B-c1f1
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:289	Claude	migration plan	behavioral	retain-as-active-plan	active migration-plan authority	B-c1f1
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:294	CLAUDE.md	migration plan	behavioral	retain-as-active-plan	active migration-plan authority	B-c1f1
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:296	CLAUDE.md	migration plan	non-behavioral	neutral-fixture	quoted retired-authority defect example	B-c1f1
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:297	CLAUDE.md	migration plan	behavioral	retain-as-active-plan	active migration-plan authority	B-c1f1
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:298	AGENTS.md	migration plan	behavioral	retain-as-active-plan	active migration-plan authority	B-c1f1
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:307	.lattice/Lattice.md	migration plan	behavioral	retain-as-active-plan	active migration-plan authority	B-c1f1
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:308	CLAUDE.md	migration plan	behavioral	retain-as-active-plan	active migration-plan authority	B-c1f1
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:310	AGENTS.md	migration plan	behavioral	retain-as-active-plan	active migration-plan authority	B-c1f1
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:342	.lattice/Lattice.md	migration plan	behavioral	retain-as-active-plan	active migration-plan authority	B-c1f1
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:345	AGENTS.md	migration plan	behavioral	retain-as-active-plan	active migration-plan authority	B-c1f1
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:352	CLAUDE.md	migration plan	behavioral	retain-as-active-plan	active migration-plan authority	B-c1f1
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:396	Claude	migration plan	behavioral	retain-as-active-plan	active migration-plan authority	B-c1f1
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:407	AGENTS.md	migration plan	behavioral	retain-as-active-plan	active migration-plan authority	B-c1f1
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:412	AGENTS.md	migration plan	behavioral	retain-as-active-plan	active migration-plan authority	B-c1f1
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:436	CLAUDE.md	migration plan	behavioral	retain-as-active-plan	active migration-plan authority	B-c1f1
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:458	AGENTS.md	migration plan	behavioral	retain-as-active-plan	active migration-plan authority	B-c1f1
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:459	.lattice/Lattice.md	migration plan	behavioral	retain-as-active-plan	active migration-plan authority	B-c1f1
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:461	CLAUDE.md	migration plan	behavioral	retain-as-active-plan	active migration-plan authority	B-c1f1
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:463	Claude	migration plan	behavioral	retain-as-active-plan	active migration-plan authority	B-c1f1
docs/requirements/decisions/review-run-start-signed-workspace-resolution-execution-plan.md:85	Claude	active normative docs	behavioral	migrate	normative-authority migration	Story 5
docs/requirements/decisions/review-run-start-workspace-diagnostics-execution-plan.md:212	Claude	active normative docs	behavioral	migrate	normative-authority migration	Story 5
docs/requirements/decisions/role-separation.md:252	CLAUDE.md	active normative docs	behavioral	migrate	normative-authority migration	Story 5
docs/requirements/decisions/role-separation.md:264	CLAUDE.md	active normative docs	behavioral	migrate	normative-authority migration	Story 5
docs/requirements/decisions/role-separation.md:273	CLAUDE.md	active normative docs	behavioral	migrate	normative-authority migration	Story 5
docs/requirements/decisions/role-separation.md:285	CLAUDE.md	active normative docs	behavioral	migrate	normative-authority migration	Story 5
docs/requirements/decisions/role-separation.md:290	CLAUDE.md	active normative docs	behavioral	migrate	normative-authority migration	Story 5
docs/requirements/decisions/role-separation.md:315	CLAUDE.md	active normative docs	behavioral	migrate	normative-authority migration	Story 5
docs/requirements/decisions/role-separation.md:338	CLAUDE.md	active normative docs	behavioral	migrate	normative-authority migration	Story 5
docs/requirements/decisions/role-separation.md:381	CLAUDE.md	active normative docs	behavioral	migrate	normative-authority migration	Story 5
docs/requirements/decisions/role-separation.md:394	CLAUDE.md	active normative docs	behavioral	migrate	normative-authority migration	Story 5
docs/requirements/decisions/role-separation.md:433	CLAUDE.md	active normative docs	behavioral	migrate	normative-authority migration	Story 5
docs/requirements/decisions/role-separation.md:455	CLAUDE.md	active normative docs	behavioral	migrate	normative-authority migration	Story 5
docs/requirements/decisions/role-separation.md:637	CLAUDE.md	active normative docs	behavioral	migrate	normative-authority migration	Story 5
docs/requirements/decisions/role-separation.md:656	CLAUDE.md	active normative docs	behavioral	migrate	normative-authority migration	Story 5
docs/requirements/decisions/role-separation.md:947	CLAUDE.md	active normative docs	behavioral	migrate	normative-authority migration	Story 5
docs/requirements/decisions/role-separation.md:982	Claude	active normative docs	behavioral	migrate	normative-authority migration	Story 5
docs/requirements/decisions/root-document-migration-guide.md:15	AGENTS.md	active normative docs	behavioral	migrate	normative-authority migration	Story 5
docs/requirements/decisions/root-document-migration-guide.md:19	AGENTS.md	active normative docs	behavioral	migrate	normative-authority migration	Story 5
docs/requirements/decisions/root-document-migration-guide.md:20	CLAUDE.md	active normative docs	behavioral	migrate	normative-authority migration	Story 5
docs/requirements/decisions/root-document-migration-guide.md:23	LATTICE.md	active normative docs	behavioral	migrate	normative-authority migration	Story 5
docs/requirements/decisions/root-document-migration-guide.md:46	AGENTS.md	active normative docs	behavioral	migrate	normative-authority migration	Story 5
docs/requirements/decisions/root-document-migration-guide.md:71	LATTICE.md	active normative docs	behavioral	migrate	normative-authority migration	Story 5
docs/requirements/decisions/root-document-migration-guide.md:112	AGENTS.md	active normative docs	behavioral	migrate	normative-authority migration	Story 5
docs/requirements/decisions/root-markdown-migration-execution-solution.md:16	AGENTS.md	active normative docs	behavioral	migrate	normative-authority migration	Story 5
docs/requirements/decisions/root-markdown-migration-execution-solution.md:17	CLAUDE.md	active normative docs	behavioral	migrate	normative-authority migration	Story 5
docs/requirements/decisions/root-markdown-migration-execution-solution.md:21	LATTICE.md	active normative docs	behavioral	migrate	normative-authority migration	Story 5
docs/requirements/decisions/root-markdown-migration-execution-solution.md:28	AGENTS.md	active normative docs	behavioral	migrate	normative-authority migration	Story 5
docs/requirements/decisions/root-markdown-migration-execution-solution.md:29	CLAUDE.md	active normative docs	behavioral	migrate	normative-authority migration	Story 5
docs/requirements/decisions/root-markdown-migration-execution-solution.md:32	LATTICE.md	active normative docs	behavioral	migrate	normative-authority migration	Story 5
docs/requirements/decisions/root-markdown-migration-execution-solution.md:56	AGENTS.md	active normative docs	behavioral	migrate	normative-authority migration	Story 5
docs/requirements/decisions/root-markdown-migration-execution-solution.md:72	LATTICE.md	active normative docs	behavioral	migrate	normative-authority migration	Story 5
docs/requirements/decisions/root-markdown-migration-execution-solution.md:74	LATTICE.md	active normative docs	behavioral	migrate	normative-authority migration	Story 5
docs/requirements/decisions/root-markdown-migration-execution-solution.md:75	AGENTS.md	active normative docs	behavioral	migrate	normative-authority migration	Story 5
docs/requirements/decisions/root-markdown-migration-execution-solution.md:78	LATTICE.md	active normative docs	behavioral	migrate	normative-authority migration	Story 5
docs/requirements/decisions/root-markdown-migration-execution-solution.md:79	LATTICE.md	active normative docs	behavioral	migrate	normative-authority migration	Story 5
docs/requirements/decisions/root-markdown-migration-execution-solution.md:93	LATTICE.md	active normative docs	behavioral	migrate	normative-authority migration	Story 5
docs/requirements/decisions/root-markdown-migration-execution-solution.md:129	AGENTS.md	active normative docs	behavioral	migrate	normative-authority migration	Story 5
docs/requirements/decisions/session-ownership-and-write-leases.md:260	Claude	active normative docs	behavioral	migrate	normative-authority migration	Story 5
docs/requirements/decisions/stack-layering.md:316	Claude	active normative docs	behavioral	migrate	normative-authority migration	Story 5
docs/requirements/decisions/story-lifecycle.md:78	CLAUDE.md	active normative docs	behavioral	migrate	normative-authority migration	Story 5
docs/requirements/decisions/story-lifecycle.md:114	CLAUDE.md	active normative docs	behavioral	migrate	normative-authority migration	Story 5
docs/requirements/decisions/testing-infra.md:118	AGENTS.md	active normative docs	behavioral	migrate	normative-authority migration	Story 5
docs/requirements/decisions/testing-infra.md:148	Lattice	active normative docs	behavioral	migrate	normative-authority migration	Story 5
docs/requirements/decisions/tier-c-crosshost-quorum-execution-plan.md:161	Lattice	active normative docs	behavioral	migrate	normative-authority migration	Story 5
packages/main/src/claude-md-sync.ts:2	CLAUDE.md	init/managed assets	behavioral	migrate	init-managed assets	Story 7
packages/main/src/claude-md-sync.ts:14	CLAUDE.md	init/managed assets	behavioral	migrate	init-managed assets	Story 7
packages/main/src/claude-md-sync.ts:73	CLAUDE.md	init/managed assets	behavioral	migrate	init-managed assets	Story 7
packages/main/src/cli-engine.ts:730	Lattice	other source/comments	behavioral	migrate	source-authority cleanup	Story 5
packages/main/src/cli-engine.ts:758	Lattice	other source/comments	behavioral	migrate	source-authority cleanup	Story 5
packages/main/src/cli-init.ts:198	AGENTS.md	init/managed assets	behavioral	migrate	init-managed assets	Story 7
packages/main/src/cli-init.ts:199	Claude	init/managed assets	behavioral	migrate	init-managed assets	Story 7
packages/main/src/cli-init.ts:209	AGENTS.md	init/managed assets	behavioral	migrate	init-managed assets	Story 7
packages/main/src/cli-init.ts:215	Claude	init/managed assets	behavioral	migrate	init-managed assets	Story 7
packages/main/src/cli-init.ts:247	.lattice/Lattice.md	init/managed assets	behavioral	migrate	init-managed assets	Story 7
packages/main/src/cli-init.ts:249	AGENTS.md	init/managed assets	behavioral	migrate	init-managed assets	Story 7
packages/main/src/cli-init.ts:255	LATTICE.md	init/managed assets	behavioral	migrate	init-managed assets	Story 7
packages/main/src/cli-init.ts:269	.lattice/Lattice.md	init/managed assets	behavioral	migrate	init-managed assets	Story 7
packages/main/src/cli-init.ts:479	CLAUDE.md	init/managed assets	behavioral	migrate	init-managed assets	Story 7
packages/main/src/cli-init.ts:488	AGENTS.md	init/managed assets	behavioral	migrate	init-managed assets	Story 7
packages/main/src/cli-init.ts:825	.lattice/Lattice.md	init/managed assets	behavioral	migrate	init-managed assets	Story 7
packages/main/src/cli-init.ts:833	LATTICE.md	init/managed assets	behavioral	migrate	init-managed assets	Story 7
packages/main/src/cli-init.ts:835	LATTICE.md	init/managed assets	behavioral	migrate	init-managed assets	Story 7
packages/main/src/cli-init.ts:839	CLAUDE.md	init/managed assets	behavioral	migrate	init-managed assets	Story 7
packages/main/src/cli-init.ts:841	CLAUDE.md	init/managed assets	behavioral	migrate	init-managed assets	Story 7
packages/main/src/cli-init.ts:845	AGENTS.md	init/managed assets	behavioral	migrate	init-managed assets	Story 7
packages/main/src/cli-init.ts:847	AGENTS.md	init/managed assets	behavioral	migrate	init-managed assets	Story 7
packages/main/src/cli-init.ts:849	AGENTS.md	init/managed assets	behavioral	migrate	init-managed assets	Story 7
packages/main/src/cli-init.ts:1077	.lattice/Lattice.md	init/managed assets	behavioral	migrate	init-managed assets	Story 7
packages/main/src/cli-init.ts:1080	LATTICE.md	init/managed assets	behavioral	migrate	init-managed assets	Story 7
packages/main/src/cli-prompts.ts:278	CLAUDE.md	init/managed assets	behavioral	migrate	init-managed assets	Story 7
packages/main/src/cli/command-catalog.ts:1933	CLAUDE.md	init/managed assets	behavioral	migrate	init-managed assets	Story 7
packages/main/src/cli/command-catalog.ts:1934	CLAUDE.md	init/managed assets	behavioral	migrate	init-managed assets	Story 7
packages/main/src/cli/command-catalog.ts:1935	CLAUDE.md	init/managed assets	behavioral	migrate	init-managed assets	Story 7
packages/main/src/cli/command-catalog.ts:1942	CLAUDE.md	init/managed assets	behavioral	migrate	init-managed assets	Story 7
packages/main/src/cli/command-catalog.ts:2283	CLAUDE.md	init/managed assets	behavioral	migrate	init-managed assets	Story 7
packages/main/src/cli/help-renderer.ts:235	Lattice	other source/comments	behavioral	migrate	source-authority cleanup	Story 5
packages/main/src/cli/ownership-gate.ts:174	Lattice	other source/comments	behavioral	migrate	source-authority cleanup	Story 5
packages/main/src/cli/ownership-gate.ts:183	Lattice	other source/comments	behavioral	migrate	source-authority cleanup	Story 5
packages/main/src/core/advisory.ts:21	CLAUDE.md	other source/comments	behavioral	migrate	source-authority cleanup	Story 5
packages/main/src/core/audit-meta-store.ts:87	CLAUDE.md	other source/comments	behavioral	migrate	source-authority cleanup	Story 5
packages/main/src/core/audit-meta-store.ts:243	CLAUDE.md	other source/comments	behavioral	migrate	source-authority cleanup	Story 5
packages/main/src/core/audit-scan.ts:2	CLAUDE.md	audit/docs-drift	behavioral	migrate	audit-docs-drift	Story 3
packages/main/src/core/audit-scan.ts:23	CLAUDE.md	audit/docs-drift	behavioral	migrate	audit-docs-drift	Story 3
packages/main/src/core/audit-scan.ts:72	CLAUDE.md	audit/docs-drift	behavioral	migrate	audit-docs-drift	Story 3
packages/main/src/core/audit-scan.ts:74	CLAUDE.md	audit/docs-drift	behavioral	migrate	audit-docs-drift	Story 3
packages/main/src/core/audit-scan.ts:112	CLAUDE.md	audit/docs-drift	behavioral	migrate	audit-docs-drift	Story 3
packages/main/src/core/audit-scan.ts:129	CLAUDE.md	audit/docs-drift	behavioral	migrate	audit-docs-drift	Story 3
packages/main/src/core/audit-scan.ts:195	CLAUDE.md	audit/docs-drift	behavioral	migrate	audit-docs-drift	Story 3
packages/main/src/core/audit-scan.ts:268	CLAUDE.md	audit/docs-drift	behavioral	migrate	audit-docs-drift	Story 3
packages/main/src/core/audit-scan.ts:336	CLAUDE.md	audit/docs-drift	behavioral	migrate	audit-docs-drift	Story 3
packages/main/src/core/audit-trigger.ts:2	CLAUDE.md	audit/docs-drift	behavioral	migrate	audit-docs-drift	Story 3
packages/main/src/core/audit-trigger.ts:132	CLAUDE.md	audit/docs-drift	behavioral	migrate	audit-docs-drift	Story 3
packages/main/src/core/audit-trigger.ts:140	CLAUDE.md	audit/docs-drift	behavioral	migrate	audit-docs-drift	Story 3
packages/main/src/core/audit-trigger.ts:147	CLAUDE.md	audit/docs-drift	behavioral	migrate	audit-docs-drift	Story 3
packages/main/src/core/audit-trigger.ts:165	CLAUDE.md	audit/docs-drift	behavioral	migrate	audit-docs-drift	Story 3
packages/main/src/core/audit-trigger.ts:178	Claude	audit/docs-drift	behavioral	migrate	audit-docs-drift	Story 3
packages/main/src/core/audit-trigger.ts:235	CLAUDE.md	audit/docs-drift	behavioral	migrate	audit-docs-drift	Story 3
packages/main/src/core/audit-trigger.ts:289	CLAUDE.md	audit/docs-drift	behavioral	migrate	audit-docs-drift	Story 3
packages/main/src/core/background-validator.ts:7	CLAUDE.md	other source/comments	behavioral	migrate	source-authority cleanup	Story 5
packages/main/src/core/cluster-compute.ts:37	CLAUDE.md	aux/runtime discovery	behavioral	migrate	discovery registry	Story 3
packages/main/src/core/codex-adapter-checks.ts:100	AGENTS.md	init/managed assets	behavioral	migrate	init-managed assets	Story 7
packages/main/src/core/command-policy.ts:475	Claude	other source/comments	behavioral	migrate	source-authority cleanup	Story 5
packages/main/src/core/config.ts:13	CLAUDE.md	other source/comments	behavioral	migrate	source-authority cleanup	Story 5
packages/main/src/core/dirty-worktree.ts:278	AGENTS.md	aux/runtime discovery	behavioral	migrate	discovery registry	Story 3
packages/main/src/core/dirty-worktree.ts:279	CLAUDE.md	aux/runtime discovery	behavioral	migrate	discovery registry	Story 3
packages/main/src/core/finding-verify.ts:128	CLAUDE.md	other source/comments	behavioral	migrate	source-authority cleanup	Story 5
packages/main/src/core/guard-utils.ts:3	CLAUDE.md	other source/comments	behavioral	migrate	source-authority cleanup	Story 5
packages/main/src/core/guard-utils.ts:91	CLAUDE.md	other source/comments	behavioral	migrate	source-authority cleanup	Story 5
packages/main/src/core/lattice-brand.ts:14	Lattice	other source/comments	behavioral	migrate	source-authority cleanup	Story 5
packages/main/src/core/lattice-dispatch.ts:886	Claude	other source/comments	behavioral	migrate	source-authority cleanup	Story 5
packages/main/src/core/lattice-dispatch.ts:1828	Claude	other source/comments	behavioral	migrate	source-authority cleanup	Story 5
packages/main/src/core/lattice-dispatch.ts:1829	Claude	other source/comments	behavioral	migrate	source-authority cleanup	Story 5
packages/main/src/core/lattice-dispatch.ts:1831	Claude	other source/comments	behavioral	migrate	source-authority cleanup	Story 5
packages/main/src/core/lattice-dispatch.ts:2511	Claude	other source/comments	behavioral	migrate	source-authority cleanup	Story 5
packages/main/src/core/lattice-dispatch.ts:2661	Claude	other source/comments	behavioral	migrate	source-authority cleanup	Story 5
packages/main/src/core/lattice-dispatch.ts:2703	Claude	other source/comments	behavioral	migrate	source-authority cleanup	Story 5
packages/main/src/core/lattice-dispatch.ts:2727	Claude	other source/comments	behavioral	migrate	source-authority cleanup	Story 5
packages/main/src/core/lattice-evidence.ts:82	Lattice	other source/comments	behavioral	migrate	source-authority cleanup	Story 5
packages/main/src/core/lattice-evidence.ts:100	Lattice	other source/comments	behavioral	migrate	source-authority cleanup	Story 5
packages/main/src/core/lattice-evidence.ts:268	Lattice	other source/comments	behavioral	migrate	source-authority cleanup	Story 5
packages/main/src/core/lattice-hosts.ts:389	Claude	other source/comments	behavioral	migrate	source-authority cleanup	Story 5
packages/main/src/core/managed-assets.ts:500	AGENTS.md	init/managed assets	behavioral	migrate	init-managed assets	Story 7
packages/main/src/core/managed-assets.ts:501	CLAUDE.md	init/managed assets	behavioral	migrate	init-managed assets	Story 7
packages/main/src/core/managed-assets.ts:532	LATTICE.md	init/managed assets	behavioral	migrate	init-managed assets	Story 7
packages/main/src/core/managed-assets.ts:579	Lattice	init/managed assets	behavioral	migrate	init-managed assets	Story 7
packages/main/src/core/managed-assets.ts:585	AGENTS.md	init/managed assets	behavioral	migrate	init-managed assets	Story 7
packages/main/src/core/managed-assets.ts:591	AGENTS.md	init/managed assets	behavioral	migrate	init-managed assets	Story 7
packages/main/src/core/managed-assets.ts:616	CLAUDE.md	init/managed assets	behavioral	migrate	init-managed assets	Story 7
packages/main/src/core/managed-assets.ts:622	CLAUDE.md	init/managed assets	behavioral	migrate	init-managed assets	Story 7
packages/main/src/core/managed-assets.ts:642	.lattice/Lattice.md	init/managed assets	behavioral	migrate	init-managed assets	Story 7
packages/main/src/core/managed-assets.ts:643	.lattice/Lattice.md	init/managed assets	behavioral	migrate	init-managed assets	Story 7
packages/main/src/core/managed-assets.ts:645	.lattice/Lattice.md	init/managed assets	behavioral	migrate	init-managed assets	Story 7
packages/main/src/core/managed-assets.ts:671	AGENTS.md	init/managed assets	behavioral	migrate	init-managed assets	Story 7
packages/main/src/core/managed-assets.ts:672	AGENTS.md	init/managed assets	behavioral	migrate	init-managed assets	Story 7
packages/main/src/core/managed-assets.ts:674	.lattice/Lattice.md	init/managed assets	behavioral	migrate	init-managed assets	Story 7
packages/main/src/core/managed-assets.ts:693	CLAUDE.md	init/managed assets	behavioral	migrate	init-managed assets	Story 7
packages/main/src/core/managed-assets.ts:694	CLAUDE.md	init/managed assets	behavioral	migrate	init-managed assets	Story 7
packages/main/src/core/managed-assets.ts:707	LATTICE.md	init/managed assets	behavioral	migrate	init-managed assets	Story 7
packages/main/src/core/managed-assets.ts:708	LATTICE.md	init/managed assets	behavioral	migrate	init-managed assets	Story 7
packages/main/src/core/managed-assets.ts:731	AGENTS.md	init/managed assets	behavioral	migrate	init-managed assets	Story 7
packages/main/src/core/managed-assets.ts:732	AGENTS.md	init/managed assets	behavioral	migrate	init-managed assets	Story 7
packages/main/src/core/managed-assets.ts:783	CLAUDE.md	init/managed assets	behavioral	migrate	init-managed assets	Story 7
packages/main/src/core/managed-assets.ts:784	CLAUDE.md	init/managed assets	behavioral	migrate	init-managed assets	Story 7
packages/main/src/core/process-fact-levels.ts:209	Claude	other source/comments	behavioral	migrate	source-authority cleanup	Story 5
packages/main/src/core/review-pass-provenance.ts:93	CLAUDE.md	other source/comments	behavioral	migrate	source-authority cleanup	Story 5
packages/main/src/core/rollout-check.ts:230	AGENTS.md	aux/runtime discovery	behavioral	migrate	discovery registry	Story 3
packages/main/src/core/rollout-check.ts:231	CLAUDE.md	aux/runtime discovery	behavioral	migrate	discovery registry	Story 3
packages/main/src/core/rollout-check.ts:232	LATTICE.md	aux/runtime discovery	behavioral	migrate	discovery registry	Story 3
packages/main/src/core/rollout-check.ts:381	AGENTS.md	aux/runtime discovery	behavioral	migrate	discovery registry	Story 3
packages/main/src/core/rollout-check.ts:382	Lattice	aux/runtime discovery	behavioral	migrate	discovery registry	Story 3
packages/main/src/core/rollout-check.ts:386	AGENTS.md	aux/runtime discovery	behavioral	migrate	discovery registry	Story 3
packages/main/src/core/runtime-artifact-registry.ts:198	Lattice	other source/comments	behavioral	migrate	source-authority cleanup	Story 5
packages/main/src/core/runtime-artifact-registry.ts:200	Lattice	other source/comments	behavioral	migrate	source-authority cleanup	Story 5
packages/main/src/core/runtime-environment-checks.ts:593	AGENTS.md	aux/runtime discovery	behavioral	migrate	discovery registry	Story 3
packages/main/src/handlers/agent-prompt.ts:13	CLAUDE.md	review/preflight/prompts	behavioral	migrate	bounded review routing	Story 4
packages/main/src/handlers/artifact-declare.ts:11	CLAUDE.md	other source/comments	behavioral	migrate	source-authority cleanup	Story 5
packages/main/src/handlers/audit.ts:4	CLAUDE.md	audit/docs-drift	behavioral	migrate	audit-docs-drift	Story 3
packages/main/src/handlers/audit.ts:10	CLAUDE.md	audit/docs-drift	behavioral	migrate	audit-docs-drift	Story 3
packages/main/src/handlers/audit.ts:101	CLAUDE.md	audit/docs-drift	behavioral	migrate	audit-docs-drift	Story 3
packages/main/src/handlers/audit.ts:103	CLAUDE.md	audit/docs-drift	behavioral	migrate	audit-docs-drift	Story 3
packages/main/src/handlers/audit.ts:107	CLAUDE.md	audit/docs-drift	behavioral	migrate	audit-docs-drift	Story 3
packages/main/src/handlers/aux-doc.ts:23	CLAUDE.md	aux/runtime discovery	behavioral	migrate	discovery registry	Story 3
packages/main/src/handlers/checklist.ts:564	CLAUDE.md	other source/comments	behavioral	migrate	source-authority cleanup	Story 5
packages/main/src/handlers/doctor.ts:151	Claude	other source/comments	behavioral	migrate	source-authority cleanup	Story 5
packages/main/src/handlers/done-effects.ts:1036	CLAUDE.md	other source/comments	behavioral	migrate	source-authority cleanup	Story 5
packages/main/src/handlers/finding.ts:138	CLAUDE.md	other source/comments	behavioral	migrate	source-authority cleanup	Story 5
packages/main/src/handlers/finding.ts:194	CLAUDE.md	other source/comments	behavioral	migrate	source-authority cleanup	Story 5
packages/main/src/handlers/gap-log.ts:21	CLAUDE.md	other source/comments	behavioral	migrate	source-authority cleanup	Story 5
packages/main/src/handlers/init-check.ts:74	CLAUDE.md	other source/comments	behavioral	migrate	source-authority cleanup	Story 5
packages/main/src/handlers/init-check.ts:76	CLAUDE.md	other source/comments	behavioral	migrate	source-authority cleanup	Story 5
packages/main/src/handlers/init-check.ts:197	CLAUDE.md	other source/comments	behavioral	migrate	source-authority cleanup	Story 5
packages/main/src/handlers/recover-evidence.ts:131	CLAUDE.md	other source/comments	behavioral	migrate	source-authority cleanup	Story 5
packages/main/src/handlers/review-preflight.ts:153	CLAUDE.md	review/preflight/prompts	behavioral	migrate	bounded review routing	Story 4
packages/main/src/handlers/review-preflight.ts:178	CLAUDE.md	review/preflight/prompts	behavioral	migrate	bounded review routing	Story 4
packages/main/src/handlers/review-preflight.ts:226	CLAUDE.md	review/preflight/prompts	behavioral	migrate	bounded review routing	Story 4
packages/main/src/handlers/review-preflight.ts:296	CLAUDE.md	review/preflight/prompts	behavioral	migrate	bounded review routing	Story 4
packages/main/src/handlers/review-preflight.ts:299	CLAUDE.md	review/preflight/prompts	behavioral	migrate	bounded review routing	Story 4
packages/main/src/handlers/session.ts:9	CLAUDE.md	other source/comments	behavioral	migrate	source-authority cleanup	Story 5
packages/main/src/handlers/story-create.ts:386	AGENTS.md	other source/comments	behavioral	migrate	source-authority cleanup	Story 5
packages/main/src/handlers/story-create.ts:993	AGENTS.md	other source/comments	behavioral	migrate	source-authority cleanup	Story 5
packages/main/src/handlers/story-create.ts:1126	CLAUDE.md	other source/comments	behavioral	migrate	source-authority cleanup	Story 5
packages/main/src/handlers/story-dispatch.ts:11	CLAUDE.md	review/preflight/prompts	behavioral	migrate	bounded review routing	Story 4
packages/main/src/handlers/story-dispatch.ts:30	CLAUDE.md	review/preflight/prompts	behavioral	migrate	bounded review routing	Story 4
packages/main/src/handlers/story-dispatch.ts:386	CLAUDE.md	review/preflight/prompts	behavioral	migrate	bounded review routing	Story 4
packages/main/src/handlers/story-review.ts:477	CLAUDE.md	other source/comments	behavioral	migrate	source-authority cleanup	Story 5
packages/main/src/handlers/transition-effects.ts:220	CLAUDE.md	lifecycle hints	behavioral	migrate	lifecycle hint routing	Story 4
packages/main/src/handlers/transition-effects.ts:391	CLAUDE.md	lifecycle hints	behavioral	migrate	lifecycle hint routing	Story 4
packages/main/src/handlers/transition-effects.ts:394	CLAUDE.md	lifecycle hints	behavioral	migrate	lifecycle hint routing	Story 4
packages/main/src/handlers/validate-docs-drift.ts:2	CLAUDE.md	audit/docs-drift	behavioral	migrate	audit-docs-drift	Story 3
packages/main/src/handlers/validate-docs-drift.ts:15	CLAUDE.md	audit/docs-drift	behavioral	migrate	audit-docs-drift	Story 3
packages/main/src/handlers/validate-docs-drift.ts:71	CLAUDE.md	audit/docs-drift	behavioral	migrate	audit-docs-drift	Story 3
packages/main/src/handlers/validate-docs-drift.ts:123	CLAUDE.md	audit/docs-drift	behavioral	migrate	audit-docs-drift	Story 3
packages/main/src/handlers/validate-docs-drift.ts:129	CLAUDE.md	audit/docs-drift	behavioral	migrate	audit-docs-drift	Story 3
packages/main/src/handlers/validate-docs-drift.ts:139	CLAUDE.md	audit/docs-drift	behavioral	migrate	audit-docs-drift	Story 3
packages/main/src/handlers/validate-docs-drift.ts:151	CLAUDE.md	audit/docs-drift	behavioral	migrate	audit-docs-drift	Story 3
packages/main/src/handlers/validate-docs-drift.ts:162	CLAUDE.md	audit/docs-drift	behavioral	migrate	audit-docs-drift	Story 3
packages/main/src/handlers/validate-docs-drift.ts:168	CLAUDE.md	audit/docs-drift	behavioral	migrate	audit-docs-drift	Story 3
packages/main/src/handlers/validate-docs-drift.ts:178	CLAUDE.md	audit/docs-drift	behavioral	migrate	audit-docs-drift	Story 3
packages/main/src/handlers/validate-docs-drift.ts:183	CLAUDE.md	audit/docs-drift	behavioral	migrate	audit-docs-drift	Story 3
packages/main/src/handlers/validate-docs-drift.ts:186	CLAUDE.md	audit/docs-drift	behavioral	migrate	audit-docs-drift	Story 3
packages/main/src/handlers/validate-docs-drift.ts:192	CLAUDE.md	audit/docs-drift	behavioral	migrate	audit-docs-drift	Story 3
packages/main/src/handlers/validate-docs-drift.ts:198	CLAUDE.md	audit/docs-drift	behavioral	migrate	audit-docs-drift	Story 3
packages/main/src/handlers/validate-docs-drift.ts:217	CLAUDE.md	audit/docs-drift	behavioral	migrate	audit-docs-drift	Story 3
packages/main/src/handlers/validate-docs-drift.ts:220	CLAUDE.md	audit/docs-drift	behavioral	migrate	audit-docs-drift	Story 3
packages/main/src/handlers/validate-docs-drift.ts:237	CLAUDE.md	audit/docs-drift	behavioral	migrate	audit-docs-drift	Story 3
packages/main/src/handlers/validate-docs-drift.ts:353	CLAUDE.md	audit/docs-drift	behavioral	migrate	audit-docs-drift	Story 3
packages/main/src/handlers/validate-docs-drift.ts:434	CLAUDE.md	audit/docs-drift	behavioral	migrate	audit-docs-drift	Story 3
packages/main/src/handlers/validate-docs-drift.ts:436	CLAUDE.md	audit/docs-drift	behavioral	migrate	audit-docs-drift	Story 3
packages/main/src/handlers/validate-docs-drift.ts:450	CLAUDE.md	audit/docs-drift	behavioral	migrate	audit-docs-drift	Story 3
packages/main/src/handlers/validate-docs-drift.ts:496	CLAUDE.md	audit/docs-drift	behavioral	migrate	audit-docs-drift	Story 3
packages/main/src/handlers/validate-docs-drift.ts:521	CLAUDE.md	audit/docs-drift	behavioral	migrate	audit-docs-drift	Story 3
packages/main/src/handlers/validate-docs-drift.ts:535	CLAUDE.md	audit/docs-drift	behavioral	migrate	audit-docs-drift	Story 3
packages/main/src/handlers/validate-lint.ts:574	CLAUDE.md	other source/comments	behavioral	migrate	source-authority cleanup	Story 5
packages/main/src/handlers/workflow.ts:49	CLAUDE.md	init/managed assets	behavioral	migrate	init-managed assets	Story 7
packages/main/src/handlers/workflow.ts:50	CLAUDE.md	init/managed assets	behavioral	migrate	init-managed assets	Story 7
packages/main/src/handlers/workflow.ts:57	CLAUDE.md	init/managed assets	behavioral	migrate	init-managed assets	Story 7
packages/main/src/init-assets.ts:20	AGENTS	init/managed assets	behavioral	migrate	init-managed assets	Story 7
packages/main/src/init-assets.ts:25	LATTICE.md	init/managed assets	behavioral	migrate	init-managed assets	Story 7
packages/main/src/init-assets.ts:38	LATTICE.md	init/managed assets	behavioral	migrate	init-managed assets	Story 7
packages/main/src/init-assets.ts:43	LATTICE.md	init/managed assets	behavioral	migrate	init-managed assets	Story 7
packages/main/src/init-assets.ts:50	AGENTS.md	init/managed assets	behavioral	migrate	init-managed assets	Story 7
packages/main/src/init-assets.ts:58	CLAUDE.md	init/managed assets	behavioral	migrate	init-managed assets	Story 7
packages/main/src/init-assets.ts:63	LATTICE.md	init/managed assets	behavioral	migrate	init-managed assets	Story 7
packages/main/src/init-assets.ts:84	.lattice/Lattice.md	init/managed assets	behavioral	migrate	init-managed assets	Story 7
packages/main/src/init-assets.ts:97	AGENTS	init/managed assets	behavioral	migrate	init-managed assets	Story 7
packages/main/src/init-assets.ts:102	.lattice/Lattice.md	init/managed assets	behavioral	migrate	init-managed assets	Story 7
packages/main/src/init-assets.ts:252	AGENTS.md	init/managed assets	behavioral	migrate	init-managed assets	Story 7
packages/main/src/providers/claude-cli.ts:284	Claude	other source/comments	behavioral	migrate	source-authority cleanup	Story 5
packages/main/src/providers/types.ts:91	Claude	other source/comments	behavioral	migrate	source-authority cleanup	Story 5
packages/main/src/tasks/audit-esm-smoke.ts:10	CLAUDE.md	audit/docs-drift	behavioral	migrate	audit-docs-drift	Story 3
packages/main/src/tasks/cli-argument-ergonomics-smoke.ts:20	AGENTS.md	verification/test fixtures	non-behavioral	neutral-fixture	verification-fixture classification	Story 6
packages/main/src/tasks/cli-argument-ergonomics-smoke.ts:23	AGENTS.md	verification/test fixtures	behavioral	migrate	verification-fixture classification	Story 6
packages/main/src/tasks/cli-argument-ergonomics-smoke.ts:27	AGENTS.md	verification/test fixtures	non-behavioral	neutral-fixture	verification-fixture classification	Story 6
packages/main/src/tasks/cli-argument-ergonomics-smoke.ts:30	AGENTS.md	verification/test fixtures	behavioral	migrate	verification-fixture classification	Story 6
packages/main/src/tasks/cli-surface-smoke.ts:59	AGENTS.md	verification/test fixtures	behavioral	migrate	verification-fixture classification	Story 6
packages/main/src/tasks/cli-surface-smoke.ts:60	CLAUDE.md	verification/test fixtures	behavioral	migrate	verification-fixture classification	Story 6
packages/main/src/tasks/cli-surface-smoke.ts:68	AGENTS.md	verification/test fixtures	behavioral	migrate	verification-fixture classification	Story 6
packages/main/src/tasks/deprecated-gc-smoke.ts:66	CLAUDE.md	audit/docs-drift	behavioral	migrate	audit-docs-drift	Story 3
packages/main/src/tasks/docs-drift-path-drift-smoke.ts:4	CLAUDE.md	audit/docs-drift	behavioral	migrate	audit-docs-drift	Story 3
packages/main/src/tasks/docs-drift-path-drift-smoke.ts:8	CLAUDE.md	audit/docs-drift	behavioral	migrate	audit-docs-drift	Story 3
packages/main/src/tasks/docs-drift-path-drift-smoke.ts:226	CLAUDE.md	audit/docs-drift	behavioral	migrate	audit-docs-drift	Story 3
packages/main/src/tasks/docs-drift-path-drift-smoke.ts:320	CLAUDE.md	audit/docs-drift	behavioral	migrate	audit-docs-drift	Story 3
packages/main/src/tasks/docs-drift-wrapper-root-smoke.ts:34	CLAUDE.md	audit/docs-drift	behavioral	migrate	audit-docs-drift	Story 3
packages/main/src/tasks/docs-drift-wrapper-root-smoke.ts:74	CLAUDE.md	audit/docs-drift	behavioral	migrate	audit-docs-drift	Story 3
packages/main/src/tasks/docs-drift-wrapper-root-smoke.ts:215	CLAUDE.md	audit/docs-drift	behavioral	migrate	audit-docs-drift	Story 3
packages/main/src/tasks/field-regression-cli-smoke.ts:1772	CLAUDE.md	verification/test fixtures	behavioral	migrate	verification-fixture classification	Story 6
packages/main/src/tasks/flow-stability-smoke.ts:1048	.lattice/Lattice.md	lifecycle hints	behavioral	migrate	lifecycle hint routing	Story 4
packages/main/src/tasks/flow-stability-smoke.ts:1085	.lattice/Lattice.md	lifecycle hints	behavioral	migrate	lifecycle hint routing	Story 4
packages/main/src/tasks/flow-stability-smoke.ts:1086	AGENTS.md	lifecycle hints	behavioral	migrate	lifecycle hint routing	Story 4
packages/main/src/tasks/flow-stability-smoke.ts:1087	CLAUDE.md	lifecycle hints	behavioral	migrate	lifecycle hint routing	Story 4
packages/main/src/tasks/flow-stability-smoke.ts:1090	LATTICE.md	lifecycle hints	behavioral	migrate	lifecycle hint routing	Story 4
packages/main/src/tasks/flow-stability-smoke.ts:1091	AGENTS.md	lifecycle hints	behavioral	migrate	lifecycle hint routing	Story 4
packages/main/src/tasks/flow-stability-smoke.ts:1092	CLAUDE.md	lifecycle hints	behavioral	migrate	lifecycle hint routing	Story 4
packages/main/src/tasks/flow-stability-smoke.ts:3389	CLAUDE.md	lifecycle hints	behavioral	migrate	lifecycle hint routing	Story 4
packages/main/src/tasks/flow-stability-smoke.ts:3399	CLAUDE.md	lifecycle hints	behavioral	migrate	lifecycle hint routing	Story 4
packages/main/src/tasks/flow-stability-smoke.ts:3496	CLAUDE.md	lifecycle hints	behavioral	migrate	lifecycle hint routing	Story 4
packages/main/src/tasks/flow-stability-smoke.ts:3903	CLAUDE.md	lifecycle hints	behavioral	migrate	lifecycle hint routing	Story 4
packages/main/src/tasks/flow-stability-smoke.ts:3914	CLAUDE.md	lifecycle hints	behavioral	migrate	lifecycle hint routing	Story 4
packages/main/src/tasks/gap-log-smoke.ts:86	CLAUDE.md	verification/test fixtures	behavioral	migrate	verification-fixture classification	Story 6
packages/main/src/tasks/gap-log-smoke.ts:107	CLAUDE.md	verification/test fixtures	behavioral	migrate	verification-fixture classification	Story 6
packages/main/src/tasks/init-check-atomicity-smoke.ts:215	Lattice	verification/test fixtures	behavioral	migrate	verification-fixture classification	Story 6
packages/main/src/tasks/init-check-atomicity-smoke.ts:347	Lattice	verification/test fixtures	behavioral	migrate	verification-fixture classification	Story 6
packages/main/src/tasks/main-write-lock-coverage.ts:9	CLAUDE.md	other source/comments	behavioral	migrate	source-authority cleanup	Story 5
packages/main/src/tasks/managed-assets-wrapper-root-smoke.ts:9	.lattice/Lattice.md	init/managed assets	behavioral	migrate	init-managed assets	Story 7
packages/main/src/tasks/managed-assets-wrapper-root-smoke.ts:116	.lattice/Lattice.md	init/managed assets	behavioral	migrate	init-managed assets	Story 7
packages/main/src/tasks/managed-assets-wrapper-root-smoke.ts:138	.lattice/Lattice.md	init/managed assets	behavioral	migrate	init-managed assets	Story 7
packages/main/src/tasks/managed-assets-wrapper-root-smoke.ts:146	.lattice/Lattice.md	init/managed assets	behavioral	migrate	init-managed assets	Story 7
packages/main/src/tasks/playbook-runtime-memory-index-smoke.ts:124	Claude	verification/test fixtures	behavioral	migrate	verification-fixture classification	Story 6
packages/main/src/tasks/playbook-runtime-memory-index-smoke.ts:578	Claude	verification/test fixtures	behavioral	migrate	verification-fixture classification	Story 6
packages/main/src/tasks/prompt-registry-smoke.ts:89	Lattice	verification/test fixtures	behavioral	migrate	verification-fixture classification	Story 6
packages/main/src/tasks/provider-claude-smoke.ts:6	Claude	verification/test fixtures	behavioral	migrate	verification-fixture classification	Story 6
packages/main/src/tasks/provider-claude-smoke.ts:250	Claude	verification/test fixtures	behavioral	migrate	verification-fixture classification	Story 6
packages/main/src/tasks/repro-first-candidate-smoke.ts:46	CLAUDE.md	verification/test fixtures	behavioral	migrate	verification-fixture classification	Story 6
packages/main/src/tasks/repro-first-candidate-smoke.ts:47	CLAUDE.md	verification/test fixtures	behavioral	migrate	verification-fixture classification	Story 6
packages/main/src/tasks/retired-root-guard-smoke.ts:25	Lattice	verification/test fixtures	behavioral	migrate	verification-fixture classification	Story 6
packages/main/src/tasks/retired-root-guard-smoke.ts:30	Lattice	verification/test fixtures	behavioral	migrate	verification-fixture classification	Story 6
packages/main/src/tasks/retired-root-guard-smoke.ts:36	Lattice	verification/test fixtures	behavioral	migrate	verification-fixture classification	Story 6
packages/main/src/tasks/retired-root-guard-smoke.ts:48	Lattice	verification/test fixtures	behavioral	migrate	verification-fixture classification	Story 6
packages/main/src/tasks/review-host-execution-readiness-smoke.ts:189	Claude	verification/test fixtures	behavioral	migrate	verification-fixture classification	Story 6
packages/main/src/tasks/session-brief-prompt-sync-smoke.ts:38	CLAUDE.md	lifecycle hints	behavioral	migrate	lifecycle hint routing	Story 4
packages/main/src/tasks/story-create-concurrency-smoke.ts:330	AGENTS.md	verification/test fixtures	behavioral	migrate	verification-fixture classification	Story 6
packages/main/src/tasks/thin-init-assets-smoke.ts:15	.lattice/Lattice.md	init/managed assets	behavioral	migrate	init-managed assets	Story 7
packages/main/src/tasks/thin-init-assets-smoke.ts:166	LATTICE.md	init/managed assets	behavioral	migrate	init-managed assets	Story 7
packages/main/src/tasks/thin-init-assets-smoke.ts:171	Lattice	init/managed assets	behavioral	migrate	init-managed assets	Story 7
packages/main/src/tasks/thin-init-assets-smoke.ts:174	.lattice/Lattice.md	init/managed assets	behavioral	migrate	init-managed assets	Story 7
packages/main/src/tasks/thin-init-assets-smoke.ts:176	AGENTS.md	init/managed assets	behavioral	migrate	init-managed assets	Story 7
packages/main/src/tasks/thin-init-assets-smoke.ts:179	AGENTS.md	init/managed assets	behavioral	migrate	init-managed assets	Story 7
packages/main/src/tasks/thin-init-assets-smoke.ts:180	AGENTS.md	init/managed assets	behavioral	migrate	init-managed assets	Story 7
packages/main/src/tasks/thin-init-assets-smoke.ts:181	Lattice	init/managed assets	behavioral	migrate	init-managed assets	Story 7
packages/main/src/tasks/thin-init-assets-smoke.ts:182	AGENTS.md	init/managed assets	behavioral	migrate	init-managed assets	Story 7
packages/main/src/tasks/thin-init-assets-smoke.ts:183	AGENTS.md	init/managed assets	behavioral	migrate	init-managed assets	Story 7
packages/main/src/tasks/thin-init-assets-smoke.ts:185	.lattice/Lattice.md	init/managed assets	behavioral	migrate	init-managed assets	Story 7
packages/main/src/tasks/thin-init-assets-smoke.ts:186	.lattice/Lattice.md	init/managed assets	behavioral	migrate	init-managed assets	Story 7
packages/main/src/tasks/thin-init-assets-smoke.ts:187	.lattice/Lattice.md	init/managed assets	behavioral	migrate	init-managed assets	Story 7
packages/main/src/tasks/thin-init-assets-smoke.ts:188	.lattice/Lattice.md	init/managed assets	behavioral	migrate	init-managed assets	Story 7
packages/main/src/tasks/thin-init-assets-smoke.ts:200	LATTICE.md	init/managed assets	behavioral	migrate	init-managed assets	Story 7
packages/main/src/tasks/thin-init-assets-smoke.ts:216	.lattice/Lattice.md	init/managed assets	behavioral	migrate	init-managed assets	Story 7
packages/main/src/tasks/thin-init-assets-smoke.ts:218	AGENTS.md	init/managed assets	behavioral	migrate	init-managed assets	Story 7
packages/main/src/tasks/thin-init-assets-smoke.ts:227	LATTICE.md	init/managed assets	behavioral	migrate	init-managed assets	Story 7
packages/main/src/tasks/thin-init-assets-smoke.ts:232	LATTICE.md	init/managed assets	behavioral	migrate	init-managed assets	Story 7
packages/main/src/tasks/thin-init-assets-smoke.ts:246	LATTICE.md	init/managed assets	behavioral	migrate	init-managed assets	Story 7
packages/main/src/tasks/thin-init-assets-smoke.ts:266	LATTICE.md	init/managed assets	behavioral	migrate	init-managed assets	Story 7
packages/main/src/tasks/thin-init-assets-smoke.ts:277	.lattice/Lattice.md	init/managed assets	behavioral	migrate	init-managed assets	Story 7
packages/main/src/tasks/unattended-dispatch-smoke.ts:553	Claude	verification/test fixtures	behavioral	migrate	verification-fixture classification	Story 6
packages/main/src/tasks/unattended-dispatch-smoke.ts:555	Claude	verification/test fixtures	behavioral	migrate	verification-fixture classification	Story 6
packages/main/src/tasks/usage-ledger-default-on-smoke.ts:19	Claude	verification/test fixtures	behavioral	migrate	verification-fixture classification	Story 6
packages/main/src/tasks/usage-ledger-default-on-smoke.ts:244	Claude	verification/test fixtures	behavioral	migrate	verification-fixture classification	Story 6
packages/main/src/tasks/usage-ledger-default-on-smoke.ts:357	Claude	verification/test fixtures	behavioral	migrate	verification-fixture classification	Story 6
packages/main/src/tasks/usage-ledger-dispatch-smoke.ts:456	Claude	verification/test fixtures	behavioral	migrate	verification-fixture classification	Story 6
packages/main/src/tasks/validation-protocol-smoke.ts:413	Lattice	verification/test fixtures	behavioral	migrate	verification-fixture classification	Story 6
packages/main/src/tasks/validation-protocol-smoke.ts:1183	LATTICE.md	verification/test fixtures	behavioral	migrate	verification-fixture classification	Story 6
packages/main/src/tasks/validation-protocol-smoke.ts:1184	LATTICE.md	verification/test fixtures	behavioral	migrate	verification-fixture classification	Story 6
packages/main/src/tasks/validation-protocol-smoke.ts:1206	LATTICE.md	verification/test fixtures	behavioral	migrate	verification-fixture classification	Story 6
packages/main/src/tasks/validation-protocol-smoke.ts:1209	LATTICE.md	verification/test fixtures	behavioral	migrate	verification-fixture classification	Story 6
packages/main/src/tasks/validation-protocol-smoke.ts:1210	LATTICE.md	verification/test fixtures	behavioral	migrate	verification-fixture classification	Story 6
packages/main/src/tasks/validation-protocol-smoke.ts:1223	LATTICE.md	verification/test fixtures	behavioral	migrate	verification-fixture classification	Story 6
packages/main/src/tasks/validation-protocol-smoke.ts:1226	LATTICE.md	verification/test fixtures	behavioral	migrate	verification-fixture classification	Story 6
packages/main/src/tasks/worktree-policy-smoke.ts:8	Claude	verification/test fixtures	behavioral	migrate	verification-fixture classification	Story 6
packages/main/templates/agents/lattice-evaluator.md:200	Claude	other tracked text	behavioral	migrate	prompt classification	Story 4
packages/main/templates/agents/lattice-review-behavior.md:104	CLAUDE.md	review/preflight/prompts	behavioral	migrate	bounded review routing	Story 4
packages/main/templates/agents/lattice-review-channel.md:104	CLAUDE.md	review/preflight/prompts	behavioral	migrate	bounded review routing	Story 4
packages/main/templates/agents/lattice-review-concept.md:104	CLAUDE.md	review/preflight/prompts	behavioral	migrate	bounded review routing	Story 4
packages/main/templates/agents/lattice-review-delivery.md:152	CLAUDE.md	review/preflight/prompts	behavioral	migrate	bounded review routing	Story 4
packages/main/templates/agents/lattice-review-delivery.md:154	CLAUDE.md	review/preflight/prompts	behavioral	migrate	bounded review routing	Story 4
packages/main/templates/agents/lattice-review-delivery.md:161	CLAUDE.md	review/preflight/prompts	behavioral	migrate	bounded review routing	Story 4
packages/main/templates/agents/lattice-review-delivery.md:248	CLAUDE.md	review/preflight/prompts	behavioral	migrate	bounded review routing	Story 4
packages/main/templates/agents/lattice-review-docs.md:107	CLAUDE.md	review/preflight/prompts	behavioral	migrate	bounded review routing	Story 4
packages/main/templates/agents/lattice-review-docs.md:117	CLAUDE.md	review/preflight/prompts	behavioral	migrate	bounded review routing	Story 4
packages/main/templates/agents/lattice-review-docs.md:119	CLAUDE.md	review/preflight/prompts	behavioral	migrate	bounded review routing	Story 4
packages/main/templates/agents/lattice-review-docs.md:136	CLAUDE.md	review/preflight/prompts	behavioral	migrate	bounded review routing	Story 4
packages/main/templates/agents/lattice-review-docs.md:142	CLAUDE.md	review/preflight/prompts	behavioral	migrate	bounded review routing	Story 4
packages/main/templates/agents/lattice-review-docs.md:165	CLAUDE.md	review/preflight/prompts	behavioral	migrate	bounded review routing	Story 4
packages/main/templates/agents/lattice-review-docs.md:169	CLAUDE.md	review/preflight/prompts	behavioral	migrate	bounded review routing	Story 4
packages/main/templates/agents/lattice-review-docs.md:178	CLAUDE.md	review/preflight/prompts	behavioral	migrate	bounded review routing	Story 4
packages/main/templates/agents/lattice-review-quality.md:104	CLAUDE.md	review/preflight/prompts	behavioral	migrate	bounded review routing	Story 4
packages/main/templates/agents/lattice-review-story-init.md:125	CLAUDE.md	review/preflight/prompts	behavioral	migrate	bounded review routing	Story 4
packages/main/templates/agents/lattice-review-story-init.md:185	CLAUDE.md	review/preflight/prompts	behavioral	migrate	bounded review routing	Story 4
packages/main/templates/agents/lattice-review-story-init.md:205	CLAUDE.md	review/preflight/prompts	behavioral	migrate	bounded review routing	Story 4
packages/main/templates/agents/lattice-review-story-init.md:209	CLAUDE.md	review/preflight/prompts	behavioral	migrate	bounded review routing	Story 4
packages/main/templates/agents/lattice-review-story-init.md:252	CLAUDE.md	review/preflight/prompts	behavioral	migrate	bounded review routing	Story 4
packages/main/templates/agents/lattice-review-story-init.md:267	CLAUDE.md	review/preflight/prompts	behavioral	migrate	bounded review routing	Story 4
packages/main/templates/agents/test-intent.md:80	CLAUDE.md	review/preflight/prompts	behavioral	migrate	bounded review routing	Story 4
scripts/verify-codex-assets.mjs:80	AGENTS.md	verification/test fixtures	behavioral	migrate	entrypoint verification	Stories 6-7
scripts/verify-codex-assets.mjs:94	AGENTS.md	verification/test fixtures	behavioral	migrate	entrypoint verification	Stories 6-7
scripts/verify-codex-assets.mjs:95	AGENTS.md	verification/test fixtures	behavioral	migrate	entrypoint verification	Stories 6-7
scripts/verify-codex-assets.mjs:96	AGENTS.md	verification/test fixtures	behavioral	migrate	entrypoint verification	Stories 6-7
scripts/verify-codex-assets.mjs:97	AGENTS.md	verification/test fixtures	behavioral	migrate	entrypoint verification	Stories 6-7
scripts/verify-codex-assets.mjs:124	AGENTS.md	verification/test fixtures	behavioral	migrate	entrypoint verification	Stories 6-7
scripts/verify-dev-memory.mjs:781	Lattice	verification/test fixtures	behavioral	migrate	verification-fixture classification	Story 6
scripts/verify-dev-memory.mjs:801	Lattice	verification/test fixtures	behavioral	migrate	verification-fixture classification	Story 6
scripts/verify-entrypoints.mjs:99	.lattice/Lattice.md	verification/test fixtures	behavioral	migrate	entrypoint verification	Stories 6-7
scripts/verify-entrypoints.mjs:137	LATTICE.md	verification/test fixtures	behavioral	migrate	entrypoint verification	Stories 6-7
scripts/verify-entrypoints.mjs:142	AGENTS.md	verification/test fixtures	behavioral	migrate	entrypoint verification	Stories 6-7
scripts/verify-entrypoints.mjs:152	AGENTS.md	verification/test fixtures	behavioral	migrate	entrypoint verification	Stories 6-7
scripts/verify-entrypoints.mjs:157	CLAUDE.md	verification/test fixtures	behavioral	migrate	entrypoint verification	Stories 6-7
scripts/verify-entrypoints.mjs:164	CLAUDE.md	verification/test fixtures	behavioral	migrate	entrypoint verification	Stories 6-7
scripts/verify-entrypoints.mjs:178	.lattice/Lattice.md	verification/test fixtures	behavioral	migrate	entrypoint verification	Stories 6-7
scripts/verify-entrypoints.mjs:179	LATTICE.md	verification/test fixtures	behavioral	migrate	entrypoint verification	Stories 6-7
scripts/verify-entrypoints.mjs:182	AGENTS.md	verification/test fixtures	behavioral	migrate	entrypoint verification	Stories 6-7
scripts/verify-entrypoints.mjs:184	AGENTS.md	verification/test fixtures	behavioral	migrate	entrypoint verification	Stories 6-7
scripts/verify-entrypoints.mjs:189	CLAUDE.md	verification/test fixtures	behavioral	migrate	entrypoint verification	Stories 6-7
scripts/verify-entrypoints.mjs:196	CLAUDE.md	verification/test fixtures	behavioral	migrate	entrypoint verification	Stories 6-7
scripts/verify-entrypoints.mjs:398	LATTICE.md	verification/test fixtures	behavioral	migrate	entrypoint verification	Stories 6-7
scripts/verify-entrypoints.mjs:399	Claude	verification/test fixtures	behavioral	migrate	entrypoint verification	Stories 6-7
scripts/verify-entrypoints.mjs:400	Claude	verification/test fixtures	behavioral	migrate	entrypoint verification	Stories 6-7
scripts/verify-entrypoints.mjs:401	Claude	verification/test fixtures	behavioral	migrate	entrypoint verification	Stories 6-7
scripts/verify-entrypoints.mjs:515	Claude	verification/test fixtures	behavioral	migrate	entrypoint verification	Stories 6-7
scripts/verify-entrypoints.mjs:516	CLAUDE.md	verification/test fixtures	behavioral	migrate	entrypoint verification	Stories 6-7
scripts/verify-entrypoints.mjs:517	CLAUDE.md	verification/test fixtures	behavioral	migrate	entrypoint verification	Stories 6-7
scripts/verify-entrypoints.mjs:522	Claude	verification/test fixtures	behavioral	migrate	entrypoint verification	Stories 6-7
scripts/verify-entrypoints.mjs:527	CLAUDE.md	verification/test fixtures	behavioral	migrate	entrypoint verification	Stories 6-7
scripts/verify-entrypoints.mjs:529	CLAUDE.md	verification/test fixtures	behavioral	migrate	entrypoint verification	Stories 6-7
scripts/verify-entrypoints.mjs:534	CLAUDE.md	verification/test fixtures	behavioral	migrate	entrypoint verification	Stories 6-7
scripts/verify-entrypoints.mjs:565	LATTICE.md	verification/test fixtures	behavioral	migrate	entrypoint verification	Stories 6-7
scripts/verify-entrypoints.mjs:568	LATTICE.md	verification/test fixtures	behavioral	migrate	entrypoint verification	Stories 6-7
scripts/verify-entrypoints.mjs:569	LATTICE.md	verification/test fixtures	behavioral	migrate	entrypoint verification	Stories 6-7
scripts/verify-entrypoints.mjs:580	.lattice/Lattice.md	verification/test fixtures	behavioral	migrate	entrypoint verification	Stories 6-7
scripts/verify-entrypoints.mjs:726	AGENTS.md	verification/test fixtures	behavioral	migrate	entrypoint verification	Stories 6-7
scripts/verify-entrypoints.mjs:727	LATTICE.md	verification/test fixtures	behavioral	migrate	entrypoint verification	Stories 6-7
scripts/verify-entrypoints.mjs:731	CLAUDE.md	verification/test fixtures	behavioral	migrate	entrypoint verification	Stories 6-7
scripts/verify-entrypoints.mjs:732	LATTICE.md	verification/test fixtures	behavioral	migrate	entrypoint verification	Stories 6-7
scripts/verify-entrypoints.mjs:733	CLAUDE.md	verification/test fixtures	behavioral	migrate	entrypoint verification	Stories 6-7
scripts/verify-entrypoints.mjs:734	CLAUDE.md	verification/test fixtures	behavioral	migrate	entrypoint verification	Stories 6-7
scripts/verify-entrypoints.mjs:735	CLAUDE.md	verification/test fixtures	behavioral	migrate	entrypoint verification	Stories 6-7
scripts/verify-entrypoints.mjs:736	CLAUDE.md	verification/test fixtures	behavioral	migrate	entrypoint verification	Stories 6-7
scripts/verify-entrypoints.mjs:747	AGENTS.md	verification/test fixtures	behavioral	migrate	entrypoint verification	Stories 6-7
scripts/verify-entrypoints.mjs:766	AGENTS.md	verification/test fixtures	behavioral	migrate	entrypoint verification	Stories 6-7
scripts/verify-entrypoints.mjs:768	CLAUDE.md	verification/test fixtures	behavioral	migrate	entrypoint verification	Stories 6-7
scripts/verify-entrypoints.mjs:784	CLAUDE.md	verification/test fixtures	behavioral	migrate	entrypoint verification	Stories 6-7
scripts/verify-entrypoints.mjs:786	AGENTS.md	verification/test fixtures	behavioral	migrate	entrypoint verification	Stories 6-7
scripts/verify-entrypoints.mjs:800	LATTICE.md	verification/test fixtures	behavioral	migrate	entrypoint verification	Stories 6-7
scripts/verify-entrypoints.mjs:802	AGENTS.md	verification/test fixtures	behavioral	migrate	entrypoint verification	Stories 6-7
scripts/verify-entrypoints.mjs:803	CLAUDE.md	verification/test fixtures	behavioral	migrate	entrypoint verification	Stories 6-7
scripts/verify-entrypoints.mjs:819	AGENTS.md	verification/test fixtures	behavioral	migrate	entrypoint verification	Stories 6-7
scripts/verify-entrypoints.mjs:820	CLAUDE.md	verification/test fixtures	behavioral	migrate	entrypoint verification	Stories 6-7
scripts/verify-entrypoints.mjs:821	AGENTS.md	verification/test fixtures	behavioral	migrate	entrypoint verification	Stories 6-7
scripts/verify-entrypoints.mjs:822	CLAUDE.md	verification/test fixtures	behavioral	migrate	entrypoint verification	Stories 6-7
scripts/verify-entrypoints.mjs:825	AGENTS.md	verification/test fixtures	behavioral	migrate	entrypoint verification	Stories 6-7
scripts/verify-entrypoints.mjs:826	CLAUDE.md	verification/test fixtures	behavioral	migrate	entrypoint verification	Stories 6-7
scripts/verify-entrypoints.mjs:827	AGENTS.md	verification/test fixtures	behavioral	migrate	entrypoint verification	Stories 6-7
scripts/verify-entrypoints.mjs:828	CLAUDE.md	verification/test fixtures	behavioral	migrate	entrypoint verification	Stories 6-7
scripts/verify-entrypoints.mjs:842	AGENTS.md	verification/test fixtures	behavioral	migrate	entrypoint verification	Stories 6-7
scripts/verify-entrypoints.mjs:843	CLAUDE.md	verification/test fixtures	behavioral	migrate	entrypoint verification	Stories 6-7
scripts/verify-entrypoints.mjs:844	LATTICE.md	verification/test fixtures	behavioral	migrate	entrypoint verification	Stories 6-7
scripts/verify-entrypoints.mjs:848	AGENTS.md	verification/test fixtures	behavioral	migrate	entrypoint verification	Stories 6-7
scripts/verify-entrypoints.mjs:849	CLAUDE.md	verification/test fixtures	behavioral	migrate	entrypoint verification	Stories 6-7
scripts/verify-entrypoints.mjs:850	LATTICE.md	verification/test fixtures	behavioral	migrate	entrypoint verification	Stories 6-7
scripts/verify-entrypoints.mjs:851	AGENTS.md	verification/test fixtures	behavioral	migrate	entrypoint verification	Stories 6-7
scripts/verify-entrypoints.mjs:852	AGENTS.md	verification/test fixtures	behavioral	migrate	entrypoint verification	Stories 6-7
scripts/verify-entrypoints.mjs:853	AGENTS	verification/test fixtures	behavioral	migrate	entrypoint verification	Stories 6-7
scripts/verify-entrypoints.mjs:854	AGENTS.md	verification/test fixtures	behavioral	migrate	entrypoint verification	Stories 6-7
scripts/verify-entrypoints.mjs:855	CLAUDE.md	verification/test fixtures	behavioral	migrate	entrypoint verification	Stories 6-7
scripts/verify-entrypoints.mjs:856	CLAUDE.md	verification/test fixtures	behavioral	migrate	entrypoint verification	Stories 6-7
scripts/verify-entrypoints.mjs:857	LATTICE.md	verification/test fixtures	behavioral	migrate	entrypoint verification	Stories 6-7
scripts/verify-entrypoints.mjs:858	CLAUDE.md	verification/test fixtures	behavioral	migrate	entrypoint verification	Stories 6-7
scripts/verify-entrypoints.mjs:859	LATTICE.md	verification/test fixtures	behavioral	migrate	entrypoint verification	Stories 6-7
scripts/verify-entrypoints.mjs:860	LATTICE.md	verification/test fixtures	behavioral	migrate	entrypoint verification	Stories 6-7
scripts/verify-entrypoints.mjs:861	LATTICE.md	verification/test fixtures	behavioral	migrate	entrypoint verification	Stories 6-7
scripts/verify-entrypoints.mjs:870	AGENTS.md	verification/test fixtures	behavioral	migrate	entrypoint verification	Stories 6-7
scripts/verify-entrypoints.mjs:871	CLAUDE.md	verification/test fixtures	behavioral	migrate	entrypoint verification	Stories 6-7
scripts/verify-entrypoints.mjs:872	LATTICE.md	verification/test fixtures	behavioral	migrate	entrypoint verification	Stories 6-7
scripts/verify-entrypoints.mjs:873	AGENTS.md	verification/test fixtures	behavioral	migrate	entrypoint verification	Stories 6-7
scripts/verify-entrypoints.mjs:874	CLAUDE.md	verification/test fixtures	behavioral	migrate	entrypoint verification	Stories 6-7
scripts/verify-entrypoints.mjs:875	LATTICE.md	verification/test fixtures	behavioral	migrate	entrypoint verification	Stories 6-7
scripts/verify-entrypoints.mjs:878	AGENTS.md	verification/test fixtures	behavioral	migrate	entrypoint verification	Stories 6-7
scripts/verify-entrypoints.mjs:879	CLAUDE.md	verification/test fixtures	behavioral	migrate	entrypoint verification	Stories 6-7
scripts/verify-entrypoints.mjs:880	LATTICE.md	verification/test fixtures	behavioral	migrate	entrypoint verification	Stories 6-7
scripts/verify-entrypoints.mjs:881	AGENTS.md	verification/test fixtures	behavioral	migrate	entrypoint verification	Stories 6-7
scripts/verify-entrypoints.mjs:882	CLAUDE.md	verification/test fixtures	behavioral	migrate	entrypoint verification	Stories 6-7
scripts/verify-entrypoints.mjs:883	LATTICE.md	verification/test fixtures	behavioral	migrate	entrypoint verification	Stories 6-7
scripts/verify-process-fact-contract.mjs:54	AGENTS.md	verification/test fixtures	behavioral	migrate	process-fact verifier	Story 6
scripts/verify-process-fact-contract.mjs:423	CLAUDE.md	verification/test fixtures	behavioral	migrate	process-fact verifier	Story 6
scripts/verify-process-fact-contract.mjs:428	CLAUDE.md	verification/test fixtures	behavioral	migrate	process-fact verifier	Story 6
scripts/verify-proof-or-stop-prompt-baseline.mjs:132	CLAUDE.md	verification/test fixtures	behavioral	migrate	retired-authority guard	Story 5
```

</details>

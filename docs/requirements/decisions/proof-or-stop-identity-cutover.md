# Proof-or-Stop identity cutover (B-022e)

**Status:** approved clean-break policy. The original policy-only commit identified below must
precede RED and every production migration commit; later reviewed clarifications do not replace
that ordering anchor.

## Policy chronology and amendment boundary

The immutable pre-RED ordering proof is anchored to the original policy-only commit
`f245fd614c728ce6027bd3a08f25eda4de32429c`. That commit introduced only this decision document,
and it is the commit referred to as the policy commit in the required ordering below.

The current document also contains exact, reviewed clarifications committed after RED. For
example, `0d68468f6e87410afca1f2dc15ab025264a992ef` added the append-only release-ledger suffix rule
after implementation exposed that boundary. Such descendant amendments refine the current
contract; they do not claim to have preceded RED, rewrite the original policy commit, or
retroactively alter the original policy-before-RED proof. The verifier therefore checks two
separate facts: ordering against the original `f245fd...` commit, and the independently pinned
blob/SHA-256 of the current reviewed document bytes.

## Decision and supersession

Proof-or-Stop is not public yet and has two maintainers. The active product therefore has one
identity, not a bilingual compatibility contract:

- product prose: `Proof-or-Stop`;
- command, package scope, file, key, identifier, and Agent-role prefix: `proof-or-stop`;
- environment prefix: `PROOF_OR_STOP_`.

This decision explicitly supersedes the additive/read-both compatibility verdicts in
`brand-rename-mapping.md` (B-cdf6) and `proof-or-stop-identity-migration.md` (B-cc10) for **all
active** package, bin, command, Agent role, environment, path, config, runtime, prompt, generated
asset, and current-document surfaces. Those two documents remain unchanged as provenance records;
their earlier decisions explain past implementation, but they do not authorize an active alias
after B-022e.

An occurrence is active when a current build, install, invocation, dispatch, lookup, gate, runtime
read/write, generated asset, prompt, or current instruction can consume or emit it. Active
coupling is migration work, not evidence and not a reason to freeze a legacy name.

The clean-break rule has three parts:

1. New writes and generated output use only the canonical identity.
2. Normal runtime lookup does not accept, prefer, fall back to, dual-read, dual-write, dispatch,
   resolve, or advertise a legacy identity.
3. A legacy token may remain only as an exact frozen entry in one of the evidence classes defined
   below. An allowed legacy input is consumed only by an explicit migration/verification path and
   can never become a normal runtime alias.

## Baseline inventory and disposition

The pre-production inventory is taken from tracked files, not from the current diff. It combines
`git ls-files` (legacy-named paths) with case-sensitive and case-insensitive `rg` searches for
`lattice`, `Lattice`, `LATTICE_`, `@lattice/`, `.lattice`, `lattice.config.json`, versioned schema
tokens, and role IDs. Protected story and fixture contents are classified by the committed
baseline manifest rather than opened or rewritten by an implementer.

Every tracked occurrence must receive exactly one disposition: `migrate`, `remove`, or an exact
`frozen` allowlist row. An occurrence that is unclassified, multiply classified, or covered by a
directory/substring exemption fails the cutover verifier.

| Active identity class | Baseline anchors | Canonical disposition | No-alias requirement |
|---|---|---|---|
| Root/Lab/Utils package names and dependency edges | root `package.json`/lockfiles: `lattice`; Lab/Utils manifests and lockfiles: `@lattice/lab`, `@lattice/utils`; main depends on `@lattice/lab` | `proof-or-stop`, `@proof-or-stop/lab`, `@proof-or-stop/utils`, with `@proof-or-stop/core` remaining canonical | no alias package, dependency edge, lockfile node, packed name, or `file:` escape hatch for `@lattice/*` |
| npm bins and wrappers | main manifest/lockfiles still map `lattice` to `dist/cli.js`; repository wrappers are already `bin/proof-or-stop*.js` | `proof-or-stop` is the sole product bin; active script names and verifier labels are renamed | no `lattice` bin-map entry, shim, wrapper, symlink, fallback candidate, or deprecated executable |
| Command text | active source, hooks, package scripts, verifiers, prompts, and docs still contain `lattice <command>` or construct it at runtime | invoke and teach `proof-or-stop <command>` only | old command resolution fails; generated/reconstructed guidance is checked as well as static literals |
| Agent roles | thirteen current role IDs and filenames use `lattice-*`; they are mirrored under `packages/main/templates/agents`, `.claude/agents`, and `.proof-or-stop-codex/agents` | rename every role below to its `proof-or-stop-*` counterpart | no accepted-type alias, registry alias, dispatch fallback, reviewer lane alias, old commit-author fallback, or old role lookup |
| Environment keys | active code, scripts, hooks, tests, and docs expose `LATTICE_*` keys | every active key becomes the corresponding `PROOF_OR_STOP_*` key | no normal read-both, preference, forwarding, or dual-write; old-only input is ignored or rejected unless an explicit migration fixture owns it |
| State/adapter/config paths and keys | `.lattice`, `.lattice-*`, `lattice.config.json`, `lattice.json`, lattice-named constants and config routes remain in readers, diagnostics, policies, or migration fallbacks | `.proof-or-stop`, `.proof-or-stop-*`, `proof-or-stop.config.json`, `proof-or-stop.json`, and Proof-or-Stop-named keys | normal execution neither probes nor recreates a legacy path; only the bounded self-host migration path may read an exact legacy input |
| Runtime identifiers | `Lattice*` types, `lattice*` functions/locals, `lattice-*` source filenames, resolver/protocol IDs, policy values, log labels, test/script commands, and verifier filenames remain | rename active symbols, filenames, registry facts, protocol IDs, policy values, labels, and their consumers | no deprecated export/re-export, compatibility constant, active data-table value, or silently vacuous old-name predicate |
| Prompts and generated Agent assets | template filenames/frontmatter, prompt registry keys/digests, config routing, dispatch prose, host mirrors, and generated assets carry role IDs | canonical template is the single source and all generated mirrors use the same `proof-or-stop-*` identity | old prompt/role lookup is unknown; a stale mirror or zero-file scan is a failure |
| Current product documentation | README, CLI/host guidance, root instructions, hooks, examples, and current non-provenance docs contain legacy invocations or identity prose | current prose says `Proof-or-Stop` and examples invoke `proof-or-stop` | no deprecation/alias guidance; prior evidence records are preserved only through exact frozen rows |

The inventory is class-based but not count-based: counts drift as the story records evidence.
Completeness comes from rescanning every tracked path at the candidate HEAD and matching every
occurrence to the decision and exact allowlist, not from preserving a snapshot count in prose.

## Agent identity cutover

The current thirteen lattice-named Agent roles change atomically as follows:

| Retired role | Canonical role |
|---|---|
| `lattice-evaluator` | `proof-or-stop-evaluator` |
| `lattice-evaluator-cli` | `proof-or-stop-evaluator-cli` |
| `lattice-implementer` | `proof-or-stop-implementer` |
| `lattice-review-behavior` | `proof-or-stop-review-behavior` |
| `lattice-review-channel` | `proof-or-stop-review-channel` |
| `lattice-review-concept` | `proof-or-stop-review-concept` |
| `lattice-review-delivery` | `proof-or-stop-review-delivery` |
| `lattice-review-docs` | `proof-or-stop-review-docs` |
| `lattice-review-quality` | `proof-or-stop-review-quality` |
| `lattice-review-scope-plan` | `proof-or-stop-review-scope-plan` |
| `lattice-review-story-init` | `proof-or-stop-review-story-init` |
| `lattice-review-test-coverage` | `proof-or-stop-review-test-coverage` |
| `lattice-review-topology-critic` | `proof-or-stop-review-topology-critic` |

For each row, the template filename, YAML frontmatter `name`, body self-identification, registry
key, accepted dispatch type, reviewer-lane value, configuration route, prompt digest key, generated
Claude/Codex asset, command help, signed run producer, and expected author/provenance string change
together. A successful lookup of any retired role is a defect. In particular,
`lattice-review-story-init` becomes `proof-or-stop-review-story-init` everywhere; it is not kept as
an INIT compatibility alias.

Historical signed records may still contain an old role string. Their existing bytes and
signatures are verified as frozen provenance; they do not register that string as an invocable
role and they cannot authorize a new write using it. Roles that never carried a lattice name
(for example `product-reviewer`) are outside this rename unless a separate decision changes them.

## Exact frozen-evidence boundary

Only the following classes may contain a legacy identity after GREEN:

1. **Historical stories:** pre-cutover story artifacts whose bytes record what happened.
2. **Migration inputs:** exact legacy files/tokens consumed by a named, explicit, one-shot
   migration/import path. They are inputs only; canonical output is mandatory.
3. **Compatibility fixtures:** exact negative, migration, or historical-verification test cases
   that prove rejection or migration. A fixture cannot make production accept an alias.
4. **`CHANGELOG.md`:** shipped release history remains unchanged.
5. **Historical signature bytes:** retired salts may remain only inside protected pre-cutover
   artifacts. Current signing and verification source uses canonical salts and rejects records
   bound to a retired identity; preserving historical bytes does not make them admissible.
6. **Historical persisted bytes:** retired schema literals may remain in protected artifacts or
   negative/migration fixtures. The exact signed `scope_boundary.v1`, `execution_boundary.v1`, and
   `scope_freeze_check.v1` schemas retain read/gate/hash compatibility because the frozen Story
   contract requires it; they are preserved byte-for-byte and can never be emitted by a writer.
7. **Provenance/hash-bound bytes:** exact pre-cutover files or byte ranges whose digest/signature
   is consumed to establish historical provenance. This includes the unchanged B-cdf6 and B-cc10
   decision documents named above; it is not a general exemption for `docs/requirements`.

No other class is frozen. In particular, active package names, bins, commands, role identities,
env keys, normal runtime path/config fallbacks, source/test/verifier filenames, managed-block
markers emitted to new installs, live registry keys, current prompts, generated mirrors, and
current docs are not evidence merely because old code refers to them.

The following retired salts can still occur inside frozen historical bytes:

- `lattice-review-integrity-v1`
- `lattice-init-check-integrity-v1`
- `lattice-delivery-check-integrity-v1`
- `lattice-draft-check-integrity-v1`
- `lattice-finding-integrity-v1`
- `lattice-review-pass-integrity-v1`
- `lattice-review-run-integrity-v1`
- `lattice-review-scope-binding-v1`
- `lattice-review-run-workspace-binding-v1`
- `lattice-scope-check-integrity-v1`
- `lattice-closeout-write-receipt-integrity-v3`
- `lattice-final-host-check-v1`
- `lattice-stall-adjudication-integrity-v1`

This salt list does not authorize any active source constant, verifier fallback, reader alias,
role, filename, prompt, or schema. Current source must use the corresponding `proof-or-stop-*`
salt; historical records that require a retired salt fail current verification without being
rewritten. The three explicitly bounded scope-schema readers above are a separate persisted-schema
exception and do not restore any retired signature salt or general protocol alias.

## Exact allowlist contract

CHK-002 commits the allowlist and byte baselines inside
`scripts/verify-proof-or-stop-identity-cutover.mjs` so the RED target and classifier cannot drift
apart. Each allowed occurrence is a literal object with this shape:

```js
{
  id: "stable-unique-id",
  class: "historical_story" | "migration_input" | "compatibility_fixture" |
    "changelog" | "signature_salt" | "persisted_schema" | "provenance_bytes",
  path: "exact/repository-relative/file",
  token: "exact legacy token",
  expectedOccurrences: 1,
  reason: "why changing these bytes would damage history or why this exact input is tested",
  disposition: "frozen",
  contextSha256: "sha256 of the bounded occurrence context",
  byteSha256: "sha256 of the whole file when the class promises whole-file stability",
  verificationCommand: "required for a signature/schema/provenance row",
  expectedVerification: "stable pass selector from that command"
}
```

Rules are mechanical:

- `path` names one tracked file. Directory paths, globs, regexes, prefixes, suffixes, generated
  path discovery, and ignore-file exemptions are forbidden.
- `token` is an exact non-empty literal. Broad substrings such as `lattice`, case-insensitive
  matching, and regular expressions are forbidden.
- `expectedOccurrences` is a positive exact integer. Every occurrence must be accounted for;
  line numbers are diagnostic only because they drift.
- `contextSha256` is required for every row. `byteSha256` is additionally required for historical
  stories, `CHANGELOG.md`, and whole-file provenance. Signature/schema/provenance rows require a
  command and invariant pass selector.
- A missing occurrence, changed count/context/digest, duplicate row, stale unused row, unknown
  class, forbidden wildcard, new unlisted token, or active file masquerading as history fails.
- The verifier enumerates tracked files itself and proves every scan root is non-empty. It does
  not trust a hand-maintained directory count or scan only files changed by B-022e.
- Allowlisted bytes are never rewritten merely to reach zero residue. New occurrences cannot be
  added to a frozen class after the baseline unless a separate reviewed decision proves that they
  are genuinely historical/provenance-bound.
- For append-only release ledgers, the frozen JSONL prefix remains byte-exact. Every appended
  suffix record is parsed as JSON, and both object keys and string values are decoded before
  case-insensitive retired-identity classification. Any retired identity in that decoded suffix
  requires the existing exact record, token/count, and record-digest provenance; an unpinned or
  altered occurrence fails closed without weakening the frozen-prefix rule.

## Required RED-before-production order

The cutover follows this immutable order:

1. Commit this decision alone. Its commit must contain no production, manifest, lockfile, prompt,
   generated-asset, or verifier migration.
2. At a descendant commit, add the single CHK-002 acceptance verifier and exact baseline. Run it
   against that commit and observe non-zero RED with diagnostics for every active identity class.
3. Bind that exact command/target and RED commit through the RED-evidence mechanism. The policy
   commit and RED commit must both be ancestors of every production migration commit.
4. Only then change product/runtime files. GREEN evaluates the same committed target; replacing,
   weakening, renaming, or broadening it invalidates the lineage.

The verifier must reject a history in which a package, bin, role, env, path/config, runtime,
prompt, generated asset, or current-doc migration precedes either the policy commit or the bound
RED commit.

## Self-host migration without an active alias

B-022e changes the tool while using that tool. The self-host path therefore separates a bounded
migration operation from normal runtime behavior:

1. Before resolver changes, record exact digests/signature checks for frozen artifacts and prove
   `story_get` plus `checklist_get` can discover B-022e through `proof-or-stop`.
2. Build and invoke the canonical repository entrypoint explicitly. Do not depend on a bare
   `lattice` bin, an old role name, or an old env key during migration.
3. If an old external installation must be imported, an explicit one-shot migrator accepts one
   exact legacy input location, validates it, copies/moves atomically into the canonical layout,
   records a receipt, and then stops reading the old location. It refuses ambiguous dual trees,
   symlink escapes, partial copies, and destination overwrite. This migrator is the only place a
   migration-input allowlist row may be consumed.
4. Switch canonical package/bin/env/config/path/runtime/Agent identities as a coupled change. A
   fresh write before and after each boundary must land only under canonical names.
5. Re-run `story_get` and `checklist_get` for B-022e through the canonical entrypoint and compare
   story/checklist identity, not volatile lifecycle timestamps. No normal resolver may require the
   retired location after the migration check.

An already-canonical `.proof-or-stop` project is not round-tripped through a legacy spelling just
to exercise compatibility. Historical files remain where the canonical store already holds them;
their bytes are verified, not cosmetically rewritten.

## Clean-install negative contract

The publish boundary is verified from packed tarballs installed into empty temporary prefixes and
projects with registry/network fallback disabled. The following negatives are mandatory:

- only a `proof-or-stop` executable is installed; `command -v lattice`, `lattice --version`, and
  direct deprecated-wrapper resolution fail non-zero;
- `@lattice/core`, `@lattice/lab`, and `@lattice/utils` cannot be resolved and do not appear in
  packed manifests, lock/dependency trees, symlinks, or `file:` dependencies;
- every retired role listed above fails dispatch, prompt lookup, config routing, and generated
  asset lookup as an unknown role, including `lattice-review-story-init`;
- setting a retired `LATTICE_*` key alone does not activate the corresponding feature; the runtime
  ignores or rejects it and never forwards it into a canonical child environment;
- planting only `.lattice`, `.lattice-codex`, `lattice.config.json`, or `lattice.json` does not make
  normal fresh-runtime discovery consume it or create new legacy output;
- unpacked current source, built output, prompts, and generated assets contain no active legacy
  residue outside the exact frozen allowlist.

Positive smoke in the same install proves `proof-or-stop --version`, help, Lab help/run, doctor,
canonical package resolution, canonical env behavior, canonical state/config creation, and every
canonical Agent role.

## Rollback policy

Rollback is whole-cutover rollback, not reintroduction of aliases.

- Before public release, retain the last pre-migration commit and the frozen baseline digests.
- On a failed migration, stop writers, discard or revert the complete production migration commit
  sequence, and restore an explicitly migrated external tree only from the migrator's verified
  backup/receipt. Never merge two partially written identity trees.
- Re-run the pre-cutover evidence verification after rollback. A digest/signature mismatch is a
  stop condition; do not repair it by editing historical bytes.
- Do not “roll forward” by adding `lattice` bins, `@lattice/*` aliases, old roles, read-both env,
  or normal path/config fallbacks. Fix forward under canonical names or revert the whole cutover.
- After public release, use a new reviewed migration/version decision; this pre-public clean-break
  policy does not authorize silent identity changes for external consumers.

## Verification and completion gates

GREEN requires all of the following at one descendant HEAD:

1. The identity-cutover verifier reports every active class canonical, every frozen row exact and
   current, no stale/broad allowlist row, and mutation sensitivity for omitted/broadened rows.
2. Root/core/Lab/Utils build, pack, and clean-install from tarballs; packed manifests and lockfile
   identities agree and contain no legacy dependency/bin edge.
3. Canonical CLI/Lab/doctor smoke passes and every legacy command/package negative above fails as
   expected.
4. The complete canonical Agent set renders from its source templates; filename, frontmatter,
   registry, config route, generated mirrors, reviewer lanes, and dispatch/provenance identities
   agree. Every old role lookup fails.
5. Process-fact, runtime-fact, prompt-baseline, entrypoint, global-Lab, and Codex adapter verifiers
   scan canonical non-empty roots and pass.
6. Historical byte digests and signature/schema verification reproduce the RED baseline exactly;
   allowlist injection, deletion, widening, stale-row, and frozen-byte mutations each fail.
7. `story_get` and `checklist_get` discover B-022e before and after the self-host switch, and fresh
   runtime writes use only canonical locations and identifiers.

Routine TEST and DONE-required validation consume this product evidence only after the same target
is GREEN. Passing a static grep without clean-install, negative role/package/command resolution,
generated-output checks, and frozen-history verification is insufficient.

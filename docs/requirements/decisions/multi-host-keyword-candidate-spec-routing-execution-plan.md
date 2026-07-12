# Multi-Host Keyword Candidate-Spec Routing Execution Plan

Status: M6A-M6F implemented by B-8038; M6G rollout mechanics partially implemented; lifecycle delivery pending; configured mode remains `shadow`
Parent program: M6 Scope And Spec Scan Narrowing  
Origin: B-f97c removed unconditional requirements-corpus embedding from `story_review`

Implementation record (2026-07-12): B-8038 implemented M6A-M6F and the M6G configuration schema, caller-supplied-window promotion evaluator, process contracts, fail-closed evidence checks, and safe rollback boundary on its Story branch. The implementation is evidenced by commits `8d318a6791`, `504564cbc1`, `58a9e9b199`, `2a34d5aa1e`, `ec8d248d66`, `802d8088a3`, and `0fa154b2d4`, plus `packages/main/src/tasks/candidate-spec-routing-smoke.ts` and `scripts/verify-process-fact-contract.mjs`. Runtime collection of precision, candidate/full-read bytes, latency, and qualifying evaluation windows is not implemented by B-8038; `candidate_spec_rollout_check` evaluates values supplied by its caller and is not window-production evidence. This records implementation mechanics, not production release or rollout promotion: `lattice.config.json` still selects `candidateSpecRouting.mode = "shadow"`, no two-window promotion evidence is claimed, and the historical thresholds below remain authoritative.

## 1. Decision

Proofbound will replace default broad specification reads with a hybrid retrieval pipeline:

1. the CLI derives deterministic search terms from structured Story facts;
2. Codex CLI and Claude Code CLI independently propose semantic expansions;
3. Antigravity CLI (`agy`) is a supplemental or fallback proposer, not a mandatory third call;
4. the CLI performs bounded local filename, heading, and content search;
5. a deterministic ranker produces an auditable `candidateSpecSet`;
6. reviewers read candidate documents in full and title-triage the rest;
7. ambiguity, high-risk changes, or weak recall triggers an explicitly recorded broader scan.

Model output is advisory routing input. It is never gate evidence. Signed scope-check, reviewer-pass, finding, validation, and delivery artifacts remain the only lifecycle evidence.

## 2. Problem

B-f97c removed the immediate failure mode where every `story_review` prompt embedded the complete requirements corpus. That stopgap prevents routine prompt size from scaling with corpus size, but it intentionally does not solve relevant-document discovery.

The next problem is recall under a bounded read budget:

- deterministic keywords may miss historical synonyms;
- one model may reproduce the Story's current wording and miss legacy vocabulary;
- model-only search is non-reproducible and may omit exact command, field, or config names;
- `relatedDocs` is curated by the owner and cannot be the sole truth source;
- a top-N cap without ambiguity handling can hide a relevant document near the cutoff;
- reviewer prose cannot prove which files were actually read.

## 3. Goals

- Keep default full reads bounded without weakening requirement-gap detection.
- Combine deterministic recall with independent semantic expansion.
- Make every keyword, search query, candidate score, read, omission, and escalation auditable.
- Reuse one candidate contract across PLAN scope review, REVIEW behavior/docs lanes, and delivery review without merging their ownership.
- Measure recall, precision, token cost, latency, host availability, and escalation frequency.
- Fail closed when routing evidence is malformed, stale, ambiguous, or inconsistent with mechanical read logs.

## 4. Non-goals

- Restoring requirements bodies to `_reviewPrompt`.
- Treating model-proposed keywords, memory hits, or search scores as proof.
- Replacing `scope_check_save`, signed reviewer runs, findings, or delivery checks.
- Making `agy` mandatory when Codex CLI and Claude Code CLI are available.
- Using embeddings or a remote vector database in the first rollout.
- Allowing a hard top-N cutoff to suppress ambiguity escalation.
- Changing B-3928 baseline artifacts in this workstream.

## 5. Shipped-versus-future boundary

Already shipped:

- B-f97c removed recursive requirements Markdown reads and full `Truth Source` concatenation from `story_review`.
- The PLAN scope reviewer has a bounded candidate-first prompt contract and records a `readManifest`.
- Full scan requires `scanEscalationReason` in the prompt-layer stopgap.

Implemented by B-8038, with lifecycle delivery still pending:

- CLI-owned deterministic keyword generation;
- structured host keyword proposals;
- local search, scoring, and candidate materialization;
- mechanical read-log reconciliation;
- shared candidate routing across eligible review lanes;
- M6G configuration, caller-supplied-window evaluator, process contracts, and rollback mechanics.

Still future after B-8038: runtime routing-metric/window production, two qualifying observed windows, and any promotion from `shadow` to `warn` or `enforce`.

The code, focused fixtures, and process-fact verifier cited in the implementation record are the implementation evidence. This document alone must not be cited as proof of production release, successful promotion to `warn`/`enforce`, or satisfaction of the two-window rollout thresholds.

## 6. Architecture

```text
Story + checklist + understanding + scope + diff
                    |
                    v
       deterministic CLI keyword seeds
                    |
          +---------+---------+
          |                   |
          v                   v
    Codex proposal      Claude proposal
          |                   |
          +---------+---------+
                    |
          optional agy proposal
                    |
                    v
       normalized keyword/query union
                    |
                    v
 filename + heading + bounded rg search
                    |
                    v
 deterministic ranking and ambiguity check
                    |
          +---------+---------+
          |                   |
          v                   v
 candidate full reads   filename/title triage
          |                   |
          +---------+---------+
                    |
                    v
 signed scope evidence + mechanical read evidence
```

The CLI owns normalization, search execution, ranking, budgets, artifact hashes, and metrics. Hosts only propose semantic terms and short rationales.

## 7. Deterministic keyword contract

The CLI MUST derive seeds before launching any host. Sources, in priority order:

1. explicit `relatedDocs` paths and anchors;
2. Story title, description, keywords, risk signals, and acceptance wording;
3. checklist titles, `userSees`, and `excludes`;
4. understanding touchpoints and declared files;
5. changed paths, exported symbols, command names, config keys, artifact names, and process-fact names;
6. exact identifiers extracted from backticks, flags, JSON keys, environment variables, and error codes;
7. bounded memory/playbook hits, labeled advisory and non-authoritative.

Each seed records:

```ts
interface DeterministicKeywordSeed {
  term: string;
  normalizedTerm: string;
  sourceType: 'relatedDoc' | 'story' | 'checklist' | 'touchpoint' |
    'changedFile' | 'symbol' | 'command' | 'configKey' | 'artifact' |
    'processFact' | 'memoryAdvisory';
  sourceRef: string;
  weight: number;
}
```

Normalization MUST preserve exact identifiers alongside lowercase lexical forms. Hyphen, underscore, slash, camelCase, and acronym variants may be added, but the original token cannot be discarded.

## 8. Host keyword proposal contract

### 8.1 Default host policy

- Primary proposers: Codex CLI and Claude Code CLI.
- Supplemental proposer: Antigravity CLI (`agy`) when the two primary hosts disagree materially, candidate ambiguity remains, either primary host is unavailable/quota-limited, or the reviewer explicitly requests a third semantic perspective.
- No host proposal can expand lifecycle authority or satisfy a gate.

### 8.2 Fresh-context input

The CLI first applies one pre-egress sanitizer to every field and artifact that could enter a host prompt. There is no alternate adapter path around this boundary. The sanitizer:

- transmits identifier, command, configuration, and environment-variable names, never detected values;
- redacts secret-like values in Story/checklist prose, backticks, error payloads, paths, titles, symbols, seeds, and memory-derived text;
- hashes or omits sensitive provenance and `sourceRef` values while retaining a local-only mapping for audit;
- rejects and records unsafe host inputs or outputs instead of trying to repair them;
- treats uncertain classification as sensitive and skips the host call, continuing with deterministic local routing;
- persists only the sanitized request digest and sanitized proposal artifact.

After sanitization, each host receives only:

- Story ID, title, description, keywords, and risk signals;
- checklist title, `userSees`, `excludes`, and related-doc paths;
- deterministic seed list with provenance;
- changed files/symbols when available;
- complete decisions filename/title index, without document bodies;
- proposal budget and output schema.

The host does not receive the entire requirements corpus, the owner's full conversation, raw secret-bearing metadata, or the local-only provenance map.

### 8.3 Output schema

```ts
interface HostKeywordProposal {
  schemaVersion: 'proofbound.keyword-proposal.v1';
  storyId: string;
  host: 'codex-cli' | 'claude-cli' | 'agy-cli';
  proposalId: string;
  promptDigest: string;
  deterministicSeedDigest: string;
  terms: Array<{
    term: string;
    rationale: string;
    kind: 'synonym' | 'legacy-term' | 'domain-term' | 'behavior' |
      'failure-mode' | 'command-config' | 'negative-control';
    derivedFrom: string[];
    confidence: 'high' | 'medium' | 'low';
  }>;
  rejectedSeeds: Array<{ term: string; reason: string }>;
  ambiguitySignals: string[];
}
```

Limits per host:

- at most 20 proposed terms;
- at most 5 ambiguity signals;
- rationale at most 160 characters;
- no document-body quotation;
- invalid or oversized output is ignored and recorded, never silently repaired into evidence.

## 9. Local search pipeline

### 9.1 Corpus index

The CLI builds a deterministic local index containing:

- relative path;
- H1/H2 headings;
- file byte size;
- content hash;
- optional bounded keyword sketch;
- last modified Git commit, when cheap;
- document status hints such as execution plan, canonical decision, legacy, or superseded.

Complete filename enumeration is mandatory and cheap. Full bodies are not loaded into the routing prompt.

### 9.2 Query stages

1. Exact path and related-doc match.
2. Exact identifier match over filename and headings.
3. Exact identifier match over document bodies.
4. Normalized lexical match.
5. Host-proposed semantic term match.
6. Pair queries combining a domain term with a behavior, command, config key, or failure mode.
7. Negative-control queries used to detect over-broad terms.

Default budgets:

- at most 10 `rg` query groups;
- at most 50 raw hits per query group;
- at most 8 full-read candidates;
- at most 2 expansion passes;
- zero full-corpus body reads without escalation.

The CLI may deduplicate equivalent queries before execution. Deduplication and skipped-query reasons are recorded.

## 10. Candidate ranking

Candidate score is deterministic after host proposals are collected:

```text
score =
  relatedDocExact          * 100
  + changedPathOrSymbol    * 60
  + commandOrConfigExact   * 50
  + deterministicExactHit  * 35
  + headingHit             * 25
  + independentHostVotes   * 15
  + hostSemanticHit        * 8
  + riskDomainMatch        * 10
  - legacySuperseded       * 20
  - negativeControlNoise   * 15
```

Weights are versioned constants, not prompt prose. A host cannot directly assign a document score.

Tie-breaking order:

1. explicit related doc;
2. exact identifier or changed-symbol hit;
3. number of independent source classes;
4. number of independent hosts;
5. lexical relative path order.

## 11. Candidate artifact

```ts
interface CandidateSpecSetArtifact {
  schemaVersion: 'proofbound.candidate-spec-set.v1';
  storyId: string;
  phase: 'PLAN' | 'REVIEW' | 'TEST';
  corpusDigest: string;
  corpusFileCount: number;
  deterministicSeeds: DeterministicKeywordSeed[];
  hostProposalRefs: string[];
  queries: Array<{
    queryId: string;
    terms: string[];
    sourceRefs: string[];
    hitCount: number;
    truncated: boolean;
  }>;
  candidates: Array<{
    path: string;
    score: number;
    rank: number;
    reasons: string[];
    matchedTerms: string[];
    hostVotes: string[];
    contentHash: string;
  }>;
  triagedByName: string[];
  budget: {
    maxCandidates: number;
    maxQueryGroups: number;
    maxExpansionPasses: number;
  };
  ambiguitySignals: string[];
  fullScan: boolean;
  scanEscalationReason: string | null;
  metrics: RoutingMetrics;
}
```

The artifact is signed or hash-bound to Story inputs, corpus digest, prompt digests, and current material/story-files hashes according to its consuming phase.

## 12. Ambiguity and escalation

The router MUST escalate instead of guessing when any condition holds:

- lifecycle, gate, process-fact, global rename, or cross-cutting policy change;
- reviewer explicitly requests escalation;
- a relevant filename/title is detected but cannot be safely classified;
- score tie crosses the candidate cutoff;
- Codex and Claude candidate overlap is below the configured minimum;
- a high-confidence host legacy-term proposal has no search result;
- top candidates cover fewer than two independent source classes;
- a golden known-relevant document falls outside the candidate set;
- search results are truncated in a way that could affect ranking;
- corpus digest changes after routing;
- mechanical read evidence contradicts the declared manifest.

`scanEscalationReason` records:

- trigger code;
- observed ambiguity;
- candidate set attempted;
- budget already consumed;
- requesting host/reviewer;
- expanded scope and stop condition.

A broad scan is still performed through local tools and read evidence. It is never serialized into a single LLM prompt.

## 13. Read evidence

`scope_check_save` and later reviewer writes consume both a declared manifest and a mechanical read log:

```ts
interface ReviewerReadEvidence {
  candidateSpecSetDigest: string;
  filesReadFully: Array<{ path: string; contentHash: string }>;
  filesTriagedByName: string[];
  readLogDigest: string;
  manifestMatch: boolean;
  unreportedReads: string[];
  missingDeclaredReads: string[];
  scanEscalationReason: string | null;
}
```

Gate behavior:

- missing candidate artifact: fail closed when routing is required;
- stale corpus/input digest: reroute;
- declared/mechanical mismatch: fail closed;
- full scan without reason: fail closed;
- proposal-only evidence: ignored;
- a clean read manifest does not itself prove feature coverage; signed scope mapping still does.

## 14. Phase ownership

### PLAN

The scope-plan reviewer owns requirement-to-checklist mapping. It consumes the candidate set, reads candidates, title-triages the remaining corpus, records gaps/orphan-suspects/open questions, and writes `scope_check_save`.

### REVIEW

- Behavior reviewer consumes current diff, checklist commitments, scope-check result, and relevant candidates.
- Docs reviewer owns doc-code promise drift and may reuse the same candidate digest.
- Coverage reviewer checks that candidate routing and read evidence cover verification intent.
- Review lanes cannot mutate Story phase or owner artifacts.

### TEST

Validation checks artifact freshness, schema, budgets, read-log reconciliation, and required routing metrics. It does not invent candidates.

### Delivery

Delivery reviewer consumes the signed scope result, current diff, actual transcripts, and candidate/read evidence. It may request rerouting when doc promises or corpus changes make the candidate set stale.

## 15. Process-fact and runtime boundaries

Implementation that makes candidate artifacts or read evidence gate-consumed MUST update:

- process fact registry and contract verification;
- command policies and legal writer lanes;
- artifact schema/version validation;
- freshness consumers for material hash, story-files hash, and corpus digest;
- reviewer prompt guidance and handler fallback together.

Host availability, executable paths, and provider versions remain runtime facts. They must not be mixed into process-fact truth or treated as proof of review quality.

## 16. Prompt-injection and trust controls

- Search results are untrusted document content.
- Hosts propose terms before receiving document bodies.
- Document instructions cannot alter tool permissions, budgets, lifecycle phase, or output schema.
- Paths are repository-relative, normalized, traversal-safe, and constrained to the configured requirements directory.
- Symlinks escaping the repository are rejected.
- Search output is size-capped before entering host context.
- The shared pre-egress sanitizer covers every host-bound Story field, seed, path/title, provenance record, search snippet, and proposal artifact; secret-like strings never become host input or persisted keyword proposals.
- Host adapters cannot bypass sanitization. If classification is uncertain, the host is skipped and deterministic local routing continues.
- Proposal and search artifacts record provider, prompt digest, and schema version.

## 17. Quality floor

The rollout cannot claim success from token reduction alone. Required evaluation sets:

1. Golden recall corpus: known Story-to-decision relevance pairs, including legacy synonyms.
2. Negative controls: similarly named but irrelevant historical plans.
3. Gate/process changes: cases that must escalate.
4. Global rename cases.
5. Candidate cutoff ties and host disagreement.
6. Memory no-hit and host-unavailable paths.
7. Prompt-injection documents.
8. Corpus mutation between route and review.

Acceptance thresholds:

- known-relevant document recall: 100% for critical/high-risk fixtures;
- known-relevant document recall: at least 98% overall;
- no loss of load-bearing findings versus the full-scan baseline suite;
- false candidate rate reported, not hidden;
- default full-read count at most 8;
- P95 routing latency target under 5 seconds excluding host latency;
- default prompt/document bytes at least 90% below full-corpus baseline;
- full-scan rate measured and justified, not optimized to zero;
- zero accepted manifest/read-log mismatches.

Any critical recall miss blocks rollout regardless of average token savings.

## 18. Metrics

```ts
interface RoutingMetrics {
  deterministicSeedCount: number;
  hostProposalCount: Record<string, number>;
  hostAgreementJaccard: number | null;
  queryGroupCount: number;
  rawHitCount: number;
  candidateCount: number;
  fullReadCount: number;
  triagedByNameCount: number;
  corpusBytes: number;
  candidateBytes: number;
  estimatedInputTokens: number;
  routingLatencyMs: number;
  hostLatencyMs: Record<string, number>;
  fullScan: boolean;
  escalationCode: string | null;
}
```

Metrics are diagnostic and non-authoritative unless a specific gate validates their schema/freshness. Host usage is reported separately from deterministic corpus/candidate byte measurements.

## 19. Milestones and Story decomposition

### M6A - Corpus index and deterministic seeds

Implementation: B-8038, commit `8d318a6791`; direct evidence in `core/candidate-spec-routing.ts` and `candidate-spec-routing-smoke.ts`.

- implement path/heading/content-hash index;
- extract structured Story identifiers;
- normalize variants without losing originals;
- add schema and deterministic golden tests.

Exit: identical inputs produce byte-identical seed and corpus-index artifacts.

### M6B - Host proposal adapters

Implementation: B-8038, commit `504564cbc1`; deterministic host ordering and sanitizer regressions were hardened by `ec8d248d66`.

- define fresh-context prompts for Codex and Claude;
- add conditional `agy` path;
- implement one shared pre-egress sanitizer used by every host adapter, with local-only sensitive-provenance mapping;
- validate output size/schema/provenance;
- record timeout/unavailable results without blocking deterministic fallback.

Exit: host failures cannot cause unbounded scanning or silent evidence claims, and secret-like values cannot reach a host request or persisted proposal.

### M6C - Local search and ranker

Implementation: B-8038, commits `8d318a6791` and `802d8088a3`; bounded ranking and explicit escalation fixtures live in `candidate-spec-routing-smoke.ts`.

- implement bounded query planner;
- execute local filename/heading/body search;
- score candidates deterministically;
- record cutoff ambiguity and negative controls.

Exit: golden candidates and tie/escalation fixtures pass.

### M6D - Candidate artifact and read evidence

Implementation: B-8038, commits `58a9e9b199`, `ec8d248d66`, and `0fa154b2d4`; freshness and unresolved-escalation checks are consumed by scope/review evidence handlers.

- persist candidate artifact;
- capture mechanical reviewer read log;
- reconcile manifest to log;
- bind digests to Story and corpus inputs.

Exit: missing, stale, forged, or mismatched evidence fails closed.

### M6E - PLAN integration

Implementation: B-8038, commits `2a34d5aa1e` and `0fa154b2d4`; PLAN dispatch renders candidate/elevation state and `scope_check_save` fails closed on unresolved signed routing evidence.

- route scope-plan reviewer through CLI candidates;
- retain filename enumeration and open-question behavior;
- preserve full-scan escalation.

Exit: PLAN quality baseline passes with bounded default reads.

### M6F - REVIEW and delivery reuse

Implementation: B-8038, commits `58a9e9b199` and `2a34d5aa1e`; routing context is shared while existing reviewer-run writer/lane authority remains independent.

- share candidate digest across eligible lanes;
- preserve lane ownership;
- reroute on diff/corpus changes;
- avoid duplicate findings.

Exit: behavior/docs/delivery fixtures show no owner overlap or quality loss.

### M6G - Rollout and enforcement

Implementation boundary: B-8038 implemented configuration, diagnostics over caller-supplied values, the promotion evaluator, fail-closed evidence contracts, process-fact verification, and the safe rollback boundary. It did not implement runtime metric/window collection and did not produce two qualifying observed windows. Active configuration remains `shadow`; `warn`/`enforce` promotion and production release are not claimed.

- shadow mode with metrics only;
- warn mode on budget/evidence mismatches;
- enforce mode after recall and equivalence gates pass;
- add rollback configuration restoring tool-driven broad review, never corpus prompt injection.

Exit: two consecutive evaluation windows meet all quality and cost thresholds.

## 20. Validation matrix

| Scenario | Expected result |
|---|---|
| Exact related doc | rank 1 with explicit-path reason |
| Sparse matches | retain deterministic seeds, record low coverage, and escalate when the source-class floor is not met |
| Noisy/excessive matches | deduplicate and rank within configured result budgets; truncation that can change the cutoff escalates |
| Zero-candidate result | record the empty result and ambiguity reason, then use bounded escalation; never silently inject or fully scan the corpus |
| Legacy synonym proposed by one host | local hit enters candidates with host provenance |
| Both hosts miss exact config key | deterministic seed still retrieves document |
| Codex/Claude disagree at cutoff | ambiguity escalation |
| `agy` unavailable | primary pair continues; availability recorded |
| Both primary hosts unavailable | deterministic path continues; no automatic full scan |
| Memory no-hit | bounded search continues |
| High-risk gate change | recorded broad-scan escalation |
| Irrelevant 5 MB Markdown file | absent from full reads and prompt bytes |
| Relevant document ranked ninth with tied score | cutoff tie escalates |
| Corpus changes after routing | artifact stale; reroute required |
| Manifest claims unread file | fail closed |
| Mechanical log contains undeclared full read | fail closed |
| Prompt-injection text in document | ignored as instruction; content remains evidence only |
| Proposal exceeds schema budget | proposal rejected and recorded |
| Secret in Story/checklist prose or backticks | value is removed before every host request; deterministic local routing remains available |
| Secret in seed provenance, `sourceRef`, path/title, config, or error metadata | value is hashed or omitted from host-bound and persisted artifacts; the raw mapping stays local only |
| Sanitizer cannot classify a value confidently | host call is skipped and recorded; deterministic local routing continues |
| Host returns secret-like material | proposal is rejected, not persisted, and cannot influence candidate ranking |

## 21. Rollout

### Shadow

Target/historical rollout design: run the router beside current bounded reviewer behavior, record candidates, misses, bytes, latency, and what the reviewer actually read, without making candidate evidence mandatory merely because mode is `shadow`.

Current implemented semantics: when no candidate artifact digest/read binding is supplied, `shadow` remains non-authoritative and the gate does not require one. When a caller does supply `candidateSpecSetDigest`/read binding—as current dispatch examples do—the scope/review handlers validate its signature, freshness, manifest coverage, and escalation resolution fail closed even in `shadow`. Runtime metric/window collection described by the target design is still future work.

### Warn

Surface stale/malformed artifacts, budget overruns, read mismatches, and unjustified full scans. Existing signed scope evidence remains authoritative.

### Enforce

Require current candidate and read-evidence artifacts for configured lanes. Enforce only after golden recall, finding equivalence, and host failure-path tests pass.

### Rollback

Configuration disables candidate enforcement and returns reviewers to explicit tool-driven search with recorded escalation. Rollback must never restore `_reviewPrompt` corpus embedding.

## 22. DONE criteria for the implementation program

- Default review prompts contain no requirements corpus bodies.
- Deterministic seeds, host proposals, queries, candidates, rankings, and read evidence use versioned schemas.
- Codex and Claude are independent default semantic proposers; `agy` policy is explicit.
- Candidate and read artifacts are hash-bound and freshness-checked.
- Full scan requires a structured escalation reason and remains tool-driven.
- Critical/high-risk golden recall is 100%.
- Finding-equivalence baseline shows no lost load-bearing finding.
- Token/document bytes and latency meet thresholds.
- Host outage, no-hit, disagreement, injection, and stale-corpus fixtures pass.
- Process-fact registry, command policies, validation, reviewer prompts, and handler fallback agree.
- User-facing docs clearly distinguish routing evidence, review evidence, and runtime diagnostics.

## 23. Recommended first implementation Story

Historical sequencing guidance: the program originally recommended starting with M6A only—corpus index plus deterministic keyword seeds and golden fixtures—before launching model hosts. B-8038 subsequently implemented M6A-M6F plus the bounded M6G mechanics described above while preserving that separation between deterministic retrieval correctness and provider behavior; runtime M6G measurement and promotion evidence remain future work.

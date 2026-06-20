# Contract-First Parallel Decomposition — Mandatory Spec

> **导读**：本规范把"能并行的故事必须并行"从口号变成 Lattice 里可强制执行的机制。它给出一套分解算法（先抽取共享接口做 Story 0"主文件"，再把各模块拆成互不重叠、可同时开发的并行故事，最后串行做集成），配套故事模板、可直接复制的分解 prompt、以及一个挂在真实 XState guard（`canStartDevGuard`）上的强制门。强制只敢卡"可证明的文件重叠"，逻辑依赖与评审带宽属人类判断，只提示不硬卡——这条边界是刻意的，下文逐节说明。

**核心规则（规范性）：独立的故事必须并行，禁止仅出于习惯/方便而串行。** 唯一允许串行的理由是一条真实的 must-finish-before 路径（或一个具名、可审计的 `serializeReason`）。

---

## 1. Scope & the Mandatory Rule

### 1.1 What this governs

At **requirement-decomposition time** (before any worktree exists), a decomposer — human operator or AI planner — turns **one** requirement into a **set** of Lattice stories whose schedule is maximally parallel. Each story carries a scope boundary (`ScopeBoundaryData.allowed/excluded`), a scope contract (`ScopeContractData.allowedModify/allowedCreate/allowedTest/protectedFiles/explicitExcludes`), and the standard parallel metadata (`depends[]`, `blockingFor[]`, `sharedHotspots[]`, `lane`, `parallelSafe`).

### 1.2 The mandatory rule and the INVALID-decomposition rejection condition

**Default-parallel rule.** If two stories are *independent* (§2, Step 2), the decomposition MUST schedule them concurrently. Placing one after the other **with no must-finish-before path and no recorded `serializeReason`** is an **INVALID decomposition** and MUST be rejected and redone. "We just ran them one after another" is a defect, not a fallback.

**The one escape hatch (so the rule does not over-reject).** Real teams sometimes serialize *independent* work for legitimate non-dependency reasons: shared scarce reviewer expertise, risk staging (land the risky module first to fail fast), an operator wanting to learn from module A's review before authoring B, or external runtime-resource contention invisible as a file/interface edge. These are permitted **only** when named in an explicit, auditable `serializeReason` string on the story. The rule forbids *silent* serialization, not *all* serialization. No path and no `serializeReason` ⇒ INVALID.

### 1.3 Preventing gaming (fake dependencies and fake independence)

The independence test (§2, Step 2) has two halves with very different enforceability:

- **File-overlap half** — mechanically checkable from declared scope. This is the only half Lattice **hard-blocks** (§4).
- **Logical-dependency half** — a semantic judgment that static analysis *cannot* verify. A decomposer can fabricate a dependency (to dodge parallelism) or fabricate independence (to dodge a real runtime coupling), and no static check can fully catch either.

Anti-gaming controls, stated honestly:
1. Every `depends` edge MUST carry a **machine-checkable justification**: name the consumed symbol AND the producing story. The gate **rejects** an edge whose cited symbol is not present in the producer's `allowedCreate` contract surface. This turns a fabricated dependency from a free lie into a falsifiable claim.
2. `parallelSafe: 'yes'` asserted behind a **broad glob** is hard-blocked (§4.2) — you cannot hide overlap behind `src/**`.
3. **Residual, acknowledged:** a determined operator who writes a *plausible-but-false* justification, citing a symbol that really does exist, still defeats the logical-half check. This control is **friction and audit trail, not proof.** Mandatory parallelism is *provably* enforced only on the file-overlap half; the logical half is enforced socially (named, reviewable justifications), exactly because semantics are not statically decidable.

> 注：强制只对"文件重叠"这一半成立（可证明）；逻辑依赖只能靠"具名理由+审计"，承认能被精心编造的假理由绕过——这是语义不可判定的固有限制，不是实现偷懒。

---

## 2. Decomposition Algorithm & Independence Test

The output is a story set in which every pair is either on a single serial chain (the critical path) or provably independent and therefore scheduled simultaneously.

### Step 1 — Enumerate work units (candidate stories)

List every distinct unit of deliverable work. A unit is a candidate story if it has a self-contained acceptance test and a bounded file footprint.

1. Restate the requirement as a flat list of verbs-on-nouns ("parse the manifest", "add the `--json` flag", "write the migration").
2. For each item, assign a **prospective scope** = the set of file *paths* (near-file-level, §3) it will create or modify. `src/**` is not a scope; `src/parsers/manifest.ts` is.
3. Mark each unit's **produced interface**: types, class names, function/method signatures, route names, or schema it exposes to *other* units. If it produces nothing others consume, its interface is `∅`.
4. Discard pure refinements (fold them in). Result = candidate set `U = {u1 … un}`.

> **Contract-first heuristic.** Any type/class/signature appearing in **two or more** candidates' produced/consumed interface is a **shared contract** and MUST be lifted into a dedicated **Story 0** (§3). Lifting it *converts* a dependency edge into "both depend on Story 0, neither depends on the other."

### Step 2 — Build the dependency graph; apply the two independence tests

Build directed graph `G`: nodes = candidate stories, edge `A → B` means **A must finish before B can be designed and implemented**. An edge exists iff **either** test below **fails**.

A and B are **independent** iff **both** tests pass.

**Test 1 — File-overlap (static, scope-level).** Compare *write* scopes (created/modified paths). Pass iff disjoint.
```
fileOverlap(A,B) = writePaths(A) ∩ writePaths(B) ≠ ∅
```
- Compare *write* scopes only; a file both merely *read* is not an overlap.
- A modifies + B modifies the same file = overlap = **fails** (guaranteed merge conflict).
- A *creates* a file that B *imports but never edits* = **not** a file overlap → it is a logical edge, handled by Test 2.
- This is a **static, pattern-level** check (§4.2). It is the *predictive* control. It is **not** the same as Lattice's runtime `actualFileOverlapsByStory()`, which only inspects files already changed in existing worktrees and therefore **cannot produce meaningful results before DEV** — it *can* be called in PLAN (PLAN-phase stories count as active), but only stories that have entered DEV have actually modified files in their worktrees, so a pre-DEV call yields no real overlaps (see §4.2 / §7-F4). Do not conflate the two: the static check predicts; the runtime probe is a post-hoc safety net.

**Test 2 — Logical-dependency (interface-level).**
```
logicalDep(B,A) = B.consumes ∩ A.produces ≠ ∅
```
Decision rule (crux of contract-first):
- If `B.consumes ∩ A.produces` is **frozen in Story 0** (signatures + skeletons already merged), B consumes the *contract*, not A. The edge is `Story0 → B`, **not** `A → B`. A and B stay independent.
- If `B.consumes` needs A's *runtime behavior / real return values* (not just its type shape), it is a genuine `A → B` edge; they are on a serial chain.

So `A → B` is drawn **iff** `fileOverlap(A,B)` OR (`logicalDep(B,A)` AND the consumed artifact is **not** lifted into the frozen Story-0 contract). Every drawn edge carries the machine-checkable justification from §1.3.

Mapping onto real Lattice fields: a true edge ⇒ `B.depends += [A]` (drives `resolveParallelSafety → 'no'`); a pair passing both tests ⇒ `parallelSafe: 'yes'`. **A true, unavoidable file overlap does NOT get parked in `sharedHotspots`** — see Step 2-note.

> **Step 2-note (no serialization-by-another-name).** `sharedHotspots` in the real code (`resolveParallelSafety`, set-intersection of free-form strings) degrades a pair to `plan_only`, which means "may plan together but not code simultaneously" — that **is** partial serialization. Therefore an *unavoidable* file overlap means the two units are **not independent**: you MUST either **merge** them into one serial story or **contract-lift** the shared file into Story 0. Do not route a real overlap into `sharedHotspots/plan_only` to make it "look parallel." `plan_only` is acceptable only as an advisory degradation surfaced to the operator, never as the decomposer's answer to a genuine overlap.

### Step 3 — Identify the critical path (the only earned serial chain)

1. Verify `G` is acyclic. A cycle = two stories mutually need each other's interface ⇒ resolve by lifting the shared interface into Story 0 (breaks the cycle by construction) or merging the units.
2. Topologically sort `G`; compute the longest path = **critical path `CP`**.
3. Canonical shape: `CP = Story 0 → (any one parallel impl) → Story N+1 (integration)`. Story 0 and Story N+1 are the *only* mandatory serial nodes.

### Step 4 — Everything off the critical path is parallel (hard rule)

> **Hard rule.** If A and B have no path between them in `G` (neither `A →* B` nor `B →* A`), they MUST be scheduled concurrently — unless a recorded `serializeReason` (§1.2) justifies otherwise.
>
> **Rejection condition.** A decomposition that serializes a no-path pair **without** `serializeReason` is **INVALID** ⇒ reject and redo.

Validator the decomposer and the §4 gate must satisfy:
- For every no-path pair: assert not placed in the same serial slot unless `serializeReason` is set.
- The only reasons a story may sit *after* another: a must-finish-before path, or a named `serializeReason`.
- A flat list of N independent impls yields N concurrent slots, not a chain of length N.

### Step 5 — Bound parallel width to REVIEW bandwidth (advisory by design)

Let `W = maxConcurrentReview` (policy number; default 3). **This bound is advisory — the human owns review pacing** (§4.6 explains why it is not a hard block, and the one place it *could* become one).

1. The parallel impls form a wave of width `P`.
2. `P ≤ W`: dispatch all `P` concurrently. Wall-clock ≈ the **longest single story**, not the sum.
3. `P > W`: **queue the overflow** into `ceil(P / W)` sequential batches of up-to-`W` independent stories. The overflow stories stay `parallelSafe: 'yes'`; they are *rate-limited*, never re-serialized. **Never** convert a bandwidth-queued story into a `depends[]` edge or fold it into another — queueing is scheduling, serializing is decomposition; keep them separate.
4. Tie-break which independents fill the first `W` slots by `lane` rank (mainline → supporting → exploratory).
5. **Heterogeneous review sizes:** `W` is a slot count, blind to size. A single huge integration review can starve N tiny impl reviews. Treat `W` as a soft target and let the operator hold back a large review or admit an extra small one; this is a human pacing decision, consistent with the advisory framing.

### Pseudo-algorithm
```text
decompose(requirement, W = maxConcurrentReview):
  U ← enumerateWorkUnits(requirement)            # scope paths + produced/consumed interfaces
  contract ← unionOfSharedInterfaces(U)          # any iface consumed by ≥2 units
  if contract ≠ ∅:
      Story0 ← makeContractStory(contract)       # frozen signatures + skeletons + empty impl/barrel files (§3)
      rewire every u in U to consume Story0, not each other

  G ← emptyGraph(nodes = U ∪ {Story0})
  for each ordered pair (A,B) in U:
      overlap ← writePaths(A) ∩ writePaths(B) ≠ ∅
      logical ← (B.consumes ∩ A.produces ≠ ∅) and not coveredByContract(B.consumes, Story0)
      if overlap:  merge_or_contract_lift(A,B); continue   # NOT sharedHotspots
      if logical:  addEdge(A → B, justification = citedSymbol@A)
  addEdge(Story0 → u) for all u
  StoryN1 ← integrationStory(); addEdge(u → StoryN1) for all u

  assert isAcyclic(G)                            # else lift shared iface into Story0 / merge
  CP ← longestPath(topoSort(G))

  for each pair (A,B) with no path A↔B in G:     # independence invariant
      assert not serialized(A,B) OR hasSerializeReason(A,B)   # else INVALID

  wave ← nodesOffCriticalPath(G)
  batches ← chunkByLaneRank(wave, size = W)      # all parallelSafe='yes', rate-limited not serialized
  return Schedule(serialHead=Story0, parallelBatches=batches, serialTail=StoryN1, criticalPath=CP)
```

Accepted iff: `G` acyclic, independence invariant holds for every no-path pair (or `serializeReason` present), every serialized pair justified by path-or-reason, and every `depends` edge cites a real producer symbol. Else rejected.

> 注：先抽公共接口成 Story 0，再画依赖图；真实文件重叠必须"合并或上提到 Story 0"，绝不能塞进 sharedHotspots 假装并行；无路径又无 serializeReason 的串行=非法分解。

---

## 3. Contract-First Story Templates

Three archetypes. Story 0 and Story N+1 are **serial** (`lane: mainline`, `parallelSafe: no`); Stories 1..N are **parallel** (`lane: supporting`, `parallelSafe: yes`). Non-overlap is guaranteed *mechanically* by `scope_contract_set`'s `protectedFiles`/`explicitExcludes` — **not** by `scope_boundary_set`, which carries only the semantic `allowed/excluded` directions consumed by the INIT_CHECK anti-expansion gate. **Both commands are required per story; they write different artifacts.**

- `scope_boundary_set --storyId <id> --allowedScope <semantic dirs> --userConfirmed=true` → `ScopeBoundaryData.allowed/excluded` (INIT_CHECK boundary).
- `scope_contract_set --storyId <id> --mode=enforce --allowedModify … --allowedCreate … --allowedTest … --protectedFiles … --explicitExcludes …` → `ScopeContractData` (the post-diff scope gate; this is where the read-only-contract guarantee actually lives).

> **Array-flag syntax (load-bearing).** Every list-valued flag — `--allowedScope`, `--allowedModify`, `--allowedCreate`, `--allowedTest`, `--protectedFiles`, `--explicitExcludes` — takes a **single JSON-array string**, e.g. `--allowedModify '["a.ts","b.ts"]'`. The CLI's `parseFlags` consumes exactly one value per flag and JSON-parses any value beginning with `[`; **space-separated paths after one flag are silently dropped**, and `--protectedFiles ""` is the one-element array `[""]`, *not* empty — use `'[]'` for none. Every command example below follows this convention.

### 3.0 — The barrel/index ordering decision (load-bearing; read first)

A shared barrel (`index.ts` re-exporting every module) is a genuine overlap that would break parallelism if each impl had to add its own re-export. Resolution: **Story 0 creates ALL files** — `contract.ts`, `types.ts`, the barrel `index.ts` with re-exports already written, AND each `impl/<modK>.ts` as an **empty skeleton** (class declared, every method `throw NotImplemented`). Because the impl files already exist after Story 0:
- impl stories only **modify** their own pre-existing file; they never **create**, and never touch the barrel.
- the barrel can re-export real (skeleton) files at Story-0 time, so there is no chicken-and-egg.

This **amends the naive "Story 0 creates only contract.ts"** rule: Story 0 owns the barrel and the empty impl skeletons too.

### 3.1 — Story 0: the Contract (SERIAL, first)

**Produces:** the shared interface + skeletons + barrel + empty impl files. Signatures, not behavior. Kept small so REVIEW clears fast.

Contains: type/interface/DTO definitions; class names + fully-typed public method **signatures**; enums/constants/error types; skeleton bodies that compile but `throw new Error("NotImplemented: <Class>.<method>")`; the barrel re-exports; empty `impl/<modK>.ts` skeletons. No private helpers, no logic, no I/O.

**`story_create`:**
```
name: contract-<feature>
title: "Story 0 — Contract: <feature> interfaces, skeletons & barrel"
type: feature   priority: high          # priority=high ⇒ lane:mainline (DERIVED); parallelSafe:no is COMPUTED — neither is a story_create flag (see §5.1)
depends: []
# blockingFor (≈ impl-<mod1>…impl-<modN>, integration-<feature>) is DERIVED — no CLI setter; it is the converse of those stories' depends:[contract-<feature>]
keywords: [<feature>, contract, interface, skeleton]
```

**background.md (four sections):** Context — N modules built in parallel; the shared interface + skeleton impl files + barrel must exist and be frozen first. Goal — define every type/class/signature in `contract.ts`/`types.ts`, write `index.ts` re-exports, create empty `impl/<modK>.ts` skeletons that throw NotImplemented; everything compiles. Non-Goals — NO behavior, NO logic, NO I/O, NO impl of any module. Done When — files compile and type-check, every symbol Stories 1..N+1 import is exported, every method throws NotImplemented, CONTRACT-FREEZE in effect.

**checklist (shape):** declare types/DTOs; declare each `<ModKClass>` with signatures throwing NotImplemented; write barrel re-exports; create empty `impl/<modK>.ts` per module; compile/type-check; `CHK-FREEZE` (record exported symbol list in background.md).

**Persist to Lattice (two commands):**
```
scope_boundary_set --storyId contract-<feature> \
  --allowedScope "<feature> shared interface & skeletons" --userConfirmed=true

scope_contract_set --storyId contract-<feature> --mode=enforce \
  --allowedModify  '["src/<feature>/contract.ts","src/<feature>/types.ts","src/<feature>/index.ts","src/<feature>/impl/*.ts"]' \
  --allowedCreate  '["src/<feature>/contract.ts","src/<feature>/types.ts","src/<feature>/index.ts","src/<feature>/impl/*.ts"]' \
  --allowedTest    '["src/<feature>/contract.test.ts"]' \
  --protectedFiles '[]' \
  --explicitExcludes '["src/<feature>/integration/*"]'
```

**CONTRACT-FREEZE rule + ADDITIVE-amendment lane (the load-bearing invariant):**
> On Story 0 DONE, `contract.ts`/`types.ts`/`index.ts` are **frozen**. No impl story lists them under `allowedModify`/`allowedCreate`; they appear only under `protectedFiles`.
>
> **Two kinds of post-freeze change — budget for them differently:**
> 1. **ADDITIVE amendment (cheap, expected).** Appending a *new* optional type/method/overload — **no rename, no retype, no removal of an existing symbol** — does **not** invalidate in-flight impls (they don't import the new symbol yet). This is a small Story-0 patch that does **not** pause the wave. Interface growth during first implementation is the *norm*; budget for several additive amendments as normal, not as failure.
> 2. **BREAKING change (expensive, rare).** Rename / retype / remove an existing symbol forces every in-flight impl to re-sync ⇒ **pause the wave** until the contract re-freezes. This is the single most expensive failure in the pattern; spend disproportionate design effort up front (over-specify params, nail return types, enumerate error cases) to avoid it.
>
> Impl stories may **request** an additive amendment; they may **never** make a breaking change locally. The ROI of contract-first rests on keeping breaking changes near zero while treating additive ones as routine.

### 3.2 — Story 1..N: Parallel Implementation (one per module, concurrent)

Implements ONE module by filling its skeleton bodies, importing every shared symbol read-only from the frozen contract. Disjoint writable scope + read-only contract ⇒ zero file overlap ⇒ true parallelism.

**`story_create` (per module `<modK>`):**
```
name: impl-<modK>
title: "Story K — Implement <modK> against frozen contract"
type: feature   priority: medium        # priority=medium ⇒ lane:supporting (DERIVED); parallelSafe:yes is COMPUTED once contract-<feature> is DONE — neither is a flag (see §5.1)
depends: [contract-<feature>]        # justification: imports <Symbols> from contract-<feature>.allowedCreate
keywords: [<feature>, <modK>, impl]
# blockingFor (≈ integration-<feature>) and sharedHotspots ([], MUST stay empty) are DERIVED, not story_create flags — non-empty sharedHotspots ⇒ the split is wrong
```

**background.md:** Context — contract frozen (Story 0 DONE); implement ONLY `<ModKClass>` by filling its skeleton bodies; all shared symbols imported read-only. Goal — implement `<ModKClass>.<methods>` exactly matching frozen signatures; add unit tests in own test file. Non-Goals — do NOT edit `contract.ts`/`types.ts`/`index.ts` (FROZEN); do NOT touch any other module's file; do NOT write integration code; if a signature is wrong, STOP and request a Story-0 amendment (additive) or reopen (breaking) — never work around it locally. Done When — `<ModKClass>` fully implements its frozen signatures, no NotImplemented remains, unit tests pass, `git diff` of frozen files is empty.

**checklist (shape):** import shared types (read-only); implement each `<ModKClass>.<method>(<frozen params>) -> <frozen return>`; unit tests pass; `CHK-GUARD` verify `git diff src/<feature>/contract.ts src/<feature>/types.ts src/<feature>/index.ts` is EMPTY.

**Persist to Lattice:**
```
scope_boundary_set --storyId impl-<modK> --allowedScope "implement <modK> module only" --userConfirmed=true

scope_contract_set --storyId impl-<modK> --mode=enforce \
  --allowedModify  '["src/<feature>/impl/<modK>.ts"]' \
  --allowedCreate  '["src/<feature>/impl/<modK>.test.ts"]' \
  --allowedTest    '["src/<feature>/impl/<modK>.test.ts"]' \
  --protectedFiles '["src/<feature>/contract.ts","src/<feature>/types.ts","src/<feature>/index.ts"]' \
  --explicitExcludes '["src/<feature>/integration/*"]'
```
Note `<modK>.ts` is **modify-only** (Story 0 already created it); the impl story creates only its own test file. Other modules' files are excluded *by omission* from `allowedModify` and enforced by the disjointness of the static check (§4.2); the runtime probe is the backstop.

**Non-overlap (mechanical):** for any two impls K≠J, `allowedModify(K) ∩ allowedModify(J) = ∅`; both list the frozen files only under `protectedFiles`. The **static** glob-disjointness check (§4.2) is what *predicts* safety at PLAN; `actualFileOverlapsByStory()` is only the **post-DEV detective backstop** that catches a story which declared narrow but wrote wide. The split is statically provable from declared scope; the runtime probe confirms after the fact.

### 3.3 — Story N+1: Integration (SERIAL, last)

Wires the real modules together; owns end-to-end tests. Cannot start until all of 1..N are DONE.

**`story_create`:**
```
name: integration-<feature>
title: "Story N+1 — Integrate & integration-test <feature>"
type: feature   priority: high          # priority=high ⇒ lane:mainline (DERIVED); parallelSafe:no is COMPUTED while impls active — neither is a flag (see §5.1)
depends: [impl-<mod1>, …, impl-<modN>]   # justification: composes real impls of each module
# blockingFor: [] — DERIVED (nothing depends on integration); not a story_create flag
keywords: [<feature>, integration, wiring, e2e]
```

**background.md:** Context — all impls DONE. Goal — implement the integration surface (orchestrator/registry skeleton from contract), wire `<mod1>..<modN>`, add integration/e2e tests against real behavior. Non-Goals — do NOT change any module's internals (reopens a DONE story); do NOT make a breaking contract change — if integration reveals a real gap, that is a Story-0 amendment event (additive if possible), not a local patch. Done When — orchestrator wires all N modules, integration/e2e tests pass against real impls, feature works through its public entry point.

**checklist (shape):** implement orchestrator/registry wiring; DI the real impls; integration tests per cross-module scenario; e2e through public entry point; `CHK-GUARD` contract/barrel unchanged.

**Persist to Lattice:**
```
scope_boundary_set --storyId integration-<feature> --allowedScope "wire & e2e-test <feature>" --userConfirmed=true

scope_contract_set --storyId integration-<feature> --mode=enforce \
  --allowedModify  '["src/<feature>/integration/*"]' \
  --allowedCreate  '["src/<feature>/integration/*","src/<feature>/integration.e2e.test.ts"]' \
  --allowedTest    '["src/<feature>/integration.e2e.test.ts"]' \
  --protectedFiles '["src/<feature>/contract.ts","src/<feature>/types.ts","src/<feature>/index.ts","src/<feature>/impl/*.ts"]' \
  --explicitExcludes '[]'
```
Note the barrel `index.ts` is **protected** here too — it was finalized by Story 0; integration imports through it but does not edit it. If the public entry point genuinely needs a new export, that is an additive Story-0 amendment.

### 3.4 — Scope non-overlap matrix

| File / path | Story 0 | Story K (impl) | Story N+1 |
|---|---|---|---|
| `contract.ts`, `types.ts` | **write** (owner) | read-only (`protected`) | read-only (`protected`) |
| `index.ts` (barrel) | **write** (owner) | read-only (`protected`) | read-only (`protected`) |
| `impl/<modK>.ts` | **create** (empty skeleton) | **modify** (owner, unique K) | read-only (`protected`) |
| `impl/<modK>.test.ts` | — | **create** (owner, unique K) | read-only (`protected`) |
| `integration/*`, `integration.e2e.test.ts` | excluded | excluded | **write** (owner) |

Every column's **write** set is pairwise disjoint. Story 0 *creates* the impl skeletons; impl stories only *modify* their own one. The barrel is written exactly once (Story 0) and read-only everywhere else, resolving the re-export ordering paradox.

> 注：每个故事都要跑两条命令——`scope_boundary_set`（语义边界，给 INIT_CHECK）和 `scope_contract_set`（文件级 protectedFiles/excludes，真正保证冻结只读）；Story 0 还要顺手建好空的 impl 骨架和 barrel，impl 故事只改自己那一个文件。additive 改接口不暂停 wave，breaking 改才暂停。

---

## 4. Enforcement: How It Becomes MANDATORY in Lattice

The rule is inert unless Lattice refuses to let an operator serialize provably-parallel work or assert provably-false parallelism. The gate models Lattice's two existing archetypes: the **additive non-blocking advisory** (`audit-trigger.ts` → `deprecatedGcThreshold`, emitted as a `hint`) and the **hard fail-closed predicate**.

### 4.1 The two behaviors

| Behavior | Trigger | Where | Effect |
|---|---|---|---|
| **ADVISE** | a wave *looks* serializable but is decomposable; globs too broad to prove independence; `W` exceeded | `hint` from `story_review` (PLAN) and `parallel_report` | non-blocking, appended like the `deprecatedGcThreshold` advisory |
| **BLOCK** | a *provable contradiction* between declared intent and declared scope (§4.3) | XState guard `canStartDevGuard` (PLAN→DEV) | fail-closed; the actor cannot enter DEV |

Asymmetry is deliberate: we never hard-block on "you *should* have parallelized" (a judgment); we hard-block only when the operator *asserted* parallelism that is mechanically false.

### 4.2 Detection logic — static glob overlap (honest about the engine)

There is **no minimatch/micromatch/picomatch dependency in the project.** The existing matcher `pathMatchesPattern` (`core/scope-contract.ts`) is hand-rolled: it matches a **concrete path against a pattern** via exact-match, directory-prefix, trailing `/*` or `/**` strip, and `*.ext` suffix. **It cannot do pattern-vs-pattern subsumption** — the thing overlap detection actually needs. Pattern-intersection is genuinely hard and is **not** "reused from existing code."

Therefore the static check is deliberately **conservative**, in two tiers:
1. **Literal-path intersection** — normalize both write-sets, set-intersect exact paths. Cheap, zero false positives. This alone catches the common case where two impls name the same file.
2. **Shared-directory-prefix heuristic** — if two write-sets share a directory prefix and at least one side uses a trailing wildcard (`dir/*`, `dir/**`), flag as *possible* overlap (conservative: may over-flag, never under-flags within the prefix).

**Supported glob grammar (the spec defines it, because the engine is weaker than POSIX/minimatch):** a write-set entry is one of — (a) a literal path, (b) `dir/*` (direct children), or (c) `dir/**` (subtree). **Mid-path `**` (`src/**/*.ts`) and bare top-level `*` are NOT supported** and MUST be rejected/normalized at `scope_contract_set` time, because `pathMatchesPattern` would mis-handle them. This keeps the broadness classifier reasoning about patterns the engine actually matches.

**Broadness classifier (over this grammar):**
- **NARROW** = a literal path, or `dir/*`/`dir/**` where `dir` is below the package root (e.g. `src/<feature>/impl/*`).
- **BROAD** = `dir/**` at or near the repo/package root, or a `dir` spanning more than one second-level directory.

Policy:
- Both NARROW + non-intersecting (tier 1 & 2 clean) → independence provable → allow parallel, no advisory.
- Either BROAD **while** `parallelSafe: 'yes'` → independence NOT provable → **BLOCK** `broad_glob_unprovable_parallel` when `cfg.broadGlobBlocks` (strict profile); otherwise **ADVISE** (narrow the contract).
- BROAD without a parallel assertion → ADVISE only.

**Pattern subsumption beyond this grammar is unimplemented and we say so.** Anything the static tiers cannot prove falls through to the runtime `actualFileOverlapsByStory()` probe at REVIEW/wave time (post-DEV). The static check predicts the common cases; the runtime probe is the backstop for the rest.

### 4.3 BLOCK conditions (provable contradictions only)

Evaluated against all **active** peers (reusing the `terminalPhases = {DONE, DISCARDED}` filter from `parallel-policy.ts`):

1. **`overlap_declared_parallel`** — S asserts parallel AND **tier-1 literal-path intersection** (the zero-false-positive tier from §4.2) with an active peer P also asserting parallel. Names the colliding path pair and peer storyId. *Pure scope fact — safe to hard-block.* (A tier-2 shared-prefix match may over-flag, so it is emitted as an **advisory**, never this hard block.)
2. **`broad_glob_unprovable_parallel`** — S asserts parallel but its write-set contains a BROAD glob. *Pure scope fact, but config-gated (the enforcement path for `broadGlobBlocks`, §4.7):* the gate returns this as a hard block **only when `cfg.broadGlobBlocks` is true** (the `strict` profile); under `light`/`balanced` (`broadGlobBlocks: false`) the same broad glob is emitted as an **advisory**, never a hard block.
3. **`fake_dependency_chain`** — S declares `depends: [P]` whose cited symbol (§1.3) is **absent** from P's `allowedCreate` contract surface, AND S does not overlap P. This catches a fabricated dependency citing a non-existent symbol. *Fires as a hard block only when the cited symbol is provably absent;* a plausible-but-false citation to a real symbol degrades to ADVISE (semantics undecidable — §1.3 residual).

Conditions 1–2 are facts. Condition 3 is a hard block only on the *falsifiable* sub-case (cited symbol does not exist).

### 4.4 Where it attaches — TWO coordinated edits (not one)

The critical correction: **`getGuardFailureReason` is NOT the decision oracle.** `transition-orchestrator.ts:156` warns explicitly: *"Do not use getGuardFailureReason as a decision oracle: it renders human hints and can intentionally fall through to null after config/read failures."* The real PLAN→DEV decision is the XState predicate **`canStartDevGuard`** (`machine.ts`), wired as guard `canStartDev` on the PLAN→DEV transition and consulted via `actor.can()`. Returning a reason from `getGuardFailureReason` would be a **no-op block**.

So enforcement requires **two coordinated edits sharing one predicate** (the established `canEnterInitCheckGuard` + `getGuardFailureReason` pattern):
1. **DECISION — `canStartDevGuard` (`machine.ts`).** After the existing review-blocker check, call `evaluateDecompositionGate(story, peers, contracts, cfg)` where `cfg = resolveAuditConfig(...).parallelGate` (a `ParallelGateConfig`). If it returns a non-null `block` AND `cfg.mode === 'block'`, return `false`. This is what actually aborts the transition through `actor.can()`. Wrap this additive check in its own try/catch returning `true` (**fail-open**, §4.8) — deliberately the *opposite* of the surrounding guard's fail-closed `catch { return false }`, so that a config/read error in the new gate never DoSes an otherwise-legitimate transition. (The guard stays fail-closed overall; only this added sub-check fails open.)
2. **MESSAGE — `getGuardFailureReason` (`machine.ts`, DEV branch).** Add the matching human-readable branch so the rejection is *explained*. This renders the reason; it does not decide.

Both call the **same** `evaluateDecompositionGate` so decision and message never diverge.

**Detector module — new file** `packages/main/src/core/parallel-decomposition.ts` (pure functions, like `parallel-policy.ts`):
- `computeWriteSet(contract: ScopeContractData): string[]`
- `globsOverlap(a: string[], b: string[]): { overlap: boolean; pairs: [string,string][]; broadSide: 'a' | 'b' | 'both' | null }` — `broadSide` names *which* operand carried the broad glob, so the §4.3 `broad_glob_unprovable_parallel` block message can cite the offending story (tiers from §4.2)
- `evaluateDecompositionGate(story: StoryInfo, peers: StoryInfo[], contracts: Map<string, ScopeContractData>, cfg: ParallelGateConfig): { advisories: string[]; block: string | null }`

Because `canStartDevGuard(context)` receives only the machine context, the guard must first load the active `peers` (the same `terminalPhases`-filtered set `summarizeParallelPolicy` uses) and their `ScopeContractData` into `contracts`, then pass both in — the gate function itself stays pure.

**ADVISE injections (non-blocking):**
3. **`handlers/story-review.ts`** — call `evaluateDecompositionGate` before the scope-check block; push `advisories[]` as severity `advisory`. These do NOT raise `blockerCount`, so they never affect the signed `review.json`.
4. **`core/lattice-parallel-wave.ts`** — the private (non-exported) `resolveWaveSafety` here in `core/`, **not** `handlers/`, gains a `scope_glob_overlap` degradation kind, populated from `globsOverlap`, so the operator sees the overlap fact in the wave projection *before* hitting the PLAN→DEV block.

### 4.5 The one new schema field — placement corrected

Reuse `StoryInfo.depends` (already the directed edge, already read by `resolveParallelSafety`). A discriminator distinguishing a *contract* edge (impl → Story 0) from an *integration* edge (Story N+1 → impl) is **probably unnecessary for scheduling** — both are just must-finish-before and `resolveParallelSafety` treats them identically. **Recommendation: add no new field.** If a discriminator is later proven necessary, it MUST be **colocated with `depends`** (where `resolveParallelSafety` reads), e.g. model `depends` as `Array<{storyId: string; kind?: 'contract'|'integration'; citedSymbol?: string}>` or add a parallel `StoryInfo.dependsMeta` map — **never** on `ScopeContractData`, which describes file permissions, lacks the edge, and is a second artifact read away from the policy code (and absent for legacy stories). The §1.3 `citedSymbol` justification, if persisted, lives here too.

### 4.6 Review-bandwidth bound — advisory by design (and the only real enforcement seam)

`W = maxConcurrentReview` is **advisory**: `story_review` emits "wave parallel degree N exceeds review bandwidth M — split into ceil(N/M) batches" as a `hint`, never a block. The bottleneck is the human and the human decides pacing. We do **not** claim a phantom enforced bound.

**If hard enforcement is ever wanted**, the only honest seam is the **owner-lease grant** (`story-owner-lease.ts`, `acquireOwnerLease`): refuse to grant a new lease / refuse to move a story into REVIEW when `W` stories already hold an active (non-`DONE`) in-REVIEW lease. That is a real function that could count concurrent in-REVIEW leases. This spec leaves it **advisory** unless a project opts into a future `parallelGate.enforceReviewCap` flag, and labels it as not-yet-implemented rather than pretending `parallel_dispatch` already enforces it.

### 4.7 Config block — separate validation set (not AuditMode reuse)

The real `AuditMode` is `{semi-auto, full-auto, off}` with invalid-fallback `semi-auto`. Its *meaningful* values `{semi-auto, full-auto}` are disjoint from the values this gate needs `{advise, block}` — the two only overlap on the shared `off` escape hatch — and `VALID_MODES` is typed to `ReadonlySet<AuditMode>`, so it cannot be reused to validate `{advise, block, off}`. So we define a **new** set, following the same *shape* (not reusing `VALID_MODES`):

```ts
// core/audit-config.ts — extend AuditConfig
parallelGate: {
  mode: 'advise' | 'block' | 'off';   // NEW set; invalid → console.warn + fallback 'advise'
  maxConcurrentReview: number;        // positive-int guard (copied from deprecatedGcThreshold); default 3
  broadGlobBlocks: boolean;           // gates §4.3 cond.2: true → broad glob is a hard block; false → advisory only. strict → true; default false
};
// VALID_PARALLEL_MODES = new Set(['advise','block','off']);  PARALLEL_MODE_FALLBACK = 'advise';
```
- `mode` validated against `VALID_PARALLEL_MODES` (same *structure* as `VALID_MODES`, different values); invalid → `console.warn` + `'advise'`.
- `maxConcurrentReview` must be a **positive integer** (`Number.isInteger(n) && n > 0`, the same guard as `deprecatedGcThreshold`/`auditTriggerWindow`); a present-but-invalid value (including a float, `0`, a negative, `Infinity`/`NaN`, or a non-number) warns and falls back to the profile default.
- **Nested-object validation:** unlike the existing *flat scalar* fields (`auditTriggerWindow`, `deprecatedGcThreshold`), `parallelGate` is a nested object, and the per-scalar `readUserConfig` path does not recurse into it. `resolveAuditConfig` therefore delegates to a dedicated `resolveParallelGate(raw: unknown, profileDefault: ParallelGateConfig): ParallelGateConfig` helper (Story 3 / OQ-001: the profile default is passed explicitly as a second argument so the helper stays pure and decoupled from the per-profile table) that reads the nested object and applies each sub-field's guard+fallback individually. A **present-but-invalid** sub-field (wrong type *or* unknown value — e.g. `mode: 123`) warns and falls back (`mode` → `advise`, the others → their profile default), while an **absent** key keeps the profile default; a missing or non-object `raw` yields all profile defaults. Copying the flat pattern verbatim would silently skip every nested check. Presence is tested with `Object.hasOwn` (own keys only): an inherited / prototype-shaped sub-field is treated as **absent** so it can never silently promote a default to `block`, and a JSON `__proto__` key never pollutes `Object.prototype`. The warn path is **non-throwing**: invalid values are rendered through a `bigint`/circular/throwing-`toJSON`-safe formatter, so an exotic config value still warn+falls-back rather than crashing the gate.
- `mode: 'off'` disables both behaviors — the same reversible escape hatch every Lattice gate provides.

Resolution priority inherited from `resolveAuditConfig`: (1) per-field override in `.lattice/audit-config.json`, (2) profile defaults, (3) hardcoded fallback.

| profile | `mode` | `maxConcurrentReview` | `broadGlobBlocks` |
|---|---|---|---|
| `light` | `advise` | 2 | false |
| `balanced` | `advise` | 3 | false |
| `strict` | `block` | 4 | true |

### 4.8 Failure-mode guardrails (and the fail-open/fail-closed asymmetry corrected)

- **Config-load failure ⇒ fail-OPEN (allow).** Any throw in `evaluateDecompositionGate` or config resolution → treat as `mode: 'off'`, allow the transition. A scope analyzer must never DoS legitimate transitions.
- **"Cannot read MY OWN contract" ⇒ fail-OPEN.** If S's own scope contract is unreadable, allow (can't fairly block a story on its own unreadable data).
- **"Cannot read a PEER's contract" ⇒ fail-CLOSED toward refusing the *parallel assertion* — NOT silently allow.** The original draft's "unreadable peer ⇒ overlap unprovable ⇒ ADVISE" is a **bypass**: an operator could make one peer contract unreadable to dodge `overlap_declared_parallel`. Corrected behavior: an unreadable peer means independence is **unprovable**, so a `parallelSafe: 'yes'` assertion **cannot be honored** — emit a high-severity advisory and return `peer_contract_unreadable_parallel` as the block reason, which §4.4's caller enforces only under `mode: 'block'` (remediation: repair the peer contract). The gate stays pure — it computes the block reason from scope facts; the `mode` check lives solely in the §4.4 caller, never inside the gate. This closes the corrupt-peer bypass while still failing open on the gate's *own* infrastructure errors.
- **No active peers ⇒ no-op.** A lone story is trivially parallel-safe (mirrors `summarizeParallelPolicy`).
- **Block reasons are actionable** — every block string names the colliding storyId, the specific path/glob pair, and the exact remediation command (`scope_contract_set` to narrow `allowedModify`, or `story_create` to split a fake `depends` chain), matching the INIT_CHECK/review remediation convention.

> 注：强制门必须挂在真正的判定谓词 `canStartDevGuard`（不是只渲染文案的 `getGuardFailureReason`），需要两处协同改动共用一个谓词；静态只能做"字面路径相交+目录前缀"两层保守检查（项目里根本没有 minimatch，pattern-vs-pattern 不可实现），其余落到运行期探针兜底；读不到"对端"合约要 fail-closed 拒绝并行断言，否则能被一个坏合约绕过。

---

## 5. Reusable Prompt Templates

Copy-paste into a decomposer/author agent. They are **pipeline-contained, not individually self-contained**: D.1's output is the required input to D.2–D.4. Each prompt ends with a **"Persist to Lattice"** epilogue naming the exact command and which fields go to `scope_boundary_set` vs `scope_contract_set` vs `story_create`. The "self-check" steps are **textual assertions, not Lattice gates** (the real gate is the reviewer's `scope_check_save` + the §4 gate).

### 5.1 — Decomposer meta-prompt
````text
You are the LATTICE CONTRACT-FIRST DECOMPOSER. Turn ONE raw requirement into a
contract-first parallel story plan that MAXIMIZES parallel development.

## Hard rules (non-negotiable)
1. PARALLELISM IS DEFAULT. If two stories are INDEPENDENT you MUST schedule them
   concurrently. Serializing independent stories is REJECTED unless you record an
   explicit `serializeReason` (allowed reasons: shared scarce reviewer, risk
   staging, learn-from-A-before-B, external resource contention). No reason ⇒ reject.
2. INDEPENDENCE TEST — A and B independent IFF BOTH:
   (a) FILE DISJOINT: write-scope paths do not overlap, AND
   (b) LOGICALLY INDEPENDENT: B does not need A's runtime output/behavior to be
       designed/implemented (importing A's TYPE from the frozen contract does NOT count).
   If either fails: file overlap ⇒ MERGE the units or LIFT the shared file into
   Story 0 (never park it in sharedHotspots); logical need ⇒ add a `depends` edge.
3. EVERY `depends` edge MUST cite: the consumed SYMBOL and the PRODUCING story, and
   that symbol must be in the producer's allowedCreate contract surface. Uncited or
   uncitable edge = illegal ⇒ delete it and parallelize.
4. CONTRACT-FIRST SHAPE:
   - Story 0 (SERIAL, FIRST, lane=mainline, parallelSafe=no): the CONTRACT. Writes
     contract.ts/types.ts (types, class names, signatures, skeleton bodies that
     throw NotImplemented), the barrel index.ts (re-exports), AND empty impl/<mod>.ts
     skeleton files for every module. No real logic.
   - Story 1..N (PARALLEL, lane=supporting, parallelSafe=yes): each implements ONE
     module by MODIFYING its own pre-created impl file, importing the frozen contract
     read-only. Contract+types+barrel go under protectedFiles. allowedModify sets are
     pairwise DISJOINT. depends:["S0"] with citation.
   - Story N+1 (SERIAL, LAST, lane=mainline, parallelSafe=no): INTEGRATION + e2e.
     depends on ALL of S1..SN. Wires modules; owns integration/* and e2e tests.
5. CONTRACT FREEZE: after S0 DONE, contract/types/barrel are frozen. ADDITIVE
   amendments (new optional symbol, no rename/retype/remove) are cheap and do NOT
   pause the wave; BREAKING changes pause it. Impl stories never edit the contract.
6. Cap simultaneously-ACTIVE parallel stories at {{MAX_PARALLEL_REVIEWS}} by QUEUEING
   overflow into waves (still parallelSafe=yes, never re-serialized). Queueing is
   scheduling, not a depends edge.

## Input
RAW REQUIREMENT: {{RAW_REQUIREMENT}}
TARGET REPO / LANGUAGE: {{REPO_AND_LANG}}
KEY EXISTING FILES: {{KEY_EXISTING_FILES_OR_NONE}}
MAX CONCURRENT REVIEWS: {{MAX_PARALLEL_REVIEWS}}

## Required output (exact order)
A. Candidate stories (id, one-line goal, lane, the ONE module it owns; S0=contract, last=integration).
B. Dependency graph: adjacency list X -> [deps], one-line justification per edge
   citing which half forced it (file-overlap OR named symbol@producer). Uncitable ⇒ delete.
C. Critical path: longest chain (S0 -> longest single impl -> integration).
   wall-clock = time(S0)+max(time(Si))+time(integration); contrast with serial sum.
D. Contract (S0): file paths, every type/interface/class name and signature each
   module imports, the barrel re-export list, and the empty impl/<mod>.ts file list.
E. Parallel impls (S1..SN): per story — storyId, title, the ONE module, depends:["S0"]+citation,
   lane=supporting, parallelSafe=yes, allowedModify (own impl file, MODIFY), allowedCreate
   (own test only), allowedTest, protectedFiles=[contract,types,barrel],
   explicitExcludes=[integration/*], sharedHotspots=[] (MUST). Then a disjointness matrix.
F. Integration (SN+1): storyId, depends:[all impls], lane=mainline, scope for integration/*
   + e2e, modules composed.
G. Self-audit (REJECT gate), YES/NO + justification:
   - Any two independent stories serialized WITHOUT a serializeReason? (must be NO)
   - Any impl story lists contract/types/barrel under allowedModify? (must be NO)
   - Any two impls share an allowedModify path? (must be NO)
   - Any sharedHotspots non-empty? (must be NO)
   - Any depends edge missing a symbol@producer citation? (must be NO)
   If any is wrong, STOP, redraw, re-emit.

## Persist to Lattice (for each story your plan emits)
- story_create  → name,title,description,type,priority,depends,keywords,checklist,background
  (NOTE: `lane`, `parallelSafe`, `blockingFor`, `sharedHotspots` are **NOT** `story_create` flags — they are DERIVED, not set:
   `lane` ← `priority` via `resolveStoryLane` (critical/high→mainline, medium→supporting, low/else→exploratory) — choose `priority` to get the lane you want;
   `parallelSafe` ← computed by `resolveParallelSafety` from `depends`/`blockingFor`/`sharedHotspots` — never set directly;
   `blockingFor` has no CLI setter — it is the converse of another story's `depends`; `sharedHotspots` defaults to `[]`. Passing `--lane`/`--parallelSafe`/`--blockingFor` to `story_create` is silently discarded.)
- scope_boundary_set --storyId <id> --allowedScope "<semantic direction>" --userConfirmed=true   (INIT_CHECK boundary)
- scope_contract_set --storyId <id> --mode=enforce --allowedModify … --allowedCreate … --allowedTest …
                     --protectedFiles … --explicitExcludes …                (file-level scope gate)
Glob grammar allowed: literal path, dir/*, dir/**. NO mid-path ** and NO bare top-level *.
````

### 5.2 — Contract-Author prompt (Story 0)
````text
You are authoring STORY 0 — THE CONTRACT. Serial, runs FIRST. Every parallel story
imports what you write and is FORBIDDEN from editing it. Get the surface right.

## Absolute constraints
1. SIGNATURES + SKELETONS ONLY. No real logic. Every method body:
   throw new Error("NotImplemented: <Class>.<method>")  (or the {{LANG}} idiom).
2. Define EVERY symbol the parallel modules import: types, interfaces, enums, class
   names, public signatures, error types, the public export list. Missing symbol ⇒
   incomplete contract ⇒ add it now.
3. ALSO produce: the barrel {{BARREL_FILE}} (re-exporting every module) and an EMPTY
   skeleton file impl/<mod>.ts for EACH module (class declared, methods throw
   NotImplemented). Impl stories will only MODIFY these, never create them.
4. Files you write: {{CONTRACT_FILE_PATHS}}, {{BARREL_FILE}}, {{IMPL_SKELETON_PATHS}}. Nothing else.
5. FROZEN after DONE. Design so each module builds WITHOUT changing it. Prefer
   dependency-by-interface. Over-specify params, nail return types, enumerate errors.

## Inputs
CONTRACT FILE(S): {{CONTRACT_FILE_PATHS}}    BARREL: {{BARREL_FILE}}
IMPL SKELETON FILES: {{IMPL_SKELETON_PATHS}}    LANGUAGE: {{LANG}}
MODULES + RESPONSIBILITIES: {{MODULE_LIST_WITH_RESPONSIBILITIES}}
SHARED TYPES / DOMAIN OBJECTS: {{SHARED_TYPES_OR_INFER}}

## Output
1. Full contents of each contract file, the barrel, and each empty impl skeleton.
2. IMPORT MAP table: for each module, the exact symbols it imports from the contract.
3. FREEZE CHECKLIST: (a) no business logic, (b) every skeleton throws, (c) every
   downstream module's needs covered by an exported symbol, (d) barrel re-exports all impls.

## Persist to Lattice
scope_contract_set --storyId {{S0_ID}} --mode=enforce \
  --allowedModify {{S0_WRITESET_JSON}} \
  --allowedCreate {{S0_WRITESET_JSON}} \
  --protectedFiles '[]' --explicitExcludes '["src/{{FEATURE}}/integration/*"]'
# {{S0_WRITESET_JSON}} = one JSON array of contract file(s) + barrel + impl skeletons,
#   e.g. '["src/<f>/contract.ts","src/<f>/types.ts","src/<f>/index.ts","src/<f>/impl/*.ts"]'
Do not write behavioral tests — compile/type check only.
````

### 5.3 — Parallel-Impl prompt (Story 1..N)
````text
You are implementing ONE module: STORY {{STORY_ID}}. N-1 siblings run AT THE SAME
TIME against the SAME frozen contract. Conflict-free ONLY if you stay in scope.

## Absolute constraints
1. CONTRACT FROZEN. You may IMPORT from {{CONTRACT_FILE_PATHS}}/{{BARREL_FILE}} but
   MUST NOT modify them (they are in protectedFiles). If a symbol is missing/wrong:
   STOP, do not edit, request a Story-0 amendment (additive if possible). Editing
   the contract here corrupts all siblings.
2. IMPLEMENT EXACTLY ONE MODULE: {{MODULE_NAME}} — {{MODULE_RESPONSIBILITY}}, by
   MODIFYING the pre-existing skeleton {{IMPL_FILE}}. Do not touch any sibling module.
3. STAY IN SCOPE:
   - modify: {{IMPL_FILE}}    create: {{TEST_FILE}}    tests under: {{ALLOWED_TEST_GLOBS}}
   - NEVER touch {{EXPLICIT_EXCLUDES}} or anything in protectedFiles.
4. Depend only on the contract's PUBLIC interface; call siblings THROUGH the contract,
   never reach into their files (which may still be skeletons).
5. Your module compiles and its OWN unit tests pass in isolation with siblings
   still unimplemented (their skeletons still throwing is fine).

## Inputs
STORY ID: {{STORY_ID}}    CONTRACT (protected): {{CONTRACT_FILE_PATHS}}, {{BARREL_FILE}}
SYMBOLS YOU IMPORT: {{IMPORT_MAP_FOR_THIS_MODULE}}
SCOPE: allowedModify={{IMPL_FILE}} allowedCreate={{TEST_FILE}}
       protectedFiles={{CONTRACT_FILE_PATHS}},{{BARREL_FILE}} explicitExcludes={{EXPLICIT_EXCLUDES}}

## Output
1. The implementation in {{IMPL_FILE}} (fill the skeleton), importing only from the contract.
2. Unit tests in {{TEST_FILE}} passing against the frozen contract with siblings unimplemented.
3. SCOPE SELF-CHECK (textual assertion, NOT a Lattice gate): list every file you
   created/modified; assert each matches allowedModify/allowedCreate/allowedTest and
   none match protectedFiles/explicitExcludes. Out-of-scope ⇒ revert and report a blocker.

## Persist to Lattice
scope_contract_set --storyId {{STORY_ID}} --mode=enforce \
  --allowedModify {{IMPL_FILE_JSON}} --allowedCreate {{TEST_FILE_JSON}} --allowedTest {{ALLOWED_TEST_GLOBS_JSON}} \
  --protectedFiles {{CONTRACT_AND_BARREL_JSON}} --explicitExcludes {{EXPLICIT_EXCLUDES_JSON}}
# every {{..._JSON}} placeholder is a single JSON array string, e.g. '["src/<f>/impl/parser.ts"]'
(The real scope enforcement is the reviewer's scope_check_save + the PLAN→DEV gate, not this self-check.)
````

### 5.4 — Integration prompt (Story N+1)
````text
You are STORY {{INTEGRATION_STORY_ID}} — INTEGRATION. Serial, runs LAST. ASSUME all
impl stories {{IMPL_STORY_IDS}} are DONE/merged: every module is real now.

## Constraints
1. Compose modules ONLY through the contract's public interface ({{CONTRACT_FILE_PATHS}},
   {{BARREL_FILE}}) — both are protected/read-only here. If integration reveals a real
   interface gap, that is a Story-0 AMENDMENT event (additive if possible), NOT a local
   edit. Do not modify the contract or barrel here.
2. Do NOT rewrite any DONE module's internals; file a blocker against that module's
   story unless the fix is purely at the wiring layer.
3. STAY IN SCOPE: modify {{INTEGRATION_ALLOWED_MODIFY}} (integration/*, wiring/DI),
   create {{INTEGRATION_ALLOWED_CREATE}}, tests {{INTEGRATION_ALLOWED_TEST}} (integration/e2e).

## Inputs
MODULES TO COMPOSE (all DONE): {{MODULE_LIST}}
CONTRACT/BARREL: {{CONTRACT_FILE_PATHS}}, {{BARREL_FILE}}
ENTRYPOINT/WIRING FILE(S): {{ENTRYPOINT_FILES}}    E2E BEHAVIORS: {{ACCEPTANCE_SCENARIOS}}

## Output
1. Wiring/entrypoint code instantiating and connecting every module via the contract.
2. INTEGRATION/E2E tests in {{INTEGRATION_ALLOWED_TEST}} exercising {{ACCEPTANCE_SCENARIOS}}
   against real implementations — no skeletons, no mocks of sibling modules.
3. INTEGRATION REPORT: modules composed, each scenario pass/fail, and — if you had to
   request a contract amendment — exactly what and why (feedback for next decomposition).

## Persist to Lattice
scope_contract_set --storyId {{INTEGRATION_STORY_ID}} --mode=enforce \
  --allowedModify {{INTEGRATION_ALLOWED_MODIFY_JSON}} --allowedCreate {{INTEGRATION_ALLOWED_CREATE_JSON}} \
  --allowedTest {{INTEGRATION_ALLOWED_TEST_JSON}} \
  --protectedFiles {{INTEGRATION_PROTECTED_JSON}}
# every {{..._JSON}} placeholder is a single JSON array string, e.g. '["src/<f>/integration/*"]'
# {{INTEGRATION_PROTECTED_JSON}} = one JSON array of contract file(s) + barrel + "src/{{FEATURE}}/impl/*.ts"
````

> 注：四个 prompt 是"流水线相连"而非各自独立——D.1 的输出喂给 D.2–D.4；每个都带"Persist to Lattice"说明哪些字段进 `story_create`、哪些进 `scope_boundary_set`、哪些进 `scope_contract_set`；prompt 里的 self-check 只是文字断言，真正的门是 reviewer 的 `scope_check_save` 加 §4 的 PLAN→DEV gate。

---

## 6. Worked Example — CSV Export Feature

**Requirement:** "Add a CSV export feature: parse incoming records, format them into CSV rows (quoting/escaping), write the result to a stream/file. Unit-test each piece and add an end-to-end export test."

**Step 1 — units & scope:** A = parsing (`src/csv/impl/parser.ts`), B = formatting (`src/csv/impl/formatter.ts`), C = writing (`src/csv/impl/writer.ts`); shared types `CsvRecord/CsvField/Parser/Formatter/Writer/ExportOptions` (`src/csv/contract.ts`); barrel (`src/csv/index.ts`); wiring + e2e (`src/csv/integration/export.ts`, `src/csv/integration.e2e.test.ts`).

**Step 2 — independence (pairwise):**

| Pair | File overlap? | Logical dep? | Independent? |
|---|---|---|---|
| A ↔ B | none (`parser.ts` vs `formatter.ts`) | B imports `CsvRecord` *type* from contract, not A's output | yes |
| A ↔ C | none (`parser.ts` vs `writer.ts`) | C imports `CsvField`/`string` *type*, not A's output | yes |
| B ↔ C | none (`formatter.ts` vs `writer.ts`) | both import only contract types | yes |

All pass because the only shared file is `contract.ts` (+ barrel), and **none modify it**.

**Step 3 — Story 0 (SERIAL, first)** writes `contract.ts`, the barrel `index.ts`, and **empty** `impl/parser.ts`, `impl/formatter.ts`, `impl/writer.ts` skeletons:
```ts
// src/csv/contract.ts — owned by Story 0, READ-ONLY for all others
export interface CsvRecord { fields: Record<string, string>; }
export type CsvField = string;
export interface ExportOptions { delimiter: string; quote: string; eol: string; }
export interface Parser    { parse(raw: string): CsvRecord[]; }
export interface Formatter {
  formatField(value: string, opts: ExportOptions): CsvField;
  formatRow(record: CsvRecord, columns: string[], opts: ExportOptions): string;
}
export interface Writer    { write(rows: Iterable<string>, sink: NodeJS.WritableStream): Promise<void>; }
// each impl/<mod>.ts: class declared, methods throw new Error("NotImplemented: …")
// src/csv/index.ts: re-exports CsvParser, CsvFormatter, CsvWriter from ./impl/*
```
`scope_contract_set --storyId contract-csv --mode=enforce --allowedModify '["src/csv/contract.ts","src/csv/index.ts","src/csv/impl/*.ts"]' --allowedCreate '["src/csv/contract.ts","src/csv/index.ts","src/csv/impl/*.ts"]' --protectedFiles '[]' --explicitExcludes '["src/csv/integration/*"]'`

**Step 4 — dependency graph:**
```
                ┌─────────────────────────────┐
                │ Story 0 (SERIAL, first)     │
                │ contract.ts + index.ts +    │
                │ empty impl/*.ts skeletons   │
                └──────────────┬──────────────┘
                  modify own file, import read-only
        ┌──────────────────────┼──────────────────────┐
        ▼                      ▼                      ▼
 ┌─────────────┐       ┌─────────────┐       ┌─────────────┐
 │  Story 1    │       │  Story 2    │       │  Story 3    │
 │ Parser impl │       │ Formatter   │       │ Writer impl │
 │ parser.ts   │       │ formatter.ts│       │ writer.ts   │
 └──────┬──────┘       └──────┬──────┘       └──────┬──────┘
        │  PARALLEL — disjoint files, only contract types shared │
        └──────────────────────┼──────────────────────┘
                               │ all three DONE
                               ▼
                ┌─────────────────────────────┐
                │ Story 4 (SERIAL, last)      │
                │ integration/export.ts + e2e │
                └─────────────────────────────┘
```
Critical path = Story 0 → max(S1,S2,S3) → Story 4. Wall-clock ≈ `time(S0) + slowest impl + integration`, not the sum (≈3+ serial).

**Step 5 — parallel impls (disjoint, modify own file only):**

| Story | allowedModify / allowedCreate | depends (citation) | parallelSafe | lane |
|---|---|---|---|---|
| 1 Parser | mod `impl/parser.ts` / create `impl/parser.test.ts` | `[S0]` cites `Parser,CsvRecord` | yes | supporting |
| 2 Formatter | mod `impl/formatter.ts` / create `impl/formatter.test.ts` | `[S0]` cites `Formatter,ExportOptions` | yes | supporting |
| 3 Writer | mod `impl/writer.ts` / create `impl/writer.test.ts` | `[S0]` cites `Writer` | yes | supporting |

Each lists `contract.ts`/`index.ts` under `protectedFiles`, has `sharedHotspots: []`. `resolveParallelSafety()` returns `yes` for all three concurrently.

**Step 6 — integration (SERIAL, last):** Story 4 `depends: [S1,S2,S3]`, `parallelSafe: no`, owns `src/csv/integration/*` + e2e test; imports impls through the barrel. `resolveParallelSafety()` returns `no` while any impl is active, so it naturally waits.

**Validity proof:** (1) the three *concurrent* impl `allowedModify` sets are pairwise disjoint by literal path — S1:`impl/parser.ts`, S2:`impl/formatter.ts`, S3:`impl/writer.ts`; S0 (serial-first) only *creates* those skeletons and S4 (serial-last) owns `integration/*`, so no two stories that ever run at the same time share a write path; the **static** literal-path check at PLAN proves it, `actualFileOverlapsByStory()` confirms post-DEV. (2) S1/S2/S3 import only contract types; no sibling import; acyclic. (3) the only serial points are the two unavoidable ones. (4) merge order S0 → {S1,S2,S3 any order} → S4 is the topological sort `mergeOrder()` already produces.

> 注：CSV 例子里 Story 0 不只写 contract，还顺手建好空的 parser/formatter/writer 骨架和 barrel；三个 impl 只改自己那一个文件、只读 contract，所以静态查重就能证明并行，运行期探针只是兜底。

---

## 7. Failure Modes & Guardrails (incl. review-bandwidth matching)

| ID | Symptom | Root cause | Mitigation | Lattice hook |
|---|---|---|---|---|
| **F1** | Mid-DEV an impl finds the contract is missing a symbol | contract treated as a stub, not a reviewed interface | Contract-complete REVIEW gate before S0 DONE; ADDITIVE amendment (new optional symbol) is cheap and does NOT pause the wave; only BREAKING change reopens — budget for N additive amendments as normal | `story_review` blocker on Story 0 |
| **F2** | "Independent" modules turn out coupled; cycle `S1→S2→S1` | independence test was wrong; contract boundary mis-drawn | A cycle ⇒ **merge** the two or **re-contract** (lift the shared piece into Story 0); never resolve by mutual edits | `resolveParallelSafety` degrades mutual `depends`/`blockingFor` to `no` |
| **F3** | 12 independent stories but operator holds ~3 reviews | parallel *degree* optimized for the code graph, not REVIEW bandwidth | Decompose maximally, **dispatch** ≤ `W` (queue overflow, stays `parallelSafe:yes`, never gains a `depends` edge); advisory by design (§4.6) | `story_review` advisory hint; optional lease-grant cap (§4.6) |
| **F4** | Story declares `src/csv/**` then two stories collide at merge | wide globs defeat static overlap detection | Require NARROW grammar (literal / `dir/*` / `dir/**` below package root); reject mid-path `**` and bare `*` at `scope_contract_set`; BROAD + `parallelSafe:yes` ⇒ **block** (§4.2); runtime probe backstops declared-narrow-wrote-wide | PLAN→DEV `canStartDevGuard` + `actualFileOverlapsByStory()` |
| **F5** | S1/S2/S3 reach DONE together and race to merge a shared barrel | parallel *dev* is safe; *merge* is serial git state; barrel is shared | Serialize the **merge** only via `mergeOrder` single-writer; the barrel is owned by Story 0 (written once, read-only after) so impls never touch it | `parallel_merge_queue` / `mergeOrder` |
| **F6** | Shared test fixtures/factories/snapshot become a hidden hotspot | impls "own their own test file" but share helpers | Shared test fixtures/factories belong to **Story 0** (created with the skeletons) and are `protectedFiles` for impls; per-impl tests use them read-only. A fixture an impl must *write* means the split is wrong | static check flags fixture path in two write-sets |
| **F7** | Every impl must touch `package.json`/lockfile/tsconfig/CI | cross-cutting non-source files are real shared writes | Pull all cross-cutting file edits into **Story 0** (deps/config added up front) or a dedicated serial pre-story; impls add **zero** new dependencies — if an impl needs a dep, it requests a Story-0 amendment | static check flags shared config path |
| **F8** | Two impls share a mutable runtime config / DI registry with zero file overlap | runtime coupling invisible to the file+interface test | Out of scope for the static gate (acknowledged blind spot §7.1); mitigate by routing all shared runtime state **through the contract** so the coupling becomes a visible interface edge, not a hidden one | none — design discipline + integration test |

### 7.1 Acknowledged blind spots & missing-case handling

- **Single-indivisible feature.** The 3-archetype rule is for decomposable work. A trivial feature where contract+impl+integration is genuinely one indivisible unit MAY be a **single serial story** — do not impose Story-0/Story-N+1 overhead on work that cannot be split. The gate never *forces* decomposition (that is a judgment, advisory only, §4.1); it only forbids *false parallel assertions*.
- **Story 0 fails REVIEW / is DISCARDED after impls entered DEV.** Because every impl `depends: [contract-<feature>]`, an impl cannot reach DONE while Story 0 is non-terminal. If Story 0 is DISCARDED, the whole wave is **aborted**: impl stories built against an unmerged contract MUST be discarded or re-based onto the corrected contract. This rollback path is explicit, not assumed away.
- **Runtime coupling with no file/interface edge (F8).** The two-test definition is blind to it. Route shared runtime state through the contract so it becomes a visible edge; otherwise it is a residual risk caught only at integration.
- **Mid-flight re-decomposition.** If an impl's scope grows and must split, spawn a **new parallel sibling** under the *same frozen contract* via `story_create` (`depends: [contract-<feature>]`, disjoint `allowedModify`) — no need to re-run the whole decomposer, provided the new sibling's files are disjoint and the contract is unchanged.
- **Cross-feature contract collision.** The broadness classifier operates within one feature. Two features whose contract paths share a package root (`featureA/contract.ts` vs `featureB/contract.ts`) are disjoint by path and fine; a genuine package-level shared file (`package.json`) is handled by F7. Cross-feature collisions on the *same* path are caught by the same literal-path static check across all active stories.
- **Heterogeneous review sizes (§4.6).** `W` is a slot count; a huge integration review can starve small impl reviews. Operator pacing decision, advisory.

**Through-line:** the decomposition stays maximally parallel; the only things ever serialized are the two structural serial points (contract, integration) and the physical merge — never the development of independent modules.

> 注：F1 把"接口补全"分成 additive（便宜、不暂停 wave）和 breaking（暂停）；F6/F7 把共享测试夹具和 package.json/tsconfig 这类跨切文件统一收归 Story 0，否则"零重叠"在加第一个依赖时就破功；F8 运行期耦合是静态门的盲区，靠"把共享状态走 contract"显式化。

---

## 8. Rollout — Build This as a Lattice Multi-Story Program (Dogfooding)

Build the gate itself **through the Lattice story workflow** (every code change has an audit trail) and **decompose it using this very method** (dogfooding). Constraints that bind this program:
- **All Orchestrate story artifacts (background/checklist/plan/scope) MUST be English** — the `english-artifacts` gate blocks DONE otherwise. Chinese is for operator chat only.
- **All code changes go through the story lifecycle** (INIT → INIT_CHECK → PLAN → DEV → REVIEW → TEST → DONE); no direct commits.

### Suggested story breakdown (itself contract-first)

**Story 0 — Contract (SERIAL, first).** Create `packages/main/src/core/parallel-decomposition.ts` with the pure-function **signatures + skeletons** (`computeWriteSet`, `globsOverlap`, `evaluateDecompositionGate` all throwing NotImplemented), the `ParallelGateConfig` type, the new `VALID_PARALLEL_MODES` constant, and the `ParallelDecompositionBlock` reason enum. Also add the `parallelGate` field to the `AuditConfig` interface in `audit-config.ts` (type only, no resolution logic). This freezes the interface every other story imports.
`scope_contract_set --storyId <S0> --mode=enforce --allowedModify '["packages/main/src/core/parallel-decomposition.ts","packages/main/src/core/audit-config.ts"]' --allowedCreate '["packages/main/src/core/parallel-decomposition.ts"]'` — the `audit-config.ts` entry in `allowedModify` is the narrowly-scoped touch for the interface field (a sharedHotspot with Story 3 — resolve by putting the *type-only* edit here and the *resolution-logic* edit in Story 3, so the write-lines are disjoint; if they cannot be made disjoint, merge Stories 0 and 3's config work).

**Story 1 — Static overlap engine (PARALLEL).** Implement `computeWriteSet` + `globsOverlap` (literal-path intersection + shared-dir-prefix heuristic + broadness classifier over the defined grammar), and the `scope_contract_set` grammar validator that rejects mid-path `**` / bare `*`. `allowedModify: parallel-decomposition.ts` impl region + a new `parallel-decomposition.test.ts`. depends:[S0] cites `globsOverlap` signature.

**Story 2 — Gate verdict + advisories (PARALLEL).** Implement `evaluateDecompositionGate` (active-peer filter, BLOCK conditions §4.3, fail-open/peer-fail-closed §4.8, actionable reason strings). depends:[S0] cites `evaluateDecompositionGate`. Disjoint from S1 (different functions, own test file).

**Story 3 — Config resolution (PARALLEL).** Implement `parallelGate` resolution in `resolveAuditConfig` (per-field override + profile defaults + positive-int/`VALID_PARALLEL_MODES` validation + fallbacks), profile tiering table (§4.7). depends:[S0]. Disjoint from S1/S2 (lives in `audit-config.ts` resolution body, not `parallel-decomposition.ts`).

**Story 4 — Wave/REVIEW advisory wiring (PARALLEL).** Add the `scope_glob_overlap` degradation to `resolveWaveSafety` (`lattice-parallel-wave.ts`) and the `story-review.ts` advisory injection. depends:[S0]. Disjoint files from S1/S2/S3.

**Story 5 — Integration: the hard gate + message (SERIAL, last).** The **two coordinated edits** of §4.4: wire `evaluateDecompositionGate` into `canStartDevGuard` (`machine.ts`, the real decision) **and** the matching branch in `getGuardFailureReason` (the message), sharing the one predicate. End-to-end tests: a declared-parallel file overlap is **blocked** at PLAN→DEV; a broad glob is blocked; a clean disjoint wave passes; `mode: 'off'` disables; config-load failure fails open; unreadable peer contract under `block` refuses the parallel assertion. depends:[S1,S2,S3,S4].

This is the canonical shape: contract first (S0), four independent impls in parallel (S1–S4, bounded by `W`), serial integration last (S5). The critical path is S0 → slowest of S1–S4 → S5 — the spec proving itself.

> 注：这套门要用 Lattice 自己的故事流程来建（有审计轨迹）、并用本规范自身分解来做（吃自己的狗粮）：S0 冻接口、S1–S4 并行、S5 串行集成；所有故事产物必须英文（否则 english-artifacts 门卡 DONE），不能直接提交代码。S5 必须同时改 `canStartDevGuard`（真判定）和 `getGuardFailureReason`（文案），共用一个谓词。

---

Key real Lattice anchors (cite by symbol; line numbers drift): `canStartDevGuard` and `getGuardFailureReason` (`packages/main/src/core/machine.ts`) — the **predicate vs renderer** split, with the explicit warning at `transition-orchestrator.ts:156`; `pathMatchesPattern` (`packages/main/src/core/scope-contract.ts`) — hand-rolled matcher, **no minimatch in the project**; `AuditMode`/`VALID_MODES`/`resolveAuditConfig` (`packages/main/src/core/audit-config.ts`) — values `{semi-auto,full-auto,off}`, fallback `semi-auto`, so `parallelGate.mode` needs a **new** `VALID_PARALLEL_MODES`; `resolveParallelSafety` (`packages/main/src/core/parallel-policy.ts`) — `parallelSafe → blockingFor → depends → sharedHotspots`; `actualFileOverlapsByStory`/`resolveWaveSafety` (`packages/main/src/core/lattice-parallel-wave.ts`) — **post-DEV runtime** probe, not a decomposition-time proof; `ScopeContractData` (`packages/main/src/core/types.ts`) — `allowedModify/allowedCreate/allowedTest/protectedFiles/explicitExcludes`; commands `scope_boundary_set` (writes `ScopeBoundaryData`) vs `scope_contract_set` (writes `ScopeContractData`) in `cli-engine.ts`. New file to add: `packages/main/src/core/parallel-decomposition.ts`.
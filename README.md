# Proof-or-Stop

[![arXiv](https://img.shields.io/badge/arXiv-2607.14890-b31b1b.svg)](https://arxiv.org/abs/2607.14890)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Release](https://img.shields.io/github/v/release/Proof-or-Stop/Prooforstop)](https://github.com/Proof-or-Stop/Prooforstop/releases/latest)

> An evidence-gated control layer for unattended agent development — every phase advance, review pass, and "done" must present fresh, code-state-bound, mechanically verifiable proof, or the loop stops.

**Proof-or-Stop** is an evidence-gated control layer that lets coding agents run an unattended development loop — *plan → execute → review → reflect → done* — where every step forward is admitted only on **mechanically verifiable evidence bound to the current code state**, never on the agent's word. If the evidence isn't there, the loop repairs or stops. The point isn't that an agent *can* run unattended — plenty of frameworks do that. The point is that what an unattended run marks "done" comes with a **mechanically checkable merge-readiness claim** — evidence a reviewer or merge policy can act on.

The host-neutral evidence boundary is formalized as the **Evidence Environment
Adapter (EEA)** contract: an Agent proposes, an Environment observes, Proof
Admissibility evaluates, and the existing Gate decides. The current
implementation includes the generic contract plus bounded code-runtime and
Quantum receipt projections; the existing DONE_REQUIRED lifecycle evaluator
consumes the code-runtime projection after revalidating its raw bindings. It
does not expose an arbitrary runner; Lean,
Rosetta, AlphaFold, PINN solvers, browsers, databases, CI, Kubernetes, and
production deployment remain integration targets.

## Loop Engineering

```
plan ──▶ execute ──▶ review ──▶ reflect ──▶ done
  ▲                                          │
  └──────────  proof, or stop  ◀─────────────┘
```

## The problem: "done" is a claim, not a proof

Agents write code, run tests, and report `tests passed / reviewed / done` on their own — and downstream automation (merge, release, next task) takes those words at face value. But they are **claims, not evidence**:

- tests may have run against **stale code**;
- a "LGTM" may have **no auditable artifact** behind it;
- a green pipeline can **coexist with a real defect** (the *green-but-wrong* failure).

The most expensive incident is the quiet one: **tests green, code wrong, auto-merged to main.**

## The control rule

Any lifecycle advance — next phase, review pass, mark done, merge-readiness claim — **must** be backed by structured evidence that is **fresh** (still bound to the current code-state hash — the moment code changes, prior evidence is void) and **tamper-evident** (signed, not hand-waved). No qualifying evidence → **repair, downgrade, or stop.** Never pass on the agent's testimony.

> Think of it less as a better engine and more as a traffic light for autonomous development: the value isn't speed — it's making "the wrong thing auto-merges to main" *mechanically hard to happen*.

## How it's proven

Seven kinds of proof, each mapped to the evidence behind it:

| # | Proof | What it establishes | Evidence |
|---|---|---|---|
| 1 | **Formal** | when a claim is *admissible* is precisely defined | admissibility predicate + gated lifecycle-transition equations |
| 2 | **Mechanism** | the gate's verdict can't be faked or gamed | freshness binding, anti-forgery, receipt verification; **10/10** engine contract (zero false DONE); **18** tamper classes rejected (zero false accepts) |
| 3 | **System** | the method is really implemented, not just theory | Proof-or-Stop runs it as a full autonomous coding lifecycle (PLAN→DEV→REVIEW→TEST→DONE) |
| 4 | **Empirical** | stronger control *causally* reduces amplification | 9,240-cell powered ablation; pre-registered primary **A4 vs A2′: 31/1800 → 2/1800** (≈1.6pp, CI excludes zero) |
| 5 | **Failure** | missing or wrong evidence → repair or safe-stop, never a false DONE | injected-failure runs exhibit repair / safe-stop / no-false-DONE |
| 6 | **Operational** | it works in real, sustained lifecycle use | self-application corpus: **565 stories / 1,007 findings**; **26/28 (93%)** deep-set findings from independent review while the author's tests were green |
| 7 | **Boundary** | it states honestly what is *not* proven | threats / future work: no general PR-less auto-merge; cross-vendor quorum & multi-model generalization remain open |

![Amplified test-passing-but-wrong deliverables per 1,000 injected cells: A1 single-pass ≈9, A2 naive-retry ≈10, A2′ budget-capped retry ≈17, A3 retry with advisory review ≈8, A4 retry with the enforced gate ≈1.](docs/assets/fig-gate-ablation.png)

The empirical result's sharpest cut is **enforcement, not review**: given the *same* review signal, treating it as advisory (A3) lets 14 defects through while enforcing it (A4) lets only 2 — at nearly identical token spend (A3/A4 = 0.98×). And "green tests ≠ correct" is common, not rare: in the deep set, 93% of findings came from independent review while the author's own tests were green.

## Where it fits

**Proof-or-Stop specializes evidence-gated claim admissibility for autonomous coding lifecycles.** What sets it apart is the combination:

- **No admissible evidence → no lifecycle advance.**
- Agent / reviewer / tool output is a **claim**, not truth.
- Evidence must be **mechanically checkable** — structured, not prose.
- Evidence must be **bound to current state** — `materialHash` / `headHash` / `storyFilesHash` / `policyHash` / `commandSetHash`.
- The gate controls specific **transitions** — PLAN→DEV, REVIEW→TEST, TEST→DONE, handoff, merge-readiness.
- Failure is not an infinite loop — **repair / degrade honestly / escalate / stop safely.**
- **Host-neutral** — host identity affects provenance and independence, not gate semantics.

## What it does *not* do

- It does **not** make the agent smarter.
- It does **not** make development faster — on a clean task it's roughly **2× pure overhead**.
- It does **not** replace your merge policy — the gate yields a **merge-readiness claim**; the actual merge stays a repo/human decision.
- Cross-vendor quorum and multi-model generalization are **still future work**;
  the Evidence Environment quorum path is explicitly fail-closed unsupported
  until a project-owned pinned-key, session-bound, revocation-aware producer
  registry exists.

Its job is narrow and expensive-to-skip: turn the costliest failure — *wrong code silently reaching main* — into something mechanically difficult.

## CLI

Proof-or-Stop ships as a CLI (`proof-or-stop`). Full command reference: **[docs/CLI.md](docs/CLI.md)**.

Check the installed CLI with `proof-or-stop --version` before following version-specific instructions.

```bash
proof-or-stop session_brief   # recover project state
proof-or-stop validate        # run the gates
```

> `proof-or-stop` is the CLI command name. Use `PROOF_OR_STOP_*` for environment keys and the registry's canonical `proof-or-stop-*` agent roles. Retired command, role, environment, state/config lookup, and signing aliases are not supported. Historical bytes remain audit records; only the three explicitly contracted historical scope schemas retain bounded read/hash compatibility. See the [identity cutover decision](docs/requirements/decisions/proof-or-stop-identity-cutover.md).

## Paper

The method, its formal admissibility model, and the full evaluation are described in:

> **Proof-or-Stop: Don't Trust the Agent, Trust the Evidence — Loop Engineering for Verifiable Evidence-Gated Lifecycle Control**
> Jek Huang, Jeffery Hsia, Jiayi Sun, Freddie Shi, Wei Huang, Ian H. White
> arXiv:2607.14890 [cs.AI] · [abstract](https://arxiv.org/abs/2607.14890) · [HTML](https://arxiv.org/html/2607.14890v1) · [DOI](https://doi.org/10.48550/arXiv.2607.14890)

The tag [`paper-arxiv-v1`](https://github.com/Proof-or-Stop/Prooforstop/tree/paper-arxiv-v1) marks the code state at the time of the arXiv v1 submission (2026-07-16).

### Where the paper's evidence lives in this repository

| Paper | Repository |
|---|---|
| §3 Evidence-gating principle — admissibility predicate & gates | `packages/main/src/core/proof-admissibility-*.ts`, `packages/main/src/core/evidence/admissibility/` |
| §3 Offline receipt-bundle contract (18 tamper classes) | `.proof-or-stop/story/actives/B-4c65/` |
| §3 Gate-strength self-red-team contract | `.proof-or-stop/story/actives/B-7b6e/` |
| §3 Evidence-instrument characterization (replay campaign M0–M4) | `experiments/pos-instrument-replay/` |
| §5 Unattended loop — powered control-policy ablation cells | `experiments/multi-model-ablation/` |
| §6 Recovery under injected failure | `experiments/recovery-runner/` |
| §7 Host-neutral transfer — git-native handoff & Tier-C receipts | `experiments/handoff-demo/`, `experiments/tier-c-proof/` |
| §8 Self-application corpus (565 stories / 1,007 findings) | `.proof-or-stop/story/actives/` |
| §9 Experience reuse | `experiments/experience-ablation/` |

### Citation

```bibtex
@misc{huang2026proofstop,
      title={Proof-or-Stop: Don't Trust the Agent, Trust the Evidence -- Loop Engineering for Verifiable Evidence-Gated Lifecycle Control},
      author={Jek Huang and Jeffery Hsia and Jiayi Sun and Freddie Shi and Wei Huang and Ian H. White},
      year={2026},
      eprint={2607.14890},
      archivePrefix={arXiv},
      primaryClass={cs.AI},
      url={https://arxiv.org/abs/2607.14890}
}
```

Or use GitHub's **"Cite this repository"** button (backed by [`CITATION.cff`](CITATION.cff)).

## Status

Open source, under active development. Current release: [`v0.3.214`](https://github.com/Proof-or-Stop/Prooforstop/releases/tag/v0.3.214).

## License

Code is licensed under the Apache License 2.0 — see [LICENSE](LICENSE). The paper is distributed by arXiv under CC BY-NC-SA 4.0.

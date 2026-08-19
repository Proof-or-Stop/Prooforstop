# Plan: B-49d4 Derive red-harness validate registration instead of asserting a fixed allowlist

Decision: option **B — derive both populations from disk, require registered-or-excluded-with-reason, and register the guard itself** (see `decision.json`).

## Standing rules for every item

1. **Do NOT narrow the enumeration with a name pattern.** The reference implementation
   `red-b2aa7-chk007-receipt.mjs` filters with `/^red-b2aa7-.*\.mjs$/`. Copying that literally leaves a
   future differently-prefixed harness outside the population and reproduces this defect one prefix over.
   Enumerate the directory **unfiltered**. This is the single most likely way this story ships a hollow fix.
2. **Never enumerate the registered side inside a test file.** It is whatever `lattice.config.json`
   contains. An in-file copy is a snapshot, and snapshots are the defect.
3. **An exclusion is a decision and carries a machine-checked reason.** Silent absence is indistinguishable
   from an oversight. An exclusion naming a file that no longer exists must fail.
4. **Any guard includes itself in its own population, with no self-exception.** A carve-out is exactly the
   exemption being removed.
5. **Re-measure, do not trust a number.** Four runs of the 18 unregistered harnesses gave 31.7s / 37s /
   38.5s / 37.6s. Quote your own measurement, not one of those.

## CHK-001: Repro-first RED

**Owner**: lattice-implementer
**DependsOn**: none
**Files**
- Create: `packages/main/tests/red/red-b49d4-registration-derivation.mjs`

**Verify**
- Runs on the pre-fix tree and **FAILS**. A RED artifact that passes before the fix proves nothing.

**DoneWhen** — three demonstrations, each with its own assertion shape:
- **BLINDNESS**: a genuine member of the guard's population, registered nowhere, deliberately exiting
  non-zero, leaves the guard at exit 0 — and its success line reports the *expectation's* size, not the
  population's. Assert both; the second is why it can never reveal a gap.
- **CONTROL**: de-registering a currently-listed command against a **copy** of `lattice.config.json` makes
  the guard exit non-zero. Without this, the blindness result could be a broken experiment. **Do not edit
  the real config.**
- **POPULATION**: derive — do not hard-code — how many `packages/main/tests/red/*.mjs` are neither
  registered nor transitively reachable from a registered command, accounting for what
  `red-b2aa7-chk007-receipt.mjs` spawns.
- Include a **differently-prefixed** newcomer (not `red-b2aa7-*`, not `red-w2c-*`) so a narrowed derivation
  fails this artifact. Standing rule 1 must be mechanically enforced, not remembered.

## CHK-002: Derive the population instead of asserting it

**Owner**: lattice-implementer
**DependsOn**: CHK-001
**Files**
- Modify: `packages/main/tests/red/red-w2c-validate-registration.mjs`
- Possibly create: one derived guard covering `packages/main/tests/red/*.mjs`

**Verify**
- Both populations covered, with **no member falling between them**:
  - `packages/main/dist/tasks/red-evidence-*.js` — the w2c guard's own domain (3 members, complete today)
  - `packages/main/tests/red/*.mjs` — 31 members, covered today only for `red-b2aa7-*` by `chk007`
- **Prove the bite in BOTH directions and show the output**: an undecided newcomer, and a de-registered
  member. An unobserved bite is a claim.

**DoneWhen**
- One guard spanning both populations, or two with **disjoint declared populations** — your call, but state
  which and show that the union covers every member.
- Enumeration is unfiltered (standing rule 1).
- Each guard includes itself (standing rule 4).

## CHK-003: Register everything that should run; give every exclusion a reason

**Owner**: lattice-implementer
**DependsOn**: CHK-002
**Files**
- Modify: `lattice.config.json`

**Verify**
- **Run each harness before registering it.** Do not register anything you have not personally seen pass.
- Re-measure total runtime after registration and record the number (standing rule 5).

**DoneWhen**
- Every `packages/main/tests/red/*.mjs` is registered **or** excluded with a stated, machine-checked reason.
- **`red-b2aa7-chk001-receipt.mjs` and `red-b2aa7-chk010-receipt.mjs` are EXCLUDED, not registered.** Every
  marker they emit is gated on BLOCK A of `red-b2aa7-artifact-validation.mjs` still being RED; on a fixed
  tree that is false, so they emit nothing and exit 0. Registering them adds commands that pass forever
  while asserting nothing — the vacuous-coverage defect this story exists to remove, self-inflicted at the
  last step.
- `red-w2c-validate-registration.mjs` — the guard itself — **is registered**. It is currently unregistered,
  which is why it never runs.
- If any harness is slow, set its `timeoutMs` deliberately rather than inheriting a default.

## Dependency graph (acyclic)

```
CHK-001 ── CHK-002 ── CHK-003
```

## Parallelism

None. All three touch the same guard-and-config surface and each depends on the previous one's output:
CHK-002 needs CHK-001's RED to aim at, and CHK-003 needs CHK-002's derivation to decide against. Running
them concurrently is how B-2aa7 produced a stale-document finding — a document written before the code it
described had landed.

// Explicit case identities; shared fixture dependencies remain one ordered unit.
export interface QuorumCase {id:string;name:string;group:string}
export const QUORUM_CASES: readonly QuorumCase[] = [
  {
    "id": "Q001",
    "name": "every production process-event writer honors the shared append lock",
    "group": "Q001"
  },
  {
    "id": "Q002",
    "name": "reviewer provider mapping is explicit and unsupported providers fail closed",
    "group": "Q002"
  },
  {
    "id": "Q003",
    "name": "explicit invalid provider wins over competing host inference while true absence still infers",
    "group": "Q003"
  },
  {
    "id": "Q004",
    "name": "real story-owned fixture delta is host-independent and requires case-level Story intent closure",
    "group": "Q004"
  },
  {
    "id": "Q005",
    "name": "duplicate fixture identities always force full regardless of alias or ordering",
    "group": "Q005"
  },
  {
    "id": "Q006",
    "name": "review_run_start CLI records reviewer-requested full escalation in envelope and signed run",
    "group": "Q006"
  },
  {
    "id": "Q007",
    "name": "unsupported session providers cannot enter the dispatch-to-review-run-to-gate chain",
    "group": "Q007"
  },
  {
    "id": "Q008",
    "name": "Codex and Claude CLI provider aliases complete the thin zero-asset review chain",
    "group": "Q008"
  },
  {
    "id": "Q009",
    "name": "shared binding derivation is byte-identical to the former quorum envelopes",
    "group": "Q009"
  },
  {
    "id": "Q010",
    "name": "shared derivation preserves optional-head and missing-evidence envelopes",
    "group": "Q010"
  },
  {
    "id": "Q011",
    "name": "shared derivation fails closed on every required envelope field",
    "group": "Q011"
  },
  {
    "id": "Q012",
    "name": "shared derivation binds every replay-sensitive input",
    "group": "Q012"
  },
  {
    "id": "Q013",
    "name": "worktree-local CLI commits the exact quorum batch through the production entrypoint",
    "group": "Q013"
  },
  {
    "id": "Q014",
    "name": "mixed legacy/full reviewer evidence crosses collector, REVIEW gate, and quorum admission",
    "group": "Q014"
  },
  {
    "id": "Q015",
    "name": "production CLI refuses process-events, staged source, and lifecycle metadata pre-dirt",
    "group": "Q015"
  },
  {
    "id": "Q016",
    "name": "historical RED dirty baseline makes CLI validation refuse canonical PASS persistence",
    "group": "Q016"
  },
  {
    "id": "Q017",
    "name": "refuses when required reviewer passes are absent and writes no verdicts",
    "group": "ordered-quorum-state"
  },
  {
    "id": "Q018",
    "name": "numerically sufficient compatibility/retired-only receipts cannot authorize quorum",
    "group": "ordered-quorum-state"
  },
  {
    "id": "Q019",
    "name": "refuses when reviewer passes are stale and writes no verdicts",
    "group": "ordered-quorum-state"
  },
  {
    "id": "Q020",
    "name": "machine REVIEW and quorum consume the same full-envelope replay/tamper proof",
    "group": "ordered-quorum-state"
  },
  {
    "id": "Q021",
    "name": "explicit full-asset mode binds Claude and Codex independently and rejects selected-host drift",
    "group": "Q021"
  },
  {
    "id": "Q022",
    "name": "emits exactly rounds x 2 verdicts after current reviewer passes",
    "group": "ordered-quorum-state"
  },
  {
    "id": "Q023",
    "name": "review_escalation_status and review assurance floor report complete voluntary 3x2 rounds",
    "group": "ordered-quorum-state"
  },
  {
    "id": "Q024",
    "name": "auto-computed materialDigest and storyFilesHash match current helpers",
    "group": "ordered-quorum-state"
  },
  {
    "id": "Q025",
    "name": "hosts are independent by hostId, sessionId, and keyId",
    "group": "ordered-quorum-state"
  },
  {
    "id": "Q026",
    "name": "never sets authorityDone, fullAuthorityDone, or productionDone",
    "group": "ordered-quorum-state"
  },
  {
    "id": "Q027",
    "name": "refuses a same-material re-submit and writes no new verdicts",
    "group": "ordered-quorum-state"
  },
  {
    "id": "Q028",
    "name": "same-material duplicate refusal survives deletion of the ignored verdict cache",
    "group": "Q028"
  },
  {
    "id": "Q029",
    "name": "allows a fresh quorum after a material change",
    "group": "ordered-quorum-state"
  },
  {
    "id": "Q030",
    "name": "--rounds=N (N != 3) emits exactly N x 2 verdicts with N runIds",
    "group": "ordered-quorum-state"
  },
  {
    "id": "Q031",
    "name": "refuses a redundant re-submit when the standing quorum drift-accepts",
    "group": "Q031"
  },
  {
    "id": "Q032",
    "name": "blank storyFilesHash on committed legacy verdicts is no-signal for the drift branch",
    "group": "Q032"
  },
  {
    "id": "Q033",
    "name": "EMPTY_STORY_FILES_HASH current state allows resubmit instead of falsely drift-accepting (F-035)",
    "group": "Q033"
  },
  {
    "id": "Q034",
    "name": "a second main drift does not circumvent the drift-accept refusal",
    "group": "Q034"
  },
  {
    "id": "Q035",
    "name": "a story-owned file change after main drift makes the re-quorum genuine again",
    "group": "Q035"
  },
  {
    "id": "Q036",
    "name": "refuses pre-existing user dirt before writing any verdict",
    "group": "Q036"
  },
  {
    "id": "Q037",
    "name": "foreign append fails exact verification and rolls back only the six owned verdicts",
    "group": "Q037"
  },
  {
    "id": "Q038",
    "name": "capture-time failure rolls back the just-written event and verdict JSON",
    "group": "Q038"
  },
  {
    "id": "Q039",
    "name": "between-row foreign append preserves foreign bytes and rolls back row two",
    "group": "Q039"
  },
  {
    "id": "Q040",
    "name": "writer-owned append identity never claims a foreign row inserted before host_verdict",
    "group": "Q040"
  },
  {
    "id": "Q041",
    "name": "rollback never deletes an owned-row byte sequence embedded inside foreign binary",
    "group": "Q041"
  },
  {
    "id": "Q042",
    "name": "same-verdictId mutation of a gate-consumed field is refused and rolled back",
    "group": "Q042"
  },
  {
    "id": "Q043",
    "name": "rollback preserves a concurrently changed verdict JSON with the same verdictId",
    "group": "Q043"
  },
  {
    "id": "Q044",
    "name": "rollback preserves non-UTF8 blank and unterminated foreign suffix bytes exactly",
    "group": "Q044"
  },
  {
    "id": "Q045",
    "name": "commit-hook rejection rolls back all rows and a clean retry succeeds once",
    "group": "Q045"
  },
  {
    "id": "Q046",
    "name": "atomic quorum commit hashes process-events larger than one MiB",
    "group": "Q046"
  },
  {
    "id": "Q047",
    "name": "large atomic quorum commit still rejects a post-manifest mutation",
    "group": "Q047"
  },
  {
    "id": "Q048",
    "name": "HEAD movement loses the CAS without reverting the competing HEAD",
    "group": "Q048"
  },
  {
    "id": "Q049",
    "name": "rollback conflict preserves competing prefix bytes and removes every countable verdict",
    "group": "Q049"
  },
  {
    "id": "Q050",
    "name": "rejects non-independent host identity before writing additional verdicts",
    "group": "ordered-quorum-state"
  },
  {
    "id": "Q051",
    "name": "quorum_prune dry-run lists the poisoned duplicates without mutating",
    "group": "Q051"
  },
  {
    "id": "Q052",
    "name": "quorum_prune apply removes the losing set, backs up, and the floor returns to full-3x2",
    "group": "Q052"
  },
  {
    "id": "Q053",
    "name": "quorum_prune resolves AND executes through the built CLI in the story phase (catalog + policy + DEFAULT_PHASE_TOOLS)",
    "group": "Q053"
  },
  {
    "id": "Q054",
    "name": "quorum_prune refuses when there is nothing to prune",
    "group": "Q054"
  },
  {
    "id": "Q055",
    "name": "quorum_prune apply refuses on a dirty tree before any mutation",
    "group": "Q055"
  },
  {
    "id": "Q056",
    "name": "quorum_prune keeps exactly one event per group for a triple-duplicate",
    "group": "Q056"
  },
  {
    "id": "Q057",
    "name": "quorum_prune runIds filter prunes only the specified runIds",
    "group": "Q057"
  },
  {
    "id": "Q058",
    "name": "quorum_prune preserves interleaved non-host_verdict lines byte-identically",
    "group": "Q058"
  },
  {
    "id": "Q059",
    "name": "quorum_prune keep:oldest-material inverts which duplicate survives",
    "group": "Q059"
  },
  {
    "id": "Q060",
    "name": "quorum_prune refuses an uncommitted process-events file",
    "group": "Q060"
  },
  {
    "id": "Q061",
    "name": "quorum_prune never overwrites a previous run backup",
    "group": "Q061"
  },
  {
    "id": "Q062",
    "name": "quorum_prune apply leaves a clean worktree and a second apply needs no manual git",
    "group": "Q062"
  },
  {
    "id": "Q063",
    "name": "quorum_prune apply through the production CLI under codex leaves no process-event dirt",
    "group": "Q063"
  },
  {
    "id": "Q064",
    "name": "quorum_prune --dryRun is a real declared flag, is honored, and refuses when combined with --apply",
    "group": "Q064"
  },
  {
    "id": "Q065",
    "name": "quorum_prune dryRun:false executes instead of being a silent no-op",
    "group": "Q065"
  },
  {
    "id": "Q066",
    "name": "quorum_prune refuses the symmetric apply:false + dryRun:false conflict",
    "group": "Q066"
  },
  {
    "id": "Q067",
    "name": "every quorum_prune apply/dryRun description states both executors",
    "group": "Q067"
  },
  {
    "id": "Q068",
    "name": "quorum_prune refuses a non-pass duplicate group instead of laundering the round (F-024)",
    "group": "Q068"
  },
  {
    "id": "Q069",
    "name": "quorum_prune never deletes a verdict cache path outside the story verdict dir (F-025)",
    "group": "Q069"
  },
  {
    "id": "Q070",
    "name": "quorum_prune holds the shared append lock across read and rewrite (F-026)",
    "group": "Q070"
  },
  {
    "id": "Q071",
    "name": "quorum_prune installs the pruned log by atomic rename, never an in-place overwrite (F-027)",
    "group": "Q071"
  },
  {
    "id": "Q072",
    "name": "quorum_submit re-checks the duplicate guard against the captured HEAD (F-028)",
    "group": "Q072"
  },
  {
    "id": "Q073",
    "name": "quorum_submit compares the same-material guard on the normalized digest (F-029)",
    "group": "Q073"
  }
];

import { rmSync } from 'node:fs';
import { root, failures } from './support.js';
import { reportFullResult } from './summary.js';
import { case00, case01 } from "./proposal.js";
import { case02 } from "./prompt-supervision.js";
import { case03, case04, case05, case06, case07, case08, case09, case10, case11, case12, case13, case14, case15, case16, case17, case18, case19 } from "./usage-parsing.js";
import { case20, case21, case22, case23, case24, case25, case26 } from "./story-binding.js";
import { case27, case28, case29, case30, case31, case32, case33, case34, case35 } from "./streaming.js";
import { case36, case37, case38, case39, case40, case41 } from "./ledger-failures.js";
import { case42, case43, case44, case45, case46 } from "./output-errors.js";
import { case47, case48, case49, case50, case51, case52, case53, case54, case55, case56, case57, case58 } from "./admission.js";
import { case59, case60, case61, case62, case63, case64, case65, case66, case67, case68, case69, case70 } from "./integrations.js";
import { case71, case72, case73, case74, case75, case76, case77 } from "./ledger-concurrency.js";
import { case78, case79, case80, case81, case82, case83, case84, case85, case86, case87 } from "./process-supervision.js";
import { case88, case89, case90 } from "./evidence-mapping.js";
const CASES = [
 { capability: 'proposal', name: 'case00', label: "B-137a bounded final-result adapters: Codex JSONL/raw and Claude terminal lanes only; tool logs ignored and ambiguity/oversize explicit", run: case00 },
 { capability: 'proposal', name: 'case01', label: "B-137a admission transfer failure kills/reaps the spawned provider and cannot report runner success", run: case01 },
 { capability: 'prompt-supervision', name: 'case02', label: "F-054/F-070/F-072/F-079 prompt transport and unsafe residual supervision fail closed", run: case02 },
 { capability: 'usage-parsing', name: 'case03', label: "CHK-001 codex happy: estimate(seq1) + provider-reported final(seq2) with uncached-remainder mapping", run: case03 },
 { capability: 'usage-parsing', name: 'case04', label: "CHK-001 claude happy: stream-json result -> provider-reported final with served model", run: case04 },
 { capability: 'usage-parsing', name: 'case05', label: "CHK-001 agy safety: argv-only prompt transport refuses before spawn", run: case05 },
 { capability: 'usage-parsing', name: 'case06', label: "CHK-001 codex edge (B-3ddc): turn.failed / no usage -> unavailable (turn_failed(boom)), never a fabricated zero", run: case06 },
 { capability: 'usage-parsing', name: 'case07', label: "B-3ddc pinned B-3928: version-skew turn.failed -> unavailable final names the INNERMOST upgrade message (turn_failed(<digest>)), exit 1 propagates", run: case07 },
 { capability: 'usage-parsing', name: 'case08', label: "B-3ddc fallback: noise-only stdout (no turn.completed, no failure event) still records no_turn_completed_usage_event", run: case08 },
 { capability: 'usage-parsing', name: 'case09', label: "B-3ddc precedence: a genuine turn.completed usage FOLLOWED by a turn.failed stays provider-reported (usage never discarded; failure lane not consulted)", run: case09 },
 { capability: 'usage-parsing', name: 'case10', label: "B-3ddc streaming lane: the default runner retains the pinned turn.failed line in the SECOND bounded lane (usage lane stays empty)", run: case10 },
 { capability: 'usage-parsing', name: 'case11', label: "B-3ddc terminal error: a single {\"type\":\"error\"} line records turn_failed(stream disconnected)", run: case11 },
 { capability: 'usage-parsing', name: 'case12', label: "B-3ddc digest hygiene: control chars/newlines collapse, whitespace runs collapse, parens neutralized (F2 no-parens invariant), over-cap truncates with a trailing ellipsis at the exported cap; no message -> no_error_message", run: case12 },
 { capability: 'usage-parsing', name: 'case13', label: "B-3ddc F2 paren injection: message \"boom) turn_failed(fake\" -> turn_failed(boom] turn_failed[fake) (interior parens neutralized)", run: case13 },
 { capability: 'usage-parsing', name: 'case14', label: "B-3ddc F1 candidate-then-drop: the default runner sets failureRetentionTruncated when an over-cap line is dropped AFTER a retained turn.failed; the stale failure line then degrades to no_turn_completed_usage_event", run: case14 },
 { capability: 'usage-parsing', name: 'case15', label: "B-3ddc F1 drop-then-candidate (F-026 mirror): an over-cap line dropped BEFORE the retained turn.failed clears failureRetentionTruncated; the later candidate supersedes and turn_failed(boom) is kept", run: case15 },
 { capability: 'usage-parsing', name: 'case16', label: "CHK-001 edge: ledger OFF -> zero rows but provider admission remains active; run spawns + exit propagates", run: case16 },
 { capability: 'usage-parsing', name: 'case17', label: "CHK-001 edge: host non-zero exit propagates while codex rows still record", run: case17 },
 { capability: 'usage-parsing', name: 'case18', label: "CHK-001 adversarial: flooding stdout is line-streamed; last turn.completed usage wins", run: case18 },
 { capability: 'usage-parsing', name: 'case19', label: "CHK-001 adversarial: inherited/polluted usage never fabricates counts (own-property projection)", run: case19 },
 { capability: 'story-binding', name: 'case20', label: "CHK-002 binding: reviewRunId->threadId, lane->subagentId, phase resolves from the configured store", run: case20 },
 { capability: 'story-binding', name: 'case21', label: "CHK-002 edge: omitted reviewRunId/lane -> threadId/subagentId null (no empty-string pollution)", run: case21 },
 { capability: 'story-binding', name: 'case22', label: "CHK-002 edge: unknown storyId (per configured store) fails pre-spawn (runner never invoked)", run: case22 },
 { capability: 'story-binding', name: 'case23', label: "CHK-002 adversarial: cross-story reviewRunId refused pre-spawn (runner never invoked)", run: case23 },
 { capability: 'story-binding', name: 'case24', label: "F-005: explicit --phase is honored AS-IS with NO story-store read (fake resolver never consulted)", run: case24 },
 { capability: 'story-binding', name: 'case25', label: "F-005: unknown story is NOT refused when --phase overrides (the exact configured-storyDir bug)", run: case25 },
 { capability: 'story-binding', name: 'case26', label: "F-005: storyId with a store phase of null falls back to adhoc (no fabricated phase)", run: case26 },
 { capability: 'streaming', name: 'case27', label: "F-006: default runner streams stdout live — first line reaches the sink BEFORE process exit", run: case27 },
 { capability: 'streaming', name: 'case28', label: "F-243: stdoutDigest hashes raw provider bytes before UTF-8 decoding", run: case28 },
 { capability: 'streaming', name: 'case29', label: "F-006: host output is delivered through the passthrough EXACTLY once (no double-print) with a buffered runner", run: case29 },
 { capability: 'streaming', name: 'case30', label: "F-006: an oversized single usage line is bounded (dropped + truncation flag) -> no parse target, never OOM/fabrication", run: case30 },
 { capability: 'streaming', name: 'case31', label: "F-013 codex: valid turn.completed then an over-cap final usage line -> unavailable (usage_line_retention_truncated), never the stale earlier numbers", run: case31 },
 { capability: 'streaming', name: 'case32', label: "F-013 claude: valid result envelope then an over-cap line -> unavailable (usage_line_retention_truncated), not the stale envelope", run: case32 },
 { capability: 'streaming', name: 'case33', label: "F-026 scanner unit: drop-then-candidate clears the flag; candidate-then-drop sets it (F-013); drop-only stays set (F-006); a retained-nothing line never clears it", run: case33 },
 { capability: 'streaming', name: 'case34', label: "F-026 codex (the RED): an over-cap NON-usage line followed by a valid turn.completed -> provider-reported final with the candidate numbers (the OLD global flag forced unavailable here)", run: case34 },
 { capability: 'streaming', name: 'case35', label: "F-026 claude: an over-cap NON-usage line followed by a valid result envelope -> provider-reported final with the served model (mirror)", run: case35 },
 { capability: 'ledger-failures', name: 'case36', label: "F-021 claude: valid stream-json usage BUT a failing (corrupt) ledger -> summary reports skipped (none, ledger_append_failed), NEVER provider-reported; run completes + exit code propagates", run: case36 },
 { capability: 'ledger-failures', name: 'case37', label: "F-021 codex: valid turn.completed usage BUT a failing (corrupt) ledger -> summary reports skipped (none, ledger_append_failed), NEVER provider-reported", run: case37 },
 { capability: 'ledger-failures', name: 'case38', label: "F-029 codex: a provider-record whose ledger APPEND fails stays source=provider-reported (recorded=false, ledger_append_failed), never degraded to a false unavailable row", run: case38 },
 { capability: 'ledger-failures', name: 'case39', label: "F-030 provider (void sibling): build-vs-append separated — healthy ledger lands exactly one provider-reported row; corrupt ledger lands NO row of any source and never throws", run: case39 },
 { capability: 'ledger-failures', name: 'case40', label: "F-027 concurrency: saturated cap + failing (corrupt) ledger -> refusal fail-closed BUT summary reports none + composed reason, NEVER a blocked row / minted recordId", run: case40 },
 { capability: 'ledger-failures', name: 'case41', label: "F-027 budget: over-budget + failing (corrupt) ledger -> refusal fail-closed BUT summary reports none + composed reason, NEVER a blocked row", run: case41 },
 { capability: 'output-errors', name: 'case42', label: "F-008: throwing passthrough — run completes, no retry, final row records, slot releases, exit + passthroughError propagate", run: case42 },
 { capability: 'output-errors', name: 'case43', label: "F-020: real subprocess — a live-output consumer that closes mid-stream (async EPIPE) is CONTAINED: driver exits 0, slot released, ledger final recorded, passthroughError surfaced", run: case43 },
 { capability: 'output-errors', name: 'case44', label: "F-023: real subprocess — TEXT-mode quiet run whose stderr is closed before the FIRST (usage-line) stderr write is CONTAINED: driver exits 0, slot released, ledger final recorded (no post-finally async EPIPE crash)", run: case44 },
 { capability: 'output-errors', name: 'case45', label: "F-024: real subprocess — TEXT-mode live stdout passthrough whose consumer destroys the driver STDOUT mid/late-stream is CONTAINED: driver exits 0, slot released, ledger final recorded (no post-finally async EPIPE crash on the final chunk)", run: case45 },
 { capability: 'output-errors', name: 'case46', label: "F-152/F-165: cap-losing live writes keep EPIPE containment with one bounded shared listener until callbacks settle", run: case46 },
 { capability: 'admission', name: 'case47', label: "F-011: plan.cwd is the injected resolved root while process.cwd() is intentionally elsewhere; empty cwd refused pre-spawn", run: case47 },
 { capability: 'admission', name: 'case48', label: "F-011: the DEFAULT runner spawns the real child IN plan.cwd — child process.cwd() equals the injected root, not the smoke cwd", run: case48 },
 { capability: 'admission', name: 'case49', label: "CHK-007a budget: over-budget preflight refuses before spawn, writes blocked row (hard_budget_exceeded)", run: case49 },
 { capability: 'admission', name: 'case50', label: "CHK-007a budget (F-004): blocked rows are provider-honest — codex=openai, claude=anthropic (legacy shape byte-compat)", run: case50 },
 { capability: 'admission', name: 'case51', label: "CHK-007b concurrency: 5th run under cap 4 refuses, writes blocked row (concurrency_cap_exceeded)", run: case51 },
 { capability: 'admission', name: 'case52', label: "CHK-007b concurrency: dead-pid slot is reclaimed so the run proceeds", run: case52 },
 { capability: 'admission', name: 'case53', label: "F-025 live-holder protection: a LIVE-pid slot is NEVER age-reclaimed — the cap=1 waiter refuses fail-closed and the slot file survives (the OLD mtime rule reclaimed it here)", run: case53 },
 { capability: 'admission', name: 'case54', label: "F-025 meta-less orphan backstop: a slot whose meta never landed (corrupt/empty file) is waited out while FRESH (cap=1 refusal) and reclaimed only PAST the mtime backstop", run: case54 },
 { capability: 'admission', name: 'case55', label: "F-025 release-token guard: a reclaimed+reacquired slot survives the ORIGINAL holder's late release (token mismatch), the cap stays enforced, and a matching-token release still works", run: case55 },
 { capability: 'admission', name: 'case56', label: "CHK-007b adversarial (F-003): cap=1 real contention — second admission fails while the first holds (index wx IS the cap decision)", run: case56 },
 { capability: 'admission', name: 'case57', label: "CHK-007b adversarial (F-003): stale-reclaim race — exactly one of two reclaimers wins the wx re-create", run: case57 },
 { capability: 'admission', name: 'case58', label: "CHK-007b edge: PROOF_OR_STOP_HOST_RUN_MAX_CONCURRENT unset/invalid falls back to 4; valid honored", run: case58 },
 { capability: 'integrations', name: 'case59', label: "CHK-003 autopilot repair ON: --output-format json argv + estimate/final rows (agentType autopilot-repair) + envelope-parsed excerpt", run: case59 },
 { capability: 'integrations', name: 'case60', label: "CHK-003 autopilot repair OFF: provider argv stays byte-compatible, usage rows stay off, shared provider admission remains active", run: case60 },
 { capability: 'integrations', name: 'case61', label: "F-016 repair budget admission: ledger ON + PROOF_OR_STOP_HARD_BUDGET_TOKENS=1 refuses PRE-SPAWN (runner never invoked) + blocked row (hard_budget_exceeded, anthropic, autopilot-repair)", run: case61 },
 { capability: 'integrations', name: 'case62', label: "F-016 repair concurrency admission: saturated cap refuses pre-spawn (concurrency_cap_exceeded row, no spawn); OFF still enforces the cap; slot HELD during a normal run and RELEASED after", run: case62 },
 { capability: 'integrations', name: 'case63', label: "CHK-003 probe wiring: per-host preflight+unavailable rows (agentType host-readiness-probe), provider mapping, documented reason", run: case63 },
 { capability: 'integrations', name: 'case64', label: "F-015 probe filter: rows recorded ONLY for hosts whose readiness prompt actually spawned (missing_executable / version_failed / pre-spawn wrong_launcher skipped)", run: case64 },
 { capability: 'integrations', name: 'case65', label: "CHK-003 cross-host-review codex leaf ON: preflight + unavailable final (agentType cross-host-review:codex) with documented reason, argv unchanged", run: case65 },
 { capability: 'integrations', name: 'case66', label: "CHK-003/F-017 cross-host-review codex leaf: absent binding AND ledger OFF keep zero usage rows while provider admission remains mandatory", run: case66 },
 { capability: 'integrations', name: 'case67', label: "F-017 codex leaf budget admission: ledger ON + PROOF_OR_STOP_HARD_BUDGET_TOKENS=1 refuses PRE-SPAWN (runner never invoked) + blocked row (hard_budget_exceeded, openai) + synthesized blocked verdict", run: case67 },
 { capability: 'integrations', name: 'case68', label: "F-017 codex leaf concurrency admission: saturated cap refuses pre-spawn (concurrency_cap_exceeded row provider openai, no spawn) + synthesized blocked verdict", run: case68 },
 { capability: 'integrations', name: 'case69', label: "F-017 codex leaf normal run: the admission slot is HELD during the run and RELEASED after (cap=1 re-admission succeeds)", run: case69 },
 { capability: 'integrations', name: 'case70', label: "CHK-003 adversarial: a corrupt ledger never breaks repair / probe / codex-review (seam never throws)", run: case70 },
 { capability: 'ledger-concurrency', name: 'case71', label: "F-012 parallel writes: 6 REAL concurrent processes x 5 appends each -> zero skips, no lost writes, hash chain intact", run: case71 },
 { capability: 'ledger-concurrency', name: 'case72', label: "F-012/F-018 ownerless orphan reclaim: a lock dir with NO owner.json and an old mtime (crash-before-owner-write window) is reclaimed by the backstop — a single append succeeds and releases it", run: case72 },
 { capability: 'ledger-concurrency', name: 'case73', label: "F-012 bounded-wait skip-not-corrupt: a HELD fresh lock + tiny wait -> the append throws (skips), chain stays valid, foreign lock not stolen", run: case73 },
 { capability: 'ledger-concurrency', name: 'case74', label: "F-018 live-holder protection: a LIVE pid with valid owner.json is never reclaimed regardless of lock age — bounded wait then skip-not-corrupt, lock + token intact", run: case74 },
 { capability: 'ledger-concurrency', name: 'case75', label: "F-018 dead-holder reclaim: owner.json with a REAL dead pid is reclaimed immediately (age-independent) — the append succeeds", run: case75 },
 { capability: 'ledger-concurrency', name: 'case76', label: "F-018 release-token guard: release removes the lock only while owner.json still carries OUR token — a reclaimed+reacquired foreign lock survives a stale release", run: case76 },
 { capability: 'ledger-concurrency', name: 'case77', label: "F-018/F-019 owner-write-failure rollback: when owner.json cannot be written after a successful mkdir, acquire returns null AND gives the dir back — no ownerless lock left behind", run: case77 },
 { capability: 'process-supervision', name: 'case78', label: "B-3aec startup watchdog: silent child is killed/reaped before total timeout and reports startup_no_output_timeout", run: case78 },
 { capability: 'process-supervision', name: 'case79', label: "B-3aec first byte: stderr clears startup timer; productive runtime may exceed startup budget and still finish", run: case79 },
 { capability: 'process-supervision', name: 'case80', label: "B-3aec total deadline: early stdout preserves first-output evidence but a later hang is total_timeout", run: case80 },
 { capability: 'process-supervision', name: 'case81', label: "B-3aec abort cleanup: caller abort waits for close and runHostRun releases cap=1 slot for immediate reacquisition", run: case81 },
 { capability: 'process-supervision', name: 'case82', label: "B-3aec async spawn error: ENOENT is stable spawn_error/missing_executable exit 1 and settles once on close", run: case82 },
 { capability: 'process-supervision', name: 'case83', label: "B-3aec post-readiness diagnostics: bounded stderr classifies auth and interactive terminal failures", run: case83 },
 { capability: 'process-supervision', name: 'case84', label: "B-3aec dual-stream sticky diagnostics: stdout-only and early auth/interactive survive a later >64KiB tail", run: case84 },
 { capability: 'process-supervision', name: 'case85', label: "B-3aec deterministic race schedules settle once, kill at most once, and clean timers/listeners", run: case85 },
 { capability: 'process-supervision', name: 'case86', label: "B-137a:F-160/F-232 process-group timeout/abort refuse stale leader fingerprints before signalling a reused PGID or direct child", run: case86 },
 { capability: 'process-supervision', name: 'case87', label: "B-3aec timeout cleanup through runHostRun: startup and total timeout both release cap=1 for the next run", run: case87 },
 { capability: 'evidence-mapping', name: 'case88', label: "isolation: all artifacts live under the temp root (no repo pollution)", run: case88 },
 { capability: 'evidence-mapping', name: 'case89', label: "CHK-004:edge:2 pinned command executes the candidate overflow/null-first-output boundary", run: case89 },
 { capability: 'evidence-mapping', name: 'case90', label: "Pinned CLI watchdog evidence mapping", run: case90 },
];
export async function runHostUsageCli(args: string[]): Promise<void> {
 try {
  const ids = [...new Set(CASES.map(row=>row.capability))];
  if(args.length===1 && args[0]==='--list-capabilities') { console.log(JSON.stringify(ids.map(id=>({id,checks:CASES.filter(row=>row.capability===id).map(row=>row.name),descriptions:CASES.filter(row=>row.capability===id).map(row=>row.label)})))); return; }
  const full = !args.length || args.length===1 && ['--all','--canonical-core'].includes(args[0]);
  const selected = full ? ids : [...new Set(args.map(arg=>{ if(!arg.startsWith('--capability=') || !ids.includes(arg.slice(13))) throw new Error('Unknown host usage verification argument: '+arg); return arg.slice(13); }))];
  for(const row of CASES) if(selected.includes(row.capability)) await row.run();
  if(failures.length) throw new Error('host-run usage checks failed: '+failures.join(', '));
  if(full) reportFullResult(); else console.log('HOST_USAGE_PARTIAL_PASS '+JSON.stringify({full:false,capabilities:selected}));
 } finally { rmSync(root,{recursive:true,force:true}); }
}

import {
  PROOF_OR_STOP_BIN_NAMES,
  PROOF_OR_STOP_DEPRECATED_BIN,
  PROOF_OR_STOP_DEPRECATED_CODEX_BIN,
} from '../core/proof-or-stop-brand.js';

/**
 * Bin tokens this PARSER will strip when pasted redundantly as argv[0].
 *
 * Deliberately WIDER than `PROOF_OR_STOP_BIN_NAMES`. That list answers
 * "which bin names does usage text advertise?", and B-5a88 CHK-007 correctly
 * narrowed it to the canonical pair so no retired `lattice` name is ever
 * emitted. Parse tolerance is a DIFFERENT question: an operator (or an older
 * script, git hook, or copied docs line) may still paste a retired token, and
 * silently failing to strip it turns `lattice host runtime list` into an
 * unmatched alias rather than the command the reader intended.
 *
 * Accepting a token here does NOT advertise it: usage rendering still goes
 * through `resolveUsageBin`, which maps anything outside
 * `PROOF_OR_STOP_BIN_NAMES` back to the canonical `proof-or-stop` form.
 * `core/audit-scan.ts` already unions these same two sets for exactly this
 * read-tolerance reason (BIN_TOKEN_ALTERNATION).
 */
export const STRIPPABLE_BIN_TOKENS: readonly string[] = [
  ...new Set([
    ...PROOF_OR_STOP_BIN_NAMES,
    PROOF_OR_STOP_DEPRECATED_BIN,
    PROOF_OR_STOP_DEPRECATED_CODEX_BIN,
  ]),
];

export const NESTED_SPACE_ALIASES: Record<string, string> = {
  'host list': 'host_list',
  'host probe': 'host_probe',
  'host status': 'host_status',
  'host run': 'host_run',
  'host runtime list': 'host_runtime_list',
  'host runtime probe': 'host_runtime_probe',
  'host install': 'host_install',
  'host dispatch': 'host_dispatch',
  'usage sweep': 'usage_sweep',
  'dispatch plan': 'dispatch_plan',
  'dispatch prepare': 'dispatch_prepare',
  'dispatch run': 'dispatch_run',
  'dispatch collect': 'dispatch_collect',
  'dispatch receipt create': 'dispatch_receipt_create',
  'dispatch status': 'dispatch_status',
  'dispatch list': 'dispatch_list',
  'dispatch resume': 'dispatch_resume',
  'dispatch reassign': 'dispatch_reassign',
  'dispatch cancel': 'dispatch_cancel',
  'dispatch review': 'dispatch_review',
  'dispatch merge plan': 'dispatch_merge_plan',
  'dispatch policy create': 'dispatch_policy_create',
  'dispatch policy get': 'dispatch_policy_get',
  'dispatch policy check': 'dispatch_policy_check',
  'dispatch auto': 'dispatch_auto',
  'dispatch watch': 'dispatch_watch',
  'autopilot policy create': 'autopilot_policy_create',
  'autopilot policy get': 'autopilot_policy_get',
  'autopilot policy check': 'autopilot_policy_check',
  'autopilot run': 'autopilot_run',
  'autopilot status': 'autopilot_status',
  'autopilot watch': 'autopilot_watch',
  'autopilot cancel': 'autopilot_cancel',
  'autopilot review': 'autopilot_review',
  'autopilot resume': 'autopilot_resume',
  'overflow auto': 'overflow_auto',
  'handoff create': 'handoff_create',
  'handoff inspect': 'handoff_inspect',
  'handoff accept': 'handoff_accept',
  'handoff resume': 'handoff_resume',
  'handoff receipt submit': 'handoff_receipt_submit',
  'handoff worktree create': 'handoff_worktree_create',
  'config doctor': 'proof_or_stop_config_doctor',
  'config repair': 'proof_or_stop_config_repair',
  'codex verify': 'verify_codex',
  'codex doctor': 'codex_doctor',
  'rollout check': 'rollout_check',
  'baseline run': 'baseline_run',
  'baseline suite': 'baseline_suite',
  'baseline suite report': 'baseline_suite_report',
  'capability claim formal evaluate': 'capability_claim_formal_evaluate',
  'autopilot execute': 'autopilot_execute',
  'autopilot doctor': 'autopilot_doctor',
  'autopilot review submit': 'autopilot_review_submit',
  'autopilot review status': 'autopilot_review_status',
  'decision doc quorum check': 'decision_doc_quorum_check',
  'decision doc proposal': 'decision_doc_proposal',
  'decision doc preview': 'decision_doc_preview',
  'decision doc save': 'decision_doc_save',
  'review escalation status': 'review_escalation_status',
  'review escalation policy set': 'review_escalation_policy_set',
  'review host availability probe': 'review_host_availability_probe',
  'review escalation fallback set': 'review_escalation_fallback_set',
  'planner draft': 'planner_draft',
  'planner review': 'planner_review',
  'planner create-story': 'planner_create_story',
  'planner create-job': 'planner_create_job',
  'planner status': 'planner_status',
  'planner answer': 'planner_answer',
  'planner decision submit': 'planner_decision_submit',
  'planner resume': 'planner_resume',
  'planner run': 'planner_run',
  'planner source-manifest': 'planner_source_manifest',
  'story resolve': 'story_resolve',
  'done closure': 'done_closure',
  'done prepare': 'done_prepare',
  'conduit status': 'conduit_status',
  'conduit explain': 'conduit_explain',
  'observability snapshot': 'observability_snapshot',
};

export interface AliasNormalizationResult {
  matched: boolean;
  argv: string[];
  cmd: string | undefined;
  arg: string | undefined;
  canonicalAlias?: string;
  displayAlias?: string;
  consumed?: 2 | 3 | 4;
  aliasStart: 0 | 1;
}

export function normalizeNestedSpaceAlias(argv: string[]): AliasNormalizationResult {
  // B-cdf6 CHK-002: tolerate a pasted redundant bin token under EITHER name, so
  // `proof-or-stop proof-or-stop host list` is forgiven exactly like the
  // `lattice lattice host list` form the deprecated alias already accepted.
  const aliasStart = STRIPPABLE_BIN_TOKENS.includes(argv[0]) ? 1 : 0;
  const candidates: Array<{ text: string; consumed: 2 | 3 | 4 }> = [
    { text: argv.slice(aliasStart, aliasStart + 4).join(' '), consumed: 4 },
    { text: argv.slice(aliasStart, aliasStart + 3).join(' '), consumed: 3 },
    { text: argv.slice(aliasStart, aliasStart + 2).join(' '), consumed: 2 },
  ];
  const match = candidates.find(candidate => NESTED_SPACE_ALIASES[candidate.text]);
  if (!match) {
    return {
      matched: false,
      argv,
      cmd: argv[0],
      arg: argv[1],
      aliasStart,
    };
  }

  const canonicalAlias = NESTED_SPACE_ALIASES[match.text];
  const normalizedArgv = argv.slice();
  normalizedArgv.splice(0, aliasStart + match.consumed, canonicalAlias);
  return {
    matched: true,
    argv: normalizedArgv,
    cmd: canonicalAlias,
    arg: normalizedArgv[1],
    canonicalAlias,
    displayAlias: match.text,
    consumed: match.consumed,
    aliasStart,
  };
}

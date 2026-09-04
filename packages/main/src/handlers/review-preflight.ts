/**
 * review-preflight — CLI gate preflight for the REVIEW→TEST gate.
 *
 * Aggregated invocation before story_advance promotes REVIEW→TEST:
 *   - checkCommitAuthor  (validate-channel.ts)
 *   - checkConcept       (validate-concept.ts)
 *   - checkLint          (validate-lint.ts)
 *   - runDocsDriftGate   (validate-docs-drift.ts)  ← B-805f CHK-002
 *
 * Decision rules (aligned with plan.md CHK-007 DoneWhen):
 *   - channel:    status === 'pass'   → ok; 'skipped' (express channel) → ok; 'fail' → block
 *   - concept:    status === 'pass'   → ok; 'warn' and residuals < 5 → ok;
 *                 'warn'/'fail' and residuals ≥ 5 → require the current REVIEW round to have
 *                 a concept reviewer finding or a review_pass_set record;
 *                 otherwise block (recommendation=dispatch and reviewer not registered)
 *   - lint:       status === 'pass' or 'skipped' → ok; 'fail' → block
 *   - docs-drift: status === 'pass' or 'skipped' → ok; 'fail' → block
 *
 * Express channel (checklist ≤ 2 and riskSignals empty) force-skips the channel/concept/lint/
 * docs-drift/english-artifacts gates (treated as pass), symmetric with the existing "express channel
 * REVIEW reviewer not checked". The codex-adapter gate is the one exception: it is still
 * conditionally evaluated (when the story touches Codex adapter assets) and can block even on the
 * express channel — so "express" skips five of the six gates, not all of them.
 *
 * See docs/reviewer-redesign.md §3 S1 item 7.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { StoryStore } from '../core/store.js';
import {
  checkCommitAuthor,
  isNormalChannel,
  type ChannelCheckResult,
  type GitLogReader,
} from './validate-channel.js';
import {
  checkConcept,
  type ConceptCheckResult,
  type GitDiffReader,
  type GrepReader,
} from './validate-concept.js';
import {
  checkLint,
  resolveChangedFiles,
  type CommandRunner,
  type LintResult,
  type FileExists,
  type FileReader,
  type ChangedFilesReader,
} from './validate-lint.js';
import type { Finding } from '../core/types.js';
import { resolveGitCwd } from '../core/story-signed-workspace-resolution.js';
import { canonicalReviewerLane, findingAgentMatchesReviewer } from '../core/reviewer-opt-in.js';
import { collectReviewerEvidenceState } from '../core/review-run.js';
import {
  runDocsDriftGate,
  type DocsDriftGateResult,
} from './validate-docs-drift.js';
import {
  detectManagedAssetMode,
  detectManagedAssetProfile,
  listManagedAssetDefinitions,
  type ManagedAssetDefinition,
} from '../core/managed-assets.js';
import {
  LOCAL_CODEX_VERIFY_COMMAND,
  resolveLocalCodexVerifyCommand,
  storyRequiresCodexEvidence,
  summarizeCodexEvidence,
} from '../core/codex-adapter-checks.js';
import {
  runEnglishArtifactGate,
  renderEnglishArtifactViolations,
} from './english-artifact-gate.js';

// B-5f42: the english-artifacts gate has no standalone `validate --english-artifacts`
// CLI option — it runs inline as part of the REVIEW→TEST preflight. Give it an
// accurate label so a failing gate does not print a non-existent command. The
// closest standalone re-run is the smoke task that exercises the same guard.
const ENGLISH_ARTIFACTS_GATE_LABEL =
  'english-artifacts (REVIEW→TEST preflight; standalone: npm run test:legacy -- english-only-guards)';

// B-292d: proof-or-stop-residue gate — same shape as english-artifacts. Calls the
// canonical script delivered by B-40eb (`scripts/verify-proof-or-stop-residue.mjs`).
// No standalone `validate --proof-or-stop-residue` flag; standalone re-run is the npm
// script that wraps the same script (kept per user sub-decision a3).
const PROOF_OR_STOP_RESIDUE_GATE_LABEL =
  'proof-or-stop-residue (REVIEW→TEST preflight; standalone: npm run test:proof-or-stop-residue)';
const PROOF_OR_STOP_RESIDUE_SCRIPT_REL = 'scripts/verify-proof-or-stop-residue.mjs';
const PROOF_OR_STOP_RESIDUE_TIMEOUT_MS = 30_000;

interface ProofOrStopResidueGateResult {
  ok: boolean;
  summary: string;
  details: string[];
}

/**
 * B-292d: Run the canonical proof-or-stop-residue script as a preflight gate.
 *
 * Treats exit code 0 as PASS; any non-zero (including timeout / spawn failure)
 * as FAIL. The script's stdout hit list is surfaced verbatim in the gate's
 * `details`, so an operator can see the offending lines without re-running.
 *
 * Pre-mortem mitigations:
 *   - D1 (script changes exit semantics): only exit 0 is PASS.
 *   - D2 (subprocess hang): PROOF_OR_STOP_RESIDUE_TIMEOUT_MS bounds the call.
 *   - D3 (false-fail on benign rename): output prints hit lines verbatim so the
 *     operator can extend the script's allowlist via a follow-up story.
 */
function runProofOrStopResidueGate(projectRoot: string): ProofOrStopResidueGateResult {
  const scriptAbs = join(projectRoot, PROOF_OR_STOP_RESIDUE_SCRIPT_REL);
  if (!existsSync(scriptAbs)) {
    return {
      ok: false,
      summary: `proof-or-stop-residue gate script missing at ${PROOF_OR_STOP_RESIDUE_SCRIPT_REL}`,
      details: [`expected: ${scriptAbs}`],
    };
  }
  try {
    execFileSync('node', [scriptAbs], {
      cwd: projectRoot,
      timeout: PROOF_OR_STOP_RESIDUE_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
    return { ok: true, summary: 'No brand residue in tracked source', details: [] };
  } catch (err) {
    const error = err as { code?: string; signal?: string; stdout?: string; stderr?: string };
    const stdout = (error.stdout ?? '').toString();
    const stderr = (error.stderr ?? '').toString();
    const hits = stdout
      .split('\n')
      .map((s) => s.trimEnd())
      .filter((s) => s.length > 0);
    if (error.code === 'ETIMEDOUT' || error.signal === 'SIGTERM') {
      return {
        ok: false,
        summary: `proof-or-stop-residue gate timed out after ${PROOF_OR_STOP_RESIDUE_TIMEOUT_MS}ms`,
        details: stderr ? [stderr.trim()] : [],
      };
    }
    return {
      ok: false,
      summary: hits.length > 0 ? `brand residue: ${hits.length} hit(s)` : 'proof-or-stop-residue gate failed',
      details: hits.length > 0 ? hits : stderr ? [stderr.trim()] : [],
    };
  }
}

/** Reads CLAUDE.md file contents for docs-drift gate */
export type MdFileReader = (projectRoot: string) => string[];

export interface PreflightDeps {
  store: StoryStore;
  projectRoot: string;
  /** test injection — channel */
  gitLogReader?: GitLogReader;
  /** test injection — concept */
  gitDiffReader?: GitDiffReader;
  grepReader?: GrepReader;
  /** test injection — lint */
  run?: CommandRunner;
  fileExists?: FileExists;
  readFile?: FileReader;
  readdir?: (p: string) => string[];
  stat?: (p: string) => { isDirectory(): boolean; isFile(): boolean };
  /**
   * B-a749 test injection — lint change-scope. Reader of changed files vs base
   * (default `git diff --name-only main...HEAD`). When the reader throws, the
   * lint gate falls back to full recursive tsc (never skip-all).
   */
  changedFilesReader?: ChangedFilesReader;
  /** test injection — docs-drift: registry command names */
  registryNames?: Set<string>;
  /** test injection — docs-drift: CLAUDE.md file reader */
  mdFileReader?: MdFileReader;
}

export interface PreflightGateEntry {
  name: 'channel' | 'concept' | 'lint' | 'docs-drift' | 'codex-adapter' | 'english-artifacts' | 'proof-or-stop-residue' | 'reviewer-evidence';
  ok: boolean;
  status: string;
  summary: string;
  details: string[];
  /** Resolved display label for gate command (replaces hardcoded constant in renderers). */
  commandLabel?: string;
}

export interface PreflightResult {
  ok: boolean;
  /** true if fast-channel story — channel/concept/lint/docs-drift/english-artifacts force-skipped (codex-adapter still conditionally evaluated, can block) */
  fastChannel: boolean;
  channel?: ChannelCheckResult;
  concept?: ConceptCheckResult;
  lint?: LintResult;
  docsDrift?: DocsDriftGateResult;
  gates: PreflightGateEntry[];
}

function reviewerEvidenceAdvisoryGate(
  store: StoryStore,
  storyId: string,
  projectRoot: string,
): PreflightGateEntry | null {
  const evidenceState = collectReviewerEvidenceState(store, storyId, projectRoot);
  const advisories = evidenceState.advisories ?? [];
  if (advisories.length === 0) return null;
  return {
    name: 'reviewer-evidence',
    ok: true,
    status: 'warn',
    summary: `${advisories.length} reviewer evidence material drift advisory${advisories.length === 1 ? '' : 'ies'}`,
    details: advisories.map(issue => issue.message),
    commandLabel: 'reviewer-evidence freshness',
  };
}

/**
 * Determine fast-channel-ness from the same rule used elsewhere
 * (checklist.items.length ≤ 2 AND riskSignals empty). We don't use
 * WorkflowPolicy's quickPath here because quickPath is about "can skip
 * PLAN"; the REVIEW-gate channel rule is explicitly the fixed 2-item /
 * no-risk definition (see CLAUDE.md "Role constraints for the two channels" and
 * validate-channel.ts isNormalChannel).
 */
function detectFastChannel(store: StoryStore, storyId: string): boolean {
  try {
    const story = store.readStory(storyId);
    const checklist = store.readChecklist(storyId);
    const itemCount = checklist?.items?.length ?? 0;
    const riskSignalCount = story.riskSignals?.length ?? 0;
    return !isNormalChannel({ itemCount, riskSignalCount });
  } catch {
    // If we can't determine channel, fail-closed to "normal channel"
    // so the gate is enforced (safer default).
    return false;
  }
}

/**
 * Has the concept reviewer run in the current REVIEW round? This is used
 * to decide whether the concept CLI warn-with-≥5-residuals is "handled"
 * by a reviewer.
 *
 * Rule (F-014 fix): "reviewer ran" = there exists at least one finding with
 * agent=proof-or-stop-review-concept scoped to the current review round — REGARDLESS
 * of status (open / resolved / dismissed). This covers:
 *   - reviewer ran and found real issues (finding registered, any status)
 *   - reviewer ran and found zero real issues (registers 1 info/low-level
 *     placeholder finding to prove it ran; all-false-positive case)
 *
 * The previous implementation required findings to all be closed, which
 * wrongly blocked the "all-false-positive → 0 real findings" case when the
 * reviewer registered no finding at all; it also conflated CLI-gate
 * reviewer-ran check with LLM-finding-resolution (which is enforced by
 * the REVIEW round gate separately). Open / high-severity concept
 * findings are still blocked at the LLM-finding-resolution layer, not here.
 *
 * Short-circuit: if no concept finding at all exists in current round,
 * gate fails — reviewer clearly didn't run (or didn't register placeholder).
 */
function conceptReviewerHandledResiduals(
  store: StoryStore,
  storyId: string,
  projectRoot: string,
): { handled: boolean; reason: string } {
  try {
    const story = store.readStory(storyId);
    const evidenceState = collectReviewerEvidenceState(store, storyId, projectRoot);
    const conceptFindings = evidenceState.valid
      .map((entry) => entry.finding)
      .filter((finding): finding is Finding => !!finding
        && findingAgentMatchesReviewer(finding.agent, 'proof-or-stop-review-concept'));
    const conceptPasses = evidenceState.valid
      .map((entry) => entry.pass)
      .filter((pass) => !!pass && findingAgentMatchesReviewer(pass.agent, 'concept'));
    const conceptIssues = evidenceState.invalid.filter((issue) => findingAgentMatchesReviewer(issue.agent, 'concept'));
    if (conceptFindings.length === 0 && conceptPasses.length === 0) {
      return {
        handled: false,
        reason: conceptIssues[0]?.message
          ?? `No finding/review pass from ${canonicalReviewerLane('concept')} seen in the current REVIEW round (reviewer did not run or did not register any result)`,
      };
    }
    return {
      handled: true,
      reason: `${conceptFindings.length} concept finding(s), ${conceptPasses.length} concept pass(es) registered in round ${story.currentReviewRound ?? '(unknown)'} → reviewer ran`,
    };
  } catch (e: any) {
    return { handled: false, reason: `Failed to read findings: ${String(e?.message ?? e)}` };
  }
}

/** Default CLAUDE.md reader: reads root CLAUDE.md */
function defaultMdFileReader(projectRoot: string): string[] {
  const candidates = [
    join(projectRoot, 'CLAUDE.md'),
  ];
  const contents: string[] = [];
  for (const p of candidates) {
    if (existsSync(p)) {
      contents.push(readFileSync(p, 'utf-8'));
    }
  }
  return contents;
}

/**
 * Run CLI gates and aggregate into one structured result.
 * Express channel → channel/concept/lint/docs-drift/english-artifacts force-skipped (not actually
 * run); the codex-adapter gate is still conditionally evaluated and can block even on express.
 */
export function runReviewCliGates(
  storyId: string,
  deps: PreflightDeps,
): PreflightResult {
  const gates: PreflightGateEntry[] = [];

  const fastChannel = detectFastChannel(deps.store, storyId);
  if (fastChannel) {
    gates.push({
      name: 'channel',
      ok: true,
      status: 'skipped',
      summary: 'Express channel does not check CLI gates',
      details: ['checklist ≤ 2 & riskSignals empty → gates uniformly skipped'],
    });
    gates.push({
      name: 'concept',
      ok: true,
      status: 'skipped',
      summary: 'Express channel does not check CLI gate',
      details: [],
    });
    gates.push({
      name: 'lint',
      ok: true,
      status: 'skipped',
      summary: 'Express channel does not check CLI gate',
      details: [],
    });
    gates.push({
      name: 'docs-drift',
      ok: true,
      status: 'skipped',
      summary: 'Express channel does not check CLI gate',
      details: [],
    });
    gates.push({
      name: 'english-artifacts',
      ok: true,
      status: 'skipped',
      summary: 'Express channel does not check CLI gate',
      details: [],
      commandLabel: ENGLISH_ARTIFACTS_GATE_LABEL,
    });
    gates.push({
      name: 'proof-or-stop-residue',
      ok: true,
      status: 'skipped',
      summary: 'Express channel does not check CLI gate',
      details: [],
      commandLabel: PROOF_OR_STOP_RESIDUE_GATE_LABEL,
    });
    if (storyRequiresCodexEvidence(deps.store, storyId)) {
      const codex = summarizeCodexEvidence(deps.store, storyId, deps.projectRoot);
      const resolvedLabel = resolveLocalCodexVerifyCommand(deps.projectRoot);
      gates.push({
        name: 'codex-adapter',
        ok: codex.status === 'passing',
        status: codex.status,
        summary: codex.detail,
        details: codex.command ? [`run: ${codex.command}`] : [],
        commandLabel: resolvedLabel,
      });
    }
    const reviewerAdvisory = reviewerEvidenceAdvisoryGate(deps.store, storyId, deps.projectRoot);
    if (reviewerAdvisory) gates.push(reviewerAdvisory);
    return { ok: gates.every((g) => g.ok), fastChannel, gates };
  }

  // B-2856: resolve the story's gitRoot once (story context is available here)
  // so the channel/concept git readers run from the real repo in wrapper-root
  // layouts. Null/unresolved → projectRoot fallback (plain repos unchanged).
  const gitCwd = resolveGitCwd({
    store: deps.store,
    storyId,
    metadataRoot: deps.projectRoot,
    projectRoot: deps.projectRoot,
  });

  // ── channel ──
  const channel = checkCommitAuthor(storyId, {
    store: deps.store,
    projectRoot: deps.projectRoot,
    gitCwd,
    gitLogReader: deps.gitLogReader,
  });
  const channelOk = channel.status === 'pass' || channel.status === 'skipped';
  gates.push({
    name: 'channel',
    ok: channelOk,
    status: channel.status,
    summary: channel.summary,
    details: channel.details,
  });

  // ── concept ──
  const concept = checkConcept({
    projectRoot: deps.projectRoot,
    gitCwd,
    gitDiffReader: deps.gitDiffReader,
    grepReader: deps.grepReader,
  });
  let conceptOk: boolean;
  let conceptExtra: string[] = [];
  if (concept.status === 'pass') {
    conceptOk = true;
  } else if (concept.status === 'warn' && concept.residuals.length < 5) {
    // residuals 1..4 → warn, do not block
    conceptOk = true;
  } else if (concept.residuals.length >= 5) {
    // F-017: residuals ≥ 5 is now status='fail' (old implementation was warn).
    // Behavior preserved: requires concept reviewer to have run (reviewer handled → pass).
      const handled = conceptReviewerHandledResiduals(deps.store, storyId, deps.projectRoot);
    conceptOk = handled.handled;
    conceptExtra = [
      `residuals=${concept.residuals.length} (≥5) → concept reviewer needs to handle`,
      handled.reason,
    ];
  } else {
    // Any unknown status → block
    conceptOk = false;
  }
  gates.push({
    name: 'concept',
    ok: conceptOk,
    status: concept.status,
    summary: concept.summary,
    details: [
      ...(concept.deletedSymbols.length > 0
        ? [`deletedSymbols: ${concept.deletedSymbols.join(', ')}`]
        : []),
      ...(concept.residuals.length > 0
        ? [`residuals: ${concept.residuals.length}`]
        : []),
      `recommendation: ${concept.recommendation}`,
      ...conceptExtra,
    ],
  });

  // ── lint ──
  // B-a749: resolve the story's change-scope so out-of-scope packages whose
  // deps are absent are skipped-with-warning rather than hard-failing the
  // REVIEW→TEST lint gate. On resolution failure (reader throws) this returns
  // undefined → checkLint runs full recursive tsc (never skip-all).
  const changedFiles = resolveChangedFiles({
    projectRoot: deps.projectRoot,
    gitCwd,
    changedFilesReader: deps.changedFilesReader,
  });
  const lint = checkLint({
    projectRoot: deps.projectRoot,
    run: deps.run,
    fileExists: deps.fileExists,
    readFile: deps.readFile,
    readdir: deps.readdir,
    stat: deps.stat,
    changedFiles,
  });
  const lintOk = lint.status === 'pass' || lint.status === 'skipped';
  gates.push({
    name: 'lint',
    ok: lintOk,
    status: lint.status,
    summary: lint.summary,
    details: lint.details,
  });

  // ── docs-drift (B-805f CHK-002) ──
  let docsDrift: DocsDriftGateResult | undefined;
  if (deps.registryNames) {
    const mdReader = deps.mdFileReader ?? defaultMdFileReader;
    const mdContents = mdReader(deps.projectRoot);
    // B-a7b0 CHK-002: cross-reference the REAL managed-asset registry. Detect the
    // project's profile + assetMode so listManagedAssetDefinitions returns the
    // assets `proof-or-stop init` would actually generate for this repo. The check is
    // provider-injected — paths are never hardcoded in the gate. A registry-
    // resolution failure degrades to no contradiction check (never crashes the gate).
    let managedAssetDefs: Pick<ManagedAssetDefinition, 'relPath' | 'kind'>[] | undefined;
    // B-a7b0 F-002: registry resolution must fail SOFT (never crash the additive
    // contradiction check), but the degrade must stay OBSERVABLE — an empty catch
    // here would make a silent registry failure indistinguishable from a clean
    // load. Capture the error and fold it into the gate's `details` (same in-result
    // diagnostic convention used elsewhere in this file, e.g. the concept-reviewer
    // read failure at conceptReviewerHandledResiduals) so a reader sees the
    // contradiction check was skipped due to an error, not due to zero contradictions.
    let managedAssetDegrade: string | undefined;
    try {
      const profile = detectManagedAssetProfile(deps.projectRoot);
      const assetMode = detectManagedAssetMode(deps.projectRoot);
      managedAssetDefs = listManagedAssetDefinitions(
        profile,
        undefined,
        deps.projectRoot,
        assetMode,
      );
    } catch (e) {
      managedAssetDefs = undefined;
      managedAssetDegrade = `managed-asset registry unavailable (contradiction check skipped): ${
        e instanceof Error ? e.message : String(e)
      }`;
      // Also surface on stderr (advisory-warning convention, cf. checklist.ts) so
      // the degrade is visible even though the soft-degraded gate stays ok and the
      // renderer only prints gate `details` for failed gates.
      process.stderr.write(`⚠ docs-drift: ${managedAssetDegrade}\n`);
    }
    // B-a7b0 CHK-001: pass repoRoot so the gate also runs path-reference drift
    // (using DOCS_DRIFT_PATH_ALLOWLIST by default). When repoRoot is absent the
    // gate degrades to the command-only check (backward compatible).
    // B-f882 CHK-001: repoRoot must be the resolved gitCwd (same value threaded
    // into the channel/concept/english git-invoking gates), NOT deps.projectRoot.
    // On wrapper-root layouts (metadataRoot != gitRoot) scanPathDrift runs
    // fs.existsSync + `git grep` from repoRoot; using projectRoot (metadataRoot)
    // there made existing paths look absent → false missing-path drift → false
    // REVIEW→TEST block. Plain repos (projectRoot == gitCwd) are byte-identical.
    docsDrift = runDocsDriftGate(mdContents, deps.registryNames, {
      repoRoot: gitCwd,
      managedAssetDefs,
    });
    const docsDriftOk = docsDrift.status === 'pass' || docsDrift.status === 'skipped';
    gates.push({
      name: 'docs-drift',
      ok: docsDriftOk,
      status: docsDrift.status,
      summary: docsDrift.summary,
      details: [
        ...(managedAssetDegrade ? [managedAssetDegrade] : []),
        ...(docsDrift.missing.length > 0
          ? [`missing: ${docsDrift.missing.join(', ')}`]
          : []),
        ...docsDrift.missingPaths.map((p) => `missing path: ${p}`),
        ...docsDrift.managedAssetContradictions.map(
          (c) => `managed-asset contradiction: ${c.asset} (${c.kind})`,
        ),
        ...(docsDrift.stale.length > 0
          ? [`stale (advisory): ${docsDrift.stale.join(', ')}`]
          : []),
      ],
    });
  } else {
    // No registry names provided — skip gate (backwards compatible)
    gates.push({
      name: 'docs-drift',
      ok: true,
      status: 'skipped',
      summary: 'registry command name not provided, skipping docs-drift check',
      details: [],
    });
  }

  // ── english-artifacts (B-5f42 CHK-002) ──
  // Diff/story-scoped CJK gate: this branch's commit messages + the current
  // story's author-controlled metadata must be English. Legacy Chinese outside
  // this story / branch is never scanned. Never throws — git/fs failures degrade
  // to notes, not a block.
  const storyDir = deps.store.storyDirPath(storyId);
  const englishArtifacts = runEnglishArtifactGate({ storyDir, gitCwd });
  gates.push({
    name: 'english-artifacts',
    ok: englishArtifacts.ok,
    status: englishArtifacts.ok ? 'pass' : 'fail',
    summary: englishArtifacts.ok
      ? 'No non-English (CJK) text in this branch\'s commits or story metadata'
      : `Non-English (CJK) text found in ${englishArtifacts.violations.length} artifact line(s)`,
    details: [
      ...renderEnglishArtifactViolations(englishArtifacts.violations),
      ...englishArtifacts.notes,
    ],
    commandLabel: ENGLISH_ARTIFACTS_GATE_LABEL,
  });

  // ── proof-or-stop-residue (B-292d) ──
  // Run the canonical B-40eb script as a structured preflight gate.
  // Non-zero exit BLOCKs story_advance to TEST; stdout hit list is surfaced.
  const proofOrStopResidue = runProofOrStopResidueGate(deps.projectRoot);
  gates.push({
    name: 'proof-or-stop-residue',
    ok: proofOrStopResidue.ok,
    status: proofOrStopResidue.ok ? 'pass' : 'fail',
    summary: proofOrStopResidue.summary,
    details: proofOrStopResidue.details,
    commandLabel: PROOF_OR_STOP_RESIDUE_GATE_LABEL,
  });

  if (storyRequiresCodexEvidence(deps.store, storyId)) {
    const codex = summarizeCodexEvidence(deps.store, storyId, deps.projectRoot);
    const resolvedLabel = resolveLocalCodexVerifyCommand(deps.projectRoot);
    gates.push({
      name: 'codex-adapter',
      ok: codex.status === 'passing',
      status: codex.status,
      summary: codex.detail,
      details: codex.command ? [`run: ${codex.command}`] : [],
      commandLabel: resolvedLabel,
    });
  }
  const reviewerAdvisory = reviewerEvidenceAdvisoryGate(deps.store, storyId, deps.projectRoot);
  if (reviewerAdvisory) gates.push(reviewerAdvisory);

  const ok = gates.every((g) => g.ok);
  return { ok, fastChannel, channel, concept, lint, docsDrift, gates };
}

/**
 * Render PreflightResult into a human-readable string (used by story_advance error messages).
 */
export function renderPreflight(result: PreflightResult): string {
  const lines: string[] = [];
  lines.push(
    result.fastChannel
      ? 'REVIEW→TEST CLI gate preflight (express channel, CLI gates skipped):'
      : 'REVIEW→TEST CLI gate preflight:',
  );
  for (const g of result.gates) {
    const icon = g.ok ? (g.status === 'warn' ? '!' : '✓') : '✗';
    const commandLabel = g.commandLabel ?? (g.name === 'codex-adapter' ? LOCAL_CODEX_VERIFY_COMMAND : `validate --${g.name}`);
    lines.push(`  [${icon}] ${commandLabel}: ${g.status} — ${g.summary}`);
    if (g.details.length > 0 && (!g.ok || g.status === 'warn')) {
      for (const d of g.details.slice(0, 20)) {
        lines.push(`        ${d}`);
      }
    }
  }
  return lines.join('\n');
}

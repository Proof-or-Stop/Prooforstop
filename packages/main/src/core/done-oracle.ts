/**
 * B-37e9 DONE Oracle Extraction: buildDoneChecklist + DONE row assembly.
 *
 * This module is the single source of truth for the DONE gate checklist.
 * Both the DONE gate (handlers/phase-gates.ts, reached via
 * handlers/transition-orchestrator.ts) and the session_brief DONE pre-check
 * (handlers/session.ts) consume buildDoneChecklist from here — a same-source
 * contract test (tasks/flow-stability-smoke.ts) proves they render
 * byte-identical rows for the same story state.
 *
 * The function bodies were mechanically relocated from story-advance.ts with
 * zero semantic change — row order, status, blocking, and label logic are
 * byte-identical. This module must NOT import from handlers/story-advance.js
 * (no circular import — preMortem #2).
 */

import { execFileSync, execSync } from 'child_process';
import type { ChecklistData, StoryPhase, TestEvidenceData } from './types.js';
import type { StoryStore } from './store.js';
import { loadConfig } from './config.js';
import { resolveWorkflowPolicy } from './workflow-policy.js';
import { evaluateDeclaredArtifactReferences } from './declared-artifact-gate.js';
import {
  evaluateDeclaredArtifactCommitState,
  gitDeclaredArtifactPathState,
  describeDeclaredArtifactCommitStatus,
} from './declared-artifact-commit-check.js';
import type { OracleRow } from './oracle-row.js';
import {
  classifyGitStatusRows,
  dirtyWorktreeClassifierOptionsForStory,
  dirtyWorktreeClassifierOptionsFromConfig,
  renderDirtyWorktreeGroups,
} from './dirty-worktree.js';
import { defaultAuditWriter, evaluateDirtyGate, type AuditWriter, type DirtyGateName, type EvaluateDirtyGateResult } from './dirty-gate-policy.js';
import { checkEvidenceFreshnessForGit, currentMaterialHash } from './evidence-freshness.js';
import { recomputeDeliveryCheckHash } from './delivery-check-hash.js';
import {
  summarizeCodexEvidence,
  storyRequiresCodexEvidence,
} from './codex-adapter-checks.js';
import {
  evaluateReviewEscalation,
  formatReviewEscalationFailure,
} from './review-escalation.js';

// B-c622 CHK-004: DONE phase auto-syncs main — detect divergence + auto merge main

/**
 * Check how many commits main has that the current branch doesn't.
 *
 * B-6666 CHK-001: the parameter is the resolved git cwd (wrapper-root aware),
 * not the bare metadataRoot. Callers thread `resolveGitCwd(...)` here; plain
 * repos pass projectRoot==gitCwd so behavior is byte-identical.
 */
export function checkMainDivergence(gitCwd: string): { behind: number; needsSync: boolean } {
  try {
    const result = execSync('git rev-list --count HEAD..main', {
      cwd: gitCwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    const behind = parseInt(result, 10) || 0;
    return { behind, needsSync: behind > 0 };
  } catch {
    return { behind: 0, needsSync: false };
  }
}

// B-6666 CHK-001: gitCwd is the resolved git cwd (wrapper-root aware). On a
// wrapper-root layout the bare metadataRoot is not a git repo, so reading
// `git status` from it errors -> the git-working-tree DONE row falsely blocks.
function readGitStatusLines(gitCwd: string): { ok: true; lines: string[] } | { ok: false; error: string } {
  try {
    const raw = execSync('git status --porcelain=v1 --untracked-files=all', {
      cwd: gitCwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { ok: true, lines: raw.split('\n').map(line => line.trimEnd()).filter(Boolean) };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}

// Task B-6326: DONE gate dirty output uses the shared ownership classifier.
// Task B-cf60: when a storyId/store is available, mix in declaredArtifactPaths from the
// per-story declared-artifacts.json so declared paths flip from unexpected → declared.
function classifierOptionsForCheck(
  config: ReturnType<typeof loadConfig>,
  storyId: string | undefined,
  store: StoryStore | undefined,
  projectRoot?: string,
) {
  if (storyId && store) {
    return dirtyWorktreeClassifierOptionsForStory(config, storyId, store, projectRoot);
  }
  return dirtyWorktreeClassifierOptionsFromConfig(config, projectRoot);
}

// Task B-4b22: dirty git-working-tree row uses the shared dirty-gate-policy
// evaluator (single source of truth). Both summary (row.detail) and hint
// (row.hint) derive from the same EvaluateDirtyGateResult so divergent wording
// is impossible by construction (preMortem #3 anchor).
function evaluateDirtyGitStatus(
  lines: string[],
  config: ReturnType<typeof loadConfig>,
  storyId: string | undefined,
  store: StoryStore | undefined,
  gate: DirtyGateName,
  root: string,
  auditWriter?: AuditWriter | null,
): { classification: ReturnType<typeof classifyGitStatusRows>; result: EvaluateDirtyGateResult } {
  const classification = classifyGitStatusRows(lines, classifierOptionsForCheck(config, storyId, store, root));
  // Writer is wired only when storyId+store are available (so we know where to
  // append). storyId-less paths (e.g. anonymous status snapshots) skip audit
  // intentionally and pass null writer to the evaluator.
  const writer = storyId
    ? (auditWriter === undefined
      ? defaultAuditWriter(root, store ? store.storyDirRel() : config.storyDir, storyId)
      : auditWriter)
    : null;
  const result = evaluateDirtyGate(classification, {
    storyId: storyId ?? 'anonymous',
    gate,
    writer,
  });
  return { classification, result };
}

function gitRefExists(gitCwd: string, ref: string): boolean {
  try {
    execFileSync('git', ['rev-parse', '--verify', `${ref}^{commit}`], {
      cwd: gitCwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
}

function gitRefContainsMain(gitCwd: string, ref: string): boolean {
  execFileSync('git', ['merge-base', '--is-ancestor', 'main', ref], {
    cwd: gitCwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return true;
}

function checkCompletedEvidenceSnapshotFreshness(
  projectRoot: string,
  evidence: TestEvidenceData,
): { fresh: boolean; message: string } {
  if (!evidence.headHash) {
    return { fresh: false, message: 'DONE test-evidence is missing headHash; cannot inspect recorded evidence snapshot' };
  }
  if (!evidence.materialHash) {
    return { fresh: false, message: 'DONE test-evidence is missing materialHash; cannot validate recorded evidence snapshot' };
  }

  const recordedMaterialHash = currentMaterialHash(projectRoot, evidence.headHash);
  if (!recordedMaterialHash) {
    return {
      fresh: false,
      message: `recorded evidence head ${evidence.headHash.slice(0, 7)} cannot be inspected`,
    };
  }
  if (recordedMaterialHash !== evidence.materialHash) {
    return {
      fresh: false,
      message: `recorded evidence materialHash does not match material tree at ${evidence.headHash.slice(0, 7)}`,
    };
  }

  return {
    fresh: true,
    message: `evidence materialHash matches recorded evidence snapshot @ ${evidence.headHash.slice(0, 7)}`,
  };
}

// B-c622 CHK-009: active DONE-entry verifies current HEAD; completed DONE projections verify recorded snapshot.
function checkEvidenceFreshness(store: StoryStore, storyId: string, projectRoot: string, phase?: StoryPhase): { fresh: boolean; message: string } {
  const evidence = store.readTestEvidence(storyId);
  if (!evidence) return { fresh: false, message: 'test-evidence.json does not exist' };
  if (phase === 'DONE') {
    return checkCompletedEvidenceSnapshotFreshness(projectRoot, evidence);
  }
  const freshness = checkEvidenceFreshnessForGit(projectRoot, evidence.headHash, evidence.materialHash);
  return { fresh: freshness.fresh, message: freshness.reason };
}

/**
 * DONE Final Checklist: gather all DONE phase verification items into an explicit checklist.
 * Print regardless of whether advance succeeds or fails, forcing main agent to read multi-layer verification status.
 */
export type DoneCheckRow = OracleRow;

export interface BuildDoneChecklistOptions {
  /**
   * Defaults to the production dirty-gate audit writer. Pass null for
   * read-only projections such as done_closure; the DONE gate itself keeps the
   * default so audit-write failures still block completion.
   */
  auditWriter?: AuditWriter | null;
  /**
   * B-6666 CHK-001: the resolved git invocation cwd (wrapper-root aware),
   * threaded from the DONE pre-merge gate boundary (transition-orchestrator.ts
   * resolveGitCwd, resolved ONCE). ONLY the git probes (status / refs /
   * divergence / diff) use this; `root` (metadataRoot) still drives every
   * config/store/audit read. When absent it falls back to `root`, so plain
   * repos (projectRoot==gitCwd) and read-only projections stay byte-identical.
   */
  gitCwd?: string;
}

function doneCheckRow(row: Omit<DoneCheckRow, 'blocking'> & { blocking?: boolean }): DoneCheckRow {
  return {
    blocking: row.blocking ?? row.status === 'fail',
    ...row,
  };
}

export function buildDoneChecklist(storyId: string, store: StoryStore, root: string, options: BuildDoneChecklistOptions = {}): DoneCheckRow[] {
  const rows: DoneCheckRow[] = [];

  // B-6666 CHK-001: the cwd for every git probe below. Falls back to `root`
  // (metadataRoot) when no resolved gitCwd is threaded, so plain repos and
  // read-only projections stay byte-identical. `root` is still used for all
  // config/store/audit reads — ONLY git invocation cwd changes.
  const gitCwd = options.gitCwd ?? root;

  // Resolve workflow policy for policy-aware gates
  const config = loadConfig(root);
  const storyForPolicy = store.readStory(storyId);
  const policy = resolveWorkflowPolicy(config, storyForPolicy);

  // 1. test evidence
  const evidence = store.readTestEvidence(storyId);
  if (!evidence) {
    rows.push(doneCheckRow({
      id: 'test-evidence',
      status: 'fail',
      label: 'Test evidence',
      detail: 'no test evidence',
      hint: `lattice validate --json`,
      source: 'test-evidence.json',
    }));
  } else if (evidence.result !== 'PASS') {
    rows.push(doneCheckRow({
      id: 'test-evidence',
      status: 'fail',
      label: 'Test evidence',
      detail: `${evidence.result}: ${evidence.output.slice(0, 120)}`,
      hint: 'rerun lattice validate after fixing failures',
      source: 'test-evidence.json',
    }));
  } else {
    let allPassedOk = true;
    try {
      const parsed = JSON.parse(evidence.output);
      if (parsed.allPass !== true && parsed.allPassed !== true) {
        allPassedOk = false;
        rows.push(doneCheckRow({
          id: 'test-evidence',
          status: 'fail',
          label: 'Test evidence',
          detail: `allPassed=${parsed.allPass ?? parsed.allPassed}`,
          hint: 'rerun lattice validate after fixing failures',
          source: 'test-evidence.json',
        }));
      }
    } catch { /* output is not JSON, also counts as PASS (compatible with old format) */ }
    if (allPassedOk) {
      rows.push(doneCheckRow({
        id: 'test-evidence',
        status: 'pass',
        label: 'Test evidence',
        detail: `PASS @ ${evidence.timestamp}`,
        source: 'test-evidence.json',
      }));
    }
    if (evidence.verificationCoverage) {
      const vc = evidence.verificationCoverage;
      rows.push(doneCheckRow({
        id: 'verification-intent-coverage',
        status: vc.missingRequired > 0 ? 'fail' : 'pass',
        label: 'Verification intent coverage',
        detail: `${vc.covered}/${vc.total} covered, ${vc.missingRequired} required missing`,
        hint: vc.entries
          .filter(e => e.priority === 'must' && !['covered', 'waived'].includes(e.status))
          .map(e => `${e.intentRef} [${e.status}] ${e.desc}`)
          .join('\n'),
        source: 'test-evidence.json.verificationCoverage',
      }));
    }
  }

  // 1b. evidence freshness (B-c622 CHK-009)
  // B-6666 CHK-001: pass the resolved gitCwd at this boundary so the DONE-path
  // freshness git probe shares the same gitRoot as the git-status row (no
  // split-brain). The evidence-freshness.ts internals (its own no-op gitCwd
  // alias) are CHK-002; this only routes the resolved cwd to the call boundary.
  const freshness = checkEvidenceFreshness(store, storyId, gitCwd, storyForPolicy.phase);
  if (!freshness.fresh) {
    rows.push(doneCheckRow({
      id: 'evidence-freshness',
      status: 'fail',
      label: 'Evidence freshness',
      detail: freshness.message,
      hint: 'lattice validate --json',
      source: 'test-evidence.json',
    }));
  } else {
    rows.push(doneCheckRow({
      id: 'evidence-freshness',
      status: 'pass',
      label: 'Evidence freshness',
      detail: freshness.message,
      source: 'test-evidence.json',
    }));
  }

  // 2. all bugs fixed
  const bugData = store.readBugs(storyId);
  const total = bugData.bugs.length;
  const openBugs = bugData.bugs.filter(b => b.status === 'open');
  if (openBugs.length > 0) {
    rows.push(doneCheckRow({
      id: 'bugs-fixed',
      status: 'fail',
      label: 'Bugs fixed',
      detail: `${openBugs.length} open / ${total} total: ${openBugs.map(b => b.id).join(', ')}`,
      hint: 'rerun lattice validate after fixing all open bugs',
      source: 'bugs.json',
    }));
  } else {
    rows.push(doneCheckRow({
      id: 'bugs-fixed',
      status: 'pass',
      label: 'Bugs fixed',
      detail: total > 0 ? `${total}/${total}` : 'no bugs',
      source: 'bugs.json',
    }));
  }

  // 3. git working tree clean (B-4b22: category-aware via dirty-gate-policy)
  // B-6666 CHK-001: read git status from the resolved gitCwd, not bare root.
  const gitStatus = readGitStatusLines(gitCwd);
  if (gitStatus.ok && gitStatus.lines.length === 0) {
    rows.push(doneCheckRow({
      id: 'git-working-tree',
      status: 'pass',
      label: 'git working tree',
      detail: 'clean',
      source: 'git status --porcelain',
    }));
  } else if (gitStatus.ok) {
    // Task B-4b22: evaluate via shared policy; status follows allPass.
    // Both detail and hint derive from the same EvaluateDirtyGateResult so
    // wording stays consistent (preMortem #3 anchor — no inline category
    // check; consumer-side divergence is structurally impossible).
    const { classification, result } = evaluateDirtyGitStatus(
      gitStatus.lines,
      config,
      storyId,
      store,
      'done-gate',
      root,
      options.auditWriter,
    );
    const detail = result.allPass ? `pass: ${result.summary}` : `fail: ${result.summary}`;
    const hintHeader = result.auditFailure
      ? result.auditFailure
      : (result.allPass
        ? 'all dirty paths matched passing categories; audit lines appended to process-events.jsonl'
        : 'First handle these dirty paths (classified by ownership; dirty still blocks DONE):');
    const hintLines = [
      hintHeader,
      `  ${result.summary}`,
      ...renderDirtyWorktreeGroups(classification, { sampleLimit: 6, indent: '  ' }),
    ];
    if (!result.allPass) {
      hintLines.push('If these files come from lattice validate / npm test report or snapshot side effects, change project verification to be side-effect-free by default, or use an env gate (e.g. LATTICE_WRITE_*_REPORT=1) to explicitly enable report writing.');
    }
    const hint = hintLines.join('\n');
    rows.push(doneCheckRow({
      id: 'git-working-tree',
      status: result.allPass ? 'pass' : 'fail',
      label: 'git working tree',
      detail,
      hint,
      source: 'git status --porcelain',
    }));
  } else {
    rows.push(doneCheckRow({
      id: 'git-working-tree',
      status: 'fail',
      label: 'git working tree',
      detail: `unable to read git status: ${gitStatus.error}`,
      hint: 'confirm current directory is a git worktree, fix git status, and rerun DONE gate',
      source: 'git status --porcelain',
    }));
  }

  // 4. branch synced with main (B-c622 CHK-004: add divergence detection hint)
  try {
    const story = store.readStory(storyId);
    if (story.worktree?.branch) {
      const branch = story.worktree.branch;
      if (!gitRefExists(gitCwd, branch)) {
        rows.push({
          id: 'branch-synced-main',
          status: 'warn',
          label: 'Branch synced with main',
          detail: `${branch} does not exist (may have been manually merged and cleaned up)`,
          hint: `if story is still stuck at TEST/DONE boundary, use lattice story_reconcile '{"dryRun":false}' to repair phase/worktree metadata`,
          source: 'git worktree metadata',
          blocking: false,
        });
      } else {
        try {
          gitRefContainsMain(gitCwd, branch);
          rows.push(doneCheckRow({
            id: 'branch-synced-main',
            status: 'pass',
            label: 'Branch synced with main',
            detail: branch,
            source: 'git merge-base --is-ancestor main',
          }));
        } catch {
          const divergence = checkMainDivergence(gitCwd);
          rows.push(doneCheckRow({
            id: 'branch-synced-main',
            status: 'fail',
            label: 'Branch synced with main',
            detail: divergence.needsSync
              ? `${branch} is behind main by ${divergence.behind} commits`
              : `${branch} has not merged main's latest commits`,
            hint: 'Will automatically attempt git merge main when advancing to DONE; resolve any conflicts manually',
            source: 'git merge-base --is-ancestor main',
          }));
        }
      }
    } else {
      // No worktree branch recorded — detect from git directly
      const divergence = checkMainDivergence(gitCwd);
      if (divergence.needsSync) {
        rows.push(doneCheckRow({
          id: 'branch-synced-main',
          status: 'fail',
          label: 'Branch synced with main',
          detail: `Current branch is behind main by ${divergence.behind} commits`,
          hint: 'Will automatically attempt git merge main when advancing to DONE; resolve any conflicts manually',
          source: 'git rev-list HEAD..main',
        }));
      } else {
        rows.push(doneCheckRow({
          id: 'branch-synced-main',
          status: 'pass',
          label: 'Branch synced with main',
          detail: 'up to date',
          source: 'git rev-list HEAD..main',
        }));
      }
    }
  } catch { /* Failure to read story does not block; guard has already reported the error */ }

  // 5. relatedDocs (advisory, warn does not affect the verdict)
  try {
    const cl = store.readChecklist(storyId);
    const allDocs = new Map<string, string[]>();
    for (const it of cl.items) {
      const docs = it.relatedDocs;
      if (Array.isArray(docs)) {
        for (const d of docs) {
          if (!allDocs.has(d)) allDocs.set(d, []);
          allDocs.get(d)!.push(it.id);
        }
      }
    }
    if (allDocs.size > 0) {
      let changedFiles = new Set<string>();
      // B-6666 CHK-001: use the resolved gitCwd threaded into buildDoneChecklist
      // (no inner no-op `const gitCwd = root` alias) so wrapper-root layouts
      // resolve the diff against the real gitRoot.
      try {
        const out = execSync('git diff main...HEAD --name-only', {
          cwd: gitCwd,
          encoding: 'utf8',
          timeout: 5000,
          stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();
        if (out) changedFiles = new Set(out.split('\n'));
      } catch { /* ignore */ }
      const unchanged: Array<[string, string[]]> = [];
      for (const [doc, items] of allDocs.entries()) {
        if (!changedFiles.has(doc.split('#')[0])) unchanged.push([doc, items]);
      }
      if (unchanged.length > 0) {
        rows.push(doneCheckRow({
          id: 'related-docs',
          status: 'warn',
          label: 'relatedDocs',
          detail: `${unchanged.length}/${allDocs.size} untouched (advisory)`,
          hint: unchanged.map(([d, items]) => `${d}  (${items.join(', ')})`).join('\n'),
          source: 'checklist.relatedDocs',
          blocking: false,
        }));
      } else {
        rows.push(doneCheckRow({
          id: 'related-docs',
          status: 'pass',
          label: 'relatedDocs',
          detail: `${allDocs.size}/${allDocs.size} touched`,
          source: 'checklist.relatedDocs',
          blocking: false,
        }));
      }
    }
  } catch { /* ignore */ }

  // 6. delivery-check.json (hard gate, mirrors machine.canFinish / getGuardFailureReason)
  const deliveryCheck = store.readDeliveryCheck(storyId);
  if (!deliveryCheck) {
    rows.push(doneCheckRow({
      id: 'delivery-check',
      status: 'fail',
      label: 'delivery-check',
      detail: 'Missing delivery-check.json (requires lattice-review-delivery reviewer signature)',
      hint: 'Run the lattice-review-delivery reviewer and use delivery_check_set to write the signed artifact. Fallback is compliant only with lattice-review-delivery provenance / agentId=lattice-review-delivery; the main agent must not self-sign.',
      source: 'delivery-check.json',
    }));
  } else {
    const expectedHash = recomputeDeliveryCheckHash(storyId, store);
    if (expectedHash === null || deliveryCheck._hash !== expectedHash) {
      rows.push(doneCheckRow({
        id: 'delivery-check',
        status: 'fail',
        label: 'delivery-check',
        detail: 'delivery-check.json _hash mismatch',
        hint: 'Re-run the lattice-review-delivery reviewer to generate a new delivery-check.json',
        source: 'delivery-check.json._hash',
      }));
    } else {
      const unverified = deliveryCheck.docsPromises.filter(
        p => !p.verifiedBy && !p.waiverReason && !['met', 'verified', 'waived'].includes(p.status || ''),
      );
      if (unverified.length > 0) {
        rows.push(doneCheckRow({
          id: 'delivery-check',
          status: 'fail',
          label: 'delivery-check',
          detail: `${unverified.length} docsPromise entries are unverified and not waived`,
          hint: 'Use delivery_waiver_add to write a waiver, or re-run the lattice-review-delivery reviewer to add verification evidence',
          source: 'delivery-check.json.docsPromises',
        }));
      } else {
        rows.push(doneCheckRow({
          id: 'delivery-check',
          status: 'pass',
          label: 'delivery-check',
          detail: `${deliveryCheck.docsPromises.length} docsPromises checked`,
          source: 'delivery-check.json.docsPromises',
        }));
      }
    }
  }

  // 6b. declared-artifacts referenced (B-cf60 CHK-003): every entry's
  //     relatedIntent must resolve to a real verificationIntent slot or
  //     delivery-check docsPromise. Bogus intentRefs (e.g. X-001:happy:0)
  //     fail here — preMortem #2 anchor.
  {
    const declared = store.readDeclaredArtifacts(storyId);
    if (declared.entries.length === 0) {
      rows.push(doneCheckRow({
        id: 'declared-artifacts-referenced',
        status: 'pass',
        label: 'declared artifacts referenced',
        detail: '0/0 (no declarations)',
        source: 'declared-artifacts.json',
        blocking: false,
      }));
    } else {
      let checklistData: ChecklistData | null = null;
      try { checklistData = store.readChecklist(storyId); } catch { /* no checklist */ }
      const refResult = evaluateDeclaredArtifactReferences(declared, checklistData, deliveryCheck);
      const referenced = refResult.total - refResult.unreferenced.length;
      if (refResult.unreferenced.length > 0) {
        const unrefDetails = refResult.unreferenced
          .map(u => `${u.path} (relatedIntent=${u.relatedIntent || '<empty>'})`)
          .join('\n');
        rows.push(doneCheckRow({
          id: 'declared-artifacts-referenced',
          status: 'fail',
          label: 'declared artifacts referenced',
          detail: `${referenced}/${refResult.total} (unreferenced: ${refResult.unreferenced.length})`,
          hint:
            '[unreferenced_declared_artifact] The relatedIntent of the following declared artifacts does not point to any verificationIntent or delivery-check docsPromise; ' +
            'use verification_evidence_add to add evidence, change relatedIntent to an existing intentRef, or use delivery_check_set / delivery_waiver_add to add a docsPromise:\n' +
            unrefDetails,
          source: 'declared-artifacts.json',
        }));
      } else {
        rows.push(doneCheckRow({
          id: 'declared-artifacts-referenced',
          status: 'pass',
          label: 'declared artifacts referenced',
          detail: `${refResult.total}/${refResult.total}`,
          source: 'declared-artifacts.json',
          blocking: false,
        }));
      }
    }
  }

  // 6c. declared-artifacts committed (B-8db9 CHK-003): declared_artifact_changes
  //     is blocking:false in dirty-gate-policy so an uncommitted declared
  //     artifact passes the DONE dirty gate — but `git merge` does not carry
  //     uncommitted files into main, so the declared deliverable vanishes
  //     silently. This DONE-only row requires every declared path to be
  //     committed-and-clean or absent. It does NOT touch dirty-gate-policy —
  //     REVIEW/TEST keep treating declared_artifact_changes as non-blocking.
  {
    const declaredForCommit = store.readDeclaredArtifacts(storyId);
    const declaredPaths = declaredForCommit.entries
      .map((e) => (typeof e?.path === 'string' ? e.path.trim() : ''))
      .filter((p) => p.length > 0);
    if (declaredPaths.length === 0) {
      rows.push(doneCheckRow({
        id: 'declared-artifacts-committed',
        status: 'pass',
        label: 'declared artifacts committed',
        detail: '0/0 (no declarations)',
        source: 'declared-artifacts.json',
        blocking: false,
      }));
    } else {
      const commitResult = evaluateDeclaredArtifactCommitState(
        declaredPaths,
        (path) => gitDeclaredArtifactPathState(root, path),
      );
      if (commitResult.blockers.length > 0) {
        const uncommitted = commitResult.blockers
          .filter((b) => b.status !== 'git-ignored')
          .map((b) => b.path);
        const ignored = commitResult.blockers
          .filter((b) => b.status === 'git-ignored')
          .map((b) => b.path);
        const hintLines: string[] = [];
        if (uncommitted.length > 0) {
          hintLines.push(
            `[uncommitted_declared_artifact] The following declared artifacts are not committed and will not be carried into main by git merge:`,
            ...uncommitted.map((p) => `  ${p}`),
            '→ If it is a deliverable, please commit it; if it is a temporary output, delete it and remove the declaration (artifact_declare only declares generated outputs that are truly meant to be delivered).',
          );
        }
        if (ignored.length > 0) {
          hintLines.push(
            `[gitignored_declared_artifact] The following declared artifacts are ignored by .gitignore and can never be committed:`,
            ...ignored.map((p) => `  ${p}`),
            '→ git-ignored paths must not be declared as deliverable artifacts; please declare a committable path instead, or remove the declaration.',
          );
        }
        const detailParts = commitResult.blockers
          .map((b) => `${b.path} [${describeDeclaredArtifactCommitStatus(b.status)}]`);
        rows.push(doneCheckRow({
          id: 'declared-artifacts-committed',
          status: 'fail',
          label: 'declared artifacts committed',
          detail: `${commitResult.ok}/${commitResult.total} (uncommitted: ${detailParts.join(', ')})`,
          hint: hintLines.join('\n'),
          source: 'declared-artifacts.json',
        }));
      } else {
        rows.push(doneCheckRow({
          id: 'declared-artifacts-committed',
          status: 'pass',
          label: 'declared artifacts committed',
          detail: `${commitResult.ok}/${commitResult.total}`,
          source: 'declared-artifacts.json',
          blocking: false,
        }));
      }
    }
  }

  // 6d. review escalation quorum. Ordinary documentation/decision-doc edits do
  //     not trigger this gate by themselves; the trigger is mechanical: the
  //     first REVIEW round recorded at least two countable verified reviewer
  //     problems. When triggered, DONE requires full 3x2 host quorum or explicit
  //     degraded 3x1 fallback over the current material hash.
  {
    const escalation = evaluateReviewEscalation({
      projectRoot: root,
      storyId,
      store,
    });
    rows.push(doneCheckRow({
      id: 'review-escalation',
      status: escalation.ok ? 'pass' : 'fail',
      label: 'Review escalation',
      detail: escalation.required
        ? `${escalation.assuranceLevel}; first-round problems ${escalation.trigger.countableProblems.length}/${escalation.trigger.requiredProblemCount}`
        : `not required; first-round problems ${escalation.trigger.countableProblems.length}/${escalation.trigger.requiredProblemCount}`,
      hint: escalation.ok ? 'review escalation satisfied or not required' : formatReviewEscalationFailure(escalation),
      source: 'findings.json + process-events.jsonl:host_verdict',
      blocking: escalation.required && !escalation.ok,
    }));
  }

  // 7. evaluator evidence (policy-aware: hard gate or advisory depending on profile)
  if (config.browser?.devCommand) {
    const requireEval = policy.test.requireEvaluatorForBrowser;
    const evalEvidence = store.readEvalEvidence(storyId);
    if (!evalEvidence) {
      rows.push(doneCheckRow({
        id: 'eval-evidence',
        status: requireEval ? 'fail' : 'warn',
        label: 'Evaluator',
        detail: requireEval
          ? 'No evaluator score (browser projects must run the evaluator)'
          : 'No evaluator score (advisory — not required by profile)',
        hint: `lattice evaluate '{"storyId":"${storyId}"}'`,
        source: 'eval-evidence.json',
        blocking: requireEval,
      }));
    } else if (!evalEvidence.pass) {
      rows.push(doneCheckRow({
        id: 'eval-evidence',
        status: requireEval ? 'fail' : 'warn',
        label: 'Evaluator',
        detail: `Did not pass: functionality=${evalEvidence.scores.functionality} usability=${evalEvidence.scores.usability} total=${evalEvidence.total}`,
        hint: 'Re-run lattice evaluate after fixing the issues found by evaluator',
        source: 'eval-evidence.json',
        blocking: requireEval,
      }));
    } else {
      rows.push(doneCheckRow({
        id: 'eval-evidence',
        status: 'pass',
        label: 'Evaluator',
        detail: `functionality=${evalEvidence.scores.functionality} usability=${evalEvidence.scores.usability} total=${evalEvidence.total} @ ${evalEvidence.timestamp}`,
        source: 'eval-evidence.json',
        blocking: false,
      }));
    }
  }

  // 8. summary.json (policy-aware: 'full' = hard gate, 'minimal' = warn, 'none' = skip)
  const summaryReq = policy.done.requireSummary;
  if (summaryReq !== 'none') {
    const summary = store.readSummary(storyId);
    if (!summary) {
      rows.push(doneCheckRow({
        id: 'story-summary',
        status: summaryReq === 'full' ? 'fail' : 'warn',
        label: 'Story summary',
        detail: summaryReq === 'full'
          ? 'No summary.json'
          : 'No summary.json (advisory — profile requires minimal)',
        hint: `lattice summary_set '{"storyId":"${storyId}","changes":"What changed (≥10 chars)","usage":"How to use (≥10 chars)","expectedOutcome":"What the user expects to see","actualTranscript":"What was actually observed when run","outcomeDiff":"expected vs actual diff","acceptanceVerdict":"accepted","limitations":"Known limitations or \\"none — fully covered\\"","pitfalls":"Pitfall notes (≥10 chars, mandatory section)"}'`,
        source: 'summary.json',
        blocking: summaryReq === 'full',
      }));
    } else {
      const missing: string[] = [];
      if (!summary.changes || summary.changes.trim().length < 10) missing.push('changes');
      if (!summary.usage || summary.usage.trim().length < 10) missing.push('usage');
      if (!summary.expectedOutcome || summary.expectedOutcome.trim().length < 10) missing.push('expectedOutcome');
      if (!summary.actualTranscript || summary.actualTranscript.trim().length < 10) missing.push('actualTranscript');
      if (!summary.outcomeDiff || summary.outcomeDiff.trim().length < 5) missing.push('outcomeDiff');
      if (!summary.acceptanceVerdict) missing.push('acceptanceVerdict');
      if (typeof summary.limitations !== 'string' || summary.limitations.trim().length < 2) missing.push('limitations');
      if (!summary.pitfalls || summary.pitfalls.trim().length < 10) missing.push('pitfalls');
      if (missing.length > 0) {
        rows.push(doneCheckRow({
          id: 'story-summary',
          status: summaryReq === 'full' ? 'fail' : 'warn',
          label: 'Story summary',
          detail: `Missing/too short fields: ${missing.join(', ')}`,
          hint: `Re-invoke lattice summary_set to fill in ${missing.join(', ')}`,
          source: 'summary.json',
          blocking: summaryReq === 'full',
        }));
      } else {
        const cov = summary.realMachineCoverage;
        const covNote = `${cov.ran.length} ran / ${cov.skipped.length} skipped`;
        const expectedOutcome = summary.expectedOutcome || '';
        rows.push(doneCheckRow({
          id: 'story-summary',
          status: 'pass',
          label: 'Story summary',
          detail: `complete (${covNote})`,
          source: 'summary.json',
          blocking: false,
        }));
        rows.push(doneCheckRow({
          id: 'user-value-summary',
          status: 'pass',
          label: 'User value summary',
          detail: `${summary.acceptanceVerdict}: ${expectedOutcome.slice(0, 80)}${expectedOutcome.length > 80 ? '...' : ''}`,
          hint: [
            `usage: ${summary.usage}`,
            `actual: ${summary.actualTranscript}`,
            `diff: ${summary.outcomeDiff}`,
            `limitations: ${summary.limitations}`,
          ].join('\n'),
          source: 'summary.json',
          blocking: false,
        }));
      }
    }
  }

  // 8. Codex adapter hard evidence for Codex-touching stories.
  if (storyRequiresCodexEvidence(store, storyId)) {
    const codex = summarizeCodexEvidence(store, storyId, root);
    rows.push(doneCheckRow({
      id: 'codex-adapter-evidence',
      status: codex.status === 'passing' ? 'pass' : 'fail',
      label: 'Codex adapter evidence',
      detail: `${codex.status}: ${codex.detail}`,
      hint: codex.command,
      source: 'process-events:codex_adapter_verification',
    }));
  }

  return rows;
}

export function renderDoneChecklist(storyId: string, rows: DoneCheckRow[]): string {
  const ICONS: Record<DoneCheckRow['status'], string> = { pass: '✓', fail: '✗', warn: '!' };
  const lines = [`DONE Gate Checklist (${storyId}):`];
  for (const row of rows) {
    let line = `  [${ICONS[row.status]}] ${row.label}`;
    if (row.detail) line += `: ${row.detail}`;
    lines.push(line);
    // Both warn lines and the user-value summary expand multi-line details for easy recap to the user before DONE.
    if ((row.status === 'warn' || row.id === 'user-value-summary') && row.hint) {
      for (const h of row.hint.split('\n')) {
        lines.push(`        - ${h}`);
      }
    }
  }
  return lines.join('\n');
}

import { StoryStore } from '../core/store.js';

type HandlerMap = Record<string, Function>;
type RunWrapper = (fn: () => unknown | Promise<unknown>) => Promise<void>;

export async function runStoryCreateLifecycleDispatch(args: {
  data: Record<string, unknown>;
  gitReady: boolean;
  handlers: HandlerMap;
  root: string;
  run: RunWrapper;
  store: StoryStore;
  preflightFromDraftMetadataBootstrap: (root: string) => void;
  commitFromDraftMetadataOnMain: (root: string, store: StoryStore, storyId: string, draftName: string) => string;
  commitFromDraftMetadataAndMergeMain: (root: string, store: StoryStore, storyId: string, draftName: string) => string;
}): Promise<void> {
  await args.run(() => {
    const fromDraftName = typeof args.data.fromDraft === 'string' ? args.data.fromDraft : '';
    if (fromDraftName && args.gitReady) {
      args.preflightFromDraftMetadataBootstrap(args.root);
    }
    const result = args.handlers.story_create(args.data);
    if (result.includes('created from draft') && result.includes('(phase=INIT_CHECK)')) {
      const storyId = result.match(/Story\s+([\w-]+)/)?.[1];
      if (!storyId) return result;
      if (!args.gitReady) {
        return `${result}\n⚠ Current directory is not a Git repository: story was recorded, but the from-draft worktree cannot be created automatically.\nNext: Run git init and make the first commit, then retry proof-or-stop story_advance '{"storyId":"${storyId}","phase":"INIT_CHECK"}'`;
      }
      try {
        const wtResult = args.handlers.dev_start({ storyId });
        const syncResult = args.commitFromDraftMetadataAndMergeMain(args.root, args.store, storyId, fromDraftName);
        return `${result}\n\n${wtResult}\n\n${syncResult}\n\nNext: Change to the worktree directory above, then run proof-or-stop story_advance phase=PLAN to enter PLAN`;
      } catch (e: any) {
        throw new Error(
          `from-draft worktree bootstrap failed for ${storyId}: ${e.message}\n` +
          `Next: After diagnosing, run proof-or-stop story_advance --phase=INIT_CHECK again to retry automatically, or manually run proof-or-stop dev_start '{"storyId":"${storyId}"}'`,
        );
      }
    }
    if (!result.includes('(INIT)')) return result;
    const storyId = result.match(/Story\s+([\w-]+)/)?.[1];
    if (!storyId) return result;
    if (result.includes('当前目录不是 git 仓库')) return result;
    let fromDraftMetadataSegment = '';
    if (fromDraftName && result.includes('created from draft') && args.gitReady) {
      fromDraftMetadataSegment = args.commitFromDraftMetadataOnMain(args.root, args.store, storyId, fromDraftName);
    }
    if (!args.gitReady) {
      return `${result}\n⚠ Current directory is not a Git repository: story was recorded, but the INIT_CHECK/worktree flow cannot run smoothly yet.\nNext: First run git init && git add . && git commit -m "init" at the project root, then run proof-or-stop story_advance '{"storyId":"${storyId}","phase":"INIT_CHECK"}'`;
    }
    const metadataLine = fromDraftMetadataSegment ? `\n${fromDraftMetadataSegment}` : '';
    return `${result}${metadataLine}\nStory is currently in INIT.\nNext steps:\n  1. proof-or-stop story_advance '{"storyId":"${storyId}","phase":"INIT_CHECK"}' create worktree\n  2. cd to the prompted worktree path\n  3. proof-or-stop story_advance '{"storyId":"${storyId}","phase":"PLAN"}' enter PLAN (cwd must be the worktree)`;
  });
}

export async function runStoryAdvanceInitCheckLifecycleDispatch(args: {
  data: Record<string, unknown>;
  gitReady: boolean;
  handlers: HandlerMap;
  root: string;
  run: RunWrapper;
  store: StoryStore;
  getGuardFailureReason: (storyId: string, store: StoryStore, phase: 'INIT_CHECK', root: string) => string | null;
  commitInitCheckMetadataAndMergeMain: (root: string, store: StoryStore, storyId: string) => string;
}): Promise<void> {
  await args.run(async () => {
    const storyId = args.data.storyId;
    if (args.data.dryRun === true) {
      const story: any = args.handlers.story_get({ storyId, detail: true });
      const currentPhase = story?.index?.phase || 'unknown';
      return [
        `[DRY-RUN] INIT_CHECK bootstrap plan for ${storyId}`,
        `- current phase: ${currentPhase}`,
        `- would verify init-check gate without mutating story metadata`,
        `- would create/update branch story/${storyId} with scoped story bootstrap files`,
        `- would create worktree under configured worktreeDir`,
        `- no phase, branch, commit, or worktree changes were made`,
      ].join('\n');
    }
    // B-804c CHK-001: make the INIT_CHECK phase write ATOMIC with the worktree
    // bootstrap (Option A — defer the write). The old order persisted
    // phase=INIT_CHECK FIRST and only then ran dev_start; a failed bootstrap
    // left phase=INIT_CHECK with no worktree and no INIT_CHECK->INIT back-edge
    // (unrecoverable). New order: bootstrap FIRST against the still-INIT story,
    // and persist phase=INIT_CHECK ONLY after dev_start succeeds. On bootstrap
    // failure we do NOT advance, so the story stays at its prior phase (INIT).
    //
    // Detect the current phase to choose the branch:
    //   - currentPhase === INIT_CHECK (B-5246 legacy victim retry): the phase is
    //     ALREADY persisted, so we never re-advance (no INIT_CHECK->INIT_CHECK);
    //     just (re)run dev_start to bootstrap the missing worktree.
    //   - currentPhase === INIT (the normal case): run dev_start against the
    //     still-INIT story; only advance the phase AFTER bootstrap succeeds.
    // story_get returns {checklist, review} by default; phase requires
    // detail:true to appear at result.index.phase.
    let alreadyInitCheck = false;
    try {
      const story: any = args.handlers.story_get({ storyId, detail: true });
      alreadyInitCheck = story?.index?.phase === 'INIT_CHECK';
    } catch {
      // story_get failed: we cannot prove the phase is INIT_CHECK, so
      // alreadyInitCheck stays false and the normal path (guard pre-check +
      // bootstrap + advance) runs — the safe behavior.
    }

    // B-804c CHK-001: validate the FULL INIT→INIT_CHECK transition guard BEFORE
    // bootstrapping. Deferring the phase write must not also defer (or weaken)
    // the gate: dev_start only enforces the scope-anti-expansion freeze gate,
    // which is a STRICT SUBSET of the INIT_CHECK transition gate (it also
    // requires a valid init-check.json — the proof-or-stop-review-story-init evidence).
    // If we bootstrapped on dev_start's subset gate alone, a story with passing
    // scope-freeze but missing init-check could create a worktree (and the exact
    // failure diagnostic would regress from [missing_init_check] to a scope
    // message). getGuardFailureReason returns null for a non-INIT story, so this
    // is a no-op for the already-INIT_CHECK retry path. The gate runs whenever
    // the story is not already INIT_CHECK — including the case where story_get
    // threw and alreadyInitCheck stayed false (closing B-804c:F-002): without
    // this pre-check that path ran dev_start FIRST with no gate, so a succeeding
    // bootstrap followed by a story_advance that failed its own gate could leave
    // a worktree on disk while the phase stayed INIT — a partial bootstrap.
    // Running the full INIT_CHECK transition guard here means dev_start never
    // bootstraps ahead of the INIT_CHECK gate, so there is no path that creates a
    // worktree without the phase advancing.
    if (!alreadyInitCheck) {
      const guardFailure = args.getGuardFailureReason(String(storyId), args.store, 'INIT_CHECK', args.root);
      if (guardFailure) {
        throw new Error(
          `${guardFailure}\n\n` +
          `INIT_CHECK aborted: Story ${storyId} stays at INIT (phase not advanced; no worktree created).`,
        );
      }
    }

    // Gate passed. Bootstrap FIRST (against the still-INIT story for the normal
    // case, or the already-INIT_CHECK story for the retry case). If this throws,
    // the phase is NOT advanced and the story stays put — no partial advance. We
    // RE-THROW the abort (rather than returning a warning string) so the command
    // exits non-zero: a failed bootstrap is a real failure, and the old exit-0
    // "advanced + ⚠ warning" output is exactly what masked this bug.
    let wtResult: string;
    try {
      wtResult = args.handlers.dev_start({ storyId });
    } catch (e: any) {
      throw new Error(
        `INIT_CHECK aborted: ${e.message}\n` +
        `Story ${storyId} stays at ${alreadyInitCheck ? 'INIT_CHECK' : 'INIT'} (phase not advanced; no worktree created).\n` +
        `Next: fix the cause, then re-run proof-or-stop story_advance --phase=INIT_CHECK, ` +
        `or run proof-or-stop dev_start '{"storyId":"${storyId}"}' to bootstrap directly.`,
      );
    }

    // Bootstrap succeeded. Persist phase=INIT_CHECK now (only when the story is
    // not already INIT_CHECK; an already-INIT_CHECK retry must never re-advance).
    // There is no separate fallback branch: if story_get failed above,
    // alreadyInitCheck is false and we take the normal advance path here.
    let advanceResult: string;
    if (alreadyInitCheck) {
      advanceResult = `Story ${storyId} is already in INIT_CHECK; bootstrapped worktree`;
    } else {
      // Normal case: persist the phase via the real story_advance handler,
      // which re-runs the same guard.
      advanceResult = await args.handlers.story_advance(args.data);
    }

    // B-f60c CHK-002: close F-008. dev_start leaves an uncommitted
    // story-metadata mirror in the main checkout that blocks the DONE
    // `git merge story/<id>`. Commit it on the base branch (mirroring the
    // metadata-commit part of the from-draft path) so DONE has nothing
    // uncommitted to collide with. Final order (B-804c): dev_start (success)
    // -> story_advance (persist phase) -> commitInitCheckMetadata.
    let syncResult = '';
    if (args.gitReady) {
      syncResult = args.commitInitCheckMetadataAndMergeMain(args.root, args.store, String(storyId));
    }
    const syncSegment = syncResult ? `\n\n${syncResult}` : '';
    return `${advanceResult}\n\n${wtResult}${syncSegment}\n\nNext: Change to the worktree directory above, then run proof-or-stop story_advance phase=PLAN to enter PLAN`;
  });
}

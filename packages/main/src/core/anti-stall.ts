/**
 * Anti-stall: structured "three exits" for stuck phases.
 *
 * When a story gets stuck (REVIEW blockers, TEST failures, waiting states),
 * this module renders a consistent three-option escape hatch:
 *   1. [retry]   — re-run the stuck operation
 *   2. [fix]     — address the root cause
 *   3. [discard] — (optional) abandon the story
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AntiStallOptions {
  storyId: string;
  title: string;
  retry: string;
  fix: string;
  discard?: string;
}

// ---------------------------------------------------------------------------
// Core renderer
// ---------------------------------------------------------------------------

export function renderAntiStall(opts: AntiStallOptions): string {
  const lines: string[] = [
    `anti-stall: ${opts.title}`,
    '',
    `  1. [retry]   ${opts.retry}`,
    `  2. [fix]     ${opts.fix}`,
  ];

  if (opts.discard != null) {
    lines.push(`  3. [discard] ${opts.discard}`);
  } else {
    lines.push(
      `  3. [discard] story_advance --phase=DISCARDED --storyId=${opts.storyId}`,
    );
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Phase-specific helpers
// ---------------------------------------------------------------------------

export function reviewAntiStall(storyId: string): string {
  return renderAntiStall({
    storyId,
    title: 'REVIEW blocked by unresolved findings',
    retry: `finding_list '{"storyId":"${storyId}"}' then resolve each blocking finding`,
    fix: `story_advance '{"storyId":"${storyId}","phase":"DEV"}' to roll back and fix code`,
  });
}

export function testAntiStall(
  storyId: string,
  openBugIds?: string[],
): string {
  const bugHint =
    openBugIds && openBugIds.length > 0
      ? ` (open bugs: ${openBugIds.join(', ')})`
      : '';

  return renderAntiStall({
    storyId,
    title: `TEST blocked${bugHint}`,
    retry: `koala validate then fix remaining failures`,
    fix: `story_advance '{"storyId":"${storyId}","phase":"DEV"}' to roll back and fix code`,
  });
}

export function waitingAntiStall(storyId: string): string {
  return renderAntiStall({
    storyId,
    title: 'story waiting with no active progress',
    retry: `koala status then resume the current phase`,
    fix: `koala checklist_get '{"storyId":"${storyId}"}' to identify next actionable item`,
  });
}

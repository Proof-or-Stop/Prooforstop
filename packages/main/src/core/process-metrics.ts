/**
 * B-abd8 CHK-002: Six-dimension process metrics aggregator.
 * Computes StoryProcessMetrics from existing story artifacts.
 * Note: reads plan.md via fs (existsSync/readFileSync) — not a pure function.
 *
 * @task B-ef9c
 * @checklist CHK-001
 * @title explainable traceable ai adapted code process
 * @type feature
 * @priority high
 * @description
 *   The codebase is adapted for native, efficient AI collaboration by making
 *   process state explainable and traceable across requirements, planning,
 *   debugging, review discipline, and subagent collaboration metrics.
 *   This supports the goal that code is managed through an automated interface
 *   used by both humans and AI, with traceable artifacts instead of memory.
 *   The entire code repository should be natively efficient for AI adaptation and should be explainable and traceable; there is no silver bullet for requirement completeness, relying on multiple layers of defense to reduce the probability of omissions.
 * @changes
 *   - [CHK-001] Aggregate story artifacts into explainable process metrics
 *   - [CHK-001] Surface requirement completeness and multi-layer defense gaps
 */

import { existsSync, readFileSync } from 'fs';
import { StoryStore } from './store.js';
import { computeChannel } from './workflow-policy.js';
import type {
  StoryProcessMetrics,
  ProcessDimensionMetrics,
  ProcessMetricValue,
  MetricConfidence,
  StoryInfo,
  StoryEvent,
  ChecklistData,
  ReviewData,
  FindingData,
  BugData,
  StoryTestRunsData,
  ProcessEvent,
} from './types.js';

// ── Helper ──

function metric(
  value: number | boolean | string | null,
  unit: ProcessMetricValue['unit'],
  confidence: MetricConfidence,
  sources: string[],
  note?: string,
): ProcessMetricValue {
  return { value, unit, confidence, sources, ...(note ? { note } : {}) };
}

function eventLogPlaceholder(): ProcessMetricValue {
  return metric(null, 'count', 'unknown', [], 'requires process-events.jsonl (Phase 3)');
}

/** Ratio helper: returns null + unknown when denominator is 0 */
function safeRatio(num: number, den: number, sources: string[]): ProcessMetricValue {
  if (den === 0) return metric(null, 'ratio', 'unknown', sources, 'no data (0 denominator)');
  return metric(Math.round((num / den) * 1000) / 1000, 'ratio', 'high', sources);
}

/** Count DEV→PLAN bounce events in story.events */
function countDevToPlanBounces(events: StoryEvent[]): number {
  let count = 0;
  let lastWasDev = false;
  for (const ev of events) {
    if (ev.phase === 'DEV' && ev.action === 'advance') lastWasDev = true;
    else if (ev.phase === 'PLAN' && ev.action === 'advance' && lastWasDev) {
      count++;
      lastWasDev = false;
    } else {
      lastWasDev = false;
    }
  }
  return count;
}

// ── Dimension computers ──

function computeTdd(
  findings: FindingData,
  bugs: BugData,
  testRuns: StoryTestRunsData,
): ProcessDimensionMetrics {
  const gaps: string[] = [];

  // findingCoverageRatio: critical/high resolved / total critical/high
  const critHigh = findings.findings.filter(f => f.severity === 'critical' || f.severity === 'high');
  const critHighResolved = critHigh.filter(f => f.status === 'resolved');
  const findingCoverageRatio = critHigh.length === 0
    ? metric(null, 'ratio', 'unknown', ['findings.json'], 'no data (0 denominator)')
    : metric(
        Math.round((critHighResolved.length / critHigh.length) * 1000) / 1000,
        'ratio', 'medium', ['findings.json'],
      );

  // bugFixWithReproEvidenceRatio
  const fixedBugs = bugs.bugs.filter(b => b.status === 'fixed');
  const fixedWithRepro = fixedBugs.filter(b => b.evidence?.reproTest);
  const bugFixWithReproEvidenceRatio = safeRatio(fixedWithRepro.length, fixedBugs.length, ['bug.json']);

  // validateFailBeforePass
  let validateFailBeforePass: ProcessMetricValue;
  if (testRuns.runs.length === 0) {
    validateFailBeforePass = metric(null, 'bool', 'unknown', ['test-runs.json'], 'no test runs');
  } else {
    const firstPassIdx = testRuns.runs.findIndex(r => r.result === 'PASS');
    const anyFailBefore = firstPassIdx > 0
      ? testRuns.runs.slice(0, firstPassIdx).some(r => r.result === 'FAIL')
      : false;
    validateFailBeforePass = metric(
      firstPassIdx < 0 ? null : anyFailBefore,
      'bool',
      firstPassIdx < 0 ? 'unknown' : 'high',
      ['test-runs.json'],
      firstPassIdx < 0 ? 'no PASS run yet' : undefined,
    );
  }

  // postPassBugCount
  let postPassBugCount: ProcessMetricValue;
  const firstPassRun = testRuns.runs.find(r => r.result === 'PASS');
  if (!firstPassRun) {
    postPassBugCount = metric(null, 'count', 'unknown', ['test-runs.json', 'bug.json'], 'no PASS run yet');
  } else {
    const passTime = new Date(firstPassRun.timestamp).getTime();
    if (isNaN(passTime)) {
      postPassBugCount = metric(null, 'count', 'unknown', ['test-runs.json', 'bug.json'], 'invalid PASS run timestamp');
    } else {
      const postBugs = bugs.bugs.filter(b => {
        const t = new Date(b.foundAt).getTime();
        return !isNaN(t) && t > passTime;
      });
      postPassBugCount = metric(postBugs.length, 'count', 'high', ['test-runs.json', 'bug.json']);
    }
  }

  // effective
  const fcVal = findingCoverageRatio.value;
  const brVal = bugFixWithReproEvidenceRatio.value;
  const ppVal = postPassBugCount.value;
  const anyNull = fcVal === null || brVal === null || ppVal === null;
  let effectiveValue: boolean | null = null;
  let effectiveConf: MetricConfidence = 'unknown';
  if (!anyNull) {
    effectiveValue = (fcVal as number) >= 1.0
      && (brVal as number) >= 0.8
      && (ppVal as number) === 0;
    effectiveConf = 'high';
  }

  return {
    effective: metric(effectiveValue, 'bool', effectiveConf, ['findings.json', 'bug.json', 'test-runs.json']),
    metrics: {
      findingCoverageRatio,
      bugFixWithReproEvidenceRatio,
      validateFailBeforePass,
      postPassBugCount,
    },
    gaps: gaps.length > 0 ? gaps : undefined,
  };
}

function computeRequirementCompleteness(
  story: StoryInfo,
  checklist: ChecklistData,
  review: ReviewData,
  findings: FindingData,
  hasUnderstanding: boolean,
  hasDecision: boolean,
  planExists: boolean,
  processEvents: ProcessEvent[],
): ProcessDimensionMetrics {
  const gaps: string[] = [];

  // planArtifactsPresent
  const planPresent = hasUnderstanding && hasDecision && checklist.items.length > 0 && planExists;
  const planArtifactsPresent = metric(planPresent, 'bool', 'high', [
    'understanding.json', 'decision.json', 'checklist.json', 'plan.md',
  ]);

  // initialStoryReviewBlockers
  let initialStoryReviewBlockers: ProcessMetricValue;
  if (review.reviews.length === 0) {
    initialStoryReviewBlockers = metric(null, 'count', 'unknown', ['review.json'], 'no reviews yet');
  } else {
    const first = review.reviews[0];
    initialStoryReviewBlockers = metric(first.blockerCount ?? 0, 'count', 'high', ['review.json']);
  }

  // missingFindingCount
  const missingCount = findings.findings.filter(f => f.category === 'missing').length;
  const missingFindingCount = metric(missingCount, 'count', 'high', ['findings.json']);

  // replanCount: DEV->PLAN bounces in story.events
  const replanCount = metric(countDevToPlanBounces(story.events ?? []), 'count', 'high', ['index.json']);

  // postDevChecklistChurn — from process events
  let postDevChecklistChurn: ProcessMetricValue;
  const postDevPhases = ['DEV', 'REVIEW', 'TEST', 'DONE'];
  const planUpdatedEvents = processEvents.filter(
    e => e.type === 'plan_updated' && postDevPhases.includes(e['phase'] as string)
  );
  if (processEvents.length === 0) {
    postDevChecklistChurn = eventLogPlaceholder();
    gaps.push('checklist churn tracking requires process-events.jsonl');
  } else {
    postDevChecklistChurn = metric(planUpdatedEvents.length, 'count', 'medium', ['process-events.jsonl']);
  }

  // effective
  const isrVal = initialStoryReviewBlockers.value;
  let effectiveValue: boolean | null;
  let effectiveConf: MetricConfidence;
  if (isrVal === null) {
    effectiveValue = null;
    effectiveConf = 'unknown';
  } else {
    effectiveValue = planPresent && (isrVal as number) === 0 && missingCount === 0;
    effectiveConf = 'high';
  }

  return {
    effective: metric(effectiveValue, 'bool', effectiveConf, [
      'understanding.json', 'decision.json', 'checklist.json', 'plan.md', 'review.json', 'findings.json',
    ]),
    metrics: {
      planArtifactsPresent,
      initialStoryReviewBlockers,
      missingFindingCount,
      replanCount,
      postDevChecklistChurn,
    },
    gaps: gaps.length > 0 ? gaps : undefined,
  };
}

function computeDebugging(bugs: BugData, processEvents: ProcessEvent[]): ProcessDimensionMetrics {
  const gaps: string[] = [];
  const fixedBugs = bugs.bugs.filter(b => b.status === 'fixed');

  const bugsWithEvidenceRatio = safeRatio(
    fixedBugs.filter(b => b.evidence != null).length, fixedBugs.length, ['bug.json'],
  );
  const bugsWithHypothesisRatio = safeRatio(
    fixedBugs.filter(b => b.evidence?.hypothesis).length, fixedBugs.length, ['bug.json'],
  );
  const bugsWithReproTestRatio = safeRatio(
    fixedBugs.filter(b => b.evidence?.reproTest).length, fixedBugs.length, ['bug.json'],
  );

  // avgFixTimeHours
  let avgFixTimeHours: ProcessMetricValue;
  if (fixedBugs.length === 0) {
    avgFixTimeHours = metric(null, 'hours', 'unknown', ['bug.json'], 'no data (0 denominator)');
  } else {
    const fixedWithTimes = fixedBugs.filter(b => b.fixedAt);
    if (fixedWithTimes.length === 0) {
      avgFixTimeHours = metric(null, 'hours', 'unknown', ['bug.json'], 'no fixedAt timestamps');
    } else {
      const totalMs = fixedWithTimes.reduce((sum, b) => {
        const diff = new Date(b.fixedAt!).getTime() - new Date(b.foundAt).getTime();
        return sum + (isNaN(diff) ? 0 : Math.max(0, diff));
      }, 0);
      const avgH = Math.round((totalMs / fixedWithTimes.length / 3600000) * 100) / 100;
      avgFixTimeHours = metric(avgH, 'hours', 'high', ['bug.json']);
    }
  }

  // reopenCount — from process events when available, else placeholder.
  // We use processEvents.length > 0 (not bugReopenedEvents.length > 0) intentionally:
  // any event in the file means the handler is wired up, so reopenCount=0 is trustworthy
  // (no bugs were reopened), not "we don't know".
  let reopenCount: ProcessMetricValue;
  const bugReopenedEvents = processEvents.filter(e => e.type === 'bug_reopened');
  if (processEvents.length > 0) {
    reopenCount = metric(bugReopenedEvents.length, 'count', 'low', ['process-events.jsonl']);
  } else {
    reopenCount = eventLogPlaceholder();
    gaps.push('bug reopen tracking requires process-events.jsonl');
  }

  // effective
  let effective: ProcessMetricValue;
  if (bugs.bugs.length === 0) {
    effective = metric('n/a', 'text', 'high', ['bug.json'], 'no bugs reported');
  } else {
    const evRatio = bugsWithEvidenceRatio.value;
    effective = evRatio === null
      ? metric(null, 'bool', 'unknown', ['bug.json'])
      : metric((evRatio as number) >= 0.8, 'bool', 'high', ['bug.json']);
  }

  return {
    effective,
    metrics: {
      bugsWithEvidenceRatio,
      bugsWithHypothesisRatio,
      bugsWithReproTestRatio,
      avgFixTimeHours,
      reopenCount,
    },
    gaps: gaps.length > 0 ? gaps : undefined,
  };
}

function computePlanning(
  story: StoryInfo,
  checklist: ChecklistData,
  planExists: boolean,
  planContent: string | null,
  processEvents: ProcessEvent[],
): ProcessDimensionMetrics {
  const gaps: string[] = [];

  const hasPlanArtifact = metric(planExists, 'bool', 'high', ['plan.md']);

  // planCoverageRatio: CHK items with matching ## CHK-xxx: in plan.md
  let planCoverageRatio: ProcessMetricValue;
  if (!planExists || !planContent) {
    planCoverageRatio = metric(0, 'ratio', 'high', ['plan.md', 'checklist.json']);
  } else {
    const chkHeaders = new Set<string>();
    const headerRe = /^## (CHK-\d+):/gm;
    let m: RegExpExecArray | null;
    while ((m = headerRe.exec(planContent)) !== null) {
      chkHeaders.add(m[1]);
    }
    const covered = checklist.items.filter(item => chkHeaders.has(item.id)).length;
    planCoverageRatio = checklist.items.length === 0
      ? metric(null, 'ratio', 'unknown', ['plan.md', 'checklist.json'], 'no data (0 denominator)')
      : metric(
          Math.round((covered / checklist.items.length) * 1000) / 1000,
          'ratio', 'high', ['plan.md', 'checklist.json'],
        );
  }

  // itemsWithVerifyRatio: CHK sections containing **Verify**: in plan.md
  let itemsWithVerifyRatio: ProcessMetricValue;
  if (!planExists || !planContent) {
    itemsWithVerifyRatio = metric(null, 'ratio', 'unknown', ['plan.md'], 'no plan.md');
  } else {
    // Split plan by ## CHK- sections
    const sections = planContent.split(/^## CHK-\d+:/gm);
    // First element is before any CHK section
    const chkSections = sections.slice(1);
    if (chkSections.length === 0) {
      itemsWithVerifyRatio = metric(null, 'ratio', 'unknown', ['plan.md'], 'no CHK sections in plan');
    } else {
      const withVerify = chkSections.filter(s => /\*\*Verify\*\*:/.test(s)).length;
      itemsWithVerifyRatio = metric(
        Math.round((withVerify / chkSections.length) * 1000) / 1000,
        'ratio', 'high', ['plan.md'],
      );
    }
  }

  // devToPlanBounceCount — same logic as replanCount
  const devToPlanBounceCount = metric(countDevToPlanBounces(story.events ?? []), 'count', 'high', ['index.json']);

  // blockedTaskCount — from process events
  let blockedTaskCount: ProcessMetricValue;
  const dispatches = processEvents.filter(e => e.type === 'dispatch');
  if (processEvents.length === 0) {
    blockedTaskCount = eventLogPlaceholder();
    gaps.push('blocked task tracking requires process-events.jsonl');
  } else if (dispatches.length === 0) {
    blockedTaskCount = metric(0, 'count', 'medium', ['process-events.jsonl'], 'no dispatch events');
  } else {
    // Count dispatches with no matching subagent_result (success=true)
    let blocked = 0;
    const results = processEvents.filter(e => e.type === 'subagent_result');
    const resultIds = new Set(
      results.filter(r => r['success'] === true).map(r => r['checklistId'] as string)
    );
    for (const d of dispatches) {
      if (!resultIds.has(d['checklistId'] as string)) blocked++;
    }
    blockedTaskCount = metric(blocked, 'count', 'medium', ['process-events.jsonl']);
  }

  // effective
  const pcVal = planCoverageRatio.value;
  const effectiveValue = planExists && pcVal !== null && (pcVal as number) >= 1.0;

  return {
    effective: metric(effectiveValue, 'bool', pcVal === null ? 'unknown' : 'high', ['plan.md', 'checklist.json']),
    metrics: {
      hasPlanArtifact,
      planCoverageRatio,
      itemsWithVerifyRatio,
      devToPlanBounceCount,
      blockedTaskCount,
    },
    gaps: gaps.length > 0 ? gaps : undefined,
  };
}

function computeSubagentCollaboration(
  story: StoryInfo,
  checklist: ChecklistData,
  findings: FindingData,
  processEvents: ProcessEvent[],
): ProcessDimensionMetrics {
  const gaps: string[] = [];

  // Three-tier channels (express/fast/normal): only normal triggers normal-channel constraints
  // express (≤2) / fast (≤5 single solution) are both treated as "non-normal channels", main agent can write code itself
  const channel = computeChannel(story, checklist);
  const isNormalChannel = channel === 'normal';
  const nonNormalReason = `${channel} channel — main agent allowed to write code itself`;

  // normalChannelUsesSubagent
  const normalChannelUsesSubagent = isNormalChannel
    ? metric(findings.findings.length > 0, 'bool', 'low', ['findings.json', 'checklist.json', 'index.json'], 'proxy: uses reviewer findings as signal, not git commit author data')
    : metric('n/a', 'text', 'high', ['checklist.json', 'index.json'], nonNormalReason);

  // reviewerIndependence
  const reviewerIndependence = metric(
    findings.findings.length > 0, 'bool', 'high', ['findings.json'],
  );

  // mainAgentCodeViolation
  const mainAgentCodeViolation = isNormalChannel
    ? metric(findings.findings.length === 0, 'bool', 'low', ['findings.json', 'checklist.json', 'index.json'], 'proxy: no reviewer findings may indicate missing review, not code violation')
    : metric(false, 'bool', 'high', ['checklist.json'], `${nonNormalReason} — no violation possible`);

  gaps.push('accurate subagent detection requires git commit author data or process-events.jsonl');

  // parallelBatchCount — from process events
  let parallelBatchCount: ProcessMetricValue;
  const scDispatches = processEvents.filter(e => e.type === 'dispatch');
  if (processEvents.length === 0) {
    parallelBatchCount = eventLogPlaceholder();
    gaps.push('parallel batch tracking requires process-events.jsonl');
  } else if (scDispatches.length === 0) {
    parallelBatchCount = metric(0, 'count', 'medium', ['process-events.jsonl'], 'no dispatch events');
  } else {
    // Group dispatches into batches: dispatches within 60s of previous = same batch
    let batchCount = 0;
    let batchSize = 1;
    for (let i = 1; i < scDispatches.length; i++) {
      const prevT = new Date(scDispatches[i - 1].timestamp).getTime();
      const currT = new Date(scDispatches[i].timestamp).getTime();
      if (!isNaN(prevT) && !isNaN(currT) && currT - prevT <= 60000) {
        batchSize++;
      } else {
        if (batchSize > 1) batchCount++;
        batchSize = 1;
      }
    }
    if (batchSize > 1) batchCount++;
    parallelBatchCount = metric(batchCount, 'count', 'medium', ['process-events.jsonl']);
  }

  // blockedReturnCount — from process events
  let blockedReturnCount: ProcessMetricValue;
  const scResults = processEvents.filter(e => e.type === 'subagent_result');
  if (processEvents.length === 0) {
    blockedReturnCount = eventLogPlaceholder();
    gaps.push('blocked return tracking requires process-events.jsonl');
  } else {
    const failedCount = scResults.filter(r => r['success'] === false).length;
    blockedReturnCount = metric(failedCount, 'count', 'medium', ['process-events.jsonl']);
  }

  // effective
  let effective: ProcessMetricValue;
  if (!isNormalChannel) {
    effective = metric('n/a', 'text', 'high', ['checklist.json', 'index.json'], nonNormalReason);
  } else {
    effective = metric(
      findings.findings.length > 0,
      'bool', 'high', ['findings.json'],
    );
  }

  return {
    effective,
    metrics: {
      normalChannelUsesSubagent,
      reviewerIndependence,
      mainAgentCodeViolation,
      parallelBatchCount,
      blockedReturnCount,
    },
    gaps: gaps.length > 0 ? gaps : undefined,
  };
}

function computeReviewDiscipline(
  review: ReviewData,
  findings: FindingData,
  testRuns: StoryTestRunsData,
  processEvents: ProcessEvent[],
): ProcessDimensionMetrics {
  const gaps: string[] = [];

  // storyReviewRounds — prefer process events (plan_reviewed) when available.
  // Use planReviewedEvents.length (not processEvents.length) to decide:
  // the events file may contain only bug_reopened events with no plan_reviewed.
  const planReviewedEvents = processEvents.filter(e => e.type === 'plan_reviewed');
  const storyReviewRounds = planReviewedEvents.length > 0
    ? metric(planReviewedEvents.length, 'count', 'medium', ['process-events.jsonl', 'review.json'])
    : metric(review.reviews.length, 'count', 'high', ['review.json']);
  const formalFindingCount = metric(findings.findings.length, 'count', 'high', ['findings.json']);

  // criticalResolvedBeforeTest
  const critHigh = findings.findings.filter(f => f.severity === 'critical' || f.severity === 'high');
  const allResolved = critHigh.length === 0 || critHigh.every(f => f.status === 'resolved');
  const criticalResolvedBeforeTest = metric(allResolved, 'bool', 'high', ['findings.json']);

  // testFailAfterReview
  let testFailAfterReview: ProcessMetricValue;
  if (review.reviews.length === 0 || testRuns.runs.length === 0) {
    testFailAfterReview = metric(null, 'bool', 'unknown', ['review.json', 'test-runs.json'],
      review.reviews.length === 0 ? 'no reviews' : 'no test runs');
  } else {
    const lastReviewTs = new Date(review.reviews[review.reviews.length - 1].timestamp).getTime();
    const failAfter = testRuns.runs.some(
      r => r.result === 'FAIL' && new Date(r.timestamp).getTime() > lastReviewTs,
    );
    testFailAfterReview = metric(failAfter, 'bool', 'medium', ['review.json', 'test-runs.json']);
  }

  // reviewAfterEachBatch — from process events
  let reviewAfterEachBatch: ProcessMetricValue;
  const rdDispatches = processEvents.filter(e => e.type === 'dispatch');
  const rdReviews = processEvents.filter(e => e.type === 'light_review');
  if (processEvents.length === 0) {
    reviewAfterEachBatch = eventLogPlaceholder();
    gaps.push('review-after-batch tracking requires process-events.jsonl');
  } else if (rdDispatches.length === 0) {
    reviewAfterEachBatch = metric('n/a', 'text', 'medium', ['process-events.jsonl'], 'no dispatch events');
  } else {
    // Group dispatches into batches (sliding 60s window), check if a light_review follows each batch
    const batches: { start: number; end: number }[] = [];
    let bEnd = new Date(rdDispatches[0].timestamp).getTime();
    let bStart = bEnd;
    for (let i = 1; i < rdDispatches.length; i++) {
      const prevT = new Date(rdDispatches[i - 1].timestamp).getTime();
      const t = new Date(rdDispatches[i].timestamp).getTime();
      if (!isNaN(prevT) && !isNaN(t) && t - prevT <= 60000) {
        bEnd = t;
      } else {
        batches.push({ start: bStart, end: bEnd });
        bStart = t;
        bEnd = t;
      }
    }
    batches.push({ start: bStart, end: bEnd });

    if (batches.length <= 1) {
      // Only one batch — can't determine pattern, check if at least one review exists
      reviewAfterEachBatch = metric(rdReviews.length > 0, 'bool', 'medium', ['process-events.jsonl']);
    } else {
      // For each batch except the last, check if a light_review occurs before the next batch
      let allReviewed = true;
      for (let i = 0; i < batches.length - 1; i++) {
        const batchEnd = batches[i].end;
        const nextBatchStart = batches[i + 1].start;
        const hasReview = rdReviews.some(r => {
          const t = new Date(r.timestamp).getTime();
          return t > batchEnd && t < nextBatchStart;
        });
        if (!hasReview) { allReviewed = false; break; }
      }
      reviewAfterEachBatch = metric(allReviewed, 'bool', 'medium', ['process-events.jsonl']);
    }
  }

  // effective
  const effectiveValue = review.reviews.length >= 1 && allResolved;

  return {
    effective: metric(effectiveValue, 'bool', 'high', ['review.json', 'findings.json']),
    metrics: {
      storyReviewRounds,
      formalFindingCount,
      criticalResolvedBeforeTest,
      testFailAfterReview,
      reviewAfterEachBatch,
    },
    gaps: gaps.length > 0 ? gaps : undefined,
  };
}

// ── Main export ──

export function computeProcessMetrics(
  storyId: string,
  store: StoryStore,
  projectRoot: string,
): StoryProcessMetrics {
  // Read all artifacts, defaulting to empty on error
  let story: StoryInfo;
  try { story = store.readStory(storyId); }
  catch { story = { storyId, name: '', title: '', description: '', type: 'feature', phase: 'INIT', priority: 'medium', createdAt: new Date().toISOString(), startedAt: null, endedAt: null }; }

  let checklist: ChecklistData;
  try { checklist = store.readChecklist(storyId); }
  catch { checklist = { items: [] }; }

  let review: ReviewData;
  try { review = store.readReview(storyId); }
  catch { review = { reviews: [] }; }

  let findings: FindingData;
  try { findings = store.readFindings(storyId); }
  catch { findings = { findings: [] }; }

  let bugs: BugData;
  try { bugs = store.readBugs(storyId); }
  catch { bugs = { bugs: [] }; }

  let testRuns: StoryTestRunsData;
  try { testRuns = store.readTestRuns(storyId); }
  catch { testRuns = { runs: [] }; }

  let processEvents: ProcessEvent[];
  try { processEvents = store.readProcessEvents(storyId); }
  catch { processEvents = []; }

  const understanding = (() => { try { return store.readUnderstanding(storyId); } catch { return null; } })();
  const decision = (() => { try { return store.readDecision(storyId); } catch { return null; } })();
  const summary = (() => { try { return store.readSummary(storyId); } catch { return null; } })();
  const evalEvidence = (() => { try { return store.readEvalEvidence(storyId); } catch { return null; } })();

  // plan.md
  const planPath = store.storyFilePath(storyId, 'plan.md');
  const planExists = existsSync(planPath);
  let planContent: string | null = null;
  if (planExists) {
    try { planContent = readFileSync(planPath, 'utf-8'); } catch { /* ignore */ }
  }

  // sourceSnapshot
  const sourceSnapshot = {
    hasUnderstanding: understanding !== null,
    hasDecision: decision !== null,
    hasPlan: planExists,
    checklistItems: checklist.items.length,
    reviewRounds: review.reviews.length,
    findings: findings.findings.length,
    bugs: bugs.bugs.length,
    testRuns: testRuns.runs.length,
    hasEvalEvidence: evalEvidence !== null,
    hasSummary: summary !== null,
  };

  // Compute all six dimensions
  const tdd = computeTdd(findings, bugs, testRuns);
  const requirementCompleteness = computeRequirementCompleteness(
    story, checklist, review, findings,
    sourceSnapshot.hasUnderstanding, sourceSnapshot.hasDecision, planExists,
    processEvents,
  );
  const debugging = computeDebugging(bugs, processEvents);
  const planning = computePlanning(story, checklist, planExists, planContent, processEvents);
  const subagentCollaboration = computeSubagentCollaboration(story, checklist, findings, processEvents);
  const reviewDiscipline = computeReviewDiscipline(review, findings, testRuns, processEvents);

  // Collect all gaps
  const overallGaps: string[] = [];
  for (const dim of [tdd, requirementCompleteness, debugging, planning, subagentCollaboration, reviewDiscipline]) {
    if (dim.gaps) overallGaps.push(...dim.gaps);
  }

  return {
    storyId,
    generatedAt: new Date().toISOString(),
    sourceSnapshot,
    dimensions: {
      tdd,
      requirementCompleteness,
      debugging,
      planning,
      subagentCollaboration,
      reviewDiscipline,
    },
    overallGaps,
  };
}

// ── Formatting helpers ──

const DIM_NAMES = ['tdd', 'requirementCompleteness', 'debugging', 'planning', 'subagentCollaboration', 'reviewDiscipline'] as const;

/**
 * Format process metrics into a compact summary string.
 * mode 'compact' uses ✓/✗/?/- (for session brief), 'verbose' uses effective/needs-work (for story_list).
 */
export function formatProcessMetricsSummary(
  pm: StoryProcessMetrics,
  mode: 'compact' | 'verbose' = 'compact',
): string {
  const parts = DIM_NAMES.map(d => {
    const dim = pm.dimensions[d];
    const eff = dim.effective.value;
    const gapCount = dim.gaps?.length ?? 0;
    let label: string;
    if (mode === 'compact') {
      label = eff === true ? '\u2713' : eff === false ? '\u2717' : eff === 'n/a' ? '-' : '?';
      const sep = ':';
      return gapCount > 0 ? `${d}${sep}${label}(${gapCount}g)` : `${d}${sep}${label}`;
    } else {
      label = eff === true ? 'effective' : eff === false ? 'needs-work' : eff === 'n/a' ? 'n/a' : 'unknown';
      return gapCount > 0 ? `${d}=${label}(${gapCount} gaps)` : `${d}=${label}`;
    }
  });
  return parts.join(' ');
}

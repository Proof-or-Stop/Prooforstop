/**
 * Old-PoS run 34 (bench-staging/oldpos/run34-analysis.md §4 sink 1d): one
 * round's lanes are launched DEFAULT_LANE_LAUNCH_STAGGER_MS apart, so the lane
 * launched last starts about 24 s after the first. Run 34's longest lanes
 * (test-coverage in R1, docs in R2) were launched 3rd and 4th, which put the
 * stagger on the round's critical path. Lanes are launched in a static order,
 * historically slowest first (lane wall times of the benchmark runs 27-34:
 * docs and test-coverage were the long pole of every round, concept and quality
 * the shortest). The stagger, the lane set and what each lane reviews are
 * unchanged; only the launch order is.
 */

/** Lane suffixes (after `-review-`), slowest first. A lane not listed keeps its own relative order after these. */
export const REVIEW_LANE_LAUNCH_ORDER: readonly string[] = ['docs', 'test-coverage', 'concept', 'quality'];

function rank(lane: string): number {
  const suffix = lane.replace(/^.*-review-/, '');
  const at = REVIEW_LANE_LAUNCH_ORDER.indexOf(suffix);
  return at < 0 ? REVIEW_LANE_LAUNCH_ORDER.length : at;
}

/** The lanes in launch order (a new array; stable for lanes of equal rank). */
export function orderLanesForLaunch<T extends string>(lanes: readonly T[]): T[] {
  return lanes.map((lane, index) => ({ lane, index })).sort((a, b) => rank(a.lane) - rank(b.lane) || a.index - b.index).map(row => row.lane);
}

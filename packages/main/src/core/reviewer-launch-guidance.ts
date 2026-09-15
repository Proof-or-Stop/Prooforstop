export function renderCodexFreshReviewerHandoff(
  taskName: string,
  promptPlaceholder: string,
): string {
  return `spawn_agent({ task_name: ${JSON.stringify(taskName)}, fork_turns: "none", message: ${JSON.stringify(promptPlaceholder)} }); retain the returned agent id or canonical task name as <returned reviewer target>; immediately repeat the delivery with followup_task({ target: <returned reviewer target>, message: <the same exact prompt> }). The repeated delivery is the same assignment, not permission to start a second review`;
}

export function renderClaudeFreshReviewerHandoff(
  agentType: string,
  promptPlaceholder: string,
): string {
  return `Agent({ subagent_type: ${JSON.stringify(agentType)}, prompt: ${JSON.stringify(promptPlaceholder)} })`;
}

export function canonicalReviewerTaskName(agentType: string): string {
  const suffix = agentType.replace(/^proof-or-stop-review-/, '');
  const normalized = `review_${suffix}`
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!/^[a-z0-9_]+$/.test(normalized)) {
    throw new Error(`Cannot derive a valid Codex reviewer task name from ${JSON.stringify(agentType)}`);
  }
  return normalized;
}

export function renderReviewerDispatchLaunch(args: {
  storyId: string;
  agentType: string;
  taskName?: string;
  promptPlaceholder?: string;
}): string {
  const prompt = args.promptPlaceholder ?? '<owner-produced standard prompt>';
  const taskName = args.taskName ?? canonicalReviewerTaskName(args.agentType);
  const dispatchArgs = JSON.stringify({ storyId: args.storyId, agentType: args.agentType });
  return `Story owner runs proof-or-stop dispatch '${dispatchArgs}', then passes the returned prompt unchanged: on Codex use ${renderCodexFreshReviewerHandoff(taskName, prompt)}; on Claude use ${renderClaudeFreshReviewerHandoff(args.agentType, prompt)}. Other hosts launch one equivalent fresh-context reviewer task without parent conversation history and require an explicit assignment acknowledgement before waiting.`;
}

export const REVIEWER_CHILD_ID_WAIT_BOUNDARY =
  'Retain every returned child agent id or canonical task name as the reviewer target. Do not wait until the reviewer has acknowledged the assignment by emitting the required start signal or beginning its role-specific start command. Wait only through the host mechanism that tracks those acknowledged targets; never call wait with an empty target/receiver set. If no nonempty target or acknowledgement exists, fail closed and report delivery_not_acknowledged instead of waiting.';

export const REVIEWER_NO_DELEGATION_BOUNDARY =
  'Execute this review directly in the current reviewer task; do not spawn or delegate another reviewer. Collaboration tools, if visible, are outside this role.';

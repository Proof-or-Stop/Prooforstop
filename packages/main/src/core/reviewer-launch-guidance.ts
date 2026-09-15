export function renderCodexFreshReviewerHandoff(
  taskName: string,
  promptPlaceholder: string,
): string {
  return `spawn_agent({ task_name: "${taskName}", fork_turns: "none", message: "${promptPlaceholder}" })`;
}

export function renderClaudeFreshReviewerHandoff(
  agentType: string,
  promptPlaceholder: string,
): string {
  return `Agent({ subagent_type: "${agentType}", prompt: "${promptPlaceholder}" })`;
}

export function renderReviewerDispatchLaunch(args: {
  storyId: string;
  agentType: string;
  taskName: string;
  promptPlaceholder?: string;
}): string {
  const prompt = args.promptPlaceholder ?? '<owner-produced standard prompt>';
  return `Story owner runs proof-or-stop dispatch '{"storyId":"${args.storyId}","agentType":"${args.agentType}"}', then passes the returned prompt unchanged: on Codex use ${renderCodexFreshReviewerHandoff(args.taskName, prompt)}; on Claude use ${renderClaudeFreshReviewerHandoff(args.agentType, prompt)}. Other hosts launch one equivalent fresh-context reviewer task without parent conversation history.`;
}

export const REVIEWER_CHILD_ID_WAIT_BOUNDARY =
  'Retain every returned child agent id and wait only on those exact ids; never call wait with an empty target/receiver set.';

export const REVIEWER_NO_DELEGATION_BOUNDARY =
  'Execute this review directly in the current reviewer task; do not spawn or delegate another reviewer. Collaboration tools, if visible, are outside this role.';

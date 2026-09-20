// Shared experiment inputs; importing these does not execute verification.
export const limits = { calls: 4, cachedInput: 100, uncachedInput: 100, output: 100 };
export const options = () => ({ limits, partitions: {
  repair: { ...limits, calls: 2 }, product: { ...limits, calls: 3 },
}, maxWallMs: 2000, maxContextBytes: 4096 });
export const event = (overrides = {}) => ({ verified: true, task: 'benchmark',
  phase: 'REVIEW', candidate: 'commit-A', policy: 'policy-A',
  blocker: { code: 'approval_required', binding: 'binding-A', dependencies: { approval: 'pending' } },
  execution: { id: 'run-A', status: 'running', progress: 0 }, ...overrides });
export const request = (id, partition = 'product', source = 'main') => ({
  task: 'benchmark', candidate: id, policy: 'policy-A', cwd: '/isolated/lab',
  command: ['node', 'verify.mjs'], witness: 'witness-A', partition, source, provider: 'local-stub',
  ceiling: { cachedInput: 10, uncachedInput: 10, output: 10 },
});
export const receipt = id => ({ responseId: id,
  usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 2, reasoning_output_tokens: 1 } });


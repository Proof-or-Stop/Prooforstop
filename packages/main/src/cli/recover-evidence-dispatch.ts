type RecoverEvidenceHandler = (args: Record<string, unknown>) => unknown | Promise<unknown>;

type StdoutLike = {
  write(chunk: string): unknown;
};

function isRecoverEvidenceFailure(result: unknown): result is {
  status: 'refused' | 'fail';
  refused?: { reason?: string };
} {
  return Boolean(
    result &&
    typeof result === 'object' &&
    ((result as any).status === 'refused' || (result as any).status === 'fail'),
  );
}

export async function dispatchRecoverEvidenceWithStructuredFailure(args: {
  handler: RecoverEvidenceHandler;
  data: Record<string, unknown>;
  stdout?: StdoutLike;
}): Promise<unknown> {
  const r = await args.handler(args.data);
  if (isRecoverEvidenceFailure(r)) {
    // Print structured result first so the user sees the refused/fail diagnosis,
    // then throw a one-line error message that runCli renders on stderr.
    (args.stdout || process.stdout).write(`${JSON.stringify(r, null, 2)}\n`);
    const msg = r.status === 'refused'
      ? (r.refused?.reason || 'recover_evidence refused')
      : 'recover_evidence: validate failed after refresh; inspect validateTranscript for details';
    throw new Error(msg);
  }
  return r;
}

import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const labRoot = resolve(import.meta.dirname, '../../../..');
const focusedRegression = resolve(
  labRoot,
  'packages/main/dist/tasks/review-incremental-context-smoke.js',
);

try {
  const output = execFileSync(
    process.execPath,
    [focusedRegression, '--asof-run-only'],
    { cwd: labRoot, encoding: 'utf8' },
  );
  if (!output.includes('AS-OF-RUN ELIGIBILITY')) {
    console.error('BROKEN: focused regression did not emit its acceptance marker');
    process.exit(2);
  }
  console.log('SEALED_REVIEW_PASS_FINALIZATION_GREEN');
} catch (error) {
  const details = [error?.stdout, error?.stderr, error?.message]
    .filter(Boolean)
    .map((value) => String(value))
    .join('\n');
  console.error(`SEALED_REVIEW_PASS_FINALIZATION_RED ${details}`);
  process.exit(1);
}

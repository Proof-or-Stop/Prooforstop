/**
 * Prints a success token. TypeScript is silent when compilation succeeds. Both the
 * emitting build and standalone noEmit typecheck chain this after the real
 * compiler, so the selector records a successful compilation. The check pipeline
 * consumes its preceding build instead of compiling the same inputs twice.
 */
console.log(process.argv[2] ?? 'OK');

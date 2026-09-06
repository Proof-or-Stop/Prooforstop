/**
 * Prints a success token. `tsc --noEmit` is silent when it succeeds, which gives a
 * verification selector nothing to match on, so the typecheck script chains this
 * to emit a token that proves the command actually ran and exited clean.
 */
console.log(process.argv[2] ?? 'OK');

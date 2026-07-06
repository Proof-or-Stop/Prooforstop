export default function parseArgs(argv) {
  const counts = {};
  const values = {};
  const positionals = [];

  for (const token of argv) {
    if (token === "--verbose" || token === "-v") {
      counts.verbose = (counts.verbose ?? 0) + 1;
    } else if (token.startsWith("--include=")) {
      (values.include ??= []).push(token.slice("--include=".length));
    } else if (token.startsWith("--exclude=")) {
      (values.exclude ??= []).push(token.slice("--exclude=".length));
    } else {
      positionals.push(token);
    }
  }

  return { counts, values, positionals };
}

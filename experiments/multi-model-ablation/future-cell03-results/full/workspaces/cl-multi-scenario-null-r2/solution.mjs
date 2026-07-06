export default function parseArgs(argv) {
  const result = {
    counts: {},
    values: {},
    positionals: [],
  };

  for (const token of argv) {
    if (token === '--verbose' || token === '-v') {
      result.counts.verbose = (result.counts.verbose ?? 0) + 1;
    } else if (token.startsWith('--include=')) {
      appendValue(result.values, 'include', token.slice('--include='.length));
    } else if (token.startsWith('--exclude=')) {
      appendValue(result.values, 'exclude', token.slice('--exclude='.length));
    } else {
      result.positionals.push(token);
    }
  }

  return result;
}

function appendValue(values, name, value) {
  if (!Object.hasOwn(values, name)) {
    values[name] = [];
  }
  values[name].push(value);
}

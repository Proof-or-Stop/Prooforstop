export default function parseArgs(argv) {
  const options = {};
  const positionals = [];

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];

    if (token === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }

    if (token.startsWith('--')) {
      const equalsIndex = token.indexOf('=');

      if (equalsIndex !== -1) {
        const name = token.slice(2, equalsIndex);
        options[name] = token.slice(equalsIndex + 1);
        continue;
      }

      const name = token.slice(2);
      const next = argv[i + 1];

      if (next !== undefined && next !== '--' && !next.startsWith('-')) {
        options[name] = next;
        i += 1;
      } else {
        options[name] = true;
      }

      continue;
    }

    positionals.push(token);
  }

  return { options, positionals };
}

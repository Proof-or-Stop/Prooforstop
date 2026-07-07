export default function parseArgs(argv) {
  const options = {};
  const positionals = [];

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];

    if (token === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }

    if (token.startsWith("--")) {
      const body = token.slice(2);
      const equalsIndex = body.indexOf("=");

      if (equalsIndex !== -1) {
        const name = body.slice(0, equalsIndex);
        const value = body.slice(equalsIndex + 1);
        options[name] = value;
        continue;
      }

      const next = argv[i + 1];
      if (next !== undefined && next !== "--" && !next.startsWith("-")) {
        options[body] = next;
        i += 1;
      } else {
        options[body] = true;
      }

      continue;
    }

    positionals.push(token);
  }

  return { options, positionals };
}

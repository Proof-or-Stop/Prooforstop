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
      const optionText = token.slice(2);
      const equalsIndex = optionText.indexOf("=");

      if (equalsIndex !== -1) {
        const name = optionText.slice(0, equalsIndex);
        const value = optionText.slice(equalsIndex + 1);
        options[name] = value;
        continue;
      }

      const nextToken = argv[i + 1];
      if (
        nextToken !== undefined &&
        nextToken !== "--" &&
        !nextToken.startsWith("-")
      ) {
        options[optionText] = nextToken;
        i += 1;
      } else {
        options[optionText] = true;
      }
      continue;
    }

    positionals.push(token);
  }

  return { options, positionals };
}

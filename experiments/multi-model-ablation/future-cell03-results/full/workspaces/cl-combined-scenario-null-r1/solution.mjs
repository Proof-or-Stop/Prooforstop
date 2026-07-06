export default function parseArgs(argv) {
  const flags = {};
  const positionals = [];
  let optionsTerminated = false;

  for (const token of argv) {
    if (optionsTerminated) {
      positionals.push(token);
      continue;
    }

    if (token === "--") {
      optionsTerminated = true;
      continue;
    }

    if (token.startsWith("--") && token.length > 2) {
      const equalsIndex = token.indexOf("=");

      if (equalsIndex === -1) {
        flags[token.slice(2)] = true;
      } else {
        flags[token.slice(2, equalsIndex)] = token.slice(equalsIndex + 1);
      }

      continue;
    }

    if (token.startsWith("-") && token.length > 1) {
      for (const name of token.slice(1)) {
        flags[name] = true;
      }
      continue;
    }

    positionals.push(token);
  }

  return { flags, positionals };
}

export default function parseArgs(argv) {
  const flags = {};
  const positionals = [];
  let optionsEnded = false;

  for (const token of argv) {
    if (optionsEnded) {
      positionals.push(token);
      continue;
    }

    if (token === "--") {
      optionsEnded = true;
      continue;
    }

    if (token.startsWith("--")) {
      const equalsIndex = token.indexOf("=", 2);

      if (equalsIndex === -1) {
        flags[token.slice(2)] = true;
      } else {
        flags[token.slice(2, equalsIndex)] = token.slice(equalsIndex + 1);
      }

      continue;
    }

    if (token.length > 1 && token.startsWith("-") && /^[A-Za-z]+$/.test(token.slice(1))) {
      for (const name of token.slice(1)) {
        flags[name] = true;
      }
      continue;
    }

    positionals.push(token);
  }

  return { flags, positionals };
}

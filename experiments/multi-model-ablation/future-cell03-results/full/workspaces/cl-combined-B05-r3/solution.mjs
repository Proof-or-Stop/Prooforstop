// parseArgs(argv) — a POSIX-flavored command-line argument parser.
//
// Returns { flags, positionals } where `flags` maps option names to either `true`
// (boolean flags) or a string (valued `--name=value` flags), and `positionals` is
// the ordered list of non-option tokens.
//
// Grammar of a single token (before the `--` terminator):
//   "--"                -> options terminator
//   "--name=value"      -> valued long flag
//   "--name"            -> boolean long flag
//   "-abc"              -> combined short boolean flags: a, b, c
//   "-"                 -> positional (stdin marker)
//   anything else       -> positional

function isLongOption(tok) {
  return tok.length > 2 && tok.startsWith('--');
}

function isShortOption(tok) {
  // Single leading dash followed by one or more letters.
  return /^-[A-Za-z]+$/.test(tok);
}

function parseLong(tok, flags) {
  const body = tok.slice(2); // strip leading "--"
  const eq = body.indexOf('=');
  if (eq === -1) {
    // Boolean long flag.
    flags[body] = true;
    return;
  }
  // Valued long flag: name is up to the first '=', value is the rest (which may
  // itself contain '=' characters — e.g. --url=a=b yields value "a=b").
  const name = body.slice(0, eq);
  const value = body.slice(eq + 1);
  flags[name] = value;
}

function parseShort(tok, flags) {
  // Each character after the single leading dash is an independent boolean flag.
  const letters = tok.slice(1);
  for (let k = 0; k < letters.length; k++) {
    const ch = letters[k];
    flags[ch] = true;
  }
}

export default function parseArgs(argv) {
  if (!Array.isArray(argv)) {
    throw new TypeError('parseArgs expects an array of strings, got ' + typeof argv);
  }

  const flags = {};
  const positionals = [];
  let optionsEnded = false;

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (typeof tok !== 'string') {
      throw new TypeError('parseArgs: argv[' + i + '] is not a string');
    }

    if (optionsEnded) {
      positionals.push(tok);
      continue;
    }

    if (tok === '--') {
      optionsEnded = true;
      continue;
    }

    if (tok === '-') {
      // Bare dash is a conventional stdin positional.
      positionals.push(tok);
      continue;
    }

    if (isLongOption(tok)) {
      parseLong(tok, flags);
      continue;
    }

    if (isShortOption(tok)) {
      parseShort(tok, flags);
      continue;
    }

    positionals.push(tok);
  }

  return { flags, positionals };
}

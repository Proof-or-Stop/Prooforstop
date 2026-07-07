// parseArgs(argv) — a command-line parser supporting both `--key=value` (inline) and
// `--key value` (space-separated) option forms, plus positionals and a `--` terminator.
//
// Returns { options, positionals }.
//   options:     name -> string value (for valued flags) or `true` (for boolean flags)
//   positionals: ordered list of non-option tokens

function looksLikeOption(tok) {
  return typeof tok === 'string' && tok.startsWith('-');
}

function splitInline(tok) {
  // tok is "--name=value..."; return [name, value] where value is EVERYTHING after the
  // first '=' (so values may themselves contain '=' characters).
  const body = tok.slice(2);
  const equalIndex = body.indexOf('=');
  return [body.slice(0, equalIndex), body.slice(equalIndex + 1)];
}

export default function parseArgs(argv) {
  if (!Array.isArray(argv)) {
    throw new TypeError('parseArgs expects an array of strings, got ' + typeof argv);
  }

  const options = {};
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

    if (tok.startsWith('--')) {
      if (tok.includes('=')) {
        // Inline form: --key=value
        const [name, value] = splitInline(tok);
        options[name] = value;
        continue;
      }
      // No '=' present: maybe space-separated, maybe boolean.
      const name = tok.slice(2);
      const next = argv[i + 1];
      const hasValue =
        next !== undefined && next !== '--' && !looksLikeOption(next);
      if (hasValue) {
        options[name] = next;
        i++; // consume the value token
      } else {
        options[name] = true;
      }
      continue;
    }

    // Not "--"-prefixed and not the terminator: positional (including bare "-").
    positionals.push(tok);
  }

  return { options, positionals };
}

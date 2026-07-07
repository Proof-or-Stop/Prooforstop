// parseArgs(argv) — a command-line parser with REPEATABLE options.
//
// Returns { counts, values, positionals }:
//   counts:      name -> how many times a count flag (--verbose / -v) appeared
//   values:      name -> array of values for a repeatable valued flag (--include / --exclude)
//   positionals: ordered list of every other token (incl. unknown --foo)

const COUNT_LONG = new Set(['verbose']);
const COUNT_SHORT = new Set(['v']);            // short aliases -> count name
const SHORT_TO_LONG = { v: 'verbose' };
const VALUED = new Set(['include', 'exclude']); // repeatable --name=value flags

function bumpCount(counts, name) {
  if (Object.prototype.hasOwnProperty.call(counts, name)) {
    counts[name] = counts[name] + 1;
  } else {
    counts[name] = 1;
  }
}

function appendValue(values, name, value) {
  if (Object.prototype.hasOwnProperty.call(values, name)) {
    values[name].push(value);
  } else {
    values[name] = [value];
  }
}

export default function parseArgs(argv) {
  if (!Array.isArray(argv)) {
    throw new TypeError('parseArgs expects an array of strings, got ' + typeof argv);
  }

  const counts = {};
  const values = {};
  const positionals = [];

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (typeof tok !== 'string') {
      throw new TypeError('parseArgs: argv[' + i + '] is not a string');
    }

    if (tok.startsWith('--')) {
      const body = tok.slice(2);
      const eq = body.indexOf('=');
      if (eq === -1) {
        // Long flag with no value.
        if (COUNT_LONG.has(body)) {
          bumpCount(counts, body);
          continue;
        }
        // Unknown long flag -> positional.
        positionals.push(tok);
        continue;
      }
      // Long flag with an inline value.
      const name = body.slice(0, eq);
      const value = body.slice(eq + 1);
      if (VALUED.has(name)) {
        appendValue(values, name, value);
        continue;
      }
      // Unknown valued flag -> positional (raw token).
      positionals.push(tok);
      continue;
    }

    if (tok.length >= 2 && tok[0] === '-') {
      // Short flag(s). Only single-letter count aliases are declared here.
      const letter = tok.slice(1);
      if (COUNT_SHORT.has(letter)) {
        bumpCount(counts, SHORT_TO_LONG[letter]);
        continue;
      }
      // Unknown short flag -> positional.
      positionals.push(tok);
      continue;
    }

    // Plain positional.
    positionals.push(tok);
  }

  return { counts, values, positionals };
}

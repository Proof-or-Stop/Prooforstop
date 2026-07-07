// interpolate(template, context) — template-string interpolator with {name} placeholders and
// backslash escapes (\{ \} \\). Specified exactly in prompt.md.

const NAME_START = /[A-Za-z_]/;
const NAME_CONT = /[A-Za-z0-9_]/;

function isOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function readName(template, start) {
  // template[start] is the char right after '{'. Returns { name, end } where
  // template[end] must be '}'. Throws on an invalid/empty name.
  let j = start;
  if (j >= template.length || !NAME_START.test(template[j])) {
    throw new Error(`Invalid placeholder at index ${start - 1}: name must start with a letter or underscore`);
  }
  j++;
  while (j < template.length && NAME_CONT.test(template[j])) j++;
  return { name: template.slice(start, j), end: j };
}

export default function interpolate(template, context) {
  if (typeof template !== 'string') {
    throw new TypeError('interpolate expects a string template, got ' + typeof template);
  }
  const ctx = context == null ? {} : context;
  if (typeof ctx !== 'object') {
    throw new TypeError('interpolate expects an object context, got ' + typeof context);
  }

  let out = '';
  let i = 0;
  const n = template.length;

  while (i < n) {
    const ch = template[i];

    if (ch === '\\') {
      // Escape sequence: exactly one of \{ \} \\, each emitting a single literal char.
      const next = i + 1 < n ? template[i + 1] : null;
      if (next === '{') {
        out += '{';
        i += 2;
        continue;
      }
      if (next === '}') {
        out += '}';
        i += 2;
        continue;
      }
      if (next === '\\') {
        out += '\\';
        i += 2;
        continue;
      }
      throw new Error(`Invalid escape at index ${i}: '\\${next ?? '<eof>'}'`);
    }

    if (ch === '{') {
      // Placeholder: {name}
      const { name, end } = readName(template, i + 1);
      if (end >= n || template[end] !== '}') {
        throw new Error(`Unterminated placeholder starting at index ${i}`);
      }
      if (!isOwn(ctx, name)) {
        throw new Error(`Unknown variable: '${name}'`);
      }
      out += String(ctx[name]);
      i = end + 1; // skip past '}'
      continue;
    }

    if (ch === '}') {
      throw new Error(`Unexpected '}' at index ${i}`);
    }

    // Plain literal character.
    out += ch;
    i++;
  }

  return out;
}

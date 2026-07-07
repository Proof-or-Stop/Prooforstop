const FOLD = Object.freeze({
  '\u00c0': 'a', '\u00c1': 'a', '\u00c2': 'a', '\u00c3': 'a', '\u00c4': 'a', '\u00c5': 'a',
  '\u00e0': 'a', '\u00e1': 'a', '\u00e2': 'a', '\u00e3': 'a', '\u00e4': 'a', '\u00e5': 'a',
  '\u00c8': 'e', '\u00c9': 'e', '\u00ca': 'e', '\u00cb': 'e',
  '\u00e8': 'e', '\u00e9': 'e', '\u00ea': 'e', '\u00eb': 'e',
  '\u00cc': 'i', '\u00cd': 'i', '\u00ce': 'i', '\u00cf': 'i',
  '\u00ec': 'i', '\u00ed': 'i', '\u00ee': 'i', '\u00ef': 'i',
  '\u00d2': 'o', '\u00d3': 'o', '\u00d4': 'o', '\u00d5': 'o', '\u00d6': 'o',
  '\u00f2': 'o', '\u00f3': 'o', '\u00f4': 'o', '\u00f5': 'o', '\u00f6': 'o',
  '\u00d9': 'u', '\u00da': 'u', '\u00db': 'u', '\u00dc': 'u',
  '\u00f9': 'u', '\u00fa': 'u', '\u00fb': 'u', '\u00fc': 'u',
  '\u00d1': 'n', '\u00f1': 'n',
  '\u00c7': 'c', '\u00e7': 'c',
});

function slugChar(ch) {
  const code = ch.charCodeAt(0);

  if (code >= 48 && code <= 57) return ch;
  if (code >= 65 && code <= 90) return String.fromCharCode(code + 32);
  if (code >= 97 && code <= 122) return ch;

  return FOLD[ch] || '';
}

export default function slugify(input) {
  const text = input == null ? '' : String(input);
  let slug = '';
  let pendingHyphen = false;

  for (const raw of text) {
    const ch = slugChar(raw);

    if (ch) {
      if (pendingHyphen && slug) slug += '-';
      slug += ch;
      pendingHyphen = false;
    } else if (slug) {
      pendingHyphen = true;
    }
  }

  return slug;
}

const FOLD_MAP = new Map([
  ["à", "a"],
  ["á", "a"],
  ["â", "a"],
  ["ã", "a"],
  ["ä", "a"],
  ["å", "a"],
  ["è", "e"],
  ["é", "e"],
  ["ê", "e"],
  ["ë", "e"],
  ["ì", "i"],
  ["í", "i"],
  ["î", "i"],
  ["ï", "i"],
  ["ò", "o"],
  ["ó", "o"],
  ["ô", "o"],
  ["õ", "o"],
  ["ö", "o"],
  ["ù", "u"],
  ["ú", "u"],
  ["û", "u"],
  ["ü", "u"],
  ["ñ", "n"],
  ["ç", "c"],
]);

export default function slugify(input) {
  let slug = "";
  let pendingSeparator = false;

  for (const char of String(input)) {
    let next = "";
    const code = char.charCodeAt(0);

    if (code >= 65 && code <= 90) {
      next = String.fromCharCode(code + 32);
    } else if ((code >= 97 && code <= 122) || (code >= 48 && code <= 57)) {
      next = char;
    } else {
      next = FOLD_MAP.get(char.toLowerCase()) ?? "";
    }

    if (next) {
      if (pendingSeparator && slug) {
        slug += "-";
      }
      slug += next;
      pendingSeparator = false;
    } else {
      pendingSeparator = true;
    }
  }

  return slug;
}

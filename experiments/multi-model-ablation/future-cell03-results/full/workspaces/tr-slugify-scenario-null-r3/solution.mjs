const FOLDED_LATIN_1 = new Map([
  ["à", "a"], ["á", "a"], ["â", "a"], ["ã", "a"], ["ä", "a"], ["å", "a"],
  ["À", "a"], ["Á", "a"], ["Â", "a"], ["Ã", "a"], ["Ä", "a"], ["Å", "a"],
  ["è", "e"], ["é", "e"], ["ê", "e"], ["ë", "e"],
  ["È", "e"], ["É", "e"], ["Ê", "e"], ["Ë", "e"],
  ["ì", "i"], ["í", "i"], ["î", "i"], ["ï", "i"],
  ["Ì", "i"], ["Í", "i"], ["Î", "i"], ["Ï", "i"],
  ["ò", "o"], ["ó", "o"], ["ô", "o"], ["õ", "o"], ["ö", "o"],
  ["Ò", "o"], ["Ó", "o"], ["Ô", "o"], ["Õ", "o"], ["Ö", "o"],
  ["ù", "u"], ["ú", "u"], ["û", "u"], ["ü", "u"],
  ["Ù", "u"], ["Ú", "u"], ["Û", "u"], ["Ü", "u"],
  ["ñ", "n"], ["Ñ", "n"],
  ["ç", "c"], ["Ç", "c"],
]);

export default function slugify(input) {
  let slug = "";
  let needsSeparator = false;

  for (const character of String(input ?? "")) {
    const code = character.charCodeAt(0);
    let next = "";

    if (code >= 48 && code <= 57) {
      next = character;
    } else if (code >= 65 && code <= 90) {
      next = String.fromCharCode(code + 32);
    } else if (code >= 97 && code <= 122) {
      next = character;
    } else {
      next = FOLDED_LATIN_1.get(character) ?? "";
    }

    if (next) {
      if (needsSeparator && slug) {
        slug += "-";
      }
      slug += next;
      needsSeparator = false;
    } else if (slug) {
      needsSeparator = true;
    }
  }

  return slug;
}

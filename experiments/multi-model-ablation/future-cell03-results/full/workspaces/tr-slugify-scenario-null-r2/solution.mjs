const folds = new Map([
  ["à", "a"], ["á", "a"], ["â", "a"], ["ã", "a"], ["ä", "a"], ["å", "a"],
  ["è", "e"], ["é", "e"], ["ê", "e"], ["ë", "e"],
  ["ì", "i"], ["í", "i"], ["î", "i"], ["ï", "i"],
  ["ò", "o"], ["ó", "o"], ["ô", "o"], ["õ", "o"], ["ö", "o"],
  ["ù", "u"], ["ú", "u"], ["û", "u"], ["ü", "u"],
  ["ñ", "n"], ["ç", "c"],
]);

export default function slugify(input) {
  let slug = "";
  let pendingHyphen = false;

  for (const char of String(input)) {
    const code = char.charCodeAt(0);
    let next = "";

    if (code >= 65 && code <= 90) {
      next = String.fromCharCode(code + 32);
    } else if ((code >= 97 && code <= 122) || (code >= 48 && code <= 57)) {
      next = char;
    } else {
      next = folds.get(char.toLowerCase()) || "";
    }

    if (next) {
      if (pendingHyphen && slug) {
        slug += "-";
      }
      slug += next;
      pendingHyphen = false;
    } else {
      pendingHyphen = true;
    }
  }

  return slug;
}

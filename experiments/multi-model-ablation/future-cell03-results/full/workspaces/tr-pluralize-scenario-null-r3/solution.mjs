const irregulars = new Map([
  ["man", "men"],
  ["woman", "women"],
  ["child", "children"],
  ["person", "people"],
  ["mouse", "mice"],
  ["tooth", "teeth"],
  ["foot", "feet"],
  ["goose", "geese"],
]);

const unchanged = new Set(["sheep", "fish", "series", "species", "deer"]);
const vowels = new Set(["a", "e", "i", "o", "u"]);

export default function pluralize(word) {
  if (irregulars.has(word)) {
    return irregulars.get(word);
  }

  if (unchanged.has(word)) {
    return word;
  }

  if (/(?:s|ss|sh|ch|x|z)$/.test(word)) {
    return `${word}es`;
  }

  if (word.endsWith("y") && word.length > 1 && !vowels.has(word.at(-2))) {
    return `${word.slice(0, -1)}ies`;
  }

  if (word.endsWith("o") && word.length > 1 && !vowels.has(word.at(-2))) {
    return `${word}es`;
  }

  if (word.endsWith("fe")) {
    return `${word.slice(0, -2)}ves`;
  }

  if (word.endsWith("f")) {
    return `${word.slice(0, -1)}ves`;
  }

  return `${word}s`;
}

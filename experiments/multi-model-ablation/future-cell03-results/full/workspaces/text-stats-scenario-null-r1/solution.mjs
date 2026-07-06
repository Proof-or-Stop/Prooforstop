export default function analyze(text) {
  if (typeof text !== 'string') {
    throw new Error('Input must be a string');
  }

  if (text.trim().length === 0) {
    return {
      words: 0,
      sentences: 0,
      avgWordLen: 0,
      topWord: '',
    };
  }

  const tokens = text
    .split(/\s+/)
    .map((token) => token.replace(/[^\p{L}]/gu, ''))
    .filter((token) => token.length > 0);

  const counts = new Map();
  let topWord = '';
  let topCount = 0;
  let totalLength = 0;

  for (const token of tokens) {
    totalLength += token.length;

    const word = token.toLowerCase();
    const count = (counts.get(word) ?? 0) + 1;
    counts.set(word, count);

    if (count > topCount) {
      topWord = word;
      topCount = count;
    }
  }

  const terminators = text.match(/[.!?]+/g);
  const sentences = terminators ? terminators.length : 1;
  const words = tokens.length;
  const avgWordLen = words === 0 ? 0 : Math.round((totalLength / words) * 10) / 10;

  return {
    words,
    sentences,
    avgWordLen,
    topWord,
  };
}

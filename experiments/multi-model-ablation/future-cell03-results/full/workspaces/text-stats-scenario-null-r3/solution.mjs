export default function analyze(text) {
  if (typeof text !== 'string') {
    throw new Error('analyze expects a string input');
  }

  const trimmed = text.trim();
  if (trimmed === '') {
    return { words: 0, sentences: 0, avgWordLen: 0, topWord: '' };
  }

  const tokens = text
    .split(/\s+/)
    .map((token) => token.replace(/[^\p{L}]/gu, ''))
    .filter((token) => token !== '');

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
      topCount = count;
      topWord = word;
    }
  }

  const terminatorRuns = trimmed.match(/[.!?]+/g);
  const words = tokens.length;
  const sentences = terminatorRuns ? terminatorRuns.length : 1;
  const avgWordLen = words === 0 ? 0 : Number((totalLength / words).toFixed(1));

  return { words, sentences, avgWordLen, topWord };
}

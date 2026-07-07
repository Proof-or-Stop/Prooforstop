// Text statistics analyzer.
// Computes word count, sentence count, average word length, and the most frequent word.

/** Split text into clean word tokens (letters only, no empties). */
function tokenize(text) {
  return text
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}]/gu, '').toLowerCase())
    .filter((w) => w.length > 0);
}

/** Count sentence terminator runs; fall back to 1 for non-empty text without one. */
function countSentences(text) {
  const matches = text.match(/[.!?]+/g);
  if (matches && matches.length > 0) return matches.length;
  return text.length > 0 ? 1 : 0;
}

/** Mean token length, rounded to one decimal place. */
function averageLength(tokens) {
  if (tokens.length === 0) return 0;
  const total = tokens.reduce((sum, w) => sum + w.length, 0);
  return Math.round((total / tokens.length) * 10) / 10;
}

/** Return the most frequent token, keeping the first token to reach the top count. */
function findTopWord(tokens) {
  const freq = new Map();
  let best = '';
  let bestCount = 0;
  for (const token of tokens) {
    const current = freq.get(token) || 0;
    const next = current + 1;
    freq.set(token, next);
    if (next > bestCount) {
      bestCount = next;
      best = token;
    }
  }
  return best;
}

export default function analyze(text) {
  if (typeof text !== 'string') throw new Error('text must be a string');
  const trimmed = text.trim();
  if (trimmed === '') {
    return { words: 0, sentences: 0, avgWordLen: 0, topWord: '' };
  }
  const tokens = tokenize(trimmed);
  const words = tokens.length;
  const sentences = countSentences(trimmed);
  const avgWordLen = averageLength(tokens);
  const topWord = findTopWord(tokens);
  return { words, sentences, avgWordLen, topWord };
}

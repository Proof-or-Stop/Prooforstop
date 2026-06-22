// Known-good reference (S4). Not shown to arms.
export default function analyze(text) {
  if (typeof text !== 'string') throw new Error('text must be a string');
  const trimmed = text.trim();
  if (trimmed === '') return { words: 0, sentences: 0, avgWordLen: 0, topWord: '' };
  const tokens = trimmed.split(/\s+/).map(w => w.replace(/[^A-Za-z]/g, '')).filter(Boolean);
  const words = tokens.length;
  const sentences = (trimmed.match(/[.!?]+/g) || []).length || (words > 0 ? 1 : 0);
  const totalLen = tokens.reduce((s, w) => s + w.length, 0);
  const avgWordLen = words ? Math.round((totalLen / words) * 10) / 10 : 0;
  const freq = new Map();
  for (const w of tokens) { const k = w.toLowerCase(); freq.set(k, (freq.get(k) || 0) + 1); }
  let topWord = '', topCount = -1;
  for (const [k, c] of freq) { if (c > topCount) { topCount = c; topWord = k; } }
  return { words, sentences, avgWordLen, topWord };
}

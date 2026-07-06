export default function median(numbers) {
  if (!Array.isArray(numbers) || numbers.length === 0) throw new Error('empty array');
  const s = [...numbers].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  if (s.length % 2 === 1) return s[mid];
  return (s[mid - 1] + s[mid]) / 2;
}

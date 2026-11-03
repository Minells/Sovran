const SEPARATORS = new Set(['/', '\\', '_', '-', '.', ' ']);

/**
 * Subsequence fuzzy score for file paths (higher is better, null = no match).
 * Rewards matches at word starts, consecutive runs and matches inside the file name.
 */
export function fuzzyScore(query: string, candidate: string): number | null {
  const q = query.toLowerCase().replace(/\s+/g, '');
  if (!q) return 0;
  const c = candidate.toLowerCase();
  const baseStart = Math.max(c.lastIndexOf('/'), c.lastIndexOf('\\')) + 1;
  // Greedy left-to-right matching can latch onto an early folder letter; also try matching inside the file name.
  const scores = [scoreFrom(q, c, 0, baseStart), scoreFrom(q, c, baseStart, baseStart)].filter((x): x is number => x !== null);
  if (!scores.length) return null;
  const bonus = c.slice(baseStart).startsWith(q) ? 10 : 0;
  return Math.max(...scores) + bonus - c.length * 0.02;
}

function scoreFrom(q: string, c: string, start: number, baseStart: number): number | null {
  let score = 0;
  let ci = start;
  let prev = -2;
  for (const ch of q) {
    const found = c.indexOf(ch, ci);
    if (found === -1) return null;
    score += 1;
    if (found === 0 || SEPARATORS.has(c[found - 1]!)) score += 4;
    if (found === prev + 1) score += 3;
    if (found >= baseStart) score += 2;
    prev = found;
    ci = found + 1;
  }
  return score;
}

export function rankFuzzy(query: string, items: readonly string[], limit: number): string[] {
  return items
    .map((item) => ({ item, score: fuzzyScore(query, item) }))
    .filter((x): x is { item: string; score: number } => x.score !== null)
    .sort((a, b) => b.score - a.score || a.item.localeCompare(b.item))
    .slice(0, limit)
    .map((x) => x.item);
}

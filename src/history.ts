import fs from 'fs';
import path from 'path';

const HISTORY_PATH = path.resolve('./history.json');

// ─────────────────────────────────────────────────────────────────────────────
//  Load / Save
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reads history.json and returns the array of previously posted tweet strings.
 * Returns an empty array if the file is missing or malformed.
 */
export function loadHistory(): string[] {
  try {
    if (!fs.existsSync(HISTORY_PATH)) return [];
    const raw = fs.readFileSync(HISTORY_PATH, 'utf-8').trim();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      console.warn('[history] history.json is not an array — resetting.');
      return [];
    }
    return parsed as string[];
  } catch {
    console.warn('[history] Could not read history.json — starting fresh.');
    return [];
  }
}

/**
 * Writes the updated `entries` array back to history.json (pretty-printed).
 */
export function saveHistory(entries: string[]): void {
  fs.writeFileSync(HISTORY_PATH, JSON.stringify(entries, null, 2), 'utf-8');
}

// ─────────────────────────────────────────────────────────────────────────────
//  Duplicate detection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns true if `candidate` is suspiciously similar to any entry in `history`.
 * Uses a simple overlap strategy: checks if >60% of words in candidate exist in
 * any previous tweet. This catches near-duplicates without false positives.
 */
export function isDuplicate(candidate: string, history: string[]): boolean {
  if (history.length === 0) return false;

  const candidateWords = new Set(
    candidate.toLowerCase().split(/\W+/).filter(Boolean)
  );

  for (const past of history) {
    const pastWords = past.toLowerCase().split(/\W+/).filter(Boolean);
    if (pastWords.length === 0) continue;

    const overlap = pastWords.filter((w) => candidateWords.has(w)).length;
    const similarity = overlap / pastWords.length;

    if (similarity > 0.6) {
      console.warn(
        `[history] Duplicate detected (${(similarity * 100).toFixed(0)}% overlap):\n  Past: "${past}"\n  New:  "${candidate}"`
      );
      return true;
    }
  }

  return false;
}

/**
 * Appends a successfully posted tweet to history and persists to disk.
 */
export function recordTweet(tweet: string, history: string[]): string[] {
  const updated = [...history, tweet];
  saveHistory(updated);
  console.log(`[history] Tweet recorded. Total in history: ${updated.length}`);
  return updated;
}

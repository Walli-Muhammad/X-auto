import { Page } from 'playwright';

// ─────────────────────────────────────────────────────────────────────────────
//  Box-Muller Gaussian random number generator
//  Returns a sample from N(mean, stddev) clamped to [min, max]
// ─────────────────────────────────────────────────────────────────────────────

function gaussianRandom(mean: number, stddev: number): number {
  // Box-Muller transform: converts two uniform randoms into a Gaussian sample
  let u = 0;
  let v = 0;
  // Avoid log(0) by ensuring u and v are never exactly 0
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  const sample = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
  return mean + stddev * sample;
}

/**
 * Returns a Gaussian-distributed delay in milliseconds.
 * Clamped between `min` and `max` to prevent negative or extreme values.
 */
export async function gaussianDelay(
  mean: number,
  stddev: number,
  min = 50,
  max = 15_000
): Promise<void> {
  const raw = gaussianRandom(mean, stddev);
  const ms = Math.round(Math.min(max, Math.max(min, raw)));
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

// ─────────────────────────────────────────────────────────────────────────────
//  Adjacent-key typo map — QWERTY layout
//  Used to generate realistic wrong characters on typo rolls
// ─────────────────────────────────────────────────────────────────────────────

const ADJACENT_KEYS: Record<string, string> = {
  a: 'sqwz', b: 'vghn', c: 'xdfv', d: 'erscf', e: 'wrds',
  f: 'rtdgv', g: 'tyfhb', h: 'yugjn', i: 'uojk', j: 'uihkm',
  k: 'iojlm', l: 'opk;', m: 'jkn,', n: 'bhjm', o: 'ipkl',
  p: 'ol;[', q: 'wa', r: 'etdf', s: 'qwedaz', t: 'rfgy',
  u: 'yhji', v: 'cfgb', w: 'qeAs', x: 'zsdc', y: 'tghu',
  z: 'asx', ' ': '  ',
};

function getTypoChar(char: string): string {
  const lower = char.toLowerCase();
  const neighbors = ADJACENT_KEYS[lower];
  if (!neighbors || neighbors.length === 0) return char;
  const wrong = neighbors[Math.floor(Math.random() * neighbors.length)];
  // Preserve original case
  return char === char.toUpperCase() ? wrong.toUpperCase() : wrong;
}

// ─────────────────────────────────────────────────────────────────────────────
//  typeLikeAHuman
//  Processes text character-by-character into a Playwright page element,
//  simulating authentic human typing with timing variance and occasional typos.
// ─────────────────────────────────────────────────────────────────────────────

const TYPO_PROBABILITY = 0.03; // 3% chance of a typo per character
const TYPE_DELAY_MIN = 50;     // ms — fastest comfortable keystroke
const TYPE_DELAY_MAX = 180;    // ms — natural hesitation ceiling

/**
 * Types `text` into the element matching `selector` on `page`.
 * Uses Gaussian delay between keystrokes and a 3% typo-then-backspace mechanic.
 */
export async function typeLikeAHuman(
  page: Page,
  selector: string,
  text: string
): Promise<void> {
  await page.click(selector);

  for (const char of text) {
    const rollTypo = Math.random() < TYPO_PROBABILITY;

    if (rollTypo) {
      // ── Typo sequence ────────────────────────────────────────────────────
      const wrong = getTypoChar(char);
      await page.keyboard.type(wrong);
      // Brief pause — human notices the mistake
      await gaussianDelay(120, 30, 60, 300);
      await page.keyboard.press('Backspace');
      // Short recovery pause before typing the correct character
      await gaussianDelay(80, 20, 40, 200);
    }

    // ── Correct keystroke ─────────────────────────────────────────────────
    await page.keyboard.type(char);

    // Per-character inter-keystroke delay — uniform random in [min, max]
    const delay =
      Math.floor(Math.random() * (TYPE_DELAY_MAX - TYPE_DELAY_MIN + 1)) +
      TYPE_DELAY_MIN;
    await new Promise<void>((resolve) => setTimeout(resolve, delay));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  lurkOverhead
//  Simulates a human "reading" the page for 5–8 seconds post-action
//  before the session is closed. Includes subtle scroll simulation.
// ─────────────────────────────────────────────────────────────────────────────

const LURK_MEAN_MS = 6_500;   // ~6.5 seconds average dwell
const LURK_STDDEV_MS = 700;   // ±700ms natural variance
const LURK_MIN_MS = 5_000;
const LURK_MAX_MS = 8_000;

/**
 * Keeps the browser alive for a Gaussian-distributed 5–8 second window,
 * emitting a small scroll mid-way to simulate reading behavior.
 */
export async function lurkOverhead(page: Page): Promise<void> {
  const totalDwell = Math.round(
    Math.min(
      LURK_MAX_MS,
      Math.max(LURK_MIN_MS, gaussianRandom(LURK_MEAN_MS, LURK_STDDEV_MS))
    )
  );

  console.log(`[lurk] Simulating read overhead for ${(totalDwell / 1000).toFixed(1)}s...`);

  // Wait half the dwell time, then do a small scroll, then wait the rest
  const midpoint = Math.floor(totalDwell / 2);
  await new Promise<void>((resolve) => setTimeout(resolve, midpoint));

  // Subtle scroll — as if scanning down the feed
  const scrollAmount = Math.floor(Math.random() * 200) + 80; // 80–280px
  await page.mouse.wheel(0, scrollAmount);

  await new Promise<void>((resolve) =>
    setTimeout(resolve, totalDwell - midpoint)
  );
}

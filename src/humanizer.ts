import { Page, ElementHandle } from 'playwright';

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

// ─────────────────────────────────────────────────────────────────────────────
//  humanMouseMove
//  Moves the mouse from a plausible start position to (targetX, targetY)
//  along a quadratic Bezier arc with per-step micro-jitter.
//  Real humans never move in straight lines at constant speed.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Simulates natural curved mouse movement to (targetX, targetY).
 *
 * Generates a quadratic Bezier path between a random start inside the
 * viewport and the target, with a random control point that creates
 * the characteristic arc of human wrist movement.
 * Each micro-step adds ±2px jitter and a 5–17ms delay.
 */
export async function humanMouseMove(
  page: Page,
  targetX: number,
  targetY: number
): Promise<void> {
  const vp = page.viewportSize() ?? { width: 1366, height: 768 };
  const steps = Math.floor(Math.random() * 16) + 20; // 20–35 steps

  // Start from a random position roughly in the viewport's inner region
  const startX = Math.floor(vp.width  * (0.25 + Math.random() * 0.5));
  const startY = Math.floor(vp.height * (0.25 + Math.random() * 0.5));

  // Bezier control point — offset from the midpoint to create a natural arc
  const cpX = startX + (targetX - startX) * (0.3 + Math.random() * 0.4)
             + (Math.random() - 0.5) * 220;
  const cpY = startY + (targetY - startY) * (0.3 + Math.random() * 0.4)
             + (Math.random() - 0.5) * 220;

  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    // Quadratic Bezier: B(t) = (1-t)²·P0 + 2(1-t)t·P1 + t²·P2
    const bx = (1 - t) ** 2 * startX + 2 * (1 - t) * t * cpX + t ** 2 * targetX;
    const by = (1 - t) ** 2 * startY + 2 * (1 - t) * t * cpY + t ** 2 * targetY;

    // ±2px hand-tremor jitter
    const jx = (Math.random() - 0.5) * 4;
    const jy = (Math.random() - 0.5) * 4;

    await page.mouse.move(Math.round(bx + jx), Math.round(by + jy));

    // Slightly slower mid-arc (sinusoidal speed profile)
    const speedFactor = Math.sin(t * Math.PI); // 0 → 1 → 0
    const stepMs = Math.round(5 + speedFactor * 8 + Math.random() * 4); // 5–17ms
    await new Promise<void>((r) => setTimeout(r, stepMs));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  humanClick
//  Moves the mouse to a random interior point of the element bounding box,
//  then fires a real mouse click. Falls back to element.click() if the
//  bounding box is unavailable (e.g., off-screen element).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Performs a human-like click on `element`.
 *
 * 1. Resolves the element's bounding box.
 * 2. Picks a random point within the inner 60% of the element (avoids edges).
 * 3. Moves the mouse there via `humanMouseMove`.
 * 4. Fires a real `page.mouse.click()` at that coordinate.
 */
export async function humanClick(
  page: Page,
  element: ElementHandle | null
): Promise<void> {
  if (!element) return;

  const box = await element.boundingBox();
  if (box && box.width > 0 && box.height > 0) {
    // Click a random point in the inner 60% of the element
    const x = Math.round(box.x + box.width  * (0.2 + Math.random() * 0.6));
    const y = Math.round(box.y + box.height * (0.2 + Math.random() * 0.6));
    await humanMouseMove(page, x, y);
    // Brief micro-pause before the click — mirrors human reaction time
    await new Promise<void>((r) => setTimeout(r, Math.floor(Math.random() * 80) + 40));
    await page.mouse.click(x, y);
  } else {
    // Fallback: element is off-screen or zero-sized — use Playwright's own click
    await element.click();
  }
}

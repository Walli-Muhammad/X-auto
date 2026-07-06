/**
 * engage.ts — Community Engagement Engine (Reply / Retweet)
 *
 * Orchestrates browser-side engagement sessions against a curated list of
 * target X handles. Called from stealth_poster.ts when MODE is REPLY or RETWEET.
 *
 * Design principles:
 *  - Max MAX_ENGAGEMENTS_PER_SESSION actions per run (2–3, randomly chosen)
 *  - Picks random handles from TARGET_HANDLES each session for variety
 *  - Skips pinned tweets when finding a target to engage with
 *  - All delays are Gaussian (Box-Muller) — never static timeouts
 *  - HUMAN_IN_THE_LOOP gate is always enforced for replies (never skipped)
 *  - All failures degrade gracefully: logs a warning and continues to next handle
 */

import readline from 'readline';
import { Page, ElementHandle } from 'playwright';

import { config } from './config';
import { generateReply } from './llm';
import { fetchLatestContext } from './search';
import { gaussianDelay, typeLikeAHuman } from './humanizer';

// ─────────────────────────────────────────────────────────────────────────────
//  Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Hard ceiling on browser actions per session — safety rail against over-posting. */
const MAX_ENGAGEMENTS_PER_SESSION = 3;

/** Minimum wait between consecutive engagements (ms). */
const INTER_ENGAGEMENT_MIN_MS = 12_000;
/** Maximum wait between consecutive engagements (ms). */
const INTER_ENGAGEMENT_MAX_MS = 28_000;

// ─────────────────────────────────────────────────────────────────────────────
//  Internal utilities
// ─────────────────────────────────────────────────────────────────────────────

/** Shuffle array and return a slice of `count` random items. */
function pickRandom<T>(arr: T[], count: number): T[] {
  return [...arr]
    .sort(() => Math.random() - 0.5)
    .slice(0, Math.min(count, arr.length));
}

/** Inline readline [y/n] gate — mirrors the one in stealth_poster.ts. */
function askYesNo(prompt: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`${prompt} [y/n] → `, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y');
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  Profile navigation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Navigate to `https://x.com/${handle}` and return `true` on success.
 * Returns `false` (with a warning) if the profile is unavailable or if the
 * session appears to have expired mid-session.
 */
async function navigateToProfile(page: Page, handle: string): Promise<boolean> {
  const cleanHandle = handle.replace(/^@/, '').trim();
  console.log(`\n[engage] Navigating to @${cleanHandle}...`);

  try {
    await page.goto(`https://x.com/${cleanHandle}`, {
      waitUntil: 'domcontentloaded',
      timeout: 20_000,
    });
    await page.waitForTimeout(2_000); // allow redirects to settle

    const url = page.url();

    if (url.includes('/login') || url.includes('/i/flow/login')) {
      console.error(
        '\n[engage] ❌ Session expired mid-session.\n' +
          "         Re-run 'npm run auth' to generate a fresh session.\n"
      );
      process.exit(1);
    }

    // X shows a "this account doesn't exist" state in a div, not a 404
    const notFound = await page.$('[data-testid="emptyState"]');
    if (notFound) {
      console.warn(`[engage] Profile @${cleanHandle} is empty, suspended, or does not exist.`);
      return false;
    }

    return true;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[engage] Failed to navigate to @${cleanHandle}: ${msg}`);
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Tweet discovery
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns the first non-pinned tweet article on a profile page.
 * Skips any article whose sibling `[data-testid="socialContext"]` contains
 * the word "pinned". Falls back to the first article if none is clearly pinned.
 */
async function findFirstNonPinnedTweet(page: Page): Promise<ElementHandle | null> {
  try {
    await page.waitForSelector('article[data-testid="tweet"]', { timeout: 10_000 });
    const articles = await page.$$('article[data-testid="tweet"]');

    for (const article of articles) {
      const socialCtx = await article.$('[data-testid="socialContext"]');
      if (socialCtx) {
        const ctxText = (await socialCtx.innerText()).toLowerCase();
        if (ctxText.includes('pinned')) {
          continue; // explicitly skip pinned tweets
        }
      }
      return article; // first non-pinned tweet found
    }

    // Fallback: if every tweet has a socialContext (edge case), return the first
    return articles[0] ?? null;
  } catch {
    console.warn('[engage] Timed out waiting for tweet articles on this profile.');
    return null;
  }
}

/**
 * Extracts the visible text content of a tweet article.
 * Returns an empty string if `[data-testid="tweetText"]` is not found.
 */
async function extractTweetText(article: ElementHandle): Promise<string> {
  try {
    const textEl = await article.$('[data-testid="tweetText"]');
    if (!textEl) return '';
    return (await textEl.innerText()).trim();
  } catch {
    return '';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Retweet action
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Clicks the retweet button on `article`, waits for the confirmation popup,
 * and clicks "Repost". Returns a history-entry string on success, or null.
 */
async function retweetTweet(
  page: Page,
  article: ElementHandle,
  handle: string
): Promise<string | null> {
  console.log(`[engage] Retweeting latest post from @${handle}...`);

  const retweetBtn = await article.$('[data-testid="retweet"]');
  if (!retweetBtn) {
    console.warn(`[engage] Retweet button not found on @${handle}'s tweet.`);
    return null;
  }

  await retweetBtn.click();
  await gaussianDelay(700, 120, 400, 1_300);

  // X shows a popup with "Repost" and "Quote" options
  try {
    await page.waitForSelector('[data-testid="retweetConfirm"]', { timeout: 6_000 });
    await gaussianDelay(500, 80, 300, 900);
    await page.click('[data-testid="retweetConfirm"]');
    console.log(`✅ Retweeted @${handle}!\n`);

    // Capture the tweet text for history (best-effort — may be empty for media-only posts)
    const tweetText = await extractTweetText(article);
    const snippet = tweetText.slice(0, 80) + (tweetText.length > 80 ? '…' : '');
    return `[RETWEET @${handle}] ${snippet}`;
  } catch {
    console.warn(
      `[engage] Repost confirmation popup not found for @${handle} — ` +
        'may already be retweeted or X changed its DOM.'
    );
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Reply action
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generates an LLM reply to `article`'s tweet content, presents it via HITL
 * (always enabled for replies), then types and submits the reply.
 * Returns a history-entry string on success, or null on skip/failure.
 */
async function replyToTweet(
  page: Page,
  article: ElementHandle,
  handle: string,
  history: string[]
): Promise<string | null> {
  // ── Extract the target tweet text ─────────────────────────────────────────
  const targetText = await extractTweetText(article);
  if (!targetText) {
    console.warn(`[engage] Could not extract tweet text from @${handle} — skipping.`);
    return null;
  }

  const preview = targetText.slice(0, 120) + (targetText.length > 120 ? '…' : '');
  console.log(`\n[engage] Replying to @${handle}:\n  "${preview}"\n`);

  // ── Fetch Serper context & generate reply ─────────────────────────────────
  const webContext = await fetchLatestContext(config.topic);
  const reply = await generateReply(targetText, webContext, history);

  // ── Print draft reply ─────────────────────────────────────────────────────
  console.log(`\n[llm] Draft reply (${reply.length} chars):\n`);
  console.log(`  ┌${'─'.repeat(60)}┐`);
  const wrapped = reply.match(/.{1,58}/g) ?? [reply];
  for (const line of wrapped) {
    console.log(`  │ ${line.padEnd(58)} │`);
  }
  console.log(`  └${'─'.repeat(60)}┘\n`);

  // ── HITL gate — always enforced for replies regardless of config ───────────
  const approved = await askYesNo(`[HITL] Send this reply to @${handle}?`);
  if (!approved) {
    console.log('[HITL] Reply skipped.\n');
    return null;
  }

  // ── Click the reply button on this specific article ───────────────────────
  const replyBtn = await article.$('[data-testid="reply"]');
  if (!replyBtn) {
    console.warn('[engage] Reply button not found on tweet article.');
    return null;
  }

  await replyBtn.click();
  await gaussianDelay(900, 180, 500, 1_800);

  // Wait for the reply compose textarea to appear
  const replyArea = '[data-testid="tweetTextarea_0"]';
  try {
    await page.waitForSelector(replyArea, { timeout: 8_000 });
  } catch {
    console.warn('[engage] Reply compose area did not appear in time.');
    return null;
  }

  // ── Type the reply ────────────────────────────────────────────────────────
  console.log(`[browser] Typing reply to @${handle}...`);
  await typeLikeAHuman(page, replyArea, reply);
  await gaussianDelay(1_200, 200, 700, 2_500);

  // ── Submit ────────────────────────────────────────────────────────────────
  // The inline reply submit button (inside the dialog)
  const submitSelectors = [
    '[data-testid="tweetButtonInline"]',
    '[data-testid="tweetButton"]',
  ];

  for (const sel of submitSelectors) {
    const btn = await page.$(sel);
    if (btn) {
      const disabled = await btn.getAttribute('aria-disabled');
      if (disabled === 'true') {
        console.warn('[engage] Reply submit button is disabled — reply may be empty or over-limit.');
        return null;
      }
      await gaussianDelay(500, 80, 300, 900);
      await btn.click();
      console.log(`✅ Reply sent to @${handle}!\n`);
      return `[REPLY @${handle}] ${reply}`;
    }
  }

  console.warn('[engage] Reply submit button not found.');
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Main engagement session orchestrator
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Runs a full engagement session for the given `mode`.
 *
 * Picks a random subset of `config.targetHandles` (2–3 per session),
 * navigates to each profile, finds the latest non-pinned tweet, and performs
 * the appropriate action (reply or retweet). Enforces inter-engagement delays.
 *
 * @returns Array of strings to be appended to history.json
 */
export async function runEngagementSession(
  page: Page,
  mode: 'REPLY' | 'RETWEET',
  history: string[]
): Promise<string[]> {
  const { targetHandles } = config;

  // Randomly choose 2 or 3 engagements for this session
  const sessionCount = Math.floor(Math.random() * 2) + 2;
  const sessionHandles = pickRandom(targetHandles, Math.min(sessionCount, MAX_ENGAGEMENTS_PER_SESSION));

  console.log(`\n[engage] ─────────────────────────────────────────`);
  console.log(`[engage] Mode            : ${mode}`);
  console.log(`[engage] Session handles : ${sessionHandles.map((h) => '@' + h).join(', ')}`);
  console.log(`[engage] Actions planned : ${sessionHandles.length}`);
  console.log(`[engage] ─────────────────────────────────────────\n`);

  const results: string[] = [];
  // Track history locally so each LLM call within the session avoids repeating
  let sessionHistory = [...history];

  for (let i = 0; i < sessionHandles.length; i++) {
    const handle = sessionHandles[i]!;

    // Navigate to this user's profile
    const arrived = await navigateToProfile(page, handle);
    if (!arrived) continue;

    // Natural dwell — simulate briefly reading the profile
    await gaussianDelay(2_200, 450, 1_200, 4_500);

    // Find the first non-pinned tweet
    const article = await findFirstNonPinnedTweet(page);
    if (!article) {
      console.warn(`[engage] No usable tweet found on @${handle}. Skipping.\n`);
      continue;
    }

    // Perform the engagement
    const result =
      mode === 'REPLY'
        ? await replyToTweet(page, article, handle, sessionHistory)
        : await retweetTweet(page, article, handle);

    if (result) {
      results.push(result);
      sessionHistory = [...sessionHistory, result]; // update in-session dedup context
    }

    // Inter-engagement delay (skip after the last one)
    if (i < sessionHandles.length - 1) {
      const waitMs =
        INTER_ENGAGEMENT_MIN_MS +
        Math.floor(Math.random() * (INTER_ENGAGEMENT_MAX_MS - INTER_ENGAGEMENT_MIN_MS));
      console.log(
        `[engage] Waiting ${(waitMs / 1_000).toFixed(0)}s before next engagement...\n`
      );
      await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
    }
  }

  console.log(
    `\n[engage] Session complete — ${results.length}/${sessionHandles.length} engagements successful.\n`
  );
  return results;
}

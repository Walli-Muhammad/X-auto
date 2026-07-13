/**
 * engage.ts — Community Engagement Engine (Reply / Retweet / Feed Discovery)
 *
 * Orchestrates browser-side engagement sessions.
 *
 * Two operating modes:
 *  A) TARGET mode  — visits a curated list of TARGET_HANDLES and engages with
 *                    their latest tweet. Used when TARGET_HANDLES is non-empty.
 *  B) DISCOVER mode — scrolls the home timeline, scores visible tweets by
 *                    relevance to config.topic using keyword matching, and
 *                    replies to the top 2–3. Used when TARGET_HANDLES is empty.
 *
 * Design principles:
 *  - Max MAX_ENGAGEMENTS_PER_SESSION actions per run (2–3, randomly chosen)
 *  - All delays are Gaussian (Box-Muller) — never static timeouts
 *  - HUMAN_IN_THE_LOOP gate is always enforced for replies (never skipped)
 *  - All failures degrade gracefully: logs a warning and moves on
 */

import readline from 'readline';
import { Page, ElementHandle } from 'playwright';

import { config } from './config';
import { generateReply } from './llm';
import { fetchLatestContext } from './search';
import { gaussianDelay, typeLikeAHuman, humanClick } from './humanizer';

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

  await humanClick(page, retweetBtn);   // ← curved mouse movement
  await gaussianDelay(700, 120, 400, 1_300);

  // X shows a popup with "Repost" and "Quote" options
  try {
    await page.waitForSelector('[data-testid="retweetConfirm"]', { timeout: 6_000 });
    await gaussianDelay(500, 80, 300, 900);
    const confirmBtn = await page.$('[data-testid="retweetConfirm"]');
    await humanClick(page, confirmBtn); // ← curved mouse movement
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

  await humanClick(page, replyBtn);   // ← curved mouse movement
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
      await humanClick(page, btn);    // ← curved mouse movement
      console.log(`✅ Reply sent to @${handle}!\n`);
      return `[REPLY @${handle}] ${reply}`;
    }
  }

  console.warn('[engage] Reply submit button not found.');
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Feed discovery — scroll home timeline and find relevant tweets
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Scores a tweet's text against config.topic.
 * Simple bag-of-words keyword overlap — fast, no LLM call needed at this stage.
 * Returns a score 0–1 (higher = more relevant).
 */
function scoreTweetRelevance(tweetText: string, topic: string): number {
  const stopWords = new Set([
    'a','an','the','and','or','but','in','on','at','to','for','of',
    'with','is','it','be','this','that','are','was','were','has','have',
    'by','from','as','not','we','i','you','they','he','she','my','our',
  ]);

  const tokenise = (s: string): string[] =>
    s.toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !stopWords.has(w));

  const topicTokens = new Set(tokenise(topic));
  if (topicTokens.size === 0) return 0;

  const tweetTokens = tokenise(tweetText);
  const matches = tweetTokens.filter((w) => topicTokens.has(w)).length;
  return matches / topicTokens.size;
}

interface DiscoveredTweet {
  article: ElementHandle;
  text: string;
  author: string;
  score: number;
}

async function discoverRelevantTweets(
  page: Page,
  scrollPasses: number = 4,
  minScore: number = 0.08,
  maxResults: number = 5
): Promise<DiscoveredTweet[]> {
  console.log('[discover] Scanning home timeline for relevant tweets...');

  // ── Step 1: Detect which article selector X is currently using ─────────────
  // X periodically renames data-testid attributes. Try several known variants.
  const candidateArticleSelectors = [
    'article[data-testid="tweet"]',          // standard
    '[data-testid="tweet"]',                  // without article tag
    'article[role="article"]',               // semantic fallback
    '[data-testid="cellInnerDiv"] article',  // wrapped variant
    'article',                               // broadest fallback
  ];

  let tweetSelector = 'article[data-testid="tweet"]'; // default
  let foundAny = false;

  console.log('[discover] Waiting for feed to populate...');
  for (const sel of candidateArticleSelectors) {
    try {
      await page.waitForSelector(sel, { timeout: 6_000 });
      tweetSelector = sel;
      foundAny = true;
      console.log(`[discover] Feed ready — using selector: "${sel}"`);
      break;
    } catch { /* try next */ }
  }

  if (!foundAny) {
    console.warn('[discover] Feed did not populate. Trying "Latest" tab...');
    try {
      // Switch to Latest tab — sometimes the For You feed loads differently
      await page.goto('https://x.com/home?f=live', { waitUntil: 'domcontentloaded', timeout: 20_000 });
      await page.waitForTimeout(3_000);
      for (const sel of candidateArticleSelectors) {
        try {
          await page.waitForSelector(sel, { timeout: 5_000 });
          tweetSelector = sel;
          foundAny = true;
          console.log(`[discover] Latest feed ready — using selector: "${sel}"`);
          break;
        } catch { /* try next */ }
      }
    } catch { /* best-effort */ }
  }

  // Extra settle time after feed detection
  await page.waitForTimeout(1_500);

  // ── Step 2: Get own handle to skip own posts ───────────────────────────────
  let ownHandle = '';
  try {
    const profileLink = await page.$('a[data-testid="AppTabBar_Profile_Link"]');
    if (profileLink) {
      const href = await profileLink.getAttribute('href');
      if (href) ownHandle = href.replace('/', '').toLowerCase();
    }
  } catch { /* best-effort */ }

  const seen = new Set<string>();
  const collected: DiscoveredTweet[] = [];

  // ── Step 3: Scroll and collect ────────────────────────────────────────────
  for (let pass = 0; pass < scrollPasses; pass++) {
    const articles = await page.$$(tweetSelector);
    console.log(`[discover] Pass ${pass + 1}/${scrollPasses} — ${articles.length} articles visible (selector: "${tweetSelector}")`);

    for (const article of articles) {
      try {
        // Extract tweet text — try both old and new data-testid variants
        let text = '';
        for (const textSel of ['[data-testid="tweetText"]', '[lang]', 'div[dir="auto"]']) {
          const textEl = await article.$(textSel);
          if (textEl) {
            const t = (await textEl.innerText()).trim();
            if (t.length > 20) { text = t; break; }
          }
        }
        if (!text || seen.has(text)) continue;
        seen.add(text);

        // Extract author handle
        let author = 'unknown';
        try {
          const userLink = await article.$('a[role="link"][href*="/"]');
          if (userLink) {
            const href = await userLink.getAttribute('href');
            if (href) author = href.replace('/', '').toLowerCase();
          }
        } catch { /* best-effort */ }

        // Skip own posts
        if (ownHandle && author === ownHandle) continue;

        // Skip promoted/ad tweets
        const adLabel = await article.$('[data-testid="placementTracking"]');
        if (adLabel) continue;

        // Score for relevance — use a lower threshold so more tweets qualify
        const score = scoreTweetRelevance(text, config.topic);
        if (score >= minScore) {
          collected.push({ article, text, author, score });
        }
      } catch { /* skip malformed articles */ }
    }

    if (pass < scrollPasses - 1) {
      await page.evaluate(() => { (globalThis as any).scrollBy(0, (globalThis as any).innerHeight * 2); });
      await page.waitForTimeout(2_500);
    }
  }

  // If nothing scored high enough, take any tweet (score > 0) as fallback
  if (collected.length === 0 && seen.size > 0) {
    console.log('[discover] No tweets met score threshold — relaxing filter to any tweet with topic overlap...');
    // Re-scan with score >= 0 (any overlap at all)
    const articles = await page.$$(tweetSelector);
    for (const article of articles) {
      try {
        const textEl = await article.$('[data-testid="tweetText"]');
        if (!textEl) continue;
        const text = (await textEl.innerText()).trim();
        if (!text) continue;
        const score = scoreTweetRelevance(text, config.topic);
        if (score > 0) {
          let author = 'unknown';
          try {
            const userLink = await article.$('a[role="link"][href*="/"]');
            if (userLink) { const href = await userLink.getAttribute('href'); if (href) author = href.replace('/', '').toLowerCase(); }
          } catch { /* best-effort */ }
          collected.push({ article, text, author, score });
        }
      } catch { /* skip */ }
    }
  }

  const ranked = collected
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults);

  console.log(`[discover] Found ${ranked.length} relevant tweet(s) out of ${seen.size} scanned.`);
  ranked.forEach((t, i) =>
    console.log(`  ${i + 1}. @${t.author} (score: ${t.score.toFixed(2)}): "${t.text.slice(0, 60)}…"`)
  );

  return ranked;
}

// ─────────────────────────────────────────────────────────────────────────────

//  Feed discovery session (DISCOVER mode — no target handles needed)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Scrolls the home feed, finds the most relevant tweets, and replies to
 * the top 2–3 using the same HITL + LLM pipeline as TARGET mode.
 *
 * Called by stealth_poster.ts when MODE=REPLY and TARGET_HANDLES is empty.
 *
 * @returns Array of strings to be appended to history.json
 */
export async function discoverFromFeed(
  page: Page,
  history: string[]
): Promise<string[]> {
  const sessionCount = Math.floor(Math.random() * 2) + 2; // 2 or 3

  console.log('\n[discover] ─────────────────────────────────────────');
  console.log('[discover] Mode    : Feed Discovery (no target handles)');
  console.log(`[discover] Topic   : "${config.topic}"`);
  console.log(`[discover] Max replies : ${sessionCount}`);
  console.log('[discover] ─────────────────────────────────────────\n');

  // Discover relevant tweets from the home feed
  const candidates = await discoverRelevantTweets(page, 4, 0.05, sessionCount + 2);

  if (candidates.length === 0) {
    console.warn(
      '[discover] No relevant tweets found on the home feed.\n' +
      '           Try broadening your TOPIC or switching to TARGET mode.'
    );
    return [];
  }

  // Scroll back to top so article handles are still in the viewport
  await page.evaluate(() => { (globalThis as any).scrollTo(0, 0); });
  await page.waitForTimeout(1_500);

  const results: string[] = [];
  let sessionHistory = [...history];
  const toReply = candidates.slice(0, sessionCount);

  for (let i = 0; i < toReply.length; i++) {
    const { article, author } = toReply[i]!;

    // Re-scroll into view (the article handle may be off-screen after scroll-to-top)
    try {
      await article.scrollIntoViewIfNeeded();
      await page.waitForTimeout(800);
    } catch { /* article may have been replaced by React re-render — skip */ }

    const result = await replyToTweet(page, article, author, sessionHistory);

    if (result) {
      results.push(result);
      sessionHistory = [...sessionHistory, result];
    }

    // Inter-reply delay
    if (i < toReply.length - 1) {
      const waitMs =
        INTER_ENGAGEMENT_MIN_MS +
        Math.floor(Math.random() * (INTER_ENGAGEMENT_MAX_MS - INTER_ENGAGEMENT_MIN_MS));
      console.log(`[discover] Waiting ${(waitMs / 1_000).toFixed(0)}s before next reply...\n`);
      await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
    }
  }

  console.log(
    `\n[discover] Session complete — ${results.length}/${toReply.length} replies sent.\n`
  );
  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Main engagement session orchestrator (TARGET mode)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Runs a full TARGET engagement session.
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

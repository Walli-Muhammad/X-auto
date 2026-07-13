/**
 * stealth_poster.ts — Orchestration Entry Point
 *
 * Run with: npm start
 *
 * Branches on config.mode:
 *
 *  ORIGINAL_POST:
 *   1. Validate config & session
 *   2. Load history
 *   2.5 Fetch Serper web context (RAG)
 *   3. Generate tweet via DeepInfra LLM
 *   4. [HITL] CLI preview + [y/n] approval
 *   5. Launch browser with storageState
 *   6. Navigate home — session-expiry guard
 *   7. typeLikeAHuman → compose box
 *   8. [HITL] Final confirmation before Post
 *   9. Submit → lurkOverhead → close browser
 *  10. Record in history.json
 *
 *  REPLY | RETWEET:
 *   1. Validate config & session
 *   2. Load history
 *   3. Launch browser → validate session via home
 *   4. runEngagementSession (engage.ts) — up to 3 handles
 *   5. lurkOverhead → close browser
 *   6. Record all actions in history.json
 */

import readline from 'readline';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { chromium, Browser, BrowserContext, Page } from 'playwright';

import { config, assertSessionExists } from './config';
import { generateTweet } from './llm';
import { loadHistory, isDuplicate, recordTweet } from './history';
import { gaussianDelay, typeLikeAHuman, lurkOverhead, humanClick } from './humanizer';
import { fetchLatestContext } from './search';
import { runEngagementSession, discoverFromFeed } from './engage';

// ─────────────────────────────────────────────────────────────────────────────
//  Resolve headful Chrome binary — bypasses incomplete Playwright install check
//  (headless-shell often fails to download on restricted networks, but the
//  headful chrome.exe is always what we use)
// ─────────────────────────────────────────────────────────────────────────────

function resolveChromePath(): string | undefined {
  const win = path.join(
    os.homedir(),
    'AppData', 'Local', 'ms-playwright',
    'chromium-1228', 'chrome-win64', 'chrome.exe'
  );
  if (process.platform === 'win32' && fs.existsSync(win)) return win;
  return undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Viewport pool — real screen resolutions to randomize fingerprint
// ─────────────────────────────────────────────────────────────────────────────

const VIEWPORT_POOL = [
  { width: 1920, height: 1080 },
  { width: 1440, height: 900 },
  { width: 1536, height: 864 },
  { width: 1366, height: 768 },
  { width: 1280, height: 800 },
  { width: 2560, height: 1440 },
];

function randomViewport() {
  return VIEWPORT_POOL[Math.floor(Math.random() * VIEWPORT_POOL.length)];
}

// ─────────────────────────────────────────────────────────────────────────────
//  CLI helpers
// ─────────────────────────────────────────────────────────────────────────────

function askYesNo(prompt: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(`${prompt} [y/n] → `, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y');
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  Session expiry detection
//  X redirects unauthenticated users back to /login or /i/flow/login
// ─────────────────────────────────────────────────────────────────────────────

function isSessionExpired(url: string): boolean {
  return (
    url.includes('/login') ||
    url.includes('/i/flow/login') ||
    url.includes('/i/flow/signup') ||
    url.includes('/logout')
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  Browser launch — stealth configuration
// ─────────────────────────────────────────────────────────────────────────────

async function launchBrowser(): Promise<{
  browser: Browser;
  context: BrowserContext;
  page: Page;
}> {
  const viewport = randomViewport();

  const browser = await chromium.launch({
    headless: config.headless,
    executablePath: resolveChromePath(), // use already-downloaded chrome.exe directly
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
    ],
  });

  const context = await browser.newContext({
    storageState: config.authSessionPath,
    viewport,
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
    locale: 'en-US',
    timezoneId: Intl.DateTimeFormat().resolvedOptions().timeZone,
    // Mask webdriver flag to avoid trivial bot detection
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });

  // Inject script to remove navigator.webdriver before page load.
  // The callback runs inside the browser's renderer process where `navigator`
  // exists — cast to `() => void` to avoid Node.js TS lib false-positive.
  await context.addInitScript((() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Object.defineProperty((globalThis as any).navigator, 'webdriver', {
      get: () => undefined,
    });
  }) as () => void);

  const page = await context.newPage();
  return { browser, context, page };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Navigate to X home and validate session
// ─────────────────────────────────────────────────────────────────────────────

async function navigateHome(page: Page): Promise<void> {
  console.log('[browser] Navigating to https://x.com/home ...');
  await page.goto('https://x.com/home', {
    waitUntil: 'domcontentloaded',
    timeout: 30_000,
  });

  // Allow redirects to settle
  await page.waitForTimeout(2_000);

  const finalUrl = page.url();
  console.log(`[browser] Landed on: ${finalUrl}`);

  if (isSessionExpired(finalUrl)) {
    console.error(
      '\n❌ Session expired. Please re-run \'npm run auth\' to generate a fresh session.\n'
    );
    process.exit(1);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Find and activate the tweet compose box
// ─────────────────────────────────────────────────────────────────────────────

async function openComposeBox(page: Page): Promise<string> {
  console.log('[browser] Looking for compose box...');

  // All selectors that could represent the compose textarea
  // (X changes these periodically — ordered by specificity)
  const textareaSelectors = [
    '[data-testid="tweetTextarea_0"]',
    '[data-testid^="tweetTextarea"]',           // any variant of tweetTextarea
    'div[contenteditable="true"][role="textbox"]',
    'div.public-DraftEditor-content',            // Draft.js editor fallback
    'div[contenteditable="true"][aria-label]',   // any labelled contenteditable
    'div[contenteditable="true"]',               // ultimate fallback
  ];

  // Helper: wait for the first matching textarea selector to appear
  async function waitForTextarea(timeoutMs: number): Promise<string | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      for (const sel of textareaSelectors) {
        try {
          const el = await page.waitForSelector(sel, { timeout: 1_500 });
          if (el) {
            console.log(`[browser] Compose textarea found via: ${sel}`);
            return sel;
          }
        } catch { /* not found yet */ }
      }
    }
    return null;
  }

  // Give the home feed extra time to fully hydrate before probing the DOM
  await page.waitForTimeout(3_000);

  // ── Strategy 1: inline compose area already visible on home feed ───────────
  const found1 = await waitForTextarea(5_000);
  if (found1) {
    const el = await page.$(found1);
    if (el) {
      await humanClick(page, el);
      await gaussianDelay(400, 80, 250, 700);
      return found1;
    }
  }

  // ── Strategy 2: click the compose / new-post button, then wait for modal ──
  const composeButtonSelectors = [
    '[data-testid="SideNav_NewTweet_Button"]',  // sidebar pencil icon
    'a[href="/compose/post"]',                   // direct link variant
    'a[href="/compose/tweet"]',                  // older URL variant
    '[aria-label="Post"]',                       // button label variant
    '[aria-label="Compose tweet"]',
  ];

  for (const btnSel of composeButtonSelectors) {
    try {
      const btn = await page.waitForSelector(btnSel, { timeout: 4_000 });
      if (!btn) continue;

      console.log(`[browser] Clicking compose button: ${btnSel}`);
      await humanClick(page, btn);   // ← human curved mouse path

      // Allow the compose modal/drawer to animate open
      await page.waitForTimeout(1_500);

      // Poll for a textarea for up to 20 seconds — generous to handle slow renders
      const found2 = await waitForTextarea(20_000);
      if (found2) {
        return found2;
      }
      console.log(`[browser] Textarea not found after clicking ${btnSel}, trying next...`);
    } catch {
      // button selector not found — try next
    }
  }

  throw new Error(
    '[browser] Could not locate the tweet compose area. ' +
      'X may have changed its DOM. Update the selectors in openComposeBox().'
  );
}

// ─────────────────────────────────────────────────────────────────────────────


//  Submit the tweet
// ─────────────────────────────────────────────────────────────────────────────

async function submitTweet(page: Page): Promise<void> {
  const postButtonSelectors = [
    '[data-testid="tweetButtonInline"]',
    '[data-testid="tweetButton"]',
    '[aria-label="Post all"]',
  ];

  for (const sel of postButtonSelectors) {
    const btn = await page.$(sel);
    if (btn) {
      const isDisabled = await btn.getAttribute('aria-disabled');
      if (isDisabled === 'true') {
        throw new Error(
          '[browser] Post button is disabled. The tweet may be empty or too long.'
        );
      }
      console.log(`[browser] Clicking post button: ${sel}`);
      await humanClick(page, btn);   // ← human curved mouse path
      return;
    }
  }

  throw new Error(
    '[browser] Could not find the Post button. ' +
      'X may have changed its DOM. Update the selectors in submitTweet().'
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  Main pipeline
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║         X Automation — Stealth Poster             ║');
  console.log('╚══════════════════════════════════════════════════╝\n');

  // ── Step 1: Validate config & session ────────────────────────────────────────────
  assertSessionExists(config.authSessionPath);
  console.log(`[config] Mode         : ${config.mode}`);
  console.log(`[config] Topic        : "${config.topic}"`);
  console.log(`[config] Tone         : ${config.toneStyle}`);
  console.log(`[config] Max length   : ${config.tweetMaxLength} chars`);
  console.log(`[config] HITL         : ${config.humanInTheLoop}`);
  console.log(`[config] Headless     : ${config.headless}\n`);

  // ── Step 2: Load dedup history ────────────────────────────────────────────
  const history = loadHistory();
  console.log(`[history] Loaded ${history.length} previously posted tweet(s).\n`);

  // ─────────────────────────────────────────────────────────────────────────────
  //  BRANCH: ORIGINAL_POST
  // ─────────────────────────────────────────────────────────────────────────────
  if (config.mode === 'ORIGINAL_POST') {
    // Step 2.5: Fetch real-time web context (RAG)
    // fetchLatestContext is fault-tolerant: returns '' on any failure.
    const webContext = await fetchLatestContext(config.topic);

    // Step 3: Generate tweet via LLM (grounded by web context)
    let draft = await generateTweet(config.topic, webContext, history);

    // Regenerate once if it's a near-duplicate (belt-and-suspenders check)
    if (isDuplicate(draft, history)) {
      console.log('[llm] Draft too similar to history — requesting a new one...');
      draft = await generateTweet(config.topic, webContext, history);
    }

    // Print draft
    console.log(`\n[llm] Draft tweet (${draft.length} chars):\n`);
    console.log(`  ┌${'─'.repeat(60)}┐`);
    const wrapped = draft.match(/.{1,58}/g) ?? [draft];
    for (const line of wrapped) {
      console.log(`  │ ${line.padEnd(58)} │`);
    }
    console.log(`  └${'─'.repeat(60)}┘\n`);

    // Step 4: HITL — draft approval
    if (config.humanInTheLoop) {
      const approved = await askYesNo('[HITL] Approve this draft and open the browser?');
      if (!approved) {
        console.log('\n[HITL] Draft rejected. Exiting without posting.\n');
        process.exit(0);
      }
      console.log('[HITL] Draft approved. Launching browser...\n');
    }

    // Step 5: Launch browser with stored session
    const { browser, page } = await launchBrowser();
    try {
      // Step 6: Navigate home & validate session
      await navigateHome(page);
      await gaussianDelay(1_200, 250, 700, 2_500);

      // Step 7: Open compose box & type
      const composeSel = await openComposeBox(page);
      await gaussianDelay(800, 150, 500, 1_500);
      console.log('[browser] Typing tweet...');
      await typeLikeAHuman(page, composeSel, draft);
      await gaussianDelay(1_500, 300, 900, 3_000);

      // Step 8: HITL — final confirmation before submit
      if (config.humanInTheLoop) {
        const confirm = await askYesNo('[HITL] Tweet is typed. Submit now?');
        if (!confirm) {
          console.log('\n[HITL] Submission cancelled. Closing browser without posting.\n');
          await browser.close();
          process.exit(0);
        }
      }

      // Step 9: Submit
      await gaussianDelay(600, 100, 400, 1_200);
      await submitTweet(page);
      console.log('\n✅ Tweet submitted successfully!\n');

      // Step 10: Lurk overhead
      await lurkOverhead(page);
    } finally {
      await browser.close();
      console.log('[browser] Session closed.\n');
    }

    // Step 11: Record in history
    recordTweet(draft, history);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  //  BRANCH: REPLY | RETWEET
  // ─────────────────────────────────────────────────────────────────────────────
  else {
    const hasHandles = config.targetHandles.length > 0;
    const isReply = config.mode === 'REPLY';

    // RETWEET mode always requires explicit handles
    if (!isReply && !hasHandles) {
      console.error(
        '\n[engage] ❌ RETWEET mode requires TARGET_HANDLES to be configured.\n' +
          '         Add at least one X handle in the Configure tab or .env.\n'
      );
      process.exit(1);
    }

    // REPLY mode: if no handles → use feed discovery mode
    if (isReply && !hasHandles) {
      console.log('[engage] No TARGET_HANDLES set → switching to Feed Discovery mode.');
      console.log('[engage] Will scroll home feed and reply to the most relevant tweets.\n');
    } else {
      console.log(`[engage] Targets available: ${config.targetHandles.map((h) => '@' + h).join(', ')}\n`);
    }

    const { browser, page } = await launchBrowser();
    let posted: string[] = [];

    try {
      // Validate session before navigating
      await navigateHome(page);
      await gaussianDelay(1_200, 250, 700, 2_500);

      if (isReply && !hasHandles) {
        // DISCOVER mode: scroll home feed, find & reply to relevant tweets
        posted = await discoverFromFeed(page, history);
      } else {
        // TARGET mode: visit specific profiles
        posted = await runEngagementSession(
          page,
          config.mode as 'REPLY' | 'RETWEET',
          history
        );
      }

      await lurkOverhead(page);
    } finally {
      await browser.close();
      console.log('[browser] Session closed.\n');
    }

    // Record all engagement actions in history
    let updatedHistory = history;
    for (const entry of posted) {
      updatedHistory = recordTweet(entry, updatedHistory);
    }
  }

  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║               Run complete. Done.                 ║');
  console.log('╚══════════════════════════════════════════════════╝\n');
}

// ─────────────────────────────────────────────────────────────────────────────
//  Entry point
// ─────────────────────────────────────────────────────────────────────────────

main().catch((err: unknown) => {
  console.error('\n[fatal] Unhandled error:', err);
  process.exit(1);
});

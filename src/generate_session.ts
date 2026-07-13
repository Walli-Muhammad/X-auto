/**
 * generate_session.ts — Mode A: Session Generator
 *
 * Run with: npm run auth
 *
 * Launches a headful Chromium browser, navigates to x.com, and waits for
 * the user to complete Google OAuth login manually. Once confirmed via terminal,
 * it snapshots the browser's cookies and localStorage to AUTH_SESSION_PATH
 * so that stealth_poster.ts can operate without any credential input.
 */

import readline from 'readline';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { chromium } from 'playwright';
import dotenv from 'dotenv';

// ─────────────────────────────────────────────────────────────────────────────
//  Resolve the headful Chrome executable that Playwright already downloaded.
//  We bypass the "all components installed" check because the headless-shell
//  download keeps failing on some networks — but we only ever run headful anyway.
// ─────────────────────────────────────────────────────────────────────────────

function resolveChromePath(): string | undefined {
  // Standard Playwright cache location on Windows
  const win = path.join(
    os.homedir(),
    'AppData', 'Local', 'ms-playwright',
    'chromium-1228', 'chrome-win64', 'chrome.exe'
  );
  if (process.platform === 'win32' && fs.existsSync(win)) return win;
  return undefined; // fall back to Playwright's own resolution on other OSes
}

dotenv.config();

// ─────────────────────────────────────────────────────────────────────────────
//  Resolve session output path
// ─────────────────────────────────────────────────────────────────────────────

const rawSessionPath = process.env['AUTH_SESSION_PATH'] ?? './auth/session.json';
const SESSION_PATH = path.resolve(rawSessionPath);
const SESSION_DIR = path.dirname(SESSION_PATH);

// ─────────────────────────────────────────────────────────────────────────────
//  CLI prompt helper
// ─────────────────────────────────────────────────────────────────────────────

function waitForEnter(prompt: string): Promise<void> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(prompt, () => {
      rl.close();
      resolve();
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  Main session capture flow
// ─────────────────────────────────────────────────────────────────────────────

async function generateSession(): Promise<void> {
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║         X Automation — Session Generator          ║');
  console.log('╚══════════════════════════════════════════════════╝\n');
  console.log('[auth] Launching headful browser...\n');

  // Ensure the auth directory exists before we try to write into it
  if (!fs.existsSync(SESSION_DIR)) {
    fs.mkdirSync(SESSION_DIR, { recursive: true });
    console.log(`[auth] Created directory: ${SESSION_DIR}`);
  }

  const executablePath = resolveChromePath();
  if (executablePath) {
    console.log(`[auth] Using browser: ${executablePath}`);
  }

  const browser = await chromium.launch({
    headless: false,
    executablePath,          // uses the already-downloaded chrome.exe directly
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--start-maximized',
    ],
  });

  // Fresh context — no storageState so we start fully unauthenticated
  const context = await browser.newContext({
    viewport: null, // Use the OS window size (--start-maximized)
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
    locale: 'en-US',
  });

  const page = await context.newPage();

  console.log('[auth] Navigating to https://x.com/login ...');
  await page.goto('https://x.com/login', { waitUntil: 'domcontentloaded' });

  console.log('\n┌─────────────────────────────────────────────────┐');
  console.log('│  ACTION REQUIRED                                 │');
  console.log('│                                                   │');
  console.log('│  1. In the browser window that just opened,      │');
  console.log('│     click "Sign in with Google".                 │');
  console.log('│  2. Complete the full Google login flow.         │');
  console.log('│  3. Make sure you land on your X home feed.      │');
  console.log('│  4. Then return here and press ENTER.            │');
  console.log('└─────────────────────────────────────────────────┘\n');

  await waitForEnter('Press ENTER once you are fully logged in to X → ');

  // ── Verify we actually landed on the home feed ─────────────────────────
  const currentUrl = page.url();
  if (
    currentUrl.includes('/login') ||
    currentUrl.includes('/i/flow/login') ||
    currentUrl.includes('/i/flow/signup')
  ) {
    console.error(
      '\n[auth] ERROR: Browser still appears to be on the login page.\n' +
        '       Please complete the full Google OAuth flow before pressing ENTER.\n' +
        '       Re-run "npm run auth" and try again.\n'
    );
    await browser.close();
    process.exit(1);
  }

  // ── Snapshot storageState (cookies + localStorage) ─────────────────────
  console.log('\n[auth] Saving session state...');
  await context.storageState({ path: SESSION_PATH });

  console.log(`\n✅ Session saved to: ${SESSION_PATH}`);
  console.log('   You can now run "npm start" to begin automated posting.\n');
  console.log(
    '   ⚠️  Keep auth/session.json private — it contains live session tokens.\n'
  );

  await browser.close();
  process.exit(0);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Entry point
// ─────────────────────────────────────────────────────────────────────────────

generateSession().catch((err: unknown) => {
  console.error('\n[auth] Unexpected error:', err);
  process.exit(1);
});

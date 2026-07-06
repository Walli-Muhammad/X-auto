/**
 * configure.ts — Interactive Terminal Configuration Editor
 *
 * Run with: npm run configure
 *
 * Presents a guided inquirer prompt session covering all runtime-tunable
 * settings, then writes the updated values directly into your local .env file
 * (preserving all existing comments and secret keys like DEEPINFRA_TOKEN).
 *
 * Does NOT import from ./config so it is safe to run before a .env exists.
 */

import inquirer from 'inquirer';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

const ENV_PATH = path.resolve('.env');
const ENV_EXAMPLE_PATH = path.resolve('.env.example');

// ─────────────────────────────────────────────────────────────────────────────
//  .env I/O helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Parse the current .env (or .env.example as fallback) into a plain object. */
function readCurrentEnv(): Record<string, string> {
  const sourcePath = fs.existsSync(ENV_PATH) ? ENV_PATH : ENV_EXAMPLE_PATH;
  if (!fs.existsSync(sourcePath)) return {};
  return dotenv.parse(fs.readFileSync(sourcePath, 'utf-8'));
}

/**
 * Writes `updates` back into .env, replacing existing values line-by-line and
 * appending any keys that are not yet present. Comments are preserved.
 */
function writeEnvUpdates(updates: Record<string, string>): void {
  // Seed from .env; fall back to .env.example template if .env doesn't exist
  let content = '';
  if (fs.existsSync(ENV_PATH)) {
    content = fs.readFileSync(ENV_PATH, 'utf-8');
  } else if (fs.existsSync(ENV_EXAMPLE_PATH)) {
    content = fs.readFileSync(ENV_EXAMPLE_PATH, 'utf-8');
    console.log('\n[configure] .env not found — initialising from .env.example template.');
  }

  for (const [key, value] of Object.entries(updates)) {
    // Escape special regex chars in key names (handles underscores etc.)
    const keyPattern = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const lineRegex = new RegExp(`^${keyPattern}=.*$`, 'm');

    if (lineRegex.test(content)) {
      content = content.replace(lineRegex, `${key}=${value}`);
    } else {
      // Key not present — append at end of file
      content = content.endsWith('\n') ? content : content + '\n';
      content += `${key}=${value}\n`;
    }
  }

  fs.writeFileSync(ENV_PATH, content, 'utf-8');
}

// ─────────────────────────────────────────────────────────────────────────────
//  Prompt definitions
// ─────────────────────────────────────────────────────────────────────────────

async function runConfigure(): Promise<void> {
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║   X Automation — Interactive Config Editor       ║');
  console.log('╠══════════════════════════════════════════════════╣');
  console.log('║  API keys (DEEPINFRA_TOKEN, SERPER_API_KEY etc)  ║');
  console.log('║  are NOT shown here — edit .env directly.        ║');
  console.log('╚══════════════════════════════════════════════════╝\n');

  const current = readCurrentEnv();

  // ── Parse current boolean values ────────────────────────────────────────
  const currentHitl = (current['HUMAN_IN_THE_LOOP'] ?? 'true').toLowerCase() === 'true';
  const currentHeadless = (current['HEADLESS'] ?? 'false').toLowerCase() === 'true';
  const currentMaxLen = parseInt(current['TWEET_MAX_LENGTH'] ?? '240', 10);

  // ── Inquirer prompt chain ────────────────────────────────────────────────
  const answers = await inquirer.prompt([
    {
      type: 'list',
      name: 'MODE',
      message: 'Posting mode:',
      choices: [
        {
          name: '📝  Original Post  — generate a new tweet from scratch',
          value: 'ORIGINAL_POST',
        },
        {
          name: '💬  Reply          — reply to the latest post of target handles',
          value: 'REPLY',
        },
        {
          name: '🔁  Retweet        — repost the latest post of target handles',
          value: 'RETWEET',
        },
      ],
      default: current['MODE'] ?? 'ORIGINAL_POST',
    },
    {
      type: 'input',
      name: 'TOPIC',
      message: 'Tweet topic / context for LLM:',
      default: current['TOPIC'] ?? 'AI and software engineering',
      validate: (input: string) =>
        input.trim().length > 0 || 'Topic cannot be empty.',
    },
    {
      type: 'list',
      name: 'TONE_STYLE',
      message: 'Tone / persona style:',
      choices: [
        { name: 'pragmatic      — Direct builder mindset, zero fluff', value: 'pragmatic' },
        { name: 'tech-founder   — Visionary, opinionated, product-focused', value: 'tech-founder' },
        { name: 'cynical        — Sardonic, contrarian, skeptical of hype', value: 'cynical' },
        { name: 'educational    — Clear, explanatory, generous with knowledge', value: 'educational' },
        { name: 'provocative    — Bold takes, debate-starting, challenges norms', value: 'provocative' },
      ],
      default: current['TONE_STYLE'] ?? 'pragmatic',
    },
    {
      type: 'number',
      name: 'TWEET_MAX_LENGTH',
      message: 'Max post character length (100–280):',
      default: isNaN(currentMaxLen) ? 240 : currentMaxLen,
      validate: (input: number) =>
        (Number.isInteger(input) && input >= 100 && input <= 280) ||
        'Must be an integer between 100 and 280.',
    },
    {
      type: 'input',
      name: 'TARGET_HANDLES',
      message: 'Target X handles for Reply/Retweet (comma-separated, no @):',
      default: current['TARGET_HANDLES'] ?? '',
      when: (a: Record<string, unknown>) => a['MODE'] !== 'ORIGINAL_POST',
      validate: (input: string, a?: Record<string, unknown>) => {
        if (a?.['MODE'] === 'ORIGINAL_POST') return true;
        return input.trim().length > 0 || 'Enter at least one handle for Reply/Retweet mode.';
      },
    },
    {
      type: 'confirm',
      name: 'HUMAN_IN_THE_LOOP',
      message: 'Enable Human-in-the-Loop confirmation gate? (recommended)',
      default: currentHitl,
    },
    {
      type: 'confirm',
      name: 'HEADLESS',
      message: 'Run browser in headless mode? (less authentic — not recommended)',
      default: currentHeadless,
    },
  ]);

  // ─────────────────────────────────────────────────────────────────────────
  //  Build env update map from answers
  // ─────────────────────────────────────────────────────────────────────────

  const updates: Record<string, string> = {
    MODE: String(answers['MODE']),
    TOPIC: String(answers['TOPIC']).trim(),
    TONE_STYLE: String(answers['TONE_STYLE']),
    TWEET_MAX_LENGTH: String(answers['TWEET_MAX_LENGTH']),
    HUMAN_IN_THE_LOOP: String(answers['HUMAN_IN_THE_LOOP']),
    HEADLESS: String(answers['HEADLESS']),
  };

  // TARGET_HANDLES is only shown for REPLY/RETWEET; preserve existing value otherwise
  if (answers['TARGET_HANDLES'] !== undefined) {
    // Normalise: strip @ symbols, trim whitespace, remove blanks
    const handles = String(answers['TARGET_HANDLES'])
      .split(',')
      .map((h: string) => h.trim().replace(/^@/, ''))
      .filter(Boolean)
      .join(',');
    updates['TARGET_HANDLES'] = handles;
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  Write to .env
  // ─────────────────────────────────────────────────────────────────────────

  writeEnvUpdates(updates);

  // ─────────────────────────────────────────────────────────────────────────
  //  Summary
  // ─────────────────────────────────────────────────────────────────────────

  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║           ✅  Configuration Saved                 ║');
  console.log('╚══════════════════════════════════════════════════╝\n');

  const displayUpdates = { ...updates };
  for (const [k, v] of Object.entries(displayUpdates)) {
    console.log(`  ${k.padEnd(22)} = ${v}`);
  }

  console.log('\n  Run "npm start" to post, or "npm run auth" if session expired.\n');
}

// ─────────────────────────────────────────────────────────────────────────────
//  Entry point
// ─────────────────────────────────────────────────────────────────────────────

runConfigure().catch((err: unknown) => {
  // Handle Ctrl+C gracefully (inquirer throws an ExitPromptError on SIGINT)
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes('User force closed') || msg.includes('ExitPromptError')) {
    console.log('\n[configure] Cancelled — no changes written.\n');
    process.exit(0);
  }
  console.error('\n[configure] Error:', err);
  process.exit(1);
});

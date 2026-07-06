import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';

dotenv.config();

// ─────────────────────────────────────────────────────────────────────────────
//  Types
// ─────────────────────────────────────────────────────────────────────────────

export type PostMode = 'ORIGINAL_POST' | 'REPLY' | 'RETWEET';

// ─────────────────────────────────────────────────────────────────────────────
//  Config shape
// ─────────────────────────────────────────────────────────────────────────────

export interface Config {
  deepinfraToken: string;
  serperApiKey: string;
  authSessionPath: string;
  topic: string;
  mode: PostMode;
  toneStyle: string;
  tweetMaxLength: number;
  targetHandles: string[];
  humanInTheLoop: boolean;
  headless: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Validation helpers
// ─────────────────────────────────────────────────────────────────────────────

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value || value.trim() === '') {
    throw new Error(
      `[config] Missing required environment variable: ${key}\n` +
        `        Copy .env.example to .env and fill in all required values.`
    );
  }
  return value.trim();
}

function boolEnv(key: string, defaultValue: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return defaultValue;
  return raw.trim().toLowerCase() === 'true';
}

// ─────────────────────────────────────────────────────────────────────────────
//  Load and validate config
// ─────────────────────────────────────────────────────────────────────────────

function loadConfig(): Config {
  const deepinfraToken = requireEnv('DEEPINFRA_TOKEN');
  const serperApiKey = requireEnv('SERPER_API_KEY');
  const authSessionPath = path.resolve(
    requireEnv('AUTH_SESSION_PATH')
  );
  const topic = process.env['TOPIC']?.trim() || 'technology and AI';

  // ── Engagement mode ───────────────────────────────────────────────────────
  const VALID_MODES: PostMode[] = ['ORIGINAL_POST', 'REPLY', 'RETWEET'];
  const rawMode = (process.env['MODE']?.trim().toUpperCase() ?? 'ORIGINAL_POST') as PostMode;
  if (!VALID_MODES.includes(rawMode)) {
    throw new Error(
      `[config] Invalid MODE: "${rawMode}". Must be one of: ${VALID_MODES.join(', ')}`
    );
  }
  const mode: PostMode = rawMode;

  // ── Style & length ────────────────────────────────────────────────────────
  const toneStyle = process.env['TONE_STYLE']?.trim() || 'pragmatic';
  const rawMaxLen = parseInt(process.env['TWEET_MAX_LENGTH'] ?? '240', 10);
  const tweetMaxLength = isNaN(rawMaxLen)
    ? 240
    : Math.min(280, Math.max(100, rawMaxLen));

  // ── Target handles ────────────────────────────────────────────────────────
  const targetHandles = (process.env['TARGET_HANDLES'] ?? '')
    .split(',')
    .map((h) => h.trim().replace(/^@/, ''))
    .filter(Boolean);

  const humanInTheLoop = boolEnv('HUMAN_IN_THE_LOOP', true);
  const headless = boolEnv('HEADLESS', false);

  return {
    deepinfraToken,
    serperApiKey,
    authSessionPath,
    topic,
    mode,
    toneStyle,
    tweetMaxLength,
    targetHandles,
    humanInTheLoop,
    headless,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Session file guard — used by stealth_poster (not generate_session)
// ─────────────────────────────────────────────────────────────────────────────

export function assertSessionExists(authSessionPath: string): void {
  if (!fs.existsSync(authSessionPath)) {
    console.error(
      `\n[auth] Session file not found at: ${authSessionPath}\n` +
        `       Please run 'npm run auth' to generate a session first.\n`
    );
    process.exit(1);
  }
}

export const config: Config = loadConfig();

/**
 * preview.ts — Draft Preview (used by the admin panel /api/preview endpoint)
 *
 * Runs the LLM + Serper pipeline WITHOUT any browser interaction and writes
 * the result as JSON to stdout. All intermediate logs are redirected to stderr
 * so the server can reliably parse the single result line.
 *
 * Output format (last stdout line): __RESULT__:{JSON}
 */

import dotenv from 'dotenv';
dotenv.config();

// ── Redirect console.log → stderr BEFORE importing other modules ──────────────
// This ensures that all logging from config.ts / llm.ts / search.ts etc.
// goes to stderr and leaves stdout clean for the JSON result.
const _log = console.log.bind(console);
console.log = console.error.bind(console);

// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Dynamic imports so the console.log redirect takes effect first
  const { config } = await import('./config');
  const { generateTweet } = await import('./llm');
  const { fetchLatestContext } = await import('./search');
  const { loadHistory } = await import('./history');

  const history = loadHistory();
  const webContext = await fetchLatestContext(config.topic);
  const draft = await generateTweet(config.topic, webContext, history);

  // Restore console.log and write the structured result to stdout
  console.log = _log;
  process.stdout.write(
    `__RESULT__:${JSON.stringify({
      draft,
      topic: config.topic,
      toneStyle: config.toneStyle,
      maxLength: config.tweetMaxLength,
      mode: config.mode,
      hasWebContext: webContext.length > 0,
    })}\n`
  );
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  // Write error result using the same format so the server can parse it
  process.stdout.write(`__RESULT__:${JSON.stringify({ error: msg })}\n`);
  process.exit(1);
});

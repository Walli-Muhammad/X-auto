/**
 * search.ts — Serper.dev RAG Context Fetcher
 *
 * Fetches real-time Google search results for a given topic and formats
 * the top 3 organic results into a concise context string for the LLM prompt.
 * Designed to be fault-tolerant: any network or API failure returns an empty
 * string so the main pipeline degrades gracefully rather than crashing.
 */

import { config } from './config';

// ─────────────────────────────────────────────────────────────────────────────
//  Serper API response types (strict subset — only what we consume)
// ─────────────────────────────────────────────────────────────────────────────

interface SerperOrganicResult {
  title: string;
  link: string;
  snippet: string;
  position?: number;
}

interface SerperResponse {
  organic?: SerperOrganicResult[];
  searchParameters?: { q: string };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Constants
// ─────────────────────────────────────────────────────────────────────────────

const SERPER_ENDPOINT = 'https://google.serper.dev/search';
const TOP_N_RESULTS = 3;

// ─────────────────────────────────────────────────────────────────────────────
//  fetchLatestContext
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Queries the Serper.dev Google Search API for `topic` and returns the top
 * 3 organic results formatted as a grounding context block for the LLM.
 *
 * Returns an empty string on any failure — the calling pipeline must tolerate
 * an empty context and fall back to topic-only generation.
 */
export async function fetchLatestContext(topic: string): Promise<string> {
  console.log(`[search] Fetching live context for: "${topic}"...`);

  try {
    const response = await fetch(SERPER_ENDPOINT, {
      method: 'POST',
      headers: {
        'X-API-KEY': config.serperApiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ q: topic, num: TOP_N_RESULTS }),
      signal: AbortSignal.timeout(10_000), // 10s hard timeout
    });

    if (!response.ok) {
      console.warn(
        `[search] Serper API returned HTTP ${response.status} — skipping context injection.`
      );
      return '';
    }

    const data = (await response.json()) as SerperResponse;
    const organic = data.organic ?? [];

    if (organic.length === 0) {
      console.warn('[search] No organic results returned — skipping context injection.');
      return '';
    }

    // Extract top N results and format into a structured context block
    const contextLines = organic
      .slice(0, TOP_N_RESULTS)
      .map((result, idx) => {
        const title = result.title?.trim() ?? 'Untitled';
        const snippet = result.snippet?.trim() ?? 'No description available.';
        return `[Result ${idx + 1}]\n[Title]: ${title}\n[Context]: ${snippet}`;
      })
      .join('\n\n');

    console.log(
      `[search] Injecting ${Math.min(organic.length, TOP_N_RESULTS)} result(s) as grounding context.`
    );

    return contextLines;
  } catch (err: unknown) {
    // Network errors, timeouts, JSON parse failures — all handled gracefully
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[search] Context fetch failed (${message}) — proceeding without web context.`);
    return '';
  }
}

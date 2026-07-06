import OpenAI from 'openai';
import { config } from './config';

// ─────────────────────────────────────────────────────────────────────────────
//  DeepInfra OpenAI-compatible client
//  Uses the standard OpenAI SDK with a custom baseURL pointing to DeepInfra.
// ─────────────────────────────────────────────────────────────────────────────

const client = new OpenAI({
  apiKey: config.deepinfraToken,
  baseURL: 'https://api.deepinfra.com/v1/openai',
});

const MODEL = 'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo';

// ─────────────────────────────────────────────────────────────────────────────
//  Tone style descriptions — injected into the system prompt for richer guidance
// ─────────────────────────────────────────────────────────────────────────────

const TONE_DESCRIPTIONS: Record<string, string> = {
  'pragmatic': 'Direct and no-nonsense. Builder mindset. Zero fluff or hedging.',
  'tech-founder': 'Visionary and opinionated. Product-focused. Supremely confident.',
  'cynical': 'Sardonic and contrarian. Deeply skeptical of hype. Dry wit.',
  'educational': 'Clear and genuinely helpful. Generous with knowledge. Explains the "why".',
  'provocative': 'Bold hot takes. Challenges mainstream assumptions. Invites debate.',
};

// ─────────────────────────────────────────────────────────────────────────────
//  Prompt builder
// ─────────────────────────────────────────────────────────────────────────────

function buildSystemPrompt(
  topic: string,
  webContext: string,
  history: string[]
): string {
  const toneDescription = TONE_DESCRIPTIONS[config.toneStyle] ?? config.toneStyle;
  const maxLen = config.tweetMaxLength;

  // ── Real-time grounding block ──────────────────────────────────────────
  const contextBlock =
    webContext.trim().length > 0
      ? `\n\nCRITICAL GROUNDING: You must ground your thoughts using this real-time web search data:\n` +
        `---\n${webContext}\n---\n` +
        `Speak from your own perspective with absolute authority. ` +
        `Do NOT say "According to the search results" or "Based on recent news". ` +
        `Incorporate the technical context seamlessly into an original observation.`
      : '\n\n(No live web context available — rely on your existing knowledge of the topic.)';

  // ── Dedup section ──────────────────────────────────────────────────────
  const avoidSection =
    history.length > 0
      ? `\n\nIMPORTANT — Avoid repeating or closely paraphrasing any of these previously posted tweets:\n${history
          .slice(-20)
          .map((t, i) => `${i + 1}. "${t}"`)
          .join('\n')}`
      : '';

  return (
    `You are an elite, highly pragmatic software engineer building in public. ` +
    `Write a single punchy, high-leverage X post (under ${maxLen} characters) about the given topic: "${topic}".\n` +
    `Tone: ${toneDescription}` +
    contextBlock +
    `\n\nFormatting rules:\n` +
    `- Hard limit: ${maxLen} characters.\n` +
    `- Sound human and direct — no corporate speak, no hedging.\n` +
    `- No hashtags unless they genuinely add signal.\n` +
    `- Do NOT wrap the output in quotes.\n` +
    `- Return ONLY the post text — no labels, no explanations.` +
    avoidSection
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  generateTweet
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Calls the DeepInfra LLM to generate a tweet about `topic`,
 * grounded by `webContext` (live Serper search results) and
 * actively avoiding phrases already in `history`.
 */
export async function generateTweet(
  topic: string,
  webContext: string,
  history: string[]
): Promise<string> {
  const contextLabel =
    webContext.trim().length > 0
      ? `with ${webContext.split('\n').length}-line web context`
      : 'no web context (fallback mode)';
  console.log(`[llm] Generating tweet about: "${topic}" [${contextLabel}]...`);

  const response = await client.chat.completions.create({
    model: MODEL,
    messages: [
      {
        role: 'system',
        content: buildSystemPrompt(topic, webContext, history),
      },
      {
        role: 'user',
        content: `Write an X post about: ${topic}`,
      },
    ],
    max_tokens: 120,
    temperature: 0.85,
  });

  const raw = response.choices[0]?.message?.content ?? '';

  // Strip any accidental wrapping quotes the model might add
  const tweet = raw.trim().replace(/^["']|["']$/g, '');

  if (!tweet) {
    throw new Error('[llm] DeepInfra returned an empty response. Check your token and model name.');
  }

  if (tweet.length > config.tweetMaxLength) {
    console.warn(
      `[llm] Warning: Generated tweet is ${tweet.length} chars (over ${config.tweetMaxLength}). Truncating...`
    );
    return tweet.slice(0, config.tweetMaxLength);
  }

  return tweet;
}

// ─────────────────────────────────────────────────────────────────────────────
//  generateReply
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generates a contextual reply to `targetTweetText` using the DeepInfra LLM.
 * Grounded by `webContext` (live Serper results) and deduped against `history`.
 * Reads toneStyle and tweetMaxLength directly from config.
 */
export async function generateReply(
  targetTweetText: string,
  webContext: string,
  history: string[]
): Promise<string> {
  const toneDescription = TONE_DESCRIPTIONS[config.toneStyle] ?? config.toneStyle;
  const maxLen = config.tweetMaxLength;

  // ── Context grounding block ────────────────────────────────────────────
  const contextBlock =
    webContext.trim().length > 0
      ? `\n\nCRITICAL GROUNDING: Enrich your reply using this real-time context:\n` +
        `---\n${webContext}\n---\n` +
        `Do NOT say "According to..." or "Based on recent news". Incorporate naturally.`
      : '';

  // ── Dedup guard ────────────────────────────────────────────────────────
  const avoidSection =
    history.length > 0
      ? `\n\nAvoid sounding like any of these previous posts you've made:\n${history
          .slice(-10)
          .map((t, i) => `${i + 1}. "${t}"`)
          .join('\n')}`
      : '';

  const systemPrompt =
    `You are an elite, highly pragmatic software engineer building in public.\n` +
    `You are crafting a reply to the following X post:\n` +
    `"${targetTweetText}"\n` +
    contextBlock +
    `\n\nWrite a single reply (under ${maxLen} characters) that:\n` +
    `- Adds genuine, high-signal value — not empty agreement\n` +
    `- Speaks with authority and directness\n` +
    `- Does NOT open with "Great point!", "Exactly!", or any sycophantic phrase\n` +
    `- No hashtags unless essential\n` +
    `- Return ONLY the reply text — no labels, no quotes\n` +
    `Tone: ${toneDescription}` +
    avoidSection;

  console.log('[llm] Generating reply...');

  const response = await client.chat.completions.create({
    model: MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Reply to this post: "${targetTweetText}"` },
    ],
    max_tokens: 100,
    temperature: 0.88,
  });

  const raw = response.choices[0]?.message?.content ?? '';
  const reply = raw.trim().replace(/^["']|["']$/g, '');

  if (!reply) {
    throw new Error('[llm] DeepInfra returned an empty reply. Check your token and model name.');
  }

  return reply.length > maxLen ? reply.slice(0, maxLen) : reply;
}

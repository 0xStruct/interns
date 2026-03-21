#!/usr/bin/env bun
/**
 * enrich-persona.ts
 * Calls Claude via bankr.bot's LLM Gateway to synthesise a voice profile
 * from scraped content, then appends it to PERSONA.md §Scraped Voice Analysis.
 *
 * Uses the Anthropic SDK pointed at https://llm.bankr.bot — no code changes
 * needed vs direct Anthropic, just a different baseURL + BANKR_API_KEY.
 *
 * Requires: BANKR_API_KEY env var  (format: bk_YOUR_KEY)
 * Get one at: https://bankr.bot/api  →  enable LLM Gateway
 *
 * Usage:
 *   bun run scripts/enrich-persona.ts --agent-id johndoe-intern
 *
 * Output JSON: { ok: true } | { ok: false, error }
 */

import { parseArgs } from "util";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import Anthropic from "@anthropic-ai/sdk";

const ROOT = process.env.INTERNS_DIR ?? join(dirname(fileURLToPath(import.meta.url)), "..");

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: { "agent-id": { type: "string" } },
  strict: false,
});

const agentId = values["agent-id"];
if (!agentId) {
  console.log(JSON.stringify({ ok: false, error: "Missing --agent-id" }));
  process.exit(1);
}

const agentDir = join(ROOT, "influencers", agentId);
if (!existsSync(agentDir)) {
  console.log(JSON.stringify({ ok: false, error: `Agent ${agentId} not found` }));
  process.exit(1);
}

// bankr.bot LLM Gateway — Anthropic-compatible, no SDK changes needed
// https://docs.bankr.bot/llm-gateway/overview
const BANKR_API_KEY = process.env.BANKR_API_KEY;
if (!BANKR_API_KEY) {
  console.log(JSON.stringify({ ok: false, error: "BANKR_API_KEY not set. Get one at https://bankr.bot/api" }));
  process.exit(1);
}

function readIfExists(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

async function main() {
  const samples  = readIfExists(join(agentDir, "SAMPLES.md"));
  const context  = readIfExists(join(agentDir, "CONTEXT.md"));
  const persona  = readIfExists(join(agentDir, "PERSONA.md"));

  // Extract name from PERSONA.md
  const name = persona.match(/^# (.+?) —/m)?.[1] ?? agentId;

  const prompt = `You are analyzing content from ${name}, a public figure.

Below is their actual content: tweets, video transcripts, and articles.

Your task: Write a concise voice analysis that another AI can use to write in their style.
Focus on:
1. Tone (formal/casual, serious/humorous, confident/humble)
2. Vocabulary patterns (specific words/phrases they use often)
3. How they open and close ideas
4. What they emphasise and care about
5. Their communication rhythm (long paragraphs vs short punchy lines)
6. 5 example sentence starters in their voice

Return ONLY the voice analysis section as markdown (no headers, just the content).
Keep it under 400 words.

---
## TWEETS (sample)
${samples.slice(0, 3000)}

## VIDEO TRANSCRIPTS (excerpts)
${context.slice(0, 2000)}`;

  // Point the Anthropic SDK at bankr's LLM Gateway.
  // The gateway accepts the same /v1/messages endpoint + x-api-key header.
  const client = new Anthropic({
    apiKey: BANKR_API_KEY,
    baseURL: "https://llm.bankr.bot",
  });
  const message = await client.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 600,
    messages: [{ role: "user", content: prompt }],
  });

  const analysis = (message.content[0] as { type: string; text?: string }).text ?? "";

  // Append to PERSONA.md
  const header = "\n\n---\n## Scraped Voice Analysis\n";
  const newSection = header + `*Generated: ${new Date().toISOString()}*\n\n${analysis}\n`;

  let updatedPersona = persona;
  if (persona.includes("## Scraped Voice Analysis")) {
    updatedPersona = persona.replace(/\n\n---\n## Scraped Voice Analysis[\s\S]*$/, newSection);
  } else {
    updatedPersona = persona + newSection;
  }

  writeFileSync(join(agentDir, "PERSONA.md"), updatedPersona);
  console.log(JSON.stringify({ ok: true, agentId }));
}

main().catch(err => {
  console.log(JSON.stringify({ ok: false, error: String(err) }));
  process.exit(1);
});

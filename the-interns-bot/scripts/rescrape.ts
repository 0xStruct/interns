#!/usr/bin/env bun
/**
 * rescrape.ts
 * Orchestrates async voice enrichment for an influencer:
 *   1. scrape-x.ts      → SAMPLES.md
 *   2. scrape-youtube.ts → CONTEXT.md §Video Transcripts
 *   3. scrape-newsletter.ts → CONTEXT.md §Written Content
 *   4. enrich-persona.ts → PERSONA.md §Scraped Voice Analysis
 *
 * Usage:
 *   bun run the-interns-bot/scripts/rescrape.ts --agent-id johndoe-intern
 *
 * Returns immediately with { ok: true, message: "..." }
 * Enrichment runs in the background.
 */

import { parseArgs } from "util";
import { existsSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const ROOT = process.env.INTERNS_DIR ?? join(dirname(fileURLToPath(import.meta.url)), "../..");

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

// Read DATA.md for social URLs
const dataPath = join(agentDir, "DATA.md");
const data = readFileSync(dataPath, "utf8");
const xHandle     = data.match(/x_handle:\s*(\S+)/)?.[1] ?? "";
const youtubeUrl  = data.match(/youtube_url:\s*(\S+)/)?.[1] ?? "";
const newsletterUrl = data.match(/newsletter_url:\s*(\S+)/)?.[1] ?? "";

// Return immediately — enrichment runs in background
console.log(JSON.stringify({
  ok: true,
  message: `Rescraping ${agentId} in background. Updates will appear in PERSONA.md and CONTEXT.md shortly.`,
}));

// Fire and forget: chain the scraper + enrichment scripts
async function runEnrichment() {
  const scripts = join(ROOT, "scripts");
  const run = (script: string, ...args: string[]) =>
    Bun.spawn(["bun", "run", join(scripts, script), ...args], {
      stdout: "ignore", stderr: "ignore",
    }).exited;

  if (xHandle) await run("scrape-x.ts", "--agent-id", agentId, "--handle", xHandle);
  if (youtubeUrl) await run("scrape-youtube.ts", "--agent-id", agentId, "--url", youtubeUrl);
  if (newsletterUrl) await run("scrape-newsletter.ts", "--agent-id", agentId, "--url", newsletterUrl);
  await run("enrich-persona.ts", "--agent-id", agentId);
}

runEnrichment().catch(() => {/* silent — background task */});

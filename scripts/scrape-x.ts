#!/usr/bin/env bun
/**
 * scrape-x.ts
 * Fetches the last 200 public tweets from an X/Twitter handle and writes SAMPLES.md.
 *
 * Requires: X_BEARER_TOKEN env var
 *
 * Usage:
 *   bun run scripts/scrape-x.ts --agent-id johndoe-intern --handle @johndoe
 *
 * Output JSON: { ok: true, count: 47 } | { ok: false, error }
 */

import { parseArgs } from "util";
import { writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const ROOT = process.env.INTERNS_DIR ?? join(dirname(fileURLToPath(import.meta.url)), "..");

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    "agent-id": { type: "string" },
    "handle":   { type: "string" },
  },
  strict: false,
});

const agentId = values["agent-id"];
const handle  = (values["handle"] ?? "").replace(/^@/, "");

if (!agentId || !handle) {
  console.log(JSON.stringify({ ok: false, error: "Missing --agent-id or --handle" }));
  process.exit(1);
}

const BEARER = process.env.X_BEARER_TOKEN;
if (!BEARER) {
  console.log(JSON.stringify({ ok: false, error: "X_BEARER_TOKEN not set" }));
  process.exit(1);
}

interface Tweet { id: string; text: string; created_at?: string; }
interface UserResponse { data?: { id: string }; errors?: unknown[] }
interface TweetsResponse { data?: Tweet[]; errors?: unknown[] }

async function fetchTweets(): Promise<Tweet[]> {
  // 1. Resolve user ID
  const userRes = await fetch(
    `https://api.twitter.com/2/users/by/username/${handle}`,
    { headers: { Authorization: `Bearer ${BEARER}` } }
  );
  const userData = await userRes.json() as UserResponse;
  const userId = userData.data?.id;
  if (!userId) throw new Error(`User @${handle} not found`);

  // 2. Fetch up to 200 tweets (max per call = 100, need 2 pages)
  const tweets: Tweet[] = [];
  let paginationToken: string | undefined;

  for (let page = 0; page < 2; page++) {
    const params = new URLSearchParams({
      max_results: "100",
      "tweet.fields": "created_at,text",
      exclude: "retweets,replies",
    });
    if (paginationToken) params.set("pagination_token", paginationToken);

    const res = await fetch(
      `https://api.twitter.com/2/users/${userId}/tweets?${params}`,
      { headers: { Authorization: `Bearer ${BEARER}` } }
    );
    const data = await res.json() as TweetsResponse & { meta?: { next_token?: string } };
    if (data.data) tweets.push(...data.data);
    paginationToken = (data as { meta?: { next_token?: string } }).meta?.next_token;
    if (!paginationToken) break;
  }

  return tweets;
}

async function main() {
  const tweets = await fetchTweets();

  // Keep the 50 most substantive (length > 60 chars)
  const curated = tweets
    .filter(t => t.text.length > 60 && !t.text.startsWith("http"))
    .slice(0, 50);

  const agentDir = join(ROOT, "influencers", agentId!);
  mkdirSync(agentDir, { recursive: true });

  const lines = [
    `# @${handle} — Real Post Samples\n`,
    `Use these as voice and style reference. These are actual posts.\n`,
    ...curated.map(t => `> ${t.text.replace(/\n/g, " ")}\n*(${t.created_at?.slice(0,10) ?? ""})*`),
  ];

  writeFileSync(join(agentDir, "SAMPLES.md"), lines.join("\n\n"));
  console.log(JSON.stringify({ ok: true, count: curated.length, total: tweets.length }));
}

main().catch(err => {
  console.log(JSON.stringify({ ok: false, error: String(err) }));
  process.exit(1);
});

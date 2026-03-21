#!/usr/bin/env bun
/**
 * scrape-youtube.ts
 * Fetches transcripts from the last 5 videos on a YouTube channel
 * and appends them to CONTEXT.md §Video Transcripts.
 *
 * Requires: YOUTUBE_API_KEY env var + yt-dlp installed
 *
 * Usage:
 *   bun run scripts/scrape-youtube.ts --agent-id johndoe-intern --url https://youtube.com/@johndoe
 *
 * Output JSON: { ok: true, videos: 5 } | { ok: false, error }
 */

import { parseArgs } from "util";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";

const ROOT = process.env.INTERNS_DIR ?? join(dirname(fileURLToPath(import.meta.url)), "..");

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    "agent-id": { type: "string" },
    "url":      { type: "string" },
  },
  strict: false,
});

const agentId    = values["agent-id"];
const channelUrl = values["url"];

if (!agentId || !channelUrl) {
  console.log(JSON.stringify({ ok: false, error: "Missing --agent-id or --url" }));
  process.exit(1);
}

const API_KEY = process.env.YOUTUBE_API_KEY;

async function getChannelVideos(url: string): Promise<string[]> {
  // Extract channel handle / ID from URL
  const handleMatch = url.match(/@([\w.-]+)/);
  if (!handleMatch) throw new Error("Could not parse channel handle from URL");
  const handle = handleMatch[1];

  if (!API_KEY) {
    // Fallback: use yt-dlp to list videos
    const result = spawnSync("yt-dlp", [
      "--flat-playlist", "--print", "id",
      "--playlist-end", "5",
      url,
    ], { encoding: "utf8" });
    if (result.status !== 0) throw new Error("yt-dlp failed to list videos");
    return result.stdout.trim().split("\n").filter(Boolean).slice(0, 5);
  }

  // Use YouTube Data API
  // Resolve channel ID from handle
  const searchRes = await fetch(
    `https://www.googleapis.com/youtube/v3/search?part=snippet&type=channel&q=${handle}&key=${API_KEY}`
  );
  const searchData = await searchRes.json() as { items?: { id?: { channelId?: string } }[] };
  const channelId = searchData.items?.[0]?.id?.channelId;
  if (!channelId) throw new Error("Channel not found");

  // Get latest 5 videos
  const videosRes = await fetch(
    `https://www.googleapis.com/youtube/v3/search?part=id&channelId=${channelId}&order=date&maxResults=5&type=video&key=${API_KEY}`
  );
  const videosData = await videosRes.json() as { items?: { id?: { videoId?: string } }[] };
  return (videosData.items ?? []).map(i => i.id?.videoId ?? "").filter(Boolean);
}

function getTranscript(videoId: string): string {
  const result = spawnSync("yt-dlp", [
    `https://youtube.com/watch?v=${videoId}`,
    "--write-auto-sub", "--sub-lang", "en",
    "--skip-download", "--quiet",
    "-o", `/tmp/yt-transcript-${videoId}`,
  ], { encoding: "utf8" });

  const vttPath = `/tmp/yt-transcript-${videoId}.en.vtt`;
  if (!existsSync(vttPath)) return "";

  // Parse VTT: strip timestamps, deduplicate lines
  const raw = readFileSync(vttPath, "utf8");
  const lines = raw.split("\n")
    .filter(l => l && !l.startsWith("WEBVTT") && !l.match(/^\d{2}:\d{2}/) && !l.match(/^NOTE/) && l !== "align:start position:0%")
    .map(l => l.replace(/<[^>]+>/g, "").trim())
    .filter(Boolean);

  // Deduplicate consecutive identical lines
  const deduped = lines.filter((l, i) => l !== lines[i - 1]);
  return deduped.slice(0, 100).join(" "); // first ~100 lines worth
}

async function main() {
  const videoIds = await getChannelVideos(channelUrl!);
  const sections: string[] = [];

  for (const videoId of videoIds) {
    const transcript = getTranscript(videoId);
    if (transcript) {
      sections.push(`### https://youtube.com/watch?v=${videoId}\n${transcript.slice(0, 800)}...`);
    }
  }

  if (sections.length === 0) {
    console.log(JSON.stringify({ ok: true, videos: 0, note: "No transcripts found" }));
    return;
  }

  // Append to CONTEXT.md
  const contextPath = join(ROOT, "influencers", agentId!, "CONTEXT.md");
  let context = existsSync(contextPath) ? readFileSync(contextPath, "utf8") : "";

  const header = "## Video Transcripts\n";
  const newSection = header + sections.join("\n\n") + "\n";

  if (context.includes("## Video Transcripts")) {
    context = context.replace(/## Video Transcripts[\s\S]*?(?=\n## |\n*$)/, newSection);
  } else {
    context += `\n\n${newSection}`;
  }

  writeFileSync(contextPath, context);
  console.log(JSON.stringify({ ok: true, videos: sections.length }));
}

main().catch(err => {
  console.log(JSON.stringify({ ok: false, error: String(err) }));
  process.exit(1);
});

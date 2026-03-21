#!/usr/bin/env bun
/**
 * scrape-newsletter.ts
 * Fetches the last 5 articles from a blog/newsletter URL (RSS or HTML)
 * and appends them to CONTEXT.md §Written Content.
 *
 * Usage:
 *   bun run scripts/scrape-newsletter.ts --agent-id johndoe-intern --url https://johndoe.substack.com
 *
 * Output JSON: { ok: true, articles: 5 } | { ok: false, error }
 */

import { parseArgs } from "util";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const ROOT = process.env.INTERNS_DIR ?? join(dirname(fileURLToPath(import.meta.url)), "..");

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    "agent-id": { type: "string" },
    "url":      { type: "string" },
  },
  strict: false,
});

const agentId = values["agent-id"];
const siteUrl = values["url"];

if (!agentId || !siteUrl) {
  console.log(JSON.stringify({ ok: false, error: "Missing --agent-id or --url" }));
  process.exit(1);
}

interface Article { title: string; url: string; summary: string; }

async function fetchRss(url: string): Promise<Article[]> {
  // Try common RSS feed paths
  const rssUrls = [
    url.replace(/\/$/, "") + "/feed",
    url.replace(/\/$/, "") + "/rss",
    url.replace(/\/$/, "") + "/feed.xml",
    url.replace(/\/$/, "") + "/atom.xml",
    url, // might already be a feed
  ];

  for (const feedUrl of rssUrls) {
    try {
      const res = await fetch(feedUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
      const text = await res.text();
      if (!text.includes("<item>") && !text.includes("<entry>")) continue;

      // Simple XML parse for RSS/Atom
      const items = text.match(/<item>([\s\S]*?)<\/item>/g) ??
                    text.match(/<entry>([\s\S]*?)<\/entry>/g) ?? [];

      const articles: Article[] = items.slice(0, 5).map(item => {
        const title   = item.match(/<title[^>]*>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/)?.[1]?.trim() ?? "";
        const link    = item.match(/<link[^>]*>(.*?)<\/link>/)?.[1]?.trim() ??
                        item.match(/href="([^"]+)"/)?.[1] ?? "";
        const desc    = item.match(/<description[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/)?.[1]?.trim() ??
                        item.match(/<summary[^>]*>([\s\S]*?)<\/summary>/)?.[1]?.trim() ?? "";
        // Strip HTML tags from description
        const summary = desc.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 400);
        return { title, url: link, summary };
      }).filter(a => a.title);

      if (articles.length > 0) return articles;
    } catch { /* try next */ }
  }
  return [];
}

async function main() {
  const articles = await fetchRss(siteUrl!);

  if (articles.length === 0) {
    console.log(JSON.stringify({ ok: true, articles: 0, note: "No RSS feed found or no articles" }));
    return;
  }

  const sections = articles.map(a =>
    `### [${a.title}](${a.url})\n${a.summary}${a.summary.length === 400 ? "..." : ""}`
  );

  const contextPath = join(ROOT, "influencers", agentId!, "CONTEXT.md");
  let context = existsSync(contextPath) ? readFileSync(contextPath, "utf8") : "";

  const header = "## Written Content\n";
  const newSection = header + sections.join("\n\n") + "\n";

  if (context.includes("## Written Content")) {
    context = context.replace(/## Written Content[\s\S]*?(?=\n## |\n*$)/, newSection);
  } else {
    context += `\n\n${newSection}`;
  }

  writeFileSync(contextPath, context);
  console.log(JSON.stringify({ ok: true, articles: articles.length }));
}

main().catch(err => {
  console.log(JSON.stringify({ ok: false, error: String(err) }));
  process.exit(1);
});

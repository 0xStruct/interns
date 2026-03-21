#!/usr/bin/env bun
/**
 * update-setting.ts
 * Updates a single field in a data file for an influencer agent.
 * No openclaw reload needed — files are read fresh on every message.
 *
 * Usage:
 *   bun run the-interns-bot/scripts/update-setting.ts \
 *     --agent-id johndoe-intern \
 *     --file pricing|data|persona \
 *     --field price_usd|booking_link|voice|... \
 *     --value "99"
 *     [--section "VVIP DM"]   ← optional: which ## section to update the field in
 *
 * Output JSON: { ok: true, liveAt: "next message" } | { ok: false, error }
 */

import { parseArgs } from "util";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const ROOT = process.env.INTERNS_DIR ?? join(dirname(fileURLToPath(import.meta.url)), "../..");

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    "agent-id": { type: "string" },
    "file":     { type: "string" },
    "field":    { type: "string" },
    "value":    { type: "string" },
    "section":  { type: "string" },
  },
  strict: false,
});

const agentId = values["agent-id"];
const file    = values["file"];
const field   = values["field"];
const value   = values["value"];
const section = values["section"];

if (!agentId || !file || !field || value === undefined) {
  console.log(JSON.stringify({ ok: false, error: "Missing required flags" }));
  process.exit(1);
}

const fileMap: Record<string, string> = {
  pricing: "PRICING.md",
  data:    "DATA.md",
  persona: "PERSONA.md",
  context: "CONTEXT.md",
};

const fileName = fileMap[file];
if (!fileName) {
  console.log(JSON.stringify({ ok: false, error: `Unknown --file: ${file}. Use: pricing, data, persona, context` }));
  process.exit(1);
}

const filePath = join(ROOT, "influencers", agentId, fileName);
if (!existsSync(filePath)) {
  console.log(JSON.stringify({ ok: false, error: `File not found: ${filePath}` }));
  process.exit(1);
}

let content = readFileSync(filePath, "utf8");

// Special handling: if section is specified, only update the field within that section
if (section) {
  const sectionRegex = new RegExp(`(## ${section}[\\s\\S]*?)(^[-*]?\\s*${field}:\\s*.+$)`, "m");
  if (!sectionRegex.test(content)) {
    console.log(JSON.stringify({ ok: false, error: `Field "${field}" not found in section "## ${section}"` }));
    process.exit(1);
  }
  content = content.replace(sectionRegex, (_, pre, _old) => `${pre}- ${field}: ${value}`);
} else {
  // Update first occurrence of the field anywhere in the file
  const fieldRegex = new RegExp(`^([-*]?\\s*${field}:\\s*)(.+)$`, "m");
  if (!fieldRegex.test(content)) {
    // Append if not found
    content += `\n- ${field}: ${value}\n`;
  } else {
    content = content.replace(fieldRegex, `$1${value}`);
  }
}

// Special case: cal.com vs Calendly auto-detection when updating booking_link
if (field === "booking_link" && file === "data") {
  const provider = value.includes("calendly.com") ? "Calendly" : "cal.com";
  content = content.replace(/^([-*]?\s*provider:\s*)(.+)$/m, `$1${provider}`);
}

// Special case: token_launched flag when updating token_address
if (field === "token_address" && file === "data") {
  const launched = value !== "null" && value !== "" && value !== "skip";
  content = content.replace(/^([-*]?\s*token_launched:\s*)(.+)$/m, `$1${launched}`);
}

writeFileSync(filePath, content);
console.log(JSON.stringify({ ok: true, field, value, liveAt: "next message" }));

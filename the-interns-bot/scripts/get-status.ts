#!/usr/bin/env bun
/**
 * get-status.ts
 * Reads all config files for an agent and returns a formatted summary.
 *
 * Usage:
 *   bun run the-interns-bot/scripts/get-status.ts --agent-id johndoe-intern
 *
 * Output JSON: { ok: true, summary: "...", data: {...} } | { ok: false, error }
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

function extract(md: string, key: string): string {
  const match = md.match(new RegExp(`^[-*]?\\s*${key}:\\s*(.+)$`, "m"));
  return match?.[1]?.trim() ?? "—";
}

const pricing = readFileSync(join(agentDir, "PRICING.md"), "utf8");
const data    = readFileSync(join(agentDir, "DATA.md"), "utf8");
const persona = existsSync(join(agentDir, "PERSONA.md"))
  ? readFileSync(join(agentDir, "PERSONA.md"), "utf8") : "";

const vvipPrice      = extract(pricing, "price_usd") ;
const meetingPrice   = pricing.match(/## 1:1 Meeting[\s\S]*?price_usd:\s*(\S+)/)?.[1] ?? "—";
const shoutoutPrice  = extract(pricing, "price_usd");  // first match = VVIP; get shoutout separately
const shoutoutLine   = pricing.match(/## X Shoutout[\s\S]*?price_usd:\s*(\S+)/)?.[1] ?? "disabled";
const shoutoutEnabled= extract(pricing.split("## X Shoutout")[1] ?? "", "enabled");

const calProvider    = extract(data, "provider");
const calLink        = extract(data, "booking_link");
const bankrWallet    = extract(data, "bankr_wallet");
const tokenAddr      = extract(data, "token_address");
const tokenLaunched  = extract(data, "token_launched");

const summary = [
  `📊 <b>Settings for @${agentId.replace("-intern", "")}</b>`,
  ``,
  `💬 <b>VVIP DM:</b> $${vvipPrice}`,
  `📞 <b>Meeting:</b> $${meetingPrice}`,
  `📣 <b>X Shoutout:</b> ${shoutoutEnabled === "true" ? `$${shoutoutLine}` : "disabled"}`,
  ``,
  `📅 <b>Calendar:</b> ${calProvider} — ${calLink}`,
  `💰 <b>Bankr wallet:</b> ${bankrWallet}`,
  `🪙 <b>Token:</b> ${tokenLaunched === "true" ? tokenAddr : "not launched"}`,
  ``,
  `<i>Change anything with /setprice, /setcal, /buyback, /launchtoken</i>`,
].join("\n");

console.log(JSON.stringify({
  ok: true,
  summary,
  data: { vvipPrice, meetingPrice, shoutoutPrice: shoutoutLine, shoutoutEnabled, calProvider, calLink, bankrWallet, tokenAddr, tokenLaunched },
}));

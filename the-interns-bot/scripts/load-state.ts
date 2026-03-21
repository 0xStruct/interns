#!/usr/bin/env bun
/**
 * load-state.ts
 * Reads the onboarding state for a Telegram chatId.
 *
 * Usage:
 *   bun run the-interns-bot/scripts/load-state.ts --chat-id 123456789
 *
 * Output JSON:
 *   {
 *     found: true,
 *     chatId, status, agentId, collected: {...}, startedAt, updatedAt
 *   }
 *   { found: false }   ← new user, no state yet
 */

import { parseArgs } from "util";
import { createHash } from "crypto";
import { existsSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const ROOT = process.env.INTERNS_DIR ?? join(dirname(fileURLToPath(import.meta.url)), "../..");
const STATE_DIR = join(ROOT, "state", "onboarding");

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: { "chat-id": { type: "string" } },
  strict: false,
});

const chatId = values["chat-id"];

if (!chatId) {
  console.log(JSON.stringify({ ok: false, error: "Missing --chat-id" }));
  process.exit(1);
}

const hash = createHash("sha256").update(chatId, "utf8").digest("hex").slice(0, 32);
const statePath = join(STATE_DIR, `${hash}.json`);

if (!existsSync(statePath)) {
  console.log(JSON.stringify({ found: false }));
  process.exit(0);
}

try {
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  console.log(JSON.stringify({ found: true, ...state }));
} catch {
  console.log(JSON.stringify({ found: false, error: "Corrupt state file" }));
}

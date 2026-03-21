#!/usr/bin/env bun
/**
 * save-state.ts
 * Persists onboarding step + collected data for one influencer (keyed by Telegram chatId).
 *
 * Usage:
 *   bun run the-interns-bot/scripts/save-state.ts \
 *     --chat-id 123456789 \
 *     --step waiting_handle \
 *     --data '{"name":"John Doe"}'
 *
 * Merges --data into existing collected object.
 * Output JSON: { ok: true, path: "..." } | { ok: false, error: "..." }
 */

import { parseArgs } from "util";
import { createHash } from "crypto";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const ROOT = process.env.INTERNS_DIR ?? join(dirname(fileURLToPath(import.meta.url)), "../..");
const STATE_DIR = join(ROOT, "state", "onboarding");

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    "chat-id": { type: "string" },
    step:      { type: "string" },
    data:      { type: "string" },
  },
  strict: false,
});

const chatId = values["chat-id"];
const step   = values["step"];
const rawData = values["data"] ?? "{}";

if (!chatId || !step) {
  console.log(JSON.stringify({ ok: false, error: "Missing --chat-id or --step" }));
  process.exit(1);
}

const hash = createHash("sha256").update(chatId, "utf8").digest("hex").slice(0, 32);
const statePath = join(STATE_DIR, `${hash}.json`);

mkdirSync(STATE_DIR, { recursive: true });

let existing: Record<string, unknown> = {};
if (existsSync(statePath)) {
  try { existing = JSON.parse(readFileSync(statePath, "utf8")); } catch {}
}

let incoming: Record<string, unknown> = {};
try { incoming = JSON.parse(rawData); } catch {
  console.log(JSON.stringify({ ok: false, error: "Invalid JSON in --data" }));
  process.exit(1);
}

const updated = {
  ...existing,
  chatId,
  status: step,
  collected: { ...(existing.collected as Record<string, unknown> ?? {}), ...incoming },
  updatedAt: new Date().toISOString(),
  startedAt: (existing as { startedAt?: string }).startedAt ?? new Date().toISOString(),
};

writeFileSync(statePath, JSON.stringify(updated, null, 2));
console.log(JSON.stringify({ ok: true, path: statePath, status: step }));

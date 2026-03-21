#!/usr/bin/env bun
/**
 * validate-token.ts
 * Validates a Telegram bot token by calling getMe.
 *
 * Usage:
 *   bun run the-interns-bot/scripts/validate-token.ts --token <TOKEN>
 *
 * Output JSON:
 *   { ok: true, username: "johndoe_intern_bot", first_name: "John's Intern", id: 123456 }
 *   { ok: false, error: "..." }
 */

import { parseArgs } from "util";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: { token: { type: "string" } },
  strict: false,
});

const token = values["token"];

if (!token) {
  console.log(JSON.stringify({ ok: false, error: "Missing --token" }));
  process.exit(1);
}

async function validate() {
  const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
  const data = await res.json() as {
    ok: boolean;
    result?: { id: number; first_name: string; username: string };
    description?: string;
  };

  if (!data.ok || !data.result) {
    console.log(JSON.stringify({ ok: false, error: data.description ?? "Invalid token" }));
    process.exit(1);
  }

  console.log(JSON.stringify({
    ok: true,
    id: data.result.id,
    username: data.result.username,
    first_name: data.result.first_name,
  }));
}

validate().catch((err) => {
  console.log(JSON.stringify({ ok: false, error: String(err) }));
  process.exit(1);
});

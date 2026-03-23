#!/usr/bin/env bun
/**
 * launch-token.ts
 * Deploys a creator token on Base via Bankr CLI.
 * Called by the management bot after the influencer confirms the token name.
 *
 * Usage:
 *   bun run launch-token.ts --agent-id steve55-intern --name "SteveToken" [--symbol "STEVE"]
 *
 * Outputs JSON:
 *   { ok: true,  contractAddress: "0x...", txHash: "0x...", name: "SteveToken" }
 *   { ok: false, error: "..." }
 */

import { execSync } from "child_process";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

const args = process.argv.slice(2);
const get = (flag: string) => {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : undefined;
};

const agentId = get("--agent-id");
const name    = get("--name");
const symbol  = get("--symbol") ?? "";

if (!agentId || !name) {
  console.log(JSON.stringify({ ok: false, error: "Missing --agent-id or --name" }));
  process.exit(1);
}

// Read X handle from DATA.md (stored as "- handle: @steve55" during onboarding)
const INTERNS_DIR = resolve(import.meta.dir, "../..");
const dataPath = `${INTERNS_DIR}/influencers/${agentId}/DATA.md`;
let xHandle = agentId.replace(/-intern$/, "");  // fallback: agentId without -intern
if (existsSync(dataPath)) {
  const data = readFileSync(dataPath, "utf-8");
  const m = data.match(/[-\s]*handle[:\s]+@?(\S+)/i);
  if (m) xHandle = m[1].replace(/^@/, "");
}

// Derive fee recipient: X handle (no @ prefix for bankr --fee-type x)
const feeHandle = xHandle;
// Profile image via unavatar (returns X profile picture)
const imageUrl = `https://unavatar.io/twitter/${xHandle}`;
// Tweet links to the creator's X profile
const tweetUrl = `https://x.com/${xHandle}`;

try {
  // 1. Verify bankr CLI is installed and wallet exists
  let whoami: string;
  try {
    whoami = execSync("bankr whoami", { encoding: "utf-8", timeout: 15000 });
  } catch {
    console.log(JSON.stringify({ ok: false, error: "bankr CLI not installed or not logged in. Run: npm install -g @bankr/cli && bankr login" }));
    process.exit(1);
  }

  if (!whoami.includes("0x")) {
    console.log(JSON.stringify({ ok: false, error: "No Bankr wallet found. Run: bankr login" }));
    process.exit(1);
  }

  // 2. Launch token
  // Pass all optional args explicitly to avoid interactive TTY prompts.
  // --fee-type x routes 57% of trading fees to the creator's X handle via bankr.
  // -y skips the final confirmation prompt.
  const cmd = `bankr launch --name "${name}" --symbol "${symbol}" --image "${imageUrl}" --tweet "${tweetUrl}" --website "https://interns.bot" --fee "${feeHandle}" --fee-type x -y`;

  if (process.env.DEBUG) console.error(`[launch-token] running: ${cmd}`);

  const raw = execSync(cmd, { encoding: "utf-8", timeout: 120000, env: { ...process.env } });

  // Strip ANSI escape codes so regex can match plaintext
  const output = raw.replace(/\x1b\[[0-9;]*m/g, "");

  if (process.env.DEBUG) console.error(`[launch-token] output: ${output}`);

  // 3. Parse contract address from output.
  // bankr launch outputs: "Token Address   0x{40hex}"
  const contractMatch = output.match(/Token\s+Address[\s:]+([0-9a-fA-Fx]{42})/i)
    ?? output.match(/(0x[0-9a-fA-F]{40})(?![0-9a-fA-F])/);

  const txMatch = output.match(/Transaction[\s:]+([0-9a-fA-Fx]{66})/i)
    ?? output.match(/(0x[0-9a-fA-F]{64})(?![0-9a-fA-F])/);

  if (!contractMatch) {
    console.log(JSON.stringify({ ok: false, error: "Token may have launched but could not parse contract address from output", raw: output.slice(0, 800) }));
    process.exit(1);
  }

  const contractAddress = contractMatch[1].startsWith("0x") ? contractMatch[1] : "0x" + contractMatch[1];
  const txHash = txMatch ? (txMatch[1].startsWith("0x") ? txMatch[1] : "0x" + txMatch[1]) : undefined;

  // 4. Persist to DATA.md via update-setting.ts
  const scriptDir = resolve(import.meta.dir);
  execSync(`bun run "${scriptDir}/update-setting.ts" --agent-id "${agentId}" --file data --field token_address --value "${contractAddress}"`, { timeout: 10000 });
  execSync(`bun run "${scriptDir}/update-setting.ts" --agent-id "${agentId}" --file data --field token_launched --value "true"`, { timeout: 10000 });

  console.log(JSON.stringify({ ok: true, contractAddress, txHash, name, feeHandle }));

} catch (err: any) {
  console.log(JSON.stringify({ ok: false, error: err.message ?? String(err) }));
  process.exit(1);
}

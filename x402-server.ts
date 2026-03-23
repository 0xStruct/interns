#!/usr/bin/env bun
/**
 * x402-server.ts
 * HTTP payment server for interns.bot using the x402 protocol.
 *
 * Two audiences:
 *   - AI agents: POST /agents/:handle/:service with X-PAYMENT header (standard x402)
 *   - Human fans: GET  /pay/:handle/:service  → browser paywall page (OnchainKit)
 *
 * Discovery:
 *   GET /              → list all active intern bots + service endpoints
 *   GET /agents/:handle → service catalog for one influencer
 *
 * Sessions (Telegram fan flow):
 *   POST /sessions/:handle/:service  → create pending session, returns {ref, paywall_url}
 *   GET  /sessions/:ref/status       → poll for payment completion
 *
 * Env vars:
 *   INTERNS_DIR      — root of interns project (default: /opt/interns)
 *   X402_PORT        — port to listen on (default: 4402)
 *   X402_BASE_URL    — public URL of this server (e.g. https://api.interns.bot)
 *   X402_NETWORK     — "base" (mainnet) | "base-sepolia" (default: base-sepolia)
 *   CDP_CLIENT_KEY   — Coinbase Developer Platform key for OnchainKit paywall UI
 */

import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { getPaywallHtml } from "x402/paywall";
import fs from "fs";
import path from "path";
import crypto from "crypto";

// ── Config ────────────────────────────────────────────────────────────────────

const PORT        = parseInt(process.env.X402_PORT    ?? "4402");
const INTERNS_DIR = process.env.INTERNS_DIR            ?? "/opt/interns";
const BASE_URL    = process.env.X402_BASE_URL          ?? `http://localhost:${PORT}`;
const CDP_KEY     = process.env.CDP_CLIENT_KEY         ?? "";
const TESTNET     = (process.env.X402_NETWORK         ?? "base-sepolia") !== "base";
const NETWORK     = TESTNET ? "base-sepolia" : "base";

// USDC contract addresses
const USDC = TESTNET
  ? "0x036CbD53842c5426634e7929541eC2318f3dCF7e"  // Base Sepolia USDC
  : "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"; // Base Mainnet USDC

const FACILITATOR = "https://x402.org/facilitator";

// ── Types ─────────────────────────────────────────────────────────────────────

type Service = "dm" | "shoutout" | "meeting";

interface Influencer {
  handle: string;
  name:   string;
  wallet: string;
  pricing: { dm: number; shoutout: number; meeting: number };
  calLink: string;
  botUsername: string;
}

interface Session {
  handle:  string;
  service: Service;
  payload: Record<string, string>;
  paid:    boolean;
  txHash?: string;
  result?: Record<string, unknown>;
}

// ── In-memory session store ───────────────────────────────────────────────────

const sessions = new Map<string, Session>();

// ── Helpers ───────────────────────────────────────────────────────────────────

function readInfluencer(handle: string): Influencer | null {
  const agentDir = path.join(INTERNS_DIR, "influencers", `${handle}-intern`);
  if (!fs.existsSync(agentDir)) return null;

  const data    = fs.readFileSync(path.join(agentDir, "DATA.md"),    "utf-8");
  const pricing = fs.readFileSync(path.join(agentDir, "PRICING.md"), "utf-8");
  const persona = fs.readFileSync(path.join(agentDir, "PERSONA.md"), "utf-8");

  const wallet     = data.match(/bankr_wallet:\s*(.+)/)?.[1]?.trim()      ?? "";
  const calLink    = data.match(/booking_link:\s*(.+)/)?.[1]?.trim()       ?? "";
  const botUsername = data.match(/bot_username:\s*(.+)/)?.[1]?.trim()
                   ?? `${handle}_intern_bot`;
  const name       = persona.match(/^# .+ — (.+)$/m)?.[1]?.trim()
                   ?? persona.match(/name:\s*(.+)/)?.[1]?.trim()
                   ?? handle;

  const dm_price       = parseFloat(pricing.match(/## Paid DM[\s\S]*?price_usd:\s*([\d.]+)/)?.[1]        ?? "5");
  const meeting_price  = parseFloat(pricing.match(/## 1:1 Meeting[\s\S]*?price_usd:\s*([\d.]+)/)?.[1]    ?? "50");
  const shoutout_price = parseFloat(pricing.match(/## X Shoutout[\s\S]*?price_usd:\s*([\d.]+)/)?.[1]     ?? "20");

  return { handle, name, wallet, calLink, botUsername,
           pricing: { dm: dm_price, shoutout: shoutout_price, meeting: meeting_price } };
}

function usdcAtomics(usd: number): string {
  return Math.round(usd * 1_000_000).toString(); // USDC has 6 decimals
}

function serviceDesc(name: string, service: Service): string {
  return {
    dm:       `Send a private message to ${name}`,
    shoutout: `Request an X shoutout from ${name}`,
    meeting:  `Book a 1-on-1 meeting with ${name}`,
  }[service];
}

function buildRequirements(inf: Influencer, service: Service, resource: string) {
  return {
    scheme:             "exact" as const,
    network:            NETWORK as "base" | "base-sepolia",
    maxAmountRequired:  usdcAtomics(inf.pricing[service]),
    resource,
    description:        serviceDesc(inf.handle, service),
    mimeType:           "application/json",
    payTo:              inf.wallet,
    maxTimeoutSeconds:  300,
    asset:              USDC,
    extra:              { platform: "interns.bot", handle: inf.handle, service },
  };
}

const VULGAR = ["fuck","shit","ass","bitch","cunt","dick","cock","pussy","nigger","faggot"];
function isVulgar(text: string) {
  const lower = text.toLowerCase();
  return VULGAR.some(w => lower.includes(w));
}

async function facilitatorVerify(paymentHeader: string, requirements: object): Promise<boolean> {
  try {
    const res  = await fetch(`${FACILITATOR}/verify`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ paymentHeader, paymentRequirements: requirements }),
    });
    const json = await res.json() as { isValid?: boolean };
    return json.isValid === true;
  } catch { return false; }
}

async function facilitatorSettle(paymentHeader: string, requirements: object): Promise<string | null> {
  try {
    const res  = await fetch(`${FACILITATOR}/settle`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ paymentHeader, paymentRequirements: requirements }),
    });
    const json = await res.json() as { txHash?: string; transaction?: string };
    return json.txHash ?? json.transaction ?? null;
  } catch { return null; }
}

function deliverService(
  inf: Influencer,
  service: Service,
  payload: Record<string, string>,
  txHash: string | null,
): Record<string, unknown> {
  const msgDir = path.join(INTERNS_DIR, "messages");
  fs.mkdirSync(msgDir, { recursive: true });
  const ts = new Date().toISOString();
  const txNote = txHash ? ` — tx: ${txHash}` : "";

  if (service === "dm") {
    fs.appendFileSync(
      path.join(msgDir, `${inf.handle}-dm.md`),
      `\n---\n**Paid DM via x402** — ${ts}${txNote}\nFrom: ${payload.from ?? "anonymous"}\n\n${payload.message ?? ""}\n`,
    );
    return { delivered: true, message: `DM queued for ${inf.name}` };
  }

  if (service === "shoutout") {
    fs.appendFileSync(
      path.join(msgDir, `${inf.handle}-shoutout.md`),
      `\n---\n**Shoutout Request via x402** — ${ts}${txNote}\nFrom: ${payload.from ?? "anonymous"}\n\n${payload.text ?? ""}\n`,
    );
    return { delivered: true, message: `Shoutout queued for ${inf.name}` };
  }

  // meeting — generate a one-time cal.com link
  const ref        = `pay_${crypto.randomBytes(3).toString("hex")}`;
  const bookingUrl = inf.calLink
    ? `${inf.calLink}?metadata[ref]=${ref}&metadata[tx]=${txHash ?? "x402"}`
    : "";
  fs.appendFileSync(
    path.join(msgDir, `${inf.handle}-meeting.md`),
    `\n---\n**Meeting Booking via x402** — ${ts}${txNote}\nRef: ${ref}\nURL: ${bookingUrl}\nFrom: ${payload.from ?? "anonymous"}\n`,
  );
  return { delivered: true, ref, bookingUrl, message: `Use this one-time link to book: ${bookingUrl}` };
}

// ── App ───────────────────────────────────────────────────────────────────────

const app = new Hono();

// ── Discovery helpers ─────────────────────────────────────────────────────────

function loadAllInfluencers(): Influencer[] {
  const root = path.join(INTERNS_DIR, "influencers");
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root)
    .filter(d => d.endsWith("-intern") && fs.statSync(path.join(root, d)).isDirectory())
    .map(dir => readInfluencer(dir.replace(/-intern$/, "")))
    .filter((inf): inf is Influencer => !!inf && !!inf.wallet);
}

function buildDiscoveredResources(influencers: Influencer[]) {
  const items: object[] = [];
  for (const inf of influencers) {
    for (const svc of ["dm", "shoutout", "meeting"] as Service[]) {
      const resource = `${BASE_URL}/agents/${inf.handle}/${svc}`;
      items.push({
        resource,
        type:        "http",
        x402Version: 1,
        accepts:     [buildRequirements(inf, svc, resource)],
      });
    }
  }
  return items;
}

// ── Discovery ─────────────────────────────────────────────────────────────────

/**
 * x402 standard discovery endpoint (ListDiscoveryResourcesResponse).
 * x402-aware agents check /.well-known/x402.json to find all payable resources.
 */
app.get("/.well-known/x402.json", (c) => {
  const items = buildDiscoveredResources(loadAllInfluencers());
  return c.json({ x402Version: 1, items });
});

/**
 * Emerging agents.json convention — general-purpose agent discovery.
 * Lists every intern bot as an agent with capabilities and endpoints.
 */
app.get("/.well-known/agents.json", (c) => {
  const influencers = loadAllInfluencers();
  const agents = influencers.map(inf => ({
    id:          `${BASE_URL}/agents/${inf.handle}`,
    name:        inf.name,
    description: `AI intern for ${inf.name} — handles paid DMs, X shoutouts, and meeting bookings on behalf of ${inf.name}.`,
    url:         `${BASE_URL}/agents/${inf.handle}`,
    telegram:    `https://t.me/${inf.botUsername}`,
    payment:     { protocol: "x402", network: NETWORK, currency: "USDC", asset: USDC },
    capabilities: (["dm", "shoutout", "meeting"] as Service[]).map(svc => ({
      name:        svc,
      description: serviceDesc(inf.name, svc),
      endpoint:    `${BASE_URL}/agents/${inf.handle}/${svc}`,
      paywall:     `${BASE_URL}/pay/${inf.handle}/${svc}`,
      price_usd:   inf.pricing[svc],
    })),
  }));

  return c.json({
    platform:    "interns.bot",
    description: "AI intern bots for creators, artists, and influencers. Pay with USDC on Base via x402.",
    discovery:   `${BASE_URL}/.well-known/x402.json`,
    agents,
  });
});

/** Human-readable index — also used as the root for programmatic clients. */
app.get("/", (c) => {
  const influencers = loadAllInfluencers();
  const agents = influencers.map(inf => ({
    handle:   inf.handle,
    name:     inf.name,
    telegram: `https://t.me/${inf.botUsername}`,
    catalog:  `${BASE_URL}/agents/${inf.handle}`,
    services: (["dm", "shoutout", "meeting"] as Service[]).reduce((acc, svc) => {
      acc[svc] = {
        endpoint:    `${BASE_URL}/agents/${inf.handle}/${svc}`,
        paywall_url: `${BASE_URL}/pay/${inf.handle}/${svc}`,
        price_usd:   inf.pricing[svc],
        currency:    "USDC",
        network:     NETWORK,
      };
      return acc;
    }, {} as Record<string, unknown>),
  }));

  return c.json({
    platform:    "interns.bot",
    x402Version: 1,
    network:     NETWORK,
    discovery: {
      x402:   `${BASE_URL}/.well-known/x402.json`,
      agents: `${BASE_URL}/.well-known/agents.json`,
    },
    agents,
  });
});

/** Full service catalog for a single influencer. */
app.get("/agents/:handle", (c) => {
  const inf = readInfluencer(c.req.param("handle"));
  if (!inf) return c.json({ error: "Agent not found" }, 404);

  const services = (["dm", "shoutout", "meeting"] as Service[]).reduce((acc, svc) => {
    acc[svc] = {
      description: serviceDesc(inf.name, svc),
      endpoint:    `${BASE_URL}/agents/${inf.handle}/${svc}`,
      paywall_url: `${BASE_URL}/pay/${inf.handle}/${svc}`,
      method:      "POST",
      body:        svc === "dm"
        ? { message: "string", from: "string (optional)" }
        : svc === "shoutout"
        ? { text: "string", from: "string (optional)" }
        : { from: "string (optional)" },
      payment: {
        currency:   "USDC",
        network:    NETWORK,
        amount_usd: inf.pricing[svc],
        asset:      USDC,
        payTo:      inf.wallet,
      },
    };
    return acc;
  }, {} as Record<string, unknown>);

  return c.json({ handle: inf.handle, name: inf.name,
                  telegram: `https://t.me/${inf.botUsername}`, services });
});

// ── x402 Service Endpoints (agent-to-agent) ───────────────────────────────────

async function handleService(c: any, service: Service) {
  const handle = c.req.param("handle") as string;
  const inf    = readInfluencer(handle);
  if (!inf)        return c.json({ error: "Agent not found" }, 404);
  if (!inf.wallet) return c.json({ error: "Agent wallet not configured" }, 503);

  const resource     = `${BASE_URL}/agents/${handle}/${service}`;
  const requirements = buildRequirements(inf, service, resource);
  const paymentHdr   = c.req.header("X-PAYMENT") ?? c.req.header("x-payment") ?? "";

  // No payment header → return 402
  if (!paymentHdr) {
    return c.json(
      { x402Version: 1, accepts: [requirements] },
      402,
      { "PAYMENT-REQUIRED": Buffer.from(JSON.stringify({ x402Version: 1, accepts: [requirements] })).toString("base64") },
    );
  }

  // Verify via facilitator
  const valid = await facilitatorVerify(paymentHdr, requirements);
  if (!valid) return c.json({ error: "Payment verification failed" }, 402);

  // Parse body
  const body = await c.req.json().catch(() => ({})) as Record<string, string>;

  // Content check
  const content = body.message ?? body.text ?? "";
  if (content && isVulgar(content)) return c.json({ error: "Content contains inappropriate material" }, 400);

  // Settle & deliver
  const txHash = await facilitatorSettle(paymentHdr, requirements);
  const result = deliverService(inf, service, body, txHash);
  return c.json({ success: true, service, handle, txHash, ...result });
}

app.post("/agents/:handle/dm",       (c) => handleService(c, "dm"));
app.post("/agents/:handle/shoutout", (c) => handleService(c, "shoutout"));
app.post("/agents/:handle/meeting",  (c) => handleService(c, "meeting"));

// ── Paywall Pages (browser / Telegram human fans) ─────────────────────────────

/**
 * Opens an OnchainKit paywall page for the given service.
 * Telegram bot sends this URL to the fan; fan pays via their crypto wallet in browser.
 */
app.get("/pay/:handle/:service", (c) => {
  const handle  = c.req.param("handle");
  const service = c.req.param("service") as Service;
  const ref     = c.req.query("ref");          // optional session ref

  if (!["dm", "shoutout", "meeting"].includes(service))
    return c.text("Not found", 404);

  const inf = readInfluencer(handle);
  if (!inf) return c.text("Intern not found", 404);

  // If ref present, include it in the resource URL so the session gets marked paid
  const resource     = ref
    ? `${BASE_URL}/agents/${handle}/${service}?ref=${ref}`
    : `${BASE_URL}/agents/${handle}/${service}`;
  const requirements = buildRequirements(inf, service, resource);

  const html = getPaywallHtml({
    amount:              inf.pricing[service],
    paymentRequirements: [requirements],
    currentUrl:          resource,
    testnet:             TESTNET,
    cdpClientKey:        CDP_KEY,
    appName:             `interns.bot — ${inf.name}`,
  });

  return c.html(html);
});

// ── Session Tracking (Telegram fan flow) ──────────────────────────────────────

/**
 * Create a pending session before sending the paywall URL to the fan.
 * The bot stores the fan's message/text here so the paywall doesn't need it.
 *
 * POST /sessions/:handle/:service
 * Body: { message?: string, text?: string, from?: string }
 * Returns: { ref, paywall_url, amount_usd, currency, network }
 */
app.post("/sessions/:handle/:service", async (c) => {
  const handle  = c.req.param("handle");
  const service = c.req.param("service") as Service;
  if (!["dm", "shoutout", "meeting"].includes(service))
    return c.json({ error: "Invalid service" }, 400);

  const inf = readInfluencer(handle);
  if (!inf) return c.json({ error: "Agent not found" }, 404);

  const body = await c.req.json().catch(() => ({})) as Record<string, string>;
  const ref  = crypto.randomBytes(4).toString("hex");

  sessions.set(ref, { handle, service, payload: body, paid: false });
  setTimeout(() => sessions.delete(ref), 30 * 60 * 1000); // expire after 30 min

  return c.json({
    ref,
    paywall_url: `${BASE_URL}/pay/${handle}/${service}?ref=${ref}`,
    amount_usd:  inf.pricing[service],
    currency:    "USDC",
    network:     NETWORK,
  });
});

/**
 * Poll payment status for a session ref.
 * Telegram bot calls this after the fan reports paying.
 */
app.get("/sessions/:ref/status", (c) => {
  const session = sessions.get(c.req.param("ref"));
  if (!session) return c.json({ error: "Session not found or expired" }, 404);
  return c.json({ paid: session.paid, txHash: session.txHash ?? null, result: session.result ?? null });
});

/**
 * The paywall page POSTs here after payment. This endpoint:
 *  - is an x402-protected service endpoint (handles the X-PAYMENT header)
 *  - also accepts ?ref= to mark the matching session as paid
 */
// Override the base service endpoints to also handle ?ref sessions
// (the existing /agents/:handle/:service handlers already do this via the resource URL)
// We intercept settlement and mark the session here:
const originalHandleService = handleService;

async function handleServiceWithSession(c: any, service: Service) {
  const ref     = c.req.query("ref") as string | undefined;
  const result  = await originalHandleService(c, service);

  // If this was a session-backed request and payment succeeded, mark it paid
  if (ref && sessions.has(ref)) {
    const body   = await c.req.json().catch(() => ({})) as Record<string, string>;
    const handle = c.req.param("handle") as string;
    const inf    = readInfluencer(handle);
    if (inf) {
      const txHash = (result as any)?.txHash ?? null;
      const sess   = sessions.get(ref)!;
      // Deliver with saved payload if body was empty (paywall sends no body)
      const payload = Object.keys(body).length ? body : sess.payload;
      const delivered = deliverService(inf, service, payload, txHash);
      sessions.set(ref, { ...sess, paid: true, txHash, result: delivered });
    }
  }

  return result;
}

// ── Start ─────────────────────────────────────────────────────────────────────

serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`interns.bot x402 server`);
  console.log(`  Listening : http://0.0.0.0:${PORT}`);
  console.log(`  Public URL: ${BASE_URL}`);
  console.log(`  Network   : ${NETWORK}${TESTNET ? " (testnet)" : ""}`);
  console.log(`  Discovery : ${BASE_URL}/`);
});

/**
 * interns.bot x402 payment server
 *
 * Exposes each influencer's intern bot services as x402-payable HTTP endpoints.
 * Agents (AI or human) discover via /.well-known/x402.json and pay with USDC on Base.
 * Human fans on Telegram can pay via the browser paywall at /pay/:handle/:service.
 *
 * Port: X402_PORT (default 4402)
 */

import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { getPaywallHtml } from "x402/paywall";
import fs from "fs";
import path from "path";
import crypto from "crypto";

// ── Config ────────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.X402_PORT ?? "4402");
const INTERNS_DIR = process.env.INTERNS_DIR ?? "/opt/interns";
const BASE_URL = (process.env.X402_BASE_URL ?? `http://localhost:${PORT}`).replace(/\/$/, "");
const CDP_CLIENT_KEY = process.env.CDP_CLIENT_KEY ?? "";
const MAIN_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";  // @the_interns_bot token for influencer notifications
const NETWORK = process.env.X402_NETWORK === "base" ? "base" : "base-sepolia";
const FACILITATOR_URL = process.env.X402_FACILITATOR_URL ?? "https://x402.org/facilitator";

// USDC config per network (address + EIP-712 domain name/version)
const USDC_CONFIG: Record<string, { address: string; name: string; version: string }> = {
  "base":         { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", name: "USD Coin", version: "2" },
  "base-sepolia": { address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", name: "USDC",     version: "2" },
};
const USDC_ADDRESS = USDC_CONFIG[NETWORK].address;
const USDC_NAME    = USDC_CONFIG[NETWORK].name;
const USDC_VERSION = USDC_CONFIG[NETWORK].version;

// Pending Telegram fan payment sessions  { ref → session }
const sessions = new Map<string, {
  handle: string;
  service: "dm" | "shoutout" | "meeting";
  payload: Record<string, string>;
  paid: boolean;
  txHash?: string;
  createdAt: number;
  // Telegram context for post-payment notifications
  fanChatId?: string;
  botToken?: string;
  influencerChatId?: string;
}>();

// ── Helpers ───────────────────────────────────────────────────────────────────

type Service = "dm" | "shoutout" | "meeting";

interface Influencer {
  handle: string;
  agentId: string;
  name: string;
  wallet: string;
  pricing: Record<Service, number>;
  calLink: string;
  botToken: string;
  influencerChatId: string;
}

function readInfluencer(handle: string): Influencer | null {
  const agentId = `${handle}-intern`;
  const agentDir = path.join(INTERNS_DIR, "influencers", agentId);
  if (!fs.existsSync(agentDir)) return null;

  const read = (file: string) => {
    try { return fs.readFileSync(path.join(agentDir, file), "utf-8"); }
    catch { return ""; }
  };

  const data    = read("DATA.md");
  const pricing = read("PRICING.md");
  const persona = read("PERSONA.md");

  const get = (src: string, key: string) =>
    src.match(new RegExp(`${key}:\\s*(.+)`))?.[1]?.trim() ?? "";

  // PERSONA.md: "Full name: Steve55 (steve55)"
  const name = get(persona, "Full name") || handle;

  // PRICING.md: each section has "- price_usd: X" — extract in order
  const priceMatches = [...pricing.matchAll(/- price_usd:\s*([\d.]+)/g)];
  const dmPrice       = parseFloat(priceMatches[0]?.[1] ?? "5");
  const meetingPrice  = parseFloat(priceMatches[1]?.[1] ?? "50");
  const shoutoutPrice = parseFloat(priceMatches[2]?.[1] ?? "20");

  // DATA.md: bankr_wallet, booking_link, bot_token, influencer_chat_id
  const wallet           = get(data, "- bankr_wallet")        || get(data, "bankr_wallet");
  const calLink          = get(data, "- booking_link")        || get(data, "booking_link");
  const botToken         = get(data, "- bot_token")           || get(data, "bot_token");
  const influencerChatId = get(data, "- influencer_chat_id")  || get(data, "influencer_chat_id");

  return {
    handle,
    agentId,
    name,
    wallet,
    calLink,
    botToken,
    influencerChatId,
    pricing: {
      dm:       dmPrice,
      shoutout: shoutoutPrice,
      meeting:  meetingPrice,
    },
  };
}

function listInfluencers(): Influencer[] {
  const dir = path.join(INTERNS_DIR, "influencers");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(d => d.endsWith("-intern") && fs.statSync(path.join(dir, d)).isDirectory())
    .map(d => readInfluencer(d.replace(/-intern$/, "")))
    .filter((x): x is Influencer => x !== null && x.wallet.length > 0);
}

function usdcAtomics(usd: number): string {
  return Math.round(usd * 1_000_000).toString();
}

function serviceLabel(service: Service, name: string): string {
  switch (service) {
    case "dm":       return `Send a private message to ${name}`;
    case "shoutout": return `Request an X shoutout from ${name}`;
    case "meeting":  return `Book a 1-on-1 meeting with ${name}`;
  }
}

function buildRequirements(inf: Influencer, service: Service) {
  const resource = `${BASE_URL}/agents/${inf.handle}/${service}`;
  return {
    scheme:             "exact" as const,
    network:            NETWORK as any,
    maxAmountRequired:  usdcAtomics(inf.pricing[service]),
    resource,
    description:        serviceLabel(service, inf.name),
    mimeType:           "application/json",
    payTo:              inf.wallet,
    maxTimeoutSeconds:  300,
    asset:              USDC_ADDRESS,
    // extra.name + extra.version required by x402.org facilitator for EIP-712 domain verification
    extra: { name: USDC_NAME, version: USDC_VERSION, platform: "interns.bot", handle: inf.handle, service },
  };
}

// ── Telegram notifications ────────────────────────────────────────────────────

async function tgSend(botToken: string, chatId: string, text: string) {
  if (!botToken || !chatId) {
    console.log(`[tg] skipping send — botToken=${botToken ? "set" : "MISSING"} chatId=${chatId || "MISSING"}`);
    return;
  }
  try {
    const tokenPrefix = botToken.slice(0, 8) + "...";
    console.log(`[tg] sendMessage → chatId=${chatId} token=${tokenPrefix}`);
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
    });
    const json = await res.json() as any;
    if (!json.ok) {
      console.log(`[tg] sendMessage error: ${json.description} (code ${json.error_code})`);
    } else {
      console.log(`[tg] sendMessage ok → msgId=${json.result?.message_id}`);
    }
  } catch (e: any) {
    console.log(`[tg] sendMessage exception: ${e.message}`);
  }
}

async function notifyPayment(inf: Influencer, service: Service, payload: Record<string, string>, txHash: string | null, extra: Record<string, any>, fanChatId?: string, botToken?: string, influencerChatId?: string) {
  const fanToken = botToken         || inf.botToken;      // fan-facing intern bot
  const infToken = MAIN_BOT_TOKEN   || fanToken;          // @the_interns_bot for influencer
  const infCid   = influencerChatId || inf.influencerChatId;
  const tx       = txHash ? `\nTx: <code>${txHash}</code>` : "";

  if (service === "dm") {
    if (fanChatId)  await tgSend(fanToken, fanChatId, `Payment confirmed! Your message has been delivered to ${inf.name}.${tx}`);
    if (infCid)     await tgSend(infToken,  infCid,   `New paid DM from fan:\n\n${payload.message ?? ""}${tx}`);
  } else if (service === "shoutout") {
    if (fanChatId)  await tgSend(fanToken, fanChatId, `Payment confirmed! Your shoutout request has been queued for ${inf.name} to approve.${tx}`);
    if (infCid)     await tgSend(infToken,  infCid,   `New paid shoutout request:\n\n${payload.text ?? ""}\n\nFrom: ${payload.from ?? "anonymous"}${tx}`);
  } else if (service === "meeting") {
    const link = extra.bookingUrl ? `\n\nYour one-time booking link:\n${extra.bookingUrl}` : "";
    if (fanChatId)  await tgSend(fanToken, fanChatId, `Payment confirmed! Book your meeting with ${inf.name}.${link}${tx}`);
    if (infCid)     await tgSend(infToken,  infCid,   `New paid meeting booking from ${payload.from ?? "a fan"}.${tx}`);
  }
}

const BLOCKED_WORDS = ["fuck","shit","bitch","cunt","dick","cock","pussy","nigger","faggot","asshole"];
function isVulgar(text: string): boolean {
  const l = text.toLowerCase();
  return BLOCKED_WORDS.some(w => l.includes(w));
}

function decodePaymentHeader(paymentHeader: string): object {
  // x402.org facilitator expects paymentPayload (decoded object), not raw base64 string
  try { return JSON.parse(Buffer.from(paymentHeader, "base64").toString("utf-8")); }
  catch { return paymentHeader as any; } // fallback: pass as-is
}

async function verifyPayment(paymentHeader: string, requirements: object): Promise<{ isValid: boolean; reason?: string }> {
  try {
    const paymentPayload = decodePaymentHeader(paymentHeader);
    const res = await fetch(`${FACILITATOR_URL}/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paymentPayload, paymentRequirements: requirements }),
    });
    const json = await res.json() as any;
    console.log(`[x402] facilitator verify response:`, JSON.stringify(json));
    return { isValid: json.isValid === true, reason: json.invalidReason ?? json.error };
  } catch (e: any) {
    console.log(`[x402] facilitator verify error:`, e);
    return { isValid: false, reason: e.message };
  }
}

async function settlePayment(paymentHeader: string, requirements: object): Promise<string | null> {
  try {
    const paymentPayload = decodePaymentHeader(paymentHeader);
    const res = await fetch(`${FACILITATOR_URL}/settle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paymentPayload, paymentRequirements: requirements }),
    });
    const json = await res.json() as any;
    console.log(`[x402] facilitator settle response:`, JSON.stringify(json));
    return json.txHash ?? json.transaction ?? null;
  } catch { return null; }
}

function deliverService(inf: Influencer, service: Service, payload: Record<string, string>, txHash: string | null) {
  const msgDir = path.join(INTERNS_DIR, "messages");
  fs.mkdirSync(msgDir, { recursive: true });
  const ts = new Date().toISOString();
  const tx = txHash ? ` — tx: ${txHash}` : "";

  if (service === "dm") {
    fs.appendFileSync(
      path.join(msgDir, `${inf.handle}-dm.md`),
      `\n---\n**Paid DM via x402** — ${ts}${tx}\nFrom: ${payload.from ?? "anonymous"}\n\n${payload.message ?? ""}\n`,
    );
    return { delivered: true };
  }

  if (service === "shoutout") {
    fs.appendFileSync(
      path.join(msgDir, `${inf.handle}-shoutout.md`),
      `\n---\n**Shoutout Request via x402** — ${ts}${tx}\nFrom: ${payload.from ?? "anonymous"}\n\n${payload.text ?? ""}\n`,
    );
    return { delivered: true };
  }

  if (service === "meeting") {
    const ref = `pay_${crypto.randomBytes(3).toString("hex")}`;
    const bookingUrl = inf.calLink
      ? `${inf.calLink}?metadata[ref]=${ref}&metadata[tx]=${txHash ?? "x402"}`
      : "";
    fs.appendFileSync(
      path.join(msgDir, `${inf.handle}-meeting.md`),
      `\n---\n**Meeting Booking via x402** — ${ts}${tx}\nRef: ${ref}\nFrom: ${payload.from ?? "anonymous"}\nBooking URL: ${bookingUrl}\n`,
    );
    return { delivered: true, ref, bookingUrl };
  }

  return { delivered: false };
}

// ── x402 route handler (GET = discovery 402, POST = pay + deliver) ────────────

async function x402Handler(c: any, handle: string, service: Service) {
  const inf = readInfluencer(handle);
  if (!inf) return c.json({ error: `Intern bot '${handle}' not found` }, 404);
  if (!inf.wallet) return c.json({ error: "Intern bot wallet not configured" }, 503);

  // Extract ref FIRST — must be included in requirements.resource to match what the wallet signed
  const ref     = new URL(c.req.url, BASE_URL).searchParams.get("ref") ?? undefined;
  const session = ref ? sessions.get(ref) : undefined;

  const requirements = buildRequirements(inf, service);
  if (ref) requirements.resource = `${requirements.resource}?ref=${ref}`;

  const paymentHeader = c.req.header("X-PAYMENT") ?? c.req.header("x-payment");

  // No payment header — return 402 with requirements (works for both GET and POST)
  if (!paymentHeader) {
    return c.json(
      { x402Version: 1, error: "Payment Required", accepts: [requirements] },
      402,
      { "PAYMENT-REQUIRED": Buffer.from(JSON.stringify({ accepts: [requirements] })).toString("base64") },
    );
  }

  // Payment header present — verify and deliver (handles both GET and POST from paywall)
  const method = c.req.method;
  console.log(`[x402] ${method} /${handle}/${service} ref=${ref ?? "none"} session=${session ? "found" : "missing"}`);
  console.log(`[x402] requirements.resource:        ${requirements.resource}`);
  console.log(`[x402] requirements.payTo:           ${(requirements as any).payTo}`);
  console.log(`[x402] requirements.maxAmountRequired: ${(requirements as any).maxAmountRequired}`);
  console.log(`[x402] requirements.network:         ${(requirements as any).network}`);
  // Decode payment header to see what wallet actually signed
  try {
    const decoded = JSON.parse(Buffer.from(paymentHeader, "base64").toString("utf-8"));
    const auth = decoded?.payload?.authorization ?? decoded?.authorization ?? {};
    console.log(`[x402] payment.to:      ${auth.to ?? decoded?.payload?.to ?? "?"}`);
    console.log(`[x402] payment.value:   ${auth.value ?? decoded?.payload?.value ?? "?"}`);
    console.log(`[x402] payment.network: ${decoded?.network ?? "?"}`);
  } catch { /* header may not be base64 JSON */ }
  console.log(`[x402] fanChatId=${session?.fanChatId ?? "none"} botToken=${session?.botToken ? "set" : "MISSING"} influencerChatId=${session?.influencerChatId ?? "none"}`);

  const { isValid, reason } = await verifyPayment(paymentHeader, requirements);
  console.log(`[x402] verify: ${isValid} reason: ${reason ?? "none"}`);
  if (!isValid) {
    return c.json({ x402Version: 1, error: reason ?? "Payment verification failed", accepts: [requirements] }, 402);
  }

  const rawBody = method === "POST"
    ? await c.req.json().catch(() => ({})) as Record<string, string>
    : {};
  const body = { ...(session?.payload ?? {}), ...rawBody };

  const textToCheck = body.message ?? body.text ?? "";
  if (isVulgar(textToCheck)) return c.json({ error: "Content contains inappropriate material" }, 400);

  const txHash = await settlePayment(paymentHeader, requirements);
  const result = deliverService(inf, service, body, txHash);

  // Mark session paid
  if (session && ref) {
    session.paid   = true;
    session.txHash = txHash ?? undefined;
  }

  // Notify fan + influencer via Telegram
  await notifyPayment(inf, service, body, txHash, result,
    session?.fanChatId, session?.botToken, session?.influencerChatId);

  return c.json({ success: true, service, handle, txHash, ...result });
}

// ── App ───────────────────────────────────────────────────────────────────────

const app = new Hono();

// CORS for browser paywall
app.use("*", async (c, next) => {
  await next();
  c.header("Access-Control-Allow-Origin", "*");
  c.header("Access-Control-Allow-Headers", "Content-Type, X-PAYMENT, x-payment");
  c.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
});
app.options("*", (c) => c.text("", 204));

// ── Discovery ─────────────────────────────────────────────────────────────────

// x402 standard: ListDiscoveryResourcesResponse
app.get("/.well-known/x402.json", (c) => {
  const items = listInfluencers().flatMap(inf =>
    (["dm", "shoutout", "meeting"] as Service[]).map(svc => ({
      resource:    `${BASE_URL}/agents/${inf.handle}/${svc}`,
      type:        "http",
      x402Version: 1,
      accepts:     [buildRequirements(inf, svc)],
    }))
  );
  return c.json({ x402Version: 1, items });
});

// agents.json convention
app.get("/.well-known/agents.json", (c) => {
  const agents = listInfluencers().map(inf => ({
    id:       `${BASE_URL}/agents/${inf.handle}`,
    name:     inf.name,
    handle:   inf.handle,
    telegram: `https://t.me/${inf.handle}_intern_bot`,
    services: (["dm", "shoutout", "meeting"] as Service[]).map(svc => ({
      type:        svc,
      description: serviceLabel(svc, inf.name),
      endpoint:    `${BASE_URL}/agents/${inf.handle}/${svc}`,
      method:      "POST",
      payment: {
        protocol:   "x402",
        currency:   "USDC",
        network:    NETWORK,
        amount_usd: inf.pricing[svc],
        asset:      USDC_ADDRESS,
        payTo:      inf.wallet,
      },
    })),
  }));
  return c.json({ platform: "interns.bot", version: 1, agents });
});

// Human-readable index
app.get("/", (c) => {
  const agents = listInfluencers().map(inf => ({
    handle:   inf.handle,
    name:     inf.name,
    telegram: `https://t.me/${inf.handle}_intern_bot`,
    catalog:  `${BASE_URL}/agents/${inf.handle}`,
    services: Object.fromEntries(
      (["dm", "shoutout", "meeting"] as Service[]).map(svc => [
        svc, { endpoint: `${BASE_URL}/agents/${inf.handle}/${svc}`, price_usd: inf.pricing[svc], currency: "USDC" }
      ])
    ),
  }));
  return c.json({ platform: "interns.bot", description: "AI intern bots for creators. Pay with USDC on Base via x402.", x402Version: 1, agents });
});

// Per-influencer catalog
app.get("/agents/:handle", (c) => {
  const inf = readInfluencer(c.req.param("handle"));
  if (!inf) return c.json({ error: "Agent not found" }, 404);
  return c.json({
    handle:   inf.handle,
    name:     inf.name,
    telegram: `https://t.me/${inf.handle}_intern_bot`,
    services: Object.fromEntries(
      (["dm", "shoutout", "meeting"] as Service[]).map(svc => [svc, {
        description: serviceLabel(svc, inf.name),
        endpoint:    `${BASE_URL}/agents/${inf.handle}/${svc}`,
        method:      "POST",
        body:        svc === "dm" ? { message: "string", from: "string?" }
                   : svc === "shoutout" ? { text: "string", from: "string?" }
                   : { from: "string?" },
        payment: { protocol: "x402", currency: "USDC", network: NETWORK, amount_usd: inf.pricing[svc], asset: USDC_ADDRESS, payTo: inf.wallet },
      }])
    ),
  });
});

// ── x402 Service Endpoints ────────────────────────────────────────────────────

// GET returns 402 requirements (for paywall discovery + curl exploration)
// POST without X-PAYMENT returns 402; with X-PAYMENT verifies and delivers
app.get( "/agents/:handle/dm",       (c) => x402Handler(c, c.req.param("handle"), "dm"));
app.post("/agents/:handle/dm",       (c) => x402Handler(c, c.req.param("handle"), "dm"));
app.get( "/agents/:handle/shoutout", (c) => x402Handler(c, c.req.param("handle"), "shoutout"));
app.post("/agents/:handle/shoutout", (c) => x402Handler(c, c.req.param("handle"), "shoutout"));
app.get( "/agents/:handle/meeting",  (c) => x402Handler(c, c.req.param("handle"), "meeting"));
app.post("/agents/:handle/meeting",  (c) => x402Handler(c, c.req.param("handle"), "meeting"));

// ── Browser Paywall (Telegram fan flow) ───────────────────────────────────────

app.get("/pay/:handle/:service", (c) => {
  const handle  = c.req.param("handle");
  const service = c.req.param("service") as Service;
  if (!["dm", "shoutout", "meeting"].includes(service)) return c.text("Not found", 404);

  const inf = readInfluencer(handle);
  if (!inf) return c.text(`Intern bot '${handle}' not found`, 404);
  if (!inf.wallet) return c.text("Intern bot wallet not configured", 503);

  // If ref is present, embed it in the resource URL so it comes back in the POST
  const ref = c.req.query("ref");
  const requirements = buildRequirements(inf, service);
  if (ref) requirements.resource = `${requirements.resource}?ref=${ref}`;

  const html = getPaywallHtml({
    amount:              inf.pricing[service],
    paymentRequirements: [requirements],
    currentUrl:          requirements.resource,
    testnet:             NETWORK !== "base",
    cdpClientKey:        CDP_CLIENT_KEY,
    appName:             `interns.bot — ${inf.name}`,
  });
  return c.html(html);
});

// ── Success page (after browser payment) ─────────────────────────────────────

app.get("/success/:handle/:service", (c) => {
  const handle  = c.req.param("handle");
  const service = c.req.param("service") as Service;
  const ref     = c.req.query("ref") ?? "";
  const tx      = c.req.query("tx") ?? "";
  const inf     = readInfluencer(handle);
  const name    = inf?.name ?? handle;

  const label = service === "dm"       ? "Your message has been delivered!"
              : service === "shoutout" ? "Your shoutout request is on its way!"
              : "Payment received — check Telegram for your booking link!";

  const txLine = tx ? `<p style="color:#888;font-size:13px;word-break:break-all">Tx: ${tx}</p>` : "";
  const tgLine = `<p>Head back to Telegram — you'll receive a confirmation message from <strong>${name}'s intern bot</strong>.</p>`;

  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Payment Confirmed — interns.bot</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;margin:0;background:#0f0f0f;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;}
  .card{background:#1a1a1a;border:1px solid #333;border-radius:16px;padding:40px;max-width:440px;text-align:center;}
  .icon{font-size:56px;margin-bottom:16px;}
  h1{margin:0 0 12px;font-size:22px;}
  p{color:#aaa;line-height:1.6;margin:8px 0;}
  .badge{display:inline-block;background:#1d9bf022;color:#1d9bf0;border:1px solid #1d9bf055;border-radius:8px;padding:6px 14px;font-size:13px;margin-top:16px;}
</style></head><body>
<div class="card">
  <div class="icon">✅</div>
  <h1>${label}</h1>
  ${tgLine}
  ${txLine}
  <div class="badge">Powered by x402 · USDC on Base</div>
</div>
</body></html>`;
  return c.html(html);
});

// ── Telegram session tracking ─────────────────────────────────────────────────
// Bot creates a session → gets paywall URL → fan pays → bot polls status

app.post("/sessions/:handle/:service", async (c) => {
  const handle  = c.req.param("handle");
  const service = c.req.param("service") as Service;
  if (!["dm", "shoutout", "meeting"].includes(service)) return c.json({ error: "Invalid service" }, 400);

  const inf = readInfluencer(handle);
  if (!inf) return c.json({ error: "Agent not found" }, 404);

  const body = await c.req.json().catch(() => ({})) as Record<string, string>;
  const ref  = crypto.randomBytes(4).toString("hex");

  // Extract Telegram context from body (not part of service payload)
  const { fanChatId, botToken, influencerChatId, ...payload } = body;

  sessions.set(ref, {
    handle, service, payload, paid: false, createdAt: Date.now(),
    fanChatId, botToken, influencerChatId,
  });
  setTimeout(() => sessions.delete(ref), 30 * 60 * 1000); // expire after 30 min

  return c.json({
    ref,
    paywall_url: `${BASE_URL}/pay/${handle}/${service}?ref=${ref}`,
    amount_usd:  inf.pricing[service],
    currency:    "USDC",
    network:     NETWORK,
  });
});

app.get("/sessions/:ref/status", (c) => {
  const session = sessions.get(c.req.param("ref"));
  if (!session) return c.json({ error: "Session not found or expired" }, 404);
  return c.json({ ref: c.req.param("ref"), paid: session.paid, txHash: session.txHash ?? null });
});

// ── Start ─────────────────────────────────────────────────────────────────────

// Clean up expired sessions every 10 min
setInterval(() => {
  const now = Date.now();
  for (const [ref, s] of sessions) {
    if (now - s.createdAt > 30 * 60 * 1000) sessions.delete(ref);
  }
}, 10 * 60 * 1000);

serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`interns.bot x402 server listening on port ${PORT}`);
  console.log(`Network:     ${NETWORK}`);
  console.log(`Base URL:    ${BASE_URL}`);
  console.log(`Facilitator: ${FACILITATOR_URL}`);
  console.log(`Discovery:   ${BASE_URL}/.well-known/x402.json`);
});

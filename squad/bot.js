/**
 * Squad Treasury Telegram bot.
 *
 * Commands fall into three buckets:
 *   - read-only (anyone in chat): /help, /members, /policy, /status, /recent, /ledger
 *   - voter (registered members):  /propose, /vote, /dca, /signal
 *   - admin:                       /add_member, /remove_member, /role,
 *                                  /policy set, /cancel
 *
 * Every write path runs `checkChat` + `requireMember`/`requireAdmin`. The bot
 * only responds inside the configured chat (cfg.telegram.chatId).
 *
 * Rendering: every user-facing reply is HTML. User-supplied strings are
 * escaped via `esc()`. Proposal cards are edited in place via callback
 * queries to keep the chat clean.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { Bot, InlineKeyboard, GrammyError, HttpError } from "grammy";

import { loadConfig, requireTelegramToken } from "./config.js";
import {
  addMember,
  countActiveMembers,
  ensureAtLeastOneAdmin,
  getMember,
  isAdmin,
  listMembers,
  removeMember,
  setRole,
} from "./members.js";
import {
  STATUS,
  createProposal,
  expireOverdue,
  getProposal,
  listActiveProposals,
  listRecentProposals,
  recordVote,
  sweepStaleExecuting,
  tally,
} from "./proposals.js";
import { getDb, getPolicyConfig, setPolicyValue } from "./db.js";
import { recentLedgerEntries, spentInWindow } from "./ledger.js";
import { estimateUsd } from "./pricing.js";
import { executeProposal } from "./exec.js";
import { addSchedule, listSchedules, removeSchedule } from "./scheduler.js";
import { addTrigger, listTriggers, removeTrigger } from "./signals.js";

// ---- rendering primitives -------------------------------------------------

const HTML = { parse_mode: "HTML" };
const HTML_NOPREV = { parse_mode: "HTML", disable_web_page_preview: true };

const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

// Strict, enterprise-style tag shown in proposal rows instead of a cute emoji.
const TYPE_TAG = { swap: "SWAP", bridge: "BRIDGE", send: "SEND" };

// Functional markers only — 🟢 success, 🔴 failure, ⏳ waiting. Everything
// else reads as plain words so the card looks like a serious ledger, not a
// sticker pack.
const STATUS_LINE = {
  pending: "⏳ pending",
  approved: "🟢 approved",
  rejected: "🔴 rejected",
  expired: "expired",
  executing: "⏳ executing",
  executed: "🟢 executed",
  failed: "🔴 failed",
};

const EXPLORERS = {
  base: "https://basescan.org/tx/",
  ethereum: "https://etherscan.io/tx/",
  polygon: "https://polygonscan.com/tx/",
  arbitrum: "https://arbiscan.io/tx/",
  optimism: "https://optimistic.etherscan.io/tx/",
  "binance-smart-chain": "https://bscscan.com/tx/",
};

function explorerUrl(chain, hash) {
  return (EXPLORERS[chain] || EXPLORERS.ethereum) + hash;
}

function short(addr, head = 6, tail = 4) {
  if (!addr) return "";
  return addr.length > head + tail + 1 ? `${addr.slice(0, head)}…${addr.slice(-tail)}` : addr;
}

// Absolute UTC timestamp — "18.04 10:57 UTC". Used everywhere we'd otherwise
// print "294m ago" or a half-truncated ISO string.
function fmtAbs(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getUTCDate())}.${pad(d.getUTCMonth() + 1)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

// Clickable short hash that opens the explorer (BaseScan etc.) on tap.
// Returns strict HTML — href and inner text are both escaped so the
// parser can't reject the anchor. Non-hash values render as italics.
function txLink(chain, hash, len = 10) {
  if (!hash || hash === "0xdry-run" || hash === "unknown") {
    return `<i>${esc(hash || "dry-run")}</i>`;
  }
  const label = hash.length > len + 1 ? `${hash.slice(0, len)}…` : hash;
  return `<a href="${esc(explorerUrl(chain, hash))}">${esc(label)}</a>`;
}

function actionLine(p) {
  if (p.type === "swap")
    return `${p.params.amount} ${p.params.fromToken} → ${p.params.toToken}  ·  ${p.params.chain}`;
  if (p.type === "bridge")
    return `${p.params.amount} ${p.params.token}  ·  ${p.params.fromChain} → ${p.params.toChain}`;
  if (p.type === "send")
    return `${p.params.amount} ${p.params.token} → ${short(p.params.to)}  ·  ${p.params.chain}`;
  return p.type;
}

// HTML version — bolds the key fields (amount/asset/chain) for the card.
function formatActionLine(p) {
  if (p.type === "swap")
    return `<b>${esc(p.params.amount)} ${esc(p.params.fromToken)}</b> → <b>${esc(p.params.toToken)}</b> · <b>${esc(p.params.chain)}</b>`;
  if (p.type === "bridge")
    return `<b>${esc(p.params.amount)} ${esc(p.params.token)}</b> · <b>${esc(p.params.fromChain)}</b> → <b>${esc(p.params.toChain)}</b>`;
  if (p.type === "send")
    return `<b>${esc(p.params.amount)} ${esc(p.params.token)}</b> → <code>${esc(short(p.params.to))}</code> · <b>${esc(p.params.chain)}</b>`;
  return esc(p.type);
}

function progressBar(yes, no, quorum) {
  const y = Math.min(yes, quorum);
  const n = Math.min(no, quorum);
  const empty = Math.max(0, quorum - y - n);
  const out = "🟢".repeat(y) + "🔴".repeat(n) + "⚪".repeat(empty);
  return out || "⚪";
}

function formatProposal(p) {
  const votes = p.votes || tally(p.id);
  const cfgDb = getPolicyConfig();
  const quorum = cfgDb.quorum ?? 2;
  const usd = p.estimated_usd != null ? `$${Number(p.estimated_usd).toFixed(2)}` : "?";
  const tag = TYPE_TAG[p.type] || esc(p.type).toUpperCase();
  const statusLine = STATUS_LINE[p.status] || esc(p.status);
  const bar = progressBar(votes.yes, votes.no, quorum);

  return (
    `<b>${tag}</b>  ·  ${formatActionLine(p)}  ·  <b>${usd}</b>\n` +
    `${bar} <i>${votes.yes}/${quorum}</i>  ·  ${statusLine}  ·  <i>exp ${fmtAbs(p.expires_at)}</i>  ·  <code>${esc(p.id)}</code>`
  );
}

// Raw reply_markup so we can pass the Bot API `style` field (success/danger/primary).
// grammy's InlineKeyboard builder doesn't type `style` yet; the emoji prefix
// stays as a fallback for clients that don't render the colored style.
function buildVoteKeyboard(proposalId) {
  return {
    inline_keyboard: [[
      { text: "🟢 Approve", callback_data: `vote:${proposalId}:yes`, style: "success" },
      { text: "🔴 Reject",  callback_data: `vote:${proposalId}:no`,  style: "danger"  },
    ]],
  };
}

// ---- pagination for /recent and /ledger ---------------------------------

const PAGE_SIZE = 5;
const HISTORY_LIMIT = 50;

function pageKb(prefix, page, totalPages) {
  if (totalPages <= 1) return undefined;
  const row = [];
  if (page > 1) row.push({ text: "⬅️ Prev", callback_data: `${prefix}:page:${page - 1}` });
  row.push({ text: `Page ${page}/${totalPages}`, callback_data: "noop" });
  if (page < totalPages) row.push({ text: "Next ➡️", callback_data: `${prefix}:page:${page + 1}` });
  return { inline_keyboard: [row] };
}

function clampPage(page, totalPages) {
  return Math.min(Math.max(1, page | 0 || 1), totalPages);
}

function renderRecentPage(page) {
  const rows = listRecentProposals(HISTORY_LIMIT);
  if (!rows.length) {
    return { text: "<b>Recent proposals</b>\n<i>Nothing yet.</i>", kb: undefined };
  }
  const total = rows.length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const p = clampPage(page, totalPages);
  const slice = rows.slice((p - 1) * PAGE_SIZE, p * PAGE_SIZE);
  const lines = slice.map((r) => {
    const stat = STATUS_LINE[r.status] || esc(r.status);
    const tag = TYPE_TAG[r.type] || esc(r.type).toUpperCase();
    const chain = r.params?.chain || r.params?.fromChain || "base";
    const tx = r.tx_hash ? `  ·  ${txLink(chain, r.tx_hash)}` : "";
    return (
      `<code>${esc(r.id)}</code>  ·  <b>${tag}</b>  ·  ${stat}${tx}  ·  <i>${fmtAbs(r.created_at)}</i>`
    );
  });
  return {
    text: `<b>Recent proposals</b>  <i>(${total})</i>\n\n${lines.join("\n")}`,
    kb: pageKb("recent", p, totalPages),
  };
}

function renderLedgerPage(page) {
  const rows = recentLedgerEntries(HISTORY_LIMIT);
  const spent = spentInWindow();
  const footer = `\n\n<i>24h spend: $${spent.toFixed(2)}</i>`;
  if (!rows.length) {
    return {
      text: `<b>Ledger</b>\n<i>No executed trades yet.</i>${footer}`,
      kb: undefined,
    };
  }
  const total = rows.length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const p = clampPage(page, totalPages);
  const slice = rows.slice((p - 1) * PAGE_SIZE, p * PAGE_SIZE);
  const lines = slice.map((l) => {
    // Ledger has no chain column — treasury is Base-first, so default there.
    const chain = l.chain || "base";
    return `<i>${esc(fmtAbs(l.executed_at))}</i>  ·  <b>$${Number(l.amount_usd).toFixed(2)}</b>  ·  ${txLink(chain, l.tx_hash)}`;
  });
  return {
    text: `<b>Ledger</b>  <i>(${total})</i>\n\n${lines.join("\n")}${footer}`,
    kb: pageKb("ledger", p, totalPages),
  };
}

// ---- /help inline menu --------------------------------------------------

const HELP_MAIN_TEXT =
  "<b>Squad Treasury</b>\n" +
  "Onchain treasury with multisig, policies, and execution.\n\n" +
  "Choose a section:\n\n" +
  "<i>Tip — tap any <code>value</code> to copy it.</i>\n" +
  "<i>/ping for a live health check.</i>";

const HELP_TRADING_TEXT =
  "<b>Trading</b>\n\n" +
  "/propose — interactive wizard\n" +
  "/propose swap &lt;from&gt; &lt;to&gt; &lt;amount&gt; [chain]\n" +
  "/propose bridge &lt;token&gt; &lt;toChain&gt; &lt;amount&gt; &lt;fromChain&gt;\n" +
  "/propose send &lt;token&gt; &lt;amount&gt; &lt;to&gt; &lt;chain&gt;\n" +
  "/vote &lt;id&gt; yes|no — or tap 🟢 / 🔴\n" +
  "/status [id] — active proposals or details\n" +
  "/recent — proposal history (paginated)\n" +
  "/ledger — executed spend (paginated)\n" +
  "/wallet — treasury address &amp; Base balance";

const HELP_POLICY_TEXT =
  "<b>Policy</b>\n\n" +
  "/policy — show current config\n" +
  "/policy set &lt;key&gt; &lt;value&gt; — admin\n\n" +
  "Keys: quorum, daily_limit_usd, allowed_chains, allowed_tokens, time_window_utc, proposal_expiry_minutes\n\n" +
  "<b>Automation</b>\n" +
  "/dca list | add | remove\n" +
  "/signal list | add | remove";

const HELP_TEAM_TEXT =
  "<b>Team</b>\n\n" +
  "/members — roster\n" +
  "/add_member — reply to user (admin)\n" +
  "/remove_member — reply (admin)\n" +
  "/role voter|admin — reply (admin)\n" +
  "/cancel — abort wizard, or cancel a pending proposal (admin)";

const LANDING_TEXT =
  "<b>🛡 Squad Treasury</b>\n" +
  "<i>Autonomous, policy-gated treasury agent for Zerion Frontier.</i>\n\n" +
  "Built on top of the Zerion CLI — every onchain action flows through a " +
  "fail-closed policy engine and a Telegram multisig.\n\n" +
  "<b>How it works</b>\n" +
  "• Members <code>/propose</code> a swap, bridge or send\n" +
  "• Votes tally to quorum  <i>(default 2-of-N)</i>\n" +
  "• CLI signs only if <b>every</b> policy script approves\n" +
  "• Real tx on Base · BaseScan link posted back\n\n" +
  "<b>Baked-in guarantees</b>\n" +
  "🟢 Quorum-required  ·  🟢 Daily spend cap\n" +
  "🟢 Token &amp; chain allowlist  ·  🟢 Fail-closed on DB outage\n" +
  "🟢 Atomic reservation ledger  ·  🟢 No god-mode agent key\n\n" +
  "<i>Add the bot to your squad chat and run /start inside the group to bootstrap.</i>";

const SETUP_TEXT =
  "<b>🛠 Setup guide</b>\n\n" +
  "1. Create a group and add <b>Squad Treasury</b> as a member.\n" +
  "2. <b>Inside the group</b>, run <code>/start</code> — the first caller becomes the founding admin.\n" +
  "3. <code>/add_member</code> (reply to a teammate) to invite voters.\n" +
  "4. <code>/policy</code> to review defaults  ·  <code>/policy set quorum N</code> to tune.\n" +
  "5. <code>/propose</code> launches the interactive wizard — pick swap/bridge/send, token, chain, amount.\n" +
  "6. Members tap 🟢 / 🔴 on the card until quorum is reached; the bot fires the Zerion CLI automatically.\n\n" +
  "<i>Use /help inside the group for the full command reference.</i>";

const HELP_TREASURY_TEXT =
  "<b>Treasury</b>\n\n" +
  "/wallet — treasury address &amp; Base balance\n" +
  "/ledger — executed spend (paginated)\n" +
  "/ping — health · bot, DB, policy engine\n\n" +
  "<i>Tap any <code>value</code> in a message to copy it.</i>";

function helpMainKb() {
  return {
    inline_keyboard: [
      [
        { text: "🗳 Trading",  callback_data: "help:trading"  },
        { text: "🛡 Policy",   callback_data: "help:policy"   },
      ],
      [
        { text: "👥 Team",     callback_data: "help:team"     },
        { text: "💰 Treasury", callback_data: "help:treasury" },
      ],
    ],
  };
}

function helpBackKb() {
  return { inline_keyboard: [[{ text: "🔙 Back", callback_data: "help:main" }]] };
}

function helpSection(section) {
  switch (section) {
    case "trading":  return { text: HELP_TRADING_TEXT,  kb: helpBackKb() };
    case "policy":   return { text: HELP_POLICY_TEXT,   kb: helpBackKb() };
    case "team":     return { text: HELP_TEAM_TEXT,     kb: helpBackKb() };
    case "treasury": return { text: HELP_TREASURY_TEXT, kb: helpBackKb() };
    default:         return { text: HELP_MAIN_TEXT,     kb: helpMainKb() };
  }
}

// ---- interactive /propose wizard ----------------------------------------

const WIZARD_TTL_MS = 10 * 60 * 1000;
const DEFAULT_TOKENS = ["USDC", "ETH", "USDT", "DAI", "WETH"];
const DEFAULT_CHAINS = ["base", "ethereum", "arbitrum", "optimism", "polygon"];

/** @type {Map<number, {step:string,type:string|null,data:Record<string,string>,chatId:number,messageId:number,lastActive:number}>} */
const wizards = new Map();

function getWizard(userId) {
  const w = wizards.get(userId);
  if (!w) return null;
  if (Date.now() - w.lastActive > WIZARD_TTL_MS) {
    wizards.delete(userId);
    return null;
  }
  return w;
}

function setWizard(userId, wiz) {
  wiz.lastActive = Date.now();
  wizards.set(userId, wiz);
  return wiz;
}

function endWizard(userId) {
  wizards.delete(userId);
}

function tokenChoices() {
  const cfgDb = getPolicyConfig();
  if (Array.isArray(cfgDb.allowed_tokens) && cfgDb.allowed_tokens.length) {
    return cfgDb.allowed_tokens;
  }
  return DEFAULT_TOKENS;
}

function chainChoices() {
  const cfgDb = getPolicyConfig();
  if (Array.isArray(cfgDb.allowed_chains) && cfgDb.allowed_chains.length) {
    return cfgDb.allowed_chains;
  }
  return DEFAULT_CHAINS;
}

function gridKeyboard(items, makeData, { cols = 3, back = null } = {}) {
  const kb = new InlineKeyboard();
  items.forEach((item, i) => {
    kb.text(item, makeData(item));
    const end = (i + 1) % cols === 0 || i === items.length - 1;
    if (end && i < items.length - 1) kb.row();
  });
  kb.row();
  if (back) kb.text("⬅️ Back", back);
  kb.text("✖️ Cancel", "wiz:cancel");
  return kb;
}

function wizardSummary(type, data) {
  const parts = [];
  if (type === "swap") {
    if (data.fromToken) parts.push(`from <b>${esc(data.fromToken)}</b>`);
    if (data.toToken) parts.push(`to <b>${esc(data.toToken)}</b>`);
    if (data.chain) parts.push(`on <b>${esc(data.chain)}</b>`);
  } else if (type === "bridge") {
    if (data.token) parts.push(`<b>${esc(data.token)}</b>`);
    if (data.fromChain) parts.push(`from <b>${esc(data.fromChain)}</b>`);
    if (data.toChain) parts.push(`to <b>${esc(data.toChain)}</b>`);
  } else if (type === "send") {
    if (data.token) parts.push(`<b>${esc(data.token)}</b>`);
    if (data.chain) parts.push(`on <b>${esc(data.chain)}</b>`);
    if (data.to) parts.push(`→ <code>${esc(short(data.to, 6, 4))}</code>`);
  }
  return parts.join("  ·  ");
}

const TYPE_LABEL = { swap: "🔄 Swap", bridge: "🌉 Bridge", send: "💸 Send" };

function wizardView(wiz) {
  const { step, type, data } = wiz;
  const header = type ? TYPE_LABEL[type] : "<b>New proposal</b>";
  const summary = type ? wizardSummary(type, data) : "";
  const head = summary
    ? `${header}  ·  ${summary}`
    : header;

  if (step === "type") {
    return {
      text: "<b>New proposal</b>\n<i>Choose the action type:</i>",
      kb: new InlineKeyboard()
        .text("🔄 Swap", "wiz:type:swap")
        .text("🌉 Bridge", "wiz:type:bridge")
        .text("💸 Send", "wiz:type:send")
        .row()
        .text("✖️ Cancel", "wiz:cancel"),
    };
  }

  // SWAP steps
  if (type === "swap" && step === "from") {
    return {
      text: `${head}\n<i>Step 1 of 4 · choose the token to sell:</i>`,
      kb: gridKeyboard(tokenChoices(), (t) => `wiz:from:${t}`, { back: "wiz:back:type" }),
    };
  }
  if (type === "swap" && step === "to") {
    const options = tokenChoices().filter((t) => t !== data.fromToken);
    return {
      text: `${head}\n<i>Step 2 of 4 · choose the token to buy:</i>`,
      kb: gridKeyboard(options, (t) => `wiz:to:${t}`, { back: "wiz:back:from" }),
    };
  }
  if (type === "swap" && step === "chain") {
    return {
      text: `${head}\n<i>Step 3 of 4 · choose the chain:</i>`,
      kb: gridKeyboard(chainChoices(), (c) => `wiz:chain:${c}`, { back: "wiz:back:to" }),
    };
  }
  if (type === "swap" && step === "amount") {
    return {
      text:
        `${head}\n\n` +
        `<b>Step 4 of 4</b>  ·  send the amount as a plain number\n` +
        `<i>e.g. <code>1.5</code>, <code>100</code>, <code>0.002</code></i>`,
      kb: new InlineKeyboard().text("⬅️ Back", "wiz:back:chain").text("✖️ Cancel", "wiz:cancel"),
    };
  }

  // BRIDGE steps
  if (type === "bridge" && step === "token") {
    return {
      text: `${head}\n<i>Step 1 of 4 · choose the token:</i>`,
      kb: gridKeyboard(tokenChoices(), (t) => `wiz:token:${t}`, { back: "wiz:back:type" }),
    };
  }
  if (type === "bridge" && step === "fromchain") {
    return {
      text: `${head}\n<i>Step 2 of 4 · choose the source chain:</i>`,
      kb: gridKeyboard(chainChoices(), (c) => `wiz:fromchain:${c}`, { back: "wiz:back:token" }),
    };
  }
  if (type === "bridge" && step === "tochain") {
    const options = chainChoices().filter((c) => c !== data.fromChain);
    return {
      text: `${head}\n<i>Step 3 of 4 · choose the destination chain:</i>`,
      kb: gridKeyboard(options, (c) => `wiz:tochain:${c}`, { back: "wiz:back:fromchain" }),
    };
  }
  if (type === "bridge" && step === "amount") {
    return {
      text:
        `${head}\n\n` +
        `<b>Step 4 of 4</b>  ·  send the amount as a plain number\n` +
        `<i>e.g. <code>50</code>, <code>0.1</code></i>`,
      kb: new InlineKeyboard().text("⬅️ Back", "wiz:back:tochain").text("✖️ Cancel", "wiz:cancel"),
    };
  }

  // SEND steps
  if (type === "send" && step === "token") {
    return {
      text: `${head}\n<i>Step 1 of 4 · choose the token:</i>`,
      kb: gridKeyboard(tokenChoices(), (t) => `wiz:token:${t}`, { back: "wiz:back:type" }),
    };
  }
  if (type === "send" && step === "sendchain") {
    return {
      text: `${head}\n<i>Step 2 of 4 · choose the chain:</i>`,
      kb: gridKeyboard(chainChoices(), (c) => `wiz:sendchain:${c}`, { back: "wiz:back:token" }),
    };
  }
  if (type === "send" && step === "to_addr") {
    return {
      text:
        `${head}\n\n` +
        `<b>Step 3 of 4</b>  ·  paste the recipient address\n` +
        `<i>must be a valid <code>0x…</code> address (40 hex chars)</i>`,
      kb: new InlineKeyboard().text("⬅️ Back", "wiz:back:sendchain").text("✖️ Cancel", "wiz:cancel"),
    };
  }
  if (type === "send" && step === "amount") {
    return {
      text:
        `${head}\n\n` +
        `<b>Step 4 of 4</b>  ·  send the amount as a plain number`,
      kb: new InlineKeyboard().text("⬅️ Back", "wiz:back:to_addr").text("✖️ Cancel", "wiz:cancel"),
    };
  }

  return {
    text: "🔴 <i>Unknown wizard state — try /propose again.</i>",
    kb: new InlineKeyboard().text("✖️ Cancel", "wiz:cancel"),
  };
}

async function renderWizard(ctx, wiz) {
  const { text, kb } = wizardView(wiz);
  try {
    await ctx.api.editMessageText(wiz.chatId, wiz.messageId, text, {
      ...HTML,
      reply_markup: kb,
    });
  } catch (err) {
    console.error("[wizard] editMessageText:", err?.description || err?.message);
  }
}

async function finalizeWizardProposal(ctx, wiz) {
  const { type, data } = wiz;
  const cfg = loadConfig();

  let params;
  let estSymbol;
  let estAmount;
  let estChain;
  if (type === "swap") {
    params = {
      fromToken: data.fromToken,
      toToken: data.toToken,
      amount: data.amount,
      chain: data.chain,
      toChain: data.chain,
    };
    estSymbol = data.fromToken;
    estAmount = data.amount;
    estChain = data.chain;
  } else if (type === "bridge") {
    params = {
      token: data.token,
      amount: data.amount,
      fromChain: data.fromChain,
      toChain: data.toChain,
    };
    estSymbol = data.token;
    estAmount = data.amount;
    estChain = data.fromChain;
  } else if (type === "send") {
    params = {
      token: data.token,
      amount: data.amount,
      to: data.to,
      chain: data.chain,
    };
    estSymbol = data.token;
    estAmount = data.amount;
    estChain = data.chain;
  } else {
    return;
  }

  const estimatedUsd = await estimateUsd({
    symbol: estSymbol,
    amount: estAmount,
    chain: estChain,
    apiKey: cfg.zerion.apiKey,
  });

  const proposal = createProposal({
    proposerId: ctx.from.id,
    type,
    params,
    estimatedUsd,
    source: "manual",
  });

  endWizard(ctx.from.id);

  try {
    await ctx.api.editMessageText(wiz.chatId, wiz.messageId, formatProposal(proposal), {
      ...HTML_NOPREV,
      reply_markup: buildVoteKeyboard(proposal.id),
    });
  } catch (err) {
    console.error("[wizard] finalize editMessageText:", err?.description || err?.message);
  }
  // Remove the user's numeric/address input to keep the chat clean.
  try {
    await ctx.api.deleteMessage(ctx.chat.id, ctx.message.message_id);
  } catch {}
}

function transitionWizardFromCallback(wiz, action, value) {
  // Returns true on a valid transition, false otherwise.
  if (action === "type") {
    wiz.type = value;
    wiz.data = {};
    wiz.step = value === "swap" ? "from" : "token";
    return true;
  }
  if (wiz.type === "swap") {
    if (action === "from") {
      wiz.data.fromToken = value;
      wiz.step = "to";
      return true;
    }
    if (action === "to") {
      wiz.data.toToken = value;
      wiz.step = "chain";
      return true;
    }
    if (action === "chain") {
      wiz.data.chain = value;
      wiz.step = "amount";
      return true;
    }
  }
  if (wiz.type === "bridge") {
    if (action === "token") {
      wiz.data.token = value;
      wiz.step = "fromchain";
      return true;
    }
    if (action === "fromchain") {
      wiz.data.fromChain = value;
      wiz.step = "tochain";
      return true;
    }
    if (action === "tochain") {
      wiz.data.toChain = value;
      wiz.step = "amount";
      return true;
    }
  }
  if (wiz.type === "send") {
    if (action === "token") {
      wiz.data.token = value;
      wiz.step = "sendchain";
      return true;
    }
    if (action === "sendchain") {
      wiz.data.chain = value;
      wiz.step = "to_addr";
      return true;
    }
  }
  if (action === "back") {
    if (value === "type") {
      wiz.type = null;
      wiz.data = {};
      wiz.step = "type";
      return true;
    }
    wiz.step = value;
    return true;
  }
  return false;
}

async function startWizard(ctx) {
  const wiz = {
    step: "type",
    type: null,
    data: {},
    chatId: ctx.chat.id,
    messageId: 0,
    lastActive: Date.now(),
  };
  const { text, kb } = wizardView(wiz);
  const sent = await ctx.reply(text, { ...HTML, reply_markup: kb });
  wiz.messageId = sent.message_id;
  setWizard(ctx.from.id, wiz);
}

function extractFailureReason(raw) {
  if (!raw) return "unknown error";
  const cleaned = String(raw).replace(/\(node:\d+\)[^\n]*\n?/g, "").trim();
  try {
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (m) {
      const j = JSON.parse(m[0]);
      if (j.error?.message) return j.error.message;
    }
  } catch {}
  return cleaned.slice(-400) || "unknown error";
}

function whoLabel(m) {
  if (!m) return "";
  return m.username ? `@${esc(m.username)}` : `<code>${m.telegram_id}</code>`;
}

// ---- policy value parsing -------------------------------------------------

const LIST_KEYS = new Set(["allowed_chains", "allowed_tokens"]);
const NUMBER_KEYS = new Set(["quorum", "daily_limit_usd", "proposal_expiry_minutes"]);
const OBJECT_KEYS = new Set(["time_window_utc"]);
const POLICY_KEYS = [
  "quorum",
  "daily_limit_usd",
  "allowed_chains",
  "allowed_tokens",
  "time_window_utc",
  "proposal_expiry_minutes",
];

function parsePolicyValue(key, raw) {
  const text = raw.trim();

  if (text === "null" || text === "none" || text === "any") return null;

  try {
    return JSON.parse(text);
  } catch {
    // fall through to heuristics
  }

  if (NUMBER_KEYS.has(key)) {
    const n = Number(text);
    if (!Number.isFinite(n)) throw new Error(`Expected a number for ${key}.`);
    return n;
  }

  if (LIST_KEYS.has(key)) {
    return text
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  if (OBJECT_KEYS.has(key)) {
    const m = text.match(/^(\d{1,2})\s*[-–]\s*(\d{1,2})$/);
    if (m) return { start_hour: Number(m[1]), end_hour: Number(m[2]) };
    throw new Error(`Expected \`H-H\` or JSON for ${key}. Example: 9-17`);
  }

  return text;
}

function formatPolicyValue(key, value) {
  if (value == null) return "any";
  if (LIST_KEYS.has(key)) return Array.isArray(value) ? value.join(", ") : String(value);
  if (OBJECT_KEYS.has(key) && typeof value === "object")
    return `${value.start_hour}:00–${value.end_hour}:00 UTC`;
  if (typeof value === "number" && key === "daily_limit_usd") return `$${value}`;
  if (typeof value === "number" && key === "proposal_expiry_minutes") return `${value}m`;
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

// ---- /ping & /wallet helpers --------------------------------------------

// OWS stores wallet files under ~/.ows/wallets/<uuid>.json with addresses
// sitting in plaintext. We only need the public EVM address for /wallet,
// so read it directly and avoid pulling the native @open-wallet-standard
// bindings into the bot process.
function resolveTreasuryAddress(walletName) {
  if (!walletName) return null;
  const dir = join(homedir(), ".ows", "wallets");
  if (!existsSync(dir)) return null;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      const w = JSON.parse(readFileSync(join(dir, f), "utf8"));
      if (w.name !== walletName) continue;
      const evm = (w.accounts || []).find((a) => a.chain_id?.startsWith("eip155:"));
      return evm?.address || null;
    } catch {
      continue;
    }
  }
  return null;
}

const BASE_RPC = "https://mainnet.base.org";
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

async function rpcCall(method, params) {
  const res = await fetch(BASE_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error.message);
  return json.result;
}

async function fetchBaseBalances(address) {
  const padded = address.replace(/^0x/, "").toLowerCase().padStart(64, "0");
  const [ethHex, usdcHex] = await Promise.all([
    rpcCall("eth_getBalance", [address, "latest"]),
    rpcCall("eth_call", [{ to: USDC_BASE, data: "0x70a08231" + padded }, "latest"]),
  ]);
  const ethWei = BigInt(ethHex);
  const usdcRaw = BigInt(usdcHex);
  // 18-decimal ETH / 6-decimal USDC. Truncate rather than round to avoid
  // showing a balance higher than reality on the low-side.
  const eth = Number(ethWei) / 1e18;
  const usdc = Number(usdcRaw) / 1e6;
  return { eth, usdc };
}

function checkPolicyEngine(cfg) {
  // Mirror guards.js: the bot's policy engine is "active" iff the default
  // wallet has an agent token with all 3 required squad scripts attached.
  const owsKeys = join(homedir(), ".ows", "keys");
  const owsPolicies = join(homedir(), ".ows", "policies");
  if (!existsSync(owsKeys) || !existsSync(owsPolicies)) return false;
  try {
    const required = new Set([
      "quorum-required.mjs",
      "daily-spend-limit.mjs",
      "token-allowlist.mjs",
    ]);
    for (const f of readdirSync(owsKeys)) {
      if (!f.endsWith(".json")) continue;
      const k = JSON.parse(readFileSync(join(owsKeys, f), "utf8"));
      const scripts = new Set();
      for (const pid of k.policy_ids || []) {
        const pfile = join(owsPolicies, `${pid}.json`);
        if (!existsSync(pfile)) continue;
        const pol = JSON.parse(readFileSync(pfile, "utf8"));
        for (const s of pol.config?.scripts || []) {
          scripts.add(s.split(/[\\/]/).pop());
        }
      }
      let ok = true;
      for (const r of required) if (!scripts.has(r)) { ok = false; break; }
      if (ok) return true;
    }
    return false;
  } catch {
    return false;
  }
}

// ---- bot construction -----------------------------------------------------

const COMMANDS = [
  { command: "propose", description: "Create a swap/bridge/send proposal" },
  { command: "vote", description: "Vote on a proposal (or tap buttons)" },
  { command: "status", description: "Active proposals or details by id" },
  { command: "recent", description: "Recent proposals history" },
  { command: "ledger", description: "Executed trades · 24h spend" },
  { command: "wallet", description: "Treasury address & balance" },
  { command: "members", description: "Squad roster" },
  { command: "policy", description: "Show or update policy" },
  { command: "dca", description: "Recurring swaps (list/add/remove)" },
  { command: "signal", description: "Price / drawdown triggers" },
  { command: "add_member", description: "Admin · add a voter (reply)" },
  { command: "remove_member", description: "Admin · remove a member (reply)" },
  { command: "role", description: "Admin · set role (reply)" },
  { command: "cancel", description: "Admin · cancel a pending proposal" },
  { command: "ping", description: "Health · bot, DB, policy engine" },
  { command: "help", description: "Command reference" },
];

export function buildBot() {
  const cfg = loadConfig();
  const token = requireTelegramToken();
  // Require an explicit chat binding. Without it, checkChat() would accept
  // any chat including DMs — an attacker who guesses the bot's username could
  // DM /start and become the founding admin via ensureAtLeastOneAdmin.
  if (!cfg.telegram.chatId) {
    throw new Error(
      "TELEGRAM_CHAT_ID is not set. The squad bot must be bound to a specific " +
      "group chat — export TELEGRAM_CHAT_ID or set telegram.chatId in squad.config.json."
    );
  }
  const bot = new Bot(token);

  bot.catch((err) => {
    const e = err.error;
    if (e instanceof GrammyError) console.error("[grammy]", e.description);
    else if (e instanceof HttpError) console.error("[http]", e);
    else console.error("[bot]", e);
  });

  bot.api
    .setMyCommands(COMMANDS, { scope: { type: "all_group_chats" } })
    .catch((e) => console.error("[bot] setMyCommands:", e?.message));

  // ---- helpers ------------------------------------------------------------
  // Strict chat binding — buildBot() already threw if chatId is unset, so we
  // can treat it as guaranteed present and reject anything else.
  const checkChat = (ctx) => String(ctx.chat?.id) === String(cfg.telegram.chatId);
  const requireMember = (ctx) => {
    const m = getMember(ctx.from?.id);
    if (!m) {
      ctx.reply(
        "🔴 <b>Not a member</b>\n" +
          "<i>Ask an admin to <code>/add_member</code> you.</i>",
        HTML
      );
      return null;
    }
    return m;
  };
  const requireAdmin = (ctx) => {
    if (!isAdmin(ctx.from?.id)) {
      ctx.reply(
        "🔴 <b>Admin only</b>\n" +
          "<i>Ask an existing admin to promote you via <code>/role admin</code>.</i>",
        HTML
      );
      return false;
    }
    return true;
  };

  // ---- /start & /help -----------------------------------------------------
  bot.command("start", async (ctx) => {
    // Private DM → landing page (marketing / onboarding) for people who
    // discover the bot before joining the squad group. The admin-bootstrap
    // branch (ensureAtLeastOneAdmin) only runs inside the configured group,
    // so this split never elevates DM users.
    if (ctx.chat?.type === "private") {
      const u = ctx.me.username;
      const kb = {
        inline_keyboard: [
          [{ text: "➕ Add to group", url: `https://t.me/${u}?startgroup=true` }],
          [
            { text: "📖 Zerion CLI",   url: "https://github.com/zeriontech/zerion-ai" },
            { text: "🛠 Setup guide",  callback_data: "dm:setup" },
          ],
          [{ text: "📘 Commands",      callback_data: "help:main" }],
        ],
      };
      return ctx.reply(LANDING_TEXT, { ...HTML_NOPREV, reply_markup: kb });
    }

    if (!checkChat(ctx)) return;
    const seeded = ensureAtLeastOneAdmin(ctx.from.id, ctx.from.username);
    if (seeded) {
      await ctx.reply(
        "<b>Squad Treasury online</b>\n" +
          "You are the founding admin.\n\n" +
          "Next steps:\n" +
          "1. <code>/add_member</code> — reply to a voter's message\n" +
          "2. <code>/policy</code> — review defaults\n" +
          "3. <code>/propose</code> — launch the wizard",
        HTML_NOPREV
      );
    } else {
      await ctx.reply(
        "<b>Squad Treasury is running.</b>\n<i>Type /help for the command menu.</i>",
        HTML
      );
    }
  });

  bot.command("help", async (ctx) => {
    if (!checkChat(ctx)) return;
    await ctx.api.sendMessage(ctx.chat.id, HELP_MAIN_TEXT, {
      ...HTML_NOPREV,
      reply_markup: helpMainKb(),
    });
  });

  // Bot added to a group → welcome + binding-status note. This instance is
  // bound to a single chat (H1 — strict chat binding), so we still greet
  // random groups but make it clear the bot is not operational there.
  bot.on("message:new_chat_members", async (ctx) => {
    const self = ctx.me.id;
    const added = ctx.message.new_chat_members || [];
    if (!added.some((u) => u.id === self)) return;
    const hereId = String(ctx.chat.id);
    const boundId = String(cfg.telegram.chatId);
    if (hereId === boundId) {
      await ctx.reply(
        "<b>🛡 Squad Treasury online</b>\n" +
          "<i>Fail-closed policy engine active.</i>\n\n" +
          "Run <code>/start</code> to seed the founding admin, then <code>/help</code> for the command menu.",
        HTML_NOPREV
      );
    } else {
      await ctx.reply(
        "<b>🛡 Squad Treasury</b>\n" +
          "<i>Thanks for adding me — but this instance is bound to a different squad chat (strict chat-binding is a security guarantee).</i>\n\n" +
          `Bound chat id: <code>${esc(boundId)}</code>\n` +
          `This chat id:  <code>${esc(hereId)}</code>\n\n` +
          "To run your own squad, deploy the bot with <code>TELEGRAM_CHAT_ID</code> set to this chat.",
        HTML_NOPREV
      );
    }
  });

  // ---- membership ---------------------------------------------------------
  bot.command("add_member", async (ctx) => {
    if (!checkChat(ctx) || !requireAdmin(ctx)) return;
    const reply = ctx.message?.reply_to_message;
    const entities = ctx.message?.entities || [];
    const mention = entities.find((e) => e.type === "text_mention");
    const atMention = entities.find((e) => e.type === "mention");
    let tid;
    let uname;
    if (reply?.from?.id) {
      tid = reply.from.id;
      uname = reply.from.username;
    } else if (mention?.user) {
      tid = mention.user.id;
      uname = mention.user.username;
    } else if (atMention) {
      const handle = ctx.message.text.slice(
        atMention.offset + 1,
        atMention.offset + atMention.length
      );
      return ctx.reply(
        `🔴 Can't resolve <b>@${esc(handle)}</b> — Telegram hides ids for username-only mentions.\n` +
          "<i>Forward a message from them and reply with <code>/add_member</code>, or mention them inline.</i>",
        HTML
      );
    } else {
      return ctx.reply(
        "<b>Usage</b>\n" +
          "• Reply to a user's message with <code>/add_member</code>\n" +
          "• Or inline-mention: <code>/add_member @user</code>",
        HTML
      );
    }
    addMember({ telegramId: tid, username: uname, role: "voter" });
    await ctx.reply(
      `🟢 Added ${uname ? "<b>@" + esc(uname) + "</b>" : `<code>${tid}</code>`} as <i>voter</i>.`,
      HTML
    );
  });

  bot.command("remove_member", async (ctx) => {
    if (!checkChat(ctx) || !requireAdmin(ctx)) return;
    const reply = ctx.message?.reply_to_message;
    if (!reply?.from?.id) {
      return ctx.reply(
        "<b>Usage</b>  ·  reply to the member's message with <code>/remove_member</code>.",
        HTML
      );
    }
    removeMember(reply.from.id);
    const who = reply.from.username ? `@${esc(reply.from.username)}` : `<code>${reply.from.id}</code>`;
    await ctx.reply(`Removed <b>${who}</b>.`, HTML);
  });

  bot.command("role", async (ctx) => {
    if (!checkChat(ctx) || !requireAdmin(ctx)) return;
    const [, newRole] = (ctx.match || "").split(/\s+/);
    const reply = ctx.message?.reply_to_message;
    if (!reply?.from?.id || !["voter", "admin"].includes(newRole)) {
      return ctx.reply(
        "<b>Usage</b>  ·  reply to a member with <code>/role voter</code> or <code>/role admin</code>.",
        HTML
      );
    }
    setRole(reply.from.id, newRole);
    const who = reply.from.username ? `@${esc(reply.from.username)}` : `<code>${reply.from.id}</code>`;
    await ctx.reply(`<b>${who}</b> → <i>${newRole}</i>`, HTML);
  });

  bot.command("members", async (ctx) => {
    if (!checkChat(ctx)) return;
    const rows = listMembers();
    if (!rows.length) {
      return ctx.reply("<i>No members yet.</i>  Use <code>/start</code> to bootstrap.", HTML);
    }
    const lines = rows.map((m) => {
      const who = m.username ? `@${esc(m.username)}` : `<code>${m.telegram_id}</code>`;
      return `${who} — <i>${m.role}</i>`;
    });
    await ctx.reply(
      `<b>Squad</b>  <i>(${rows.length})</i>\n\n${lines.join("\n")}`,
      HTML
    );
  });

  // ---- policy -------------------------------------------------------------
  bot.command("policy", async (ctx) => {
    if (!checkChat(ctx)) return;
    const text = (ctx.match || "").trim();

    if (!text || text === "show") {
      const cfgDb = getPolicyConfig();
      const lines = [
        `<b>Squad Policies</b>`,
        `Quorum: <b>${cfgDb.quorum ?? 2}</b> of ${countActiveMembers()} members`,
        `Daily Limit: <b>${formatPolicyValue("daily_limit_usd", cfgDb.daily_limit_usd)}</b>`,
        `Chains: <b>${esc(formatPolicyValue("allowed_chains", cfgDb.allowed_chains))}</b>`,
        `Tokens: <b>${esc(formatPolicyValue("allowed_tokens", cfgDb.allowed_tokens))}</b>`,
        `Window: <b>${esc(formatPolicyValue("time_window_utc", cfgDb.time_window_utc))}</b>`,
        `Expiry: <b>${formatPolicyValue("proposal_expiry_minutes", cfgDb.proposal_expiry_minutes)}</b>`,
      ];
      const spent = spentInWindow();
      lines.push(``, `<i>Rolling 24h spend: $${spent.toFixed(2)}</i>`);
      return ctx.reply(lines.join("\n"), HTML);
    }

    if (!requireAdmin(ctx)) return;

    const match = text.match(/^set\s+(\S+)\s+(.+)$/);
    if (!match) {
      return ctx.reply(
        "<b>Usage</b>\n" +
          "• <code>/policy</code>  ·  show current\n" +
          "• <code>/policy set &lt;key&gt; &lt;value&gt;</code>  <i>(admin)</i>\n\n" +
          `<b>Keys</b>  ·  ${POLICY_KEYS.join(", ")}\n\n` +
          "<b>Examples</b>\n" +
          "<code>/policy set quorum 2</code>\n" +
          "<code>/policy set daily_limit_usd 500</code>\n" +
          "<code>/policy set allowed_tokens USDC,ETH</code>\n" +
          "<code>/policy set allowed_chains base</code>\n" +
          "<code>/policy set time_window_utc 9-17</code>\n" +
          "<code>/policy set time_window_utc null</code>",
        HTML
      );
    }
    const key = match[1];
    if (!POLICY_KEYS.includes(key)) {
      return ctx.reply(
        `❌ Unknown key <code>${esc(key)}</code>\n<i>Allowed:</i> ${POLICY_KEYS.join(", ")}`,
        HTML
      );
    }
    let value;
    try {
      value = parsePolicyValue(key, match[2]);
    } catch (err) {
      return ctx.reply(`🔴 ${esc(err.message)}`, HTML);
    }
    setPolicyValue(key, value);
    await ctx.reply(
      `🟢 <b>${esc(key)}</b>  ·  ${esc(formatPolicyValue(key, value))}`,
      HTML
    );
  });

  // ---- proposals ---------------------------------------------------------
  bot.command("propose", async (ctx) => {
    if (!checkChat(ctx)) return;
    if (!requireMember(ctx)) return;
    const parts = (ctx.match || "").trim().split(/\s+/).filter(Boolean);

    // No args → start interactive wizard (the normie-friendly path).
    if (parts.length === 0) {
      return startWizard(ctx);
    }

    const [type, ...rest] = parts;
    const supported = ["swap", "bridge", "send"];

    if (!supported.includes(type)) {
      return ctx.reply(
        "<b>Usage</b>\n" +
          "• <code>/propose</code>  ·  <i>interactive wizard</i>\n" +
          "• <code>/propose swap &lt;from&gt; &lt;to&gt; &lt;amount&gt; [chain]</code>\n" +
          "• <code>/propose bridge &lt;token&gt; &lt;toChain&gt; &lt;amount&gt; &lt;fromChain&gt; [toToken]</code>\n" +
          "• <code>/propose send &lt;token&gt; &lt;amount&gt; &lt;to&gt; &lt;chain&gt;</code>",
        HTML
      );
    }

    let params;
    let estSymbol;
    let estAmount;
    let estChain;
    try {
      if (type === "swap") {
        const [fromToken, toToken, amount, chain] = rest;
        if (!fromToken || !toToken || !amount) {
          throw new Error("swap &lt;from&gt; &lt;to&gt; &lt;amount&gt; [chain]");
        }
        const c = chain || cfg.zerion.defaultChain;
        params = { fromToken, toToken, amount, chain: c, toChain: c };
        estSymbol = fromToken;
        estAmount = amount;
        estChain = c;
      } else if (type === "bridge") {
        const [token, toChain, amount, fromChain, toToken] = rest;
        if (!token || !toChain || !amount || !fromChain) {
          throw new Error("bridge &lt;token&gt; &lt;toChain&gt; &lt;amount&gt; &lt;fromChain&gt; [toToken]");
        }
        params = { token, amount, fromChain, toChain, toToken };
        estSymbol = token;
        estAmount = amount;
        estChain = fromChain;
      } else {
        const [token, amount, to, chain] = rest;
        if (!token || !amount || !to || !chain) {
          throw new Error("send &lt;token&gt; &lt;amount&gt; &lt;to&gt; &lt;chain&gt;");
        }
        params = { token, amount, to, chain };
        estSymbol = token;
        estAmount = amount;
        estChain = chain;
      }
    } catch (err) {
      return ctx.reply(`🔴 <b>Missing args</b>\n<code>/propose ${err.message}</code>`, HTML);
    }

    const estimatedUsd = await estimateUsd({
      symbol: estSymbol,
      amount: estAmount,
      chain: estChain,
      apiKey: cfg.zerion.apiKey,
    });

    const proposal = createProposal({
      proposerId: ctx.from.id,
      type,
      params,
      estimatedUsd,
      source: "manual",
    });

    // Direct Bot API call — bypasses grammy's InlineKeyboardMarkup typing so
    // fields like `style` on buttons survive until serialization.
    await ctx.api.sendMessage(ctx.chat.id, formatProposal(proposal), {
      ...HTML_NOPREV,
      reply_markup: buildVoteKeyboard(proposal.id),
    });
  });

  bot.command("vote", async (ctx) => {
    if (!checkChat(ctx)) return;
    if (!requireMember(ctx)) return;
    const [id, vote] = (ctx.match || "").split(/\s+/);
    if (!id || !["yes", "no"].includes(vote)) {
      return ctx.reply(
        "<b>Usage</b>  ·  <code>/vote &lt;proposal_id&gt; yes|no</code>\n" +
          "<i>or just tap the 🟢 / 🔴 buttons on the card.</i>",
        HTML
      );
    }
    try {
      const updated = recordVote({ proposalId: id, memberId: ctx.from.id, vote });
      const kb = updated.status === STATUS.PENDING ? buildVoteKeyboard(id) : undefined;
      await ctx.api.sendMessage(ctx.chat.id, formatProposal(updated), {
        ...HTML_NOPREV,
        reply_markup: kb,
      });
      await maybeExecute(ctx, updated);
    } catch (err) {
      await ctx.reply(`🔴 ${esc(err.message)}`, HTML);
    }
  });

  bot.callbackQuery(/^vote:(prop-[0-9a-f]+):(yes|no)$/, async (ctx) => {
    if (!checkChat(ctx)) return ctx.answerCallbackQuery();
    if (!getMember(ctx.from.id)) {
      return ctx.answerCallbackQuery({
        text: "You are not a squad member.",
        show_alert: true,
      });
    }
    const [, proposalId, vote] = ctx.match;
    try {
      const updated = recordVote({ proposalId, memberId: ctx.from.id, vote });
      await ctx.answerCallbackQuery({
        text: vote === "yes" ? "🟢 vote recorded" : "🔴 vote recorded",
      });
      const kb = updated.status === STATUS.PENDING ? buildVoteKeyboard(proposalId) : undefined;
      await ctx.api.editMessageText(
        ctx.chat.id,
        ctx.callbackQuery.message.message_id,
        formatProposal(updated),
        { ...HTML_NOPREV, reply_markup: kb }
      );
      await maybeExecute(ctx, updated);
    } catch (err) {
      await ctx.answerCallbackQuery({
        text: err.message.slice(0, 180),
        show_alert: true,
      });
    }
  });

  // ---- DM landing buttons ------------------------------------------------
  bot.callbackQuery("dm:setup", async (ctx) => {
    // Opened from the DM landing page — show the step-by-step onboarding.
    // No chat-binding check: DM-only content, admin-bootstrap still gated by
    // the strict checkChat inside /start.
    if (ctx.chat?.type !== "private") return ctx.answerCallbackQuery();
    try {
      await ctx.api.editMessageText(
        ctx.chat.id,
        ctx.callbackQuery.message.message_id,
        SETUP_TEXT,
        { ...HTML_NOPREV, reply_markup: { inline_keyboard: [[{ text: "🔙 Back", callback_data: "dm:landing" }]] } }
      );
    } catch (err) {
      console.error("[dm:setup] edit:", err?.description || err?.message);
    }
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery("dm:landing", async (ctx) => {
    if (ctx.chat?.type !== "private") return ctx.answerCallbackQuery();
    const u = ctx.me.username;
    const kb = {
      inline_keyboard: [
        [{ text: "➕ Add to group", url: `https://t.me/${u}?startgroup=true` }],
        [
          { text: "📖 Zerion CLI",   url: "https://github.com/zeriontech/zerion-ai" },
          { text: "🛠 Setup guide",  callback_data: "dm:setup" },
        ],
        [{ text: "📘 Commands",      callback_data: "help:main" }],
      ],
    };
    try {
      await ctx.api.editMessageText(
        ctx.chat.id,
        ctx.callbackQuery.message.message_id,
        LANDING_TEXT,
        { ...HTML_NOPREV, reply_markup: kb }
      );
    } catch (err) {
      console.error("[dm:landing] edit:", err?.description || err?.message);
    }
    await ctx.answerCallbackQuery();
  });

  // ---- help navigation ---------------------------------------------------
  bot.callbackQuery(/^help:(main|trading|policy|team|treasury)$/, async (ctx) => {
    // Help navigation is available both in DMs (landing-page "Setup Guide"
    // may link here later) and the bound group — skip the strict chat check
    // so private-chat browsing works, but still restrict to those two modes.
    if (ctx.chat?.type !== "private" && !checkChat(ctx)) return ctx.answerCallbackQuery();
    const { text, kb } = helpSection(ctx.match[1]);
    try {
      await ctx.api.editMessageText(
        ctx.chat.id,
        ctx.callbackQuery.message.message_id,
        text,
        { ...HTML_NOPREV, reply_markup: kb }
      );
    } catch (err) {
      console.error("[help] edit:", err?.description || err?.message);
    }
    await ctx.answerCallbackQuery();
  });

  // ---- pagination callbacks ----------------------------------------------
  bot.callbackQuery(/^(recent|ledger):page:(\d+)$/, async (ctx) => {
    if (!checkChat(ctx)) return ctx.answerCallbackQuery();
    const kind = ctx.match[1];
    const page = Number(ctx.match[2]);
    const { text, kb } =
      kind === "recent" ? renderRecentPage(page) : renderLedgerPage(page);
    try {
      await ctx.api.editMessageText(
        ctx.chat.id,
        ctx.callbackQuery.message.message_id,
        text,
        { ...HTML_NOPREV, reply_markup: kb }
      );
    } catch (err) {
      console.error("[pager] edit:", err?.description || err?.message);
    }
    await ctx.answerCallbackQuery();
  });

  // Tap-to-acknowledge for the static page-indicator button.
  bot.callbackQuery("noop", (ctx) => ctx.answerCallbackQuery());

  // ---- wizard callbacks --------------------------------------------------
  bot.callbackQuery(/^wiz:(.+)$/, async (ctx) => {
    if (!checkChat(ctx)) return;
    if (!getMember(ctx.from.id)) {
      return ctx.answerCallbackQuery({
        text: "You are not a squad member.",
        show_alert: true,
      });
    }
    const payload = ctx.match[1];
    const sepIdx = payload.indexOf(":");
    const action = sepIdx === -1 ? payload : payload.slice(0, sepIdx);
    const value = sepIdx === -1 ? "" : payload.slice(sepIdx + 1);

    if (action === "cancel") {
      endWizard(ctx.from.id);
      await ctx.answerCallbackQuery({ text: "cancelled" });
      try {
        await ctx.editMessageText(
          "✖️ <i>Proposal wizard cancelled.</i>",
          HTML
        );
      } catch {}
      return;
    }

    const wiz = getWizard(ctx.from.id);
    if (!wiz) {
      return ctx.answerCallbackQuery({
        text: "Not your wizard — run /propose to start your own.",
      });
    }
    if (ctx.callbackQuery.message?.message_id !== wiz.messageId) {
      return ctx.answerCallbackQuery({
        text: "This wizard belongs to a different message.",
      });
    }

    const ok = transitionWizardFromCallback(wiz, action, value);
    if (!ok) {
      return ctx.answerCallbackQuery({ text: "invalid step" });
    }
    setWizard(ctx.from.id, wiz);
    await ctx.answerCallbackQuery();
    await renderWizard(ctx, wiz);
  });

  bot.command("status", async (ctx) => {
    if (!checkChat(ctx)) return;
    const id = (ctx.match || "").trim();
    if (id) {
      const p = getProposal(id);
      if (!p) return ctx.reply(`<i>Proposal <code>${esc(id)}</code> not found.</i>`, HTML);
      const votes = tally(id);
      return ctx.api.sendMessage(ctx.chat.id, formatProposal({ ...p, votes }), HTML_NOPREV);
    }
    const active = listActiveProposals();
    if (!active.length) {
      return ctx.reply("<i>No active proposals.</i>", HTML);
    }
    const lines = active.map((p) => {
      const tag = TYPE_TAG[p.type] || esc(p.type).toUpperCase();
      const stat = STATUS_LINE[p.status] || esc(p.status);
      return `<code>${esc(p.id)}</code>  ·  <b>${tag}</b>  ·  ${stat}`;
    });
    await ctx.reply(`<b>Active proposals</b>\n\n${lines.join("\n")}`, HTML);
  });

  bot.command("recent", async (ctx) => {
    if (!checkChat(ctx)) return;
    const { text, kb } = renderRecentPage(1);
    await ctx.api.sendMessage(ctx.chat.id, text, {
      ...HTML_NOPREV,
      reply_markup: kb,
    });
  });

  bot.command("cancel", async (ctx) => {
    if (!checkChat(ctx)) return;
    const id = (ctx.match || "").trim();

    // No arg → if the caller has an active wizard, cancel it. Available to
    // anyone so they can abort their own flow without bothering an admin.
    if (!id) {
      const wiz = getWizard(ctx.from.id);
      if (wiz) {
        endWizard(ctx.from.id);
        try {
          await ctx.api.editMessageText(
            wiz.chatId,
            wiz.messageId,
            "✖️ <i>Wizard cancelled.</i>",
            HTML
          );
        } catch {}
        return ctx.reply("<i>Wizard cancelled.</i>", HTML);
      }
      if (!requireAdmin(ctx)) return;
      return ctx.reply(
        "<b>Usage</b>\n" +
          "• <code>/cancel</code>  <i>— abort your active wizard</i>\n" +
          "• <code>/cancel &lt;proposal_id&gt;</code>  <i>(admin)</i>",
        HTML
      );
    }

    if (!requireAdmin(ctx)) return;
    const p = getProposal(id);
    if (!p) return ctx.reply(`<i>Proposal <code>${esc(id)}</code> not found.</i>`, HTML);
    if (p.status !== STATUS.PENDING) {
      return ctx.reply(
        `🔴 Cannot cancel <code>${esc(id)}</code> — status is <b>${esc(p.status)}</b>.`,
        HTML
      );
    }
    getDb()
      .prepare("UPDATE proposals SET status = 'rejected' WHERE id = ? AND status = 'pending'")
      .run(id);
    await ctx.reply(`Cancelled <code>${esc(id)}</code>.`, HTML);
  });

  bot.command("ledger", async (ctx) => {
    if (!checkChat(ctx)) return;
    const { text, kb } = renderLedgerPage(1);
    await ctx.api.sendMessage(ctx.chat.id, text, {
      ...HTML_NOPREV,
      reply_markup: kb,
    });
  });

  // ---- /ping & /wallet ----------------------------------------------------
  bot.command("ping", async (ctx) => {
    if (!checkChat(ctx)) return;
    let dbOk = false;
    let dbMsg = "";
    try {
      getDb().prepare("SELECT 1").get();
      dbOk = true;
    } catch (err) {
      dbMsg = err.message;
    }
    const policyOk = checkPolicyEngine(cfg);
    const lines = [
      "🟢 <b>Bot online</b>  ·  <i>connected as</i> <b>@" + esc(ctx.me.username) + "</b>",
      (dbOk ? "🟢" : "🔴") + " SQLite  ·  <code>" + esc(cfg.dbPath) + "</code>" +
        (dbOk ? "" : "  <i>" + esc(dbMsg) + "</i>"),
      (policyOk ? "🟢" : "🔴") + " Policy engine  ·  " +
        (policyOk
          ? "<i>all 3 required scripts attached</i>"
          : "<i>required scripts missing — signing disabled</i>"),
      cfg.dryRun ? "🟡 <b>DRY-RUN</b>  ·  <i>no onchain transactions will be sent</i>" : "",
    ].filter(Boolean);
    await ctx.reply(lines.join("\n"), HTML);
  });

  bot.command("wallet", async (ctx) => {
    if (!checkChat(ctx)) return;
    const name = cfg.zerion.walletName;
    if (!name) {
      return ctx.reply(
        "🔴 <b>No wallet configured</b>\n" +
          "<i>Set <code>zerion.walletName</code> in squad.config.json.</i>",
        HTML
      );
    }
    const addr = resolveTreasuryAddress(name);
    if (!addr) {
      return ctx.reply(
        `🔴 <b>Wallet</b> <code>${esc(name)}</code> <i>not found in keystore.</i>`,
        HTML
      );
    }
    const explorer = `https://basescan.org/address/${addr}`;
    const head =
      `<b>Treasury wallet</b>  ·  <code>${esc(name)}</code>\n` +
      `<code>${esc(addr)}</code>  <i>(tap to copy)</i>\n`;
    const kb = {
      inline_keyboard: [[{ text: "View on BaseScan", url: explorer }]],
    };
    let balanceLine = "<i>fetching Base balances…</i>";
    const sent = await ctx.reply(head + balanceLine, { ...HTML_NOPREV, reply_markup: kb });
    try {
      const { eth, usdc } = await fetchBaseBalances(addr);
      balanceLine =
        `<b>Base</b>  ·  ${eth.toFixed(6)} ETH  ·  ${usdc.toFixed(2)} USDC`;
    } catch (err) {
      balanceLine = `<i>Base RPC unreachable — ${esc(err.message)}</i>`;
    }
    try {
      await ctx.api.editMessageText(sent.chat.id, sent.message_id, head + balanceLine, {
        ...HTML_NOPREV,
        reply_markup: kb,
      });
    } catch (err) {
      console.error("[wallet] edit:", err?.description || err?.message);
    }
  });

  // ---- DCA ----------------------------------------------------------------
  bot.command("dca", async (ctx) => {
    if (!checkChat(ctx)) return;
    if (!requireMember(ctx)) return;
    const parts = (ctx.match || "").trim().split(/\s+/).filter(Boolean);
    const [sub, ...rest] = parts;

    if (!sub || sub === "list") {
      const rows = listSchedules();
      if (!rows.length) return ctx.reply("<i>No DCA schedules.</i>", HTML);
      const lines = rows.map((r) => {
        const flag = r.active ? "🟢" : "⚪";
        return (
          `${flag}  <b>${esc(r.name)}</b>  ·  ${esc(r.from_token)} → ${esc(r.to_token)}  ·  ${esc(r.amount)} ` +
          `on ${esc(r.chain)}\n     <code>${esc(r.cron)}</code>`
        );
      });
      return ctx.reply(`<b>DCA schedules</b>\n\n${lines.join("\n\n")}`, HTML);
    }
    if (sub === "add") {
      if (!requireAdmin(ctx)) return;
      const [name, fromToken, toToken, amount, chain, ...cronParts] = rest;
      const cron = cronParts.join(" ");
      if (!name || !fromToken || !toToken || !amount || !chain || !cron) {
        return ctx.reply(
          "<b>Usage</b>\n" +
            "<code>/dca add &lt;name&gt; &lt;from&gt; &lt;to&gt; &lt;amount&gt; &lt;chain&gt; &lt;cron&gt;</code>\n\n" +
            "<i>Example · buy 50 USDC → ETH every Monday 13:00 UTC</i>\n" +
            "<code>/dca add weekly-eth USDC ETH 50 base 0 13 * * 1</code>",
          HTML
        );
      }
      addSchedule({
        name,
        fromToken,
        toToken,
        amount,
        chain,
        cron,
        createdBy: ctx.from.id,
      });
      return ctx.reply(`🟢 DCA <b>${esc(name)}</b> added.`, HTML);
    }
    if (sub === "remove") {
      if (!requireAdmin(ctx)) return;
      const [name] = rest;
      if (!name) return ctx.reply("<b>Usage</b>  ·  <code>/dca remove &lt;name&gt;</code>", HTML);
      removeSchedule(name);
      return ctx.reply(`🗑 Removed <b>${esc(name)}</b>.`, HTML);
    }
    return ctx.reply(
      "<i>Sub-commands:</i> <code>list</code>, <code>add</code>, <code>remove</code>.",
      HTML
    );
  });

  // ---- Signal triggers ----------------------------------------------------
  bot.command("signal", async (ctx) => {
    if (!checkChat(ctx)) return;
    if (!requireMember(ctx)) return;
    const parts = (ctx.match || "").trim().split(/\s+/).filter(Boolean);
    const [sub, ...rest] = parts;

    if (!sub || sub === "list") {
      const rows = listTriggers();
      if (!rows.length) return ctx.reply("<i>No signal triggers.</i>", HTML);
      const lines = rows.map((r) => {
        const flag = r.active ? "🟢" : "⚪";
        return `${flag}  <b>${esc(r.name)}</b>  ·  ${esc(r.kind)}\n     <code>${esc(r.config_json)}</code>`;
      });
      return ctx.reply(`<b>Signal triggers</b>\n\n${lines.join("\n\n")}`, HTML);
    }
    if (sub === "add") {
      if (!requireAdmin(ctx)) return;
      const [name, kind, ...jsonParts] = rest;
      const json = jsonParts.join(" ");
      if (!name || !kind || !json) {
        return ctx.reply(
          "<b>Usage</b>\n" +
            "<code>/signal add &lt;name&gt; &lt;kind&gt; &lt;json-config&gt;</code>\n\n" +
            "<b>Kinds</b>  ·  <code>price_below</code>, <code>price_above</code>, <code>portfolio_drawdown</code>\n\n" +
            "<i>Example — buy ETH on dip</i>\n" +
            `<code>/signal add eth-dip price_below {"symbol":"ETH","usd":3000,"action":{"type":"swap","fromToken":"USDC","toToken":"ETH","amount":"100","chain":"base"}}</code>`,
          HTML
        );
      }
      try {
        const config = JSON.parse(json);
        addTrigger({ name, kind, config, createdBy: ctx.from.id });
        return ctx.reply(`🟢 Trigger <b>${esc(name)}</b> added.`, HTML);
      } catch (err) {
        return ctx.reply(`🔴 Invalid JSON: <i>${esc(err.message)}</i>`, HTML);
      }
    }
    if (sub === "remove") {
      if (!requireAdmin(ctx)) return;
      const [name] = rest;
      if (!name) return ctx.reply("<b>Usage</b>  ·  <code>/signal remove &lt;name&gt;</code>", HTML);
      removeTrigger(name);
      return ctx.reply(`🗑 Removed <b>${esc(name)}</b>.`, HTML);
    }
    return ctx.reply(
      "<i>Sub-commands:</i> <code>list</code>, <code>add</code>, <code>remove</code>.",
      HTML
    );
  });

  // ---- wizard text input — registered LAST so every bot.command() above
  // wins. Commands never reach this handler; it only fires for plain text
  // (amount at the amount step, recipient address at the to_addr step).
  bot.on("message:text", async (ctx) => {
    if (!checkChat(ctx)) return;
    const text = ctx.message.text.trim();
    if (!text || text.startsWith("/")) return; // safety net for unknown commands

    const wiz = getWizard(ctx.from.id);
    if (!wiz) return;
    if (ctx.chat.id !== wiz.chatId) return;

    if (wiz.step === "amount") {
      // Same regex as proposals.js validateParams — reject scientific notation,
      // trailing-dot, negatives, etc. at input time instead of at proposal
      // creation (which surfaces a confusing downstream error).
      if (!/^[0-9]+(\.[0-9]+)?$/.test(text) || Number(text) <= 0) {
        await ctx.reply(
          "❌ <i>Send a positive decimal like <code>1.5</code> or <code>100</code> — no scientific notation.</i>",
          HTML
        );
        return;
      }
      wiz.data.amount = text;
      setWizard(ctx.from.id, wiz);
      await finalizeWizardProposal(ctx, wiz);
      return;
    }

    if (wiz.step === "to_addr") {
      if (!/^0x[a-fA-F0-9]{40}$/.test(text)) {
        await ctx.reply(
          "❌ <i>Invalid address — must be <code>0x</code> + 40 hex chars.</i>",
          HTML
        );
        return;
      }
      wiz.data.to = text;
      wiz.step = "amount";
      setWizard(ctx.from.id, wiz);
      await renderWizard(ctx, wiz);
      try {
        await ctx.api.deleteMessage(ctx.chat.id, ctx.message.message_id);
      } catch {}
    }
  });

  return bot;
}

// ---- execution notifications --------------------------------------------

export async function maybeExecute(ctx, proposal) {
  if (!proposal || proposal.status !== STATUS.APPROVED) return;

  const progressMsg = await ctx.reply(
    `⏳ <b>Executing</b>  ·  <code>${esc(proposal.id)}</code>\n<i>waiting for on-chain confirmation…</i>`,
    HTML
  );

  const result = await executeProposal(proposal.id, {
    onLog: (chunk) => process.stdout.write("[cli] " + chunk),
  });

  const chain = proposal.params?.chain || proposal.params?.fromChain || "base";
  const editOptions = { ...HTML_NOPREV };

  if (result.status === "executed") {
    const tx = result.txHash;
    const hasTx = tx && tx !== "unknown";
    const body =
      `🟢 <b>Executed</b>  ·  <code>${esc(proposal.id)}</code>\n` +
      `<blockquote>${formatActionLine(proposal)}</blockquote>\n` +
      (hasTx
        ? `Tx: ${txLink(chain, tx, 16)}`
        : `<i>tx hash unavailable — check wallet activity.</i>`);
    if (hasTx) {
      editOptions.reply_markup = {
        inline_keyboard: [[
          { text: "View on explorer", url: explorerUrl(chain, tx) },
        ]],
      };
    }
    await ctx.api.editMessageText(progressMsg.chat.id, progressMsg.message_id, body, editOptions);
  } else if (result.status === "dry-run") {
    await ctx.api.editMessageText(
      progressMsg.chat.id,
      progressMsg.message_id,
      `<b>Dry-run</b>  ·  <code>${esc(proposal.id)}</code>\n` +
        `<blockquote>${formatActionLine(proposal)}</blockquote>\n` +
        `<i>SQUAD_DRY_RUN=true — no transaction was sent.</i>`,
      editOptions
    );
  } else {
    const reason = extractFailureReason(result.reason);
    await ctx.api.editMessageText(

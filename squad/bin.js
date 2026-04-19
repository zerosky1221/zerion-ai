#!/usr/bin/env node
/**
 * `squad` — unified CLI for Squad Treasury.
 *
 *   squad init          scaffold squad.config.json
 *   squad bot           start the Telegram bot (+ DCA + signals)
 *   squad policies      print the computed policy chain as JSON
 *   squad status        snapshot of proposals, members, ledger
 *
 * Long-running processes (bot) also tick housekeeping every minute.
 */

import { writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

import { loadConfig } from "./config.js";
import { buildBot, tickHousekeeping } from "./bot.js";
import { startSchedulers } from "./scheduler.js";
import { startSignalReactor } from "./signals.js";
import { InlineKeyboard } from "grammy";
import {
  getPolicyConfig,
} from "./db.js";
import { listMembers } from "./members.js";
import { listRecentProposals } from "./proposals.js";
import { recentLedgerEntries, spentInWindow } from "./ledger.js";

const USAGE = `squad — Telegram-based multi-sig agent on top of zerion CLI

Commands:
  squad init               Scaffold squad.config.json in the current directory
  squad bot                Run the Telegram bot (keeps running — use systemd/pm2)
  squad policies           Print the policy chain and current config as JSON
  squad status             Snapshot of members, recent proposals, rolling spend

Environment:
  TELEGRAM_BOT_TOKEN       Bot token from @BotFather (required)
  TELEGRAM_CHAT_ID         Chat id to restrict commands to (optional but recommended)
  ZERION_API_KEY           Zerion API key (required for pricing + swaps)
  ZERION_AGENT_TOKEN       Agent token from \`zerion agent create-token\`
  SQUAD_DB_PATH            Override sqlite path (default ./.squad-data/squad.sqlite)
  SQUAD_DRY_RUN=true       Skip actual CLI invocation, just mark proposal executed
`;

const [, , subcommand] = process.argv;

switch (subcommand) {
  case "init":
    await cmdInit();
    break;
  case "bot":
    await cmdBot();
    break;
  case "policies":
    await cmdPolicies();
    break;
  case "status":
    await cmdStatus();
    break;
  default:
    console.log(USAGE);
    process.exit(subcommand ? 1 : 0);
}

async function cmdInit() {
  const path = resolve(process.cwd(), "squad.config.json");
  if (existsSync(path)) {
    console.error(`squad.config.json already exists at ${path}`);
    process.exit(1);
  }
  const sample = {
    dataDir: "./.squad-data",
    dbPath: "squad.sqlite",
    cliCommand: "zerion",
    dryRun: false,
    telegram: { token: "", chatId: "" },
    zerion: {
      apiKey: "",
      agentToken: "",
      walletName: "",
      defaultChain: "base",
    },
    proposal: { expiryMinutes: 60 },
    signals: { enabled: false, pollIntervalMs: 120000 },
  };
  writeFileSync(path, JSON.stringify(sample, null, 2));
  console.log(`Scaffolded ${path}.`);
  console.log("Next: fill in telegram.token + zerion.apiKey, then run `squad bot`.");
}

async function cmdBot() {
  const cfg = loadConfig();
  if (!cfg.telegram.token) {
    console.error("TELEGRAM_BOT_TOKEN not set. Run `squad init` and fill in the token.");
    process.exit(1);
  }
  const bot = buildBot();

  const notifyChat = async (proposal, meta) => {
    const chatId = cfg.telegram.chatId;
    if (!chatId) {
      console.warn(`[notify] no telegram.chatId set — skipping proposal broadcast ${proposal.id}`);
      return;
    }
    const headline =
      meta?.kind === "dca"
        ? `🤖 *DCA tick* \`${meta.name}\``
        : meta?.kind?.startsWith("price_") || meta?.kind === "portfolio_drawdown"
        ? `📡 *Signal* \`${meta.name}\` — _${meta.reason || ""}_`
        : `*New proposal*`;
    const lines = [headline, ""];
    lines.push(`\`${proposal.id}\` · *${proposal.type}*`);
    lines.push(
      Object.entries(proposal.params)
        .filter(([, v]) => v != null)
        .map(([k, v]) => `• ${k}: ${v}`)
        .join("\n")
    );
    if (proposal.estimated_usd != null)
      lines.push(`• estimated: $${Number(proposal.estimated_usd).toFixed(2)}`);
    lines.push(`• expires in ${cfg.proposal.expiryMinutes}m`);
    await bot.api.sendMessage(chatId, lines.join("\n"), {
      parse_mode: "Markdown",
      reply_markup: new InlineKeyboard()
        .text("✅ Yes", `vote:${proposal.id}:yes`)
        .text("❌ No", `vote:${proposal.id}:no`),
    });
  };

  startSchedulers(notifyChat);
  startSignalReactor(notifyChat);

  setInterval(tickHousekeeping, 60_000);

  console.log(`[squad] bot starting — chat=${cfg.telegram.chatId || "ANY"} db=${cfg.dbPath}`);
  await bot.start({
    drop_pending_updates: true,
    onStart: (me) => console.log(`[squad] connected as @${me.username}`),
  });
}

async function cmdPolicies() {
  const cfg = loadConfig();
  const policy = getPolicyConfig();
  console.log(JSON.stringify({ dbPath: cfg.dbPath, policy }, null, 2));
}

async function cmdStatus() {
  const members = listMembers();
  const recent = listRecentProposals(10);
  const ledger = recentLedgerEntries(10);
  const spent = spentInWindow();
  console.log(
    JSON.stringify(
      {
        members,
        rolling_24h_usd: spent,
        recent_proposals: recent,
        recent_ledger: ledger,
      },
      null,
      2
    )
  );
}

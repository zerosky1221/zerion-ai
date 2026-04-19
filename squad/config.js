/**
 * Squad Treasury configuration loader.
 *
 * Reads env vars and a JSON config file at $SQUAD_CONFIG (default ./squad.config.json).
 * Centralises every knob so bot, scheduler, policies and exec wrapper all agree on paths.
 */

import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

function readJsonIfExists(path) {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`Invalid JSON in ${path}: ${err.message}`);
  }
}

function abs(p, base) {
  if (!p) return p;
  return isAbsolute(p) ? p : resolve(base, p);
}

function parseBoolean(v, fallback = false) {
  if (v === undefined || v === null || v === "") return fallback;
  return /^(1|true|yes|on)$/i.test(String(v));
}

let cached = null;

export function loadConfig() {
  if (cached) return cached;

  const configPath = process.env.SQUAD_CONFIG
    ? resolve(process.env.SQUAD_CONFIG)
    : resolve(REPO_ROOT, "squad.config.json");

  const file = readJsonIfExists(configPath);
  const configDir = dirname(configPath);

  const dataDir = abs(
    process.env.SQUAD_DATA_DIR || file.dataDir || "./.squad-data",
    configDir
  );
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

  const dbPath = abs(
    process.env.SQUAD_DB_PATH || file.dbPath || "squad.sqlite",
    dataDir
  );

  const cfg = {
    configPath,
    repoRoot: REPO_ROOT,
    dataDir,
    dbPath,
    telegram: {
      token: process.env.TELEGRAM_BOT_TOKEN || file.telegram?.token || "",
      chatId: process.env.TELEGRAM_CHAT_ID || file.telegram?.chatId || "",
    },
    zerion: {
      apiKey: process.env.ZERION_API_KEY || file.zerion?.apiKey || "",
      agentToken: process.env.ZERION_AGENT_TOKEN || file.zerion?.agentToken || "",
      walletName: process.env.ZERION_WALLET || file.zerion?.walletName || "",
      defaultChain: file.zerion?.defaultChain || "base",
    },
    cliCommand: file.cliCommand || "zerion",
    dryRun: parseBoolean(process.env.SQUAD_DRY_RUN, file.dryRun ?? false),
    proposal: {
      expiryMinutes: Number(file.proposal?.expiryMinutes ?? 60),
    },
    signals: {
      pollIntervalMs: Number(file.signals?.pollIntervalMs ?? 120_000),
      enabled: file.signals?.enabled ?? false,
    },
  };

  // Prevent silent footguns during demo: token is required for bot; other
  // callers (policies, lookups) don't need it and can still load the config.
  cached = cfg;
  return cfg;
}

export function requireTelegramToken() {
  const cfg = loadConfig();
  if (!cfg.telegram.token) {
    throw new Error(
      "TELEGRAM_BOT_TOKEN is not set. Add it to squad.config.json or export it."
    );
  }
  return cfg.telegram.token;
}

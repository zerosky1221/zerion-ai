/**
 * SQLite store for Squad Treasury.
 *
 * One sqlite file holds every piece of state that must survive restarts
 * AND be readable from two separate Node processes:
 *
 *   1. The long-running Telegram bot (writer + reader)
 *   2. The short-lived `zerion` CLI invocation (reader — policies only)
 *
 * WAL journaling is enabled so that the policy reader does not block the bot
 * while it is writing a vote or a new proposal. Every migration is idempotent.
 */

import Database from "better-sqlite3";
import { loadConfig } from "./config.js";

let dbInstance = null;

export function getDb() {
  if (dbInstance) return dbInstance;
  const { dbPath } = loadConfig();
  dbInstance = new Database(dbPath);
  dbInstance.pragma("journal_mode = WAL");
  dbInstance.pragma("foreign_keys = ON");
  migrate(dbInstance);
  return dbInstance;
}

/**
 * Open the db in read-only mode. Used by policy scripts so a misbehaving
 * policy cannot corrupt bot state.
 */
export function getReadOnlyDb() {
  const { dbPath } = loadConfig();
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  db.pragma("query_only = ON");
  return db;
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS members (
      telegram_id INTEGER PRIMARY KEY,
      username TEXT,
      role TEXT NOT NULL DEFAULT 'voter',
      added_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS policy_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS proposals (
      id TEXT PRIMARY KEY,
      proposer_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      params_json TEXT NOT NULL,
      estimated_usd REAL,
      status TEXT NOT NULL DEFAULT 'pending',
      tx_hash TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      executed_at TEXT,
      failure_reason TEXT,
      source TEXT NOT NULL DEFAULT 'manual'
    );
    CREATE INDEX IF NOT EXISTS idx_proposals_status ON proposals(status);
    CREATE INDEX IF NOT EXISTS idx_proposals_created ON proposals(created_at);

    CREATE TABLE IF NOT EXISTS votes (
      proposal_id TEXT NOT NULL,
      member_id INTEGER NOT NULL,
      vote TEXT NOT NULL CHECK (vote IN ('yes', 'no')),
      voted_at TEXT NOT NULL,
      PRIMARY KEY (proposal_id, member_id),
      FOREIGN KEY (proposal_id) REFERENCES proposals(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      proposal_id TEXT,
      amount_usd REAL NOT NULL,
      tx_hash TEXT,
      executed_at TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'executed',
      FOREIGN KEY (proposal_id) REFERENCES proposals(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ledger_executed ON ledger(executed_at);

    CREATE TABLE IF NOT EXISTS dca_schedules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      from_token TEXT NOT NULL,
      to_token TEXT NOT NULL,
      amount TEXT NOT NULL,
      chain TEXT NOT NULL,
      cron TEXT NOT NULL,
      last_run TEXT,
      next_run TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_by INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS signal_triggers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      kind TEXT NOT NULL,
      config_json TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      last_fired TEXT,
      created_by INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
  `);

  // Backfill `kind` column on pre-existing ledger tables (CREATE TABLE
  // IF NOT EXISTS doesn't add columns to existing tables).
  const ledgerCols = db.prepare("PRAGMA table_info(ledger)").all().map((r) => r.name);
  if (!ledgerCols.includes("kind")) {
    db.exec("ALTER TABLE ledger ADD COLUMN kind TEXT NOT NULL DEFAULT 'executed'");
  }
  // Index creation deferred until after any ALTER, so it runs for both
  // brand-new and migrated databases.
  db.exec("CREATE INDEX IF NOT EXISTS idx_ledger_kind ON ledger(kind)");

  // Seed default policy config rows if empty. Admin adjusts via TG command.
  const defaults = {
    quorum: 2,
    daily_limit_usd: 1000,
    allowed_chains: ["base"],
    allowed_tokens: null, // null == accept any; array == allowlist
    time_window_utc: null, // null == always; {start_hour, end_hour}
    proposal_expiry_minutes: 60,
  };
  const existing = db.prepare("SELECT key FROM policy_config").all().map((r) => r.key);
  const insert = db.prepare("INSERT INTO policy_config(key, value) VALUES(?, ?)");
  const tx = db.transaction(() => {
    for (const [k, v] of Object.entries(defaults)) {
      if (!existing.includes(k)) insert.run(k, JSON.stringify(v));
    }
  });
  tx();
}

export function getPolicyConfig() {
  const rows = getDb().prepare("SELECT key, value FROM policy_config").all();
  const out = {};
  for (const r of rows) out[r.key] = JSON.parse(r.value);
  return out;
}

export function setPolicyValue(key, value) {
  const json = JSON.stringify(value);
  getDb()
    .prepare(
      "INSERT INTO policy_config(key, value) VALUES(?, ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    )
    .run(key, json);
}

export function readonlyPolicyConfig(db) {
  const rows = db.prepare("SELECT key, value FROM policy_config").all();
  const out = {};
  for (const r of rows) out[r.key] = JSON.parse(r.value);
  return out;
}

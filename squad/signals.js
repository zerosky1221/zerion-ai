/**
 * Signal reactor — polls external signals and turns them into proposals.
 *
 * Supported kinds:
 *   price_below    {symbol, usd, chain, action: {...swap params}}
 *   price_above    {symbol, usd, chain, action: {...swap params}}
 *   portfolio_drawdown {address, pct, action: {...}}  // drawdown vs last snapshot
 *
 * Every firing creates a proposal with source="signal:<name>" so the TG
 * group still has to approve. Cooldown: a trigger won't refire within its
 * `cooldown_minutes` (default 60) even if the condition holds.
 */

import { getDb } from "./db.js";
import { loadConfig } from "./config.js";
import { fetchTokenUsd, estimateUsd } from "./pricing.js";
import { createProposal, validateParams } from "./proposals.js";

export function addTrigger({ name, kind, config, createdBy }) {
  if (!["price_below", "price_above", "portfolio_drawdown"].includes(kind)) {
    throw new Error(`Unknown signal kind: ${kind}`);
  }
  // Pre-validate the swap action at trigger creation so bad symbols/chains
  // are rejected now instead of silently at fire-time. Coerce amount to
  // string (config_json may hold it as a JSON number).
  const action = config?.action;
  if (action?.type === "swap") {
    validateParams("swap", {
      fromToken: action.fromToken,
      toToken: action.toToken,
      amount: String(action.amount),
      chain: action.chain,
      toChain: action.chain,
    });
  }
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO signal_triggers (name, kind, config_json, active, created_by, created_at)
       VALUES (?, ?, ?, 1, ?, ?)
       ON CONFLICT(name) DO UPDATE SET kind=excluded.kind, config_json=excluded.config_json, active=1`
    )
    .run(name, kind, JSON.stringify(config), createdBy, now);
}

export function listTriggers() {
  return getDb().prepare("SELECT * FROM signal_triggers ORDER BY created_at DESC").all();
}

export function removeTrigger(name) {
  getDb().prepare("DELETE FROM signal_triggers WHERE name = ?").run(name);
}

function recentlyFired(row, cooldownMinutes) {
  if (!row.last_fired) return false;
  const age = Date.now() - new Date(row.last_fired).getTime();
  return age < cooldownMinutes * 60_000;
}

export function startSignalReactor(notifier) {
  const cfg = loadConfig();
  if (!cfg.signals.enabled) return null;
  const interval = Math.max(30_000, cfg.signals.pollIntervalMs);
  const handle = setInterval(() => pollOnce(notifier).catch(console.error), interval);
  pollOnce(notifier).catch(console.error); // fire immediately
  return () => clearInterval(handle);
}

async function pollOnce(notifier) {
  const cfg = loadConfig();
  const rows = getDb().prepare("SELECT * FROM signal_triggers WHERE active = 1").all();
  for (const row of rows) {
    try {
      const config = JSON.parse(row.config_json);
      const cooldown = Number(config.cooldown_minutes ?? 60);
      if (recentlyFired(row, cooldown)) continue;

      const hit = await evaluate(row.kind, config, cfg);
      if (!hit) continue;

      const action = config.action;
      if (!action || action.type !== "swap") {
        console.warn(`[signal ${row.name}] fired but no swap action configured`);
        continue;
      }
      const estimatedUsd = await estimateUsd({
        symbol: action.fromToken,
        amount: action.amount,
        chain: action.chain,
        apiKey: cfg.zerion.apiKey,
      });
      const proposal = createProposal({
        proposerId: row.created_by,
        type: "swap",
        params: {
          fromToken: action.fromToken,
          toToken: action.toToken,
          amount: action.amount,
          chain: action.chain,
          toChain: action.chain,
        },
        estimatedUsd,
        source: `signal:${row.name}`,
      });
      getDb()
        .prepare("UPDATE signal_triggers SET last_fired = ? WHERE name = ?")
        .run(new Date().toISOString(), row.name);
      notifier?.(proposal, { kind: row.kind, name: row.name, reason: hit.reason });
    } catch (err) {
      console.error(`[signal ${row.name}]`, err);
    }
  }
}

async function evaluate(kind, config, cfg) {
  if (kind === "price_below" || kind === "price_above") {
    const price = await fetchTokenUsd(config.symbol, config.chain, cfg.zerion.apiKey);
    if (price === null) return null;
    if (kind === "price_below" && price < config.usd) return { reason: `${config.symbol}=$${price} < $${config.usd}` };
    if (kind === "price_above" && price > config.usd) return { reason: `${config.symbol}=$${price} > $${config.usd}` };
    return null;
  }
  if (kind === "portfolio_drawdown") {
    // Fetch current total from Zerion and compare to stored snapshot.
    if (!config.address || !cfg.zerion.apiKey) return null;
    const url = new URL(`https://api.zerion.io/v1/wallets/${config.address}/portfolio`);
    const res = await fetch(url, {
      headers: { Authorization: "Basic " + Buffer.from(`${cfg.zerion.apiKey}:`).toString("base64") },
    });
    if (!res.ok) return null;
    const json = await res.json();
    const total = json?.data?.attributes?.total?.positions;
    if (typeof total !== "number") return null;

    const snapRow = getDb()
      .prepare("SELECT value FROM policy_config WHERE key = ?")
      .get(`signal_snapshot_${config.address}`);
    const last = snapRow ? Number(JSON.parse(snapRow.value)) : total;
    const drop = (last - total) / last;

    // Update snapshot for next poll (reset if positive so we track peaks).
    const newSnap = Math.max(last, total);
    getDb()
      .prepare(
        "INSERT INTO policy_config(key, value) VALUES(?, ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
      )
      .run(`signal_snapshot_${config.address}`, JSON.stringify(newSnap));

    if (drop >= (config.pct ?? 0.1)) {
      return { reason: `portfolio drawdown ${(drop * 100).toFixed(1)}% from $${last.toFixed(2)} → $${total.toFixed(2)}` };
    }
    return null;
  }
  return null;
}

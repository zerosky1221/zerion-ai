/**
 * DCA (dollar-cost averaging) scheduler.
 *
 * Cron expressions create *proposals*, never execute swaps directly. That is
 * the whole point: even an automated job has to pass quorum. For a pure
 * solo operator, the squad can set quorum=1 which effectively makes the DCA
 * rip immediately — policy-design wise this is transparent and consistent.
 *
 * Each cron tick:
 *   1. Check schedule is still active
 *   2. Estimate USD for the legs
 *   3. Create a proposal with source="dca:<name>"
 *   4. Post a vote prompt to the configured chat
 *   5. Update last_run / next_run
 */

import cron from "node-cron";
import { getDb } from "./db.js";
import { loadConfig } from "./config.js";
import { createProposal, validateParams } from "./proposals.js";
import { estimateUsd } from "./pricing.js";

const jobs = new Map(); // name -> scheduled task

export function addSchedule({ name, fromToken, toToken, amount, chain, cron: expr, createdBy }) {
  if (!cron.validate(expr)) throw new Error(`Invalid cron expression: ${expr}`);
  // Pre-validate at schedule creation so bad input is rejected immediately,
  // not silently at the next cron tick. Amount is coerced to string to
  // match the proposal validator's contract.
  validateParams("swap", {
    fromToken,
    toToken,
    amount: String(amount),
    chain,
    toChain: chain,
  });
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO dca_schedules (name, from_token, to_token, amount, chain, cron, active, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
       ON CONFLICT(name) DO UPDATE SET from_token=excluded.from_token, to_token=excluded.to_token,
         amount=excluded.amount, chain=excluded.chain, cron=excluded.cron, active=1`
    )
    .run(name, fromToken, toToken, amount, chain, expr, createdBy, now);
}

export function listSchedules() {
  return getDb().prepare("SELECT * FROM dca_schedules ORDER BY created_at DESC").all();
}

export function removeSchedule(name) {
  getDb().prepare("DELETE FROM dca_schedules WHERE name = ?").run(name);
  const task = jobs.get(name);
  if (task) {
    task.stop();
    jobs.delete(name);
  }
}

/**
 * Wire every active schedule into node-cron. Called once at bot startup.
 * The returned notifier callback is invoked with (proposalId, schedule) when
 * a new proposal is created so the bot can post the vote message.
 */
export function startSchedulers(notifier) {
  const rows = listSchedules().filter((r) => r.active);
  for (const row of rows) {
    scheduleJob(row, notifier);
  }
}

function scheduleJob(row, notifier) {
  if (jobs.has(row.name)) jobs.get(row.name).stop();
  const task = cron.schedule(row.cron, async () => {
    try {
      const cfg = loadConfig();
      const estimatedUsd = await estimateUsd({
        symbol: row.from_token,
        amount: row.amount,
        chain: row.chain,
        apiKey: cfg.zerion.apiKey,
      });
      const proposal = createProposal({
        proposerId: row.created_by,
        type: "swap",
        params: {
          fromToken: row.from_token,
          toToken: row.to_token,
          amount: row.amount,
          chain: row.chain,
          toChain: row.chain,
        },
        estimatedUsd,
        source: `dca:${row.name}`,
      });
      getDb()
        .prepare("UPDATE dca_schedules SET last_run = ? WHERE name = ?")
        .run(new Date().toISOString(), row.name);
      notifier?.(proposal, { kind: "dca", name: row.name });
    } catch (err) {
      console.error(`[dca ${row.name}]`, err);
    }
  });
  jobs.set(row.name, task);
}

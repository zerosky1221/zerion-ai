/**
 * Rolling 24h spend ledger.
 *
 * The ledger is written exactly once per executed proposal (see proposals.js).
 * The `daily-spend-limit` policy reads it to compute the rolling window total
 * BEFORE signing, and refuses to sign if `total + proposal.estimated_usd`
 * would exceed the cap. Because the policy executes in-process inside the
 * CLI, the limit is enforced even if the TG bot is bypassed.
 */

import { getDb } from "./db.js";

// Pending reservations and confirmed executions both count against the cap;
// failed/cancelled rows stay in the ledger for audit but don't consume it.
const COUNTED_KINDS = "('reservation', 'executed')";

export function spentInWindow(windowMs = 24 * 60 * 60 * 1000) {
  const cutoff = new Date(Date.now() - windowMs).toISOString();
  const row = getDb()
    .prepare(
      `SELECT COALESCE(SUM(amount_usd), 0) as total FROM ledger
       WHERE executed_at >= ? AND kind IN ${COUNTED_KINDS}`
    )
    .get(cutoff);
  return Number(row.total || 0);
}

export function spentInWindowDb(db, windowMs = 24 * 60 * 60 * 1000) {
  const cutoff = new Date(Date.now() - windowMs).toISOString();
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(amount_usd), 0) as total FROM ledger
       WHERE executed_at >= ? AND kind IN ${COUNTED_KINDS}`
    )
    .get(cutoff);
  return Number(row.total || 0);
}

/**
 * Sum of counted ledger rows in the window EXCLUDING the given proposal's
 * own reservation. Used by the daily-spend policy so we can compute
 * `other_spend + this_proposal_estimate` without double-counting.
 */
export function spentInWindowExcludingDb(db, proposalId, windowMs = 24 * 60 * 60 * 1000) {
  const cutoff = new Date(Date.now() - windowMs).toISOString();
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(amount_usd), 0) as total FROM ledger
       WHERE executed_at >= ? AND kind IN ${COUNTED_KINDS}
         AND (proposal_id IS NULL OR proposal_id != ?)`
    )
    .get(cutoff, proposalId);
  return Number(row.total || 0);
}

export function recentLedgerEntries(limit = 10) {
  return getDb()
    .prepare("SELECT * FROM ledger ORDER BY executed_at DESC LIMIT ?")
    .all(limit);
}

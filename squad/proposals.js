/**
 * Proposal lifecycle: create → collect votes → tally → execute → record.
 *
 * A proposal is the single authoritative record of group intent. Policies
 * read it (by ZERION_PROPOSAL_ID) to decide whether to allow an in-flight
 * `zerion swap` invocation. That is why the schema encodes type + params as
 * the source of truth, not the CLI argv.
 */

import { randomUUID } from "node:crypto";
import { getDb, getPolicyConfig } from "./db.js";
import { countActiveMembers } from "./members.js";

export const STATUS = Object.freeze({
  PENDING: "pending",
  APPROVED: "approved",
  REJECTED: "rejected",
  EXPIRED: "expired",
  EXECUTING: "executing",
  EXECUTED: "executed",
  FAILED: "failed",
});

// ---- param validation ---------------------------------------------------
//
// Every field below ends up as argv for `spawn(zerion, …)`. These regexes
// are the last line of defence against flag smuggling (`--slippage=99`) and
// command injection. Reject anything starting with `-` even if it matches
// the charset — token symbols don't begin with dashes.

const RE_SYMBOL = /^[A-Za-z0-9._-]{1,32}$/;
const RE_CHAIN = /^[a-z0-9-]{2,32}$/;
const RE_AMOUNT = /^[0-9]+(\.[0-9]+)?$/;
const RE_ADDR = /^0x[a-fA-F0-9]{40}$/;

function assertSymbol(v, field) {
  if (typeof v !== "string" || !RE_SYMBOL.test(v) || v.startsWith("-")) {
    throw new Error(`Invalid ${field}: "${v}"`);
  }
}
function assertChain(v, field) {
  if (typeof v !== "string" || !RE_CHAIN.test(v) || v.startsWith("-")) {
    throw new Error(`Invalid ${field}: "${v}"`);
  }
}
function assertAmount(v) {
  if (typeof v !== "string" || !RE_AMOUNT.test(v)) {
    throw new Error(`Invalid amount: "${v}" (expected decimal like "1" or "1.25")`);
  }
}
function assertAddress(v, field) {
  if (typeof v !== "string" || !RE_ADDR.test(v)) {
    throw new Error(`Invalid ${field}: "${v}" (expected 0x + 40 hex chars)`);
  }
}

export function validateParams(type, params) {
  if (!params || typeof params !== "object") {
    throw new Error("Proposal params must be an object");
  }
  assertAmount(params.amount);

  if (type === "swap") {
    assertSymbol(params.fromToken, "fromToken");
    assertSymbol(params.toToken, "toToken");
    assertChain(params.chain, "chain");
    if (params.toChain !== undefined) assertChain(params.toChain, "toChain");
  } else if (type === "bridge") {
    assertSymbol(params.token, "token");
    assertChain(params.fromChain, "fromChain");
    assertChain(params.toChain, "toChain");
    if (params.toToken !== undefined && params.toToken !== null) {
      assertSymbol(params.toToken, "toToken");
    }
  } else if (type === "send") {
    assertSymbol(params.token, "token");
    assertChain(params.chain, "chain");
    assertAddress(params.to, "to");
  } else {
    throw new Error(`Unsupported proposal type: ${type}`);
  }
}

export function createProposal({
  proposerId,
  type,
  params,
  estimatedUsd = null,
  expiryMinutes,
  source = "manual",
}) {
  // Throws before any DB write if params fail validation.
  validateParams(type, params);

  const cfg = getPolicyConfig();
  const ttl = Number(expiryMinutes ?? cfg.proposal_expiry_minutes ?? 60);
  const id = `prop-${randomUUID().slice(0, 8)}`;
  const now = new Date();
  const expires = new Date(now.getTime() + ttl * 60_000);

  getDb()
    .prepare(
      `INSERT INTO proposals
       (id, proposer_id, type, params_json, estimated_usd, status, created_at, expires_at, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      proposerId,
      type,
      JSON.stringify(params),
      estimatedUsd,
      STATUS.PENDING,
      now.toISOString(),
      expires.toISOString(),
      source
    );

  return getProposal(id);
}

export function getProposal(id) {
  const row = getDb().prepare("SELECT * FROM proposals WHERE id = ?").get(id);
  if (!row) return null;
  return hydrate(row);
}

export function getProposalForExec(id) {
  // Used by CLI policies. Includes vote counts.
  const row = getProposal(id);
  if (!row) return null;
  const votes = tally(id);
  return { ...row, votes };
}

export function listActiveProposals() {
  const rows = getDb()
    .prepare(
      "SELECT * FROM proposals WHERE status IN (?, ?) ORDER BY created_at DESC LIMIT 50"
    )
    .all(STATUS.PENDING, STATUS.APPROVED);
  return rows.map(hydrate);
}

export function listRecentProposals(limit = 10) {
  const rows = getDb()
    .prepare("SELECT * FROM proposals ORDER BY created_at DESC LIMIT ?")
    .all(limit);
  return rows.map(hydrate);
}

function hydrate(row) {
  return { ...row, params: JSON.parse(row.params_json) };
}

export function recordVote({ proposalId, memberId, vote }) {
  if (!["yes", "no"].includes(vote)) {
    throw new Error(`Invalid vote: ${vote}`);
  }
  const proposal = getProposal(proposalId);
  if (!proposal) throw new Error(`No proposal: ${proposalId}`);
  if (proposal.status !== STATUS.PENDING) {
    throw new Error(`Proposal ${proposalId} is ${proposal.status}, not accepting votes`);
  }
  if (new Date(proposal.expires_at).getTime() < Date.now()) {
    getDb()
      .prepare("UPDATE proposals SET status = ? WHERE id = ? AND status = ?")
      .run(STATUS.EXPIRED, proposalId, STATUS.PENDING);
    throw new Error(`Proposal ${proposalId} has expired`);
  }

  getDb()
    .prepare(
      "INSERT INTO votes(proposal_id, member_id, vote, voted_at) VALUES(?, ?, ?, ?) " +
      "ON CONFLICT(proposal_id, member_id) DO UPDATE SET vote = excluded.vote, voted_at = excluded.voted_at"
    )
    .run(proposalId, memberId, vote, new Date().toISOString());

  return evaluateProposal(proposalId);
}

export function tally(proposalId) {
  const rows = getDb()
    .prepare("SELECT vote, COUNT(*) as n FROM votes WHERE proposal_id = ? GROUP BY vote")
    .all(proposalId);
  const out = { yes: 0, no: 0 };
  for (const r of rows) out[r.vote] = r.n;
  return out;
}

/**
 * Evaluate whether the proposal has crossed approve/reject thresholds.
 * Called after every vote. Returns the *current* status and whether it changed.
 */
export function evaluateProposal(proposalId) {
  const proposal = getProposal(proposalId);
  if (!proposal) return null;
  if (proposal.status !== STATUS.PENDING) return proposal;

  const cfg = getPolicyConfig();
  const quorum = Number(cfg.quorum ?? 2);
  const totalMembers = countActiveMembers();
  const votes = tally(proposalId);

  // Rejection: more `no` than remaining voters can overturn.
  const undecided = Math.max(0, totalMembers - votes.yes - votes.no);
  const canStillPass = votes.yes + undecided >= quorum;

  let next = null;
  if (votes.yes >= quorum) next = STATUS.APPROVED;
  else if (!canStillPass) next = STATUS.REJECTED;

  if (next) {
    getDb()
      .prepare("UPDATE proposals SET status = ? WHERE id = ? AND status = ?")
      .run(next, proposalId, STATUS.PENDING);
    return { ...proposal, status: next, votes };
  }
  return { ...proposal, votes };
}

/**
 * Atomically transition approved → executing AND insert a ledger
 * "reservation" row so the daily-spend-limit policy sees the pending spend
 * BEFORE the CLI signs. Throws if the proposal isn't in `approved` state —
 * the caller must treat that as a failure.
 */
export function markExecuting(proposalId) {
  const db = getDb();
  const tx = db.transaction(() => {
    const upd = db
      .prepare("UPDATE proposals SET status = ? WHERE id = ? AND status = ?")
      .run(STATUS.EXECUTING, proposalId, STATUS.APPROVED);
    if (upd.changes === 0) {
      throw new Error(`Proposal ${proposalId} is not in approved state (double-execution blocked)`);
    }
    const p = db.prepare("SELECT estimated_usd FROM proposals WHERE id = ?").get(proposalId);
    const amount = Number(p?.estimated_usd || 0);
    db.prepare(
      "INSERT INTO ledger(proposal_id, amount_usd, tx_hash, executed_at, kind) " +
      "VALUES(?, ?, NULL, ?, 'reservation')"
    ).run(proposalId, amount, new Date().toISOString());
  });
  tx();
}

/**
 * Convert the reservation row into an `executed` row with the final tx_hash.
 * Runs inside a single SQLite transaction with the proposal status update so
 * the daily cap accounting stays consistent under concurrent executions.
 */
export function markExecuted(proposalId, { txHash, amountUsd }) {
  const now = new Date().toISOString();
  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare(
      "UPDATE proposals SET status = ?, tx_hash = ?, executed_at = ? WHERE id = ?"
    ).run(STATUS.EXECUTED, txHash, now, proposalId);

    const upd = db.prepare(
      "UPDATE ledger SET kind = 'executed', tx_hash = ?, amount_usd = ?, executed_at = ? " +
      "WHERE proposal_id = ? AND kind = 'reservation'"
    ).run(txHash, amountUsd ?? 0, now, proposalId);

    // Fallback for any path that reaches execution without a reservation
    // (e.g., legacy dry-run call sites). Keeps the ledger complete.
    if (upd.changes === 0) {
      db.prepare(
        "INSERT INTO ledger(proposal_id, amount_usd, tx_hash, executed_at, kind) " +
        "VALUES(?, ?, ?, ?, 'executed')"
      ).run(proposalId, amountUsd ?? 0, txHash, now);
    }
  });
  tx();
}

/**
 * Mark failed + release the reservation so the amount stops counting
 * against the rolling 24h cap. We keep the row (kind='failed') for audit,
 * but spentInWindow excludes non-reservation/executed kinds.
 */
export function markFailed(proposalId, reason) {
  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare(
      "UPDATE proposals SET status = ?, failure_reason = ?, executed_at = ? WHERE id = ?"
    ).run(STATUS.FAILED, reason?.slice(0, 500) || "unknown", new Date().toISOString(), proposalId);
    db.prepare(
      "UPDATE ledger SET kind = 'failed' WHERE proposal_id = ? AND kind = 'reservation'"
    ).run(proposalId);
  });
  tx();
}

/**
 * Sweep pending proposals whose expiry window has elapsed. Called on a tick
 * from the bot so we don't leave stale rows blocking future votes.
 */
export function expireOverdue() {
  const now = new Date().toISOString();
  return getDb()
    .prepare("UPDATE proposals SET status = ? WHERE status = ? AND expires_at < ?")
    .run(STATUS.EXPIRED, STATUS.PENDING, now).changes;
}

/**
 * Recover proposals that got stuck in `executing` because the bot crashed
 * or was killed between markExecuting and markExecuted/markFailed. Without
 * this sweep the reservation keeps consuming the daily cap forever. We key
 * off the reservation ledger row's timestamp so the window starts at the
 * moment the CLI was actually invoked.
 */
export function sweepStaleExecuting(maxAgeMinutes = 10) {
  const cutoff = new Date(Date.now() - maxAgeMinutes * 60_000).toISOString();
  const db = getDb();
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    const stuck = db
      .prepare(
        `SELECT p.id FROM proposals p
         JOIN ledger l ON l.proposal_id = p.id AND l.kind = 'reservation'
         WHERE p.status = ? AND l.executed_at < ?`
      )
      .all(STATUS.EXECUTING, cutoff);
    for (const { id } of stuck) {
      db.prepare(
        "UPDATE proposals SET status = ?, failure_reason = ?, executed_at = ? WHERE id = ?"
      ).run(STATUS.FAILED, "execution timed out — bot restart or crash", now, id);
      db.prepare(
        "UPDATE ledger SET kind = 'failed' WHERE proposal_id = ? AND kind = 'reservation'"
      ).run(id);
    }
    return stuck.length;
  });
  return tx();
}

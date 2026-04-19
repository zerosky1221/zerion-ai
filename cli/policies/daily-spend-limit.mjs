#!/usr/bin/env node
/**
 * Executable policy: block the signing if the rolling 24h USD spend plus the
 * current proposal's estimated USD would exceed policy_config.daily_limit_usd.
 *
 * Reads:
 *   - squad ledger (already-executed amounts in the last 24h)
 *   - proposal.estimated_usd for the in-flight ZERION_PROPOSAL_ID
 *   - policy_config.daily_limit_usd (null disables the cap)
 */

import { fileURLToPath } from "node:url";
import { runPolicyFromStdin } from "../lib/util/prompt.js";
import { getReadOnlyDb, readonlyPolicyConfig } from "../../squad/db.js";
import { spentInWindowExcludingDb } from "../../squad/ledger.js";

export function check(ctx) {
  const proposalId = process.env.ZERION_PROPOSAL_ID;
  // Fail-closed: every policy must independently refuse when proposal
  // context is missing, so the guarantee holds even if another policy in
  // the chain is detached or fails open.
  if (!proposalId) {
    return { allow: false, reason: "ZERION_PROPOSAL_ID missing - fail closed." };
  }

  let db;
  try {
    db = getReadOnlyDb();
  } catch (err) {
    return { allow: false, reason: `Squad DB unreachable: ${err.message}` };
  }

  try {
    const cfg = readonlyPolicyConfig(db);
    const cap = cfg.daily_limit_usd;
    if (cap === null || cap === undefined) return { allow: true };

    const proposal = db
      .prepare("SELECT estimated_usd FROM proposals WHERE id = ?")
      .get(proposalId);

    // Unpriced tokens can't be bounded by a USD cap — refuse rather than
    // treat null as $0 (which would silently bypass the limit).
    const estimatedRaw = proposal?.estimated_usd;
    if (estimatedRaw == null || Number(estimatedRaw) <= 0) {
      return {
        allow: false,
        reason: "Unpriced token - cannot verify against daily limit.",
      };
    }

    const estimated = Number(estimatedRaw);
    // Sum OTHER counted rows (reservations + executed) so we can add this
    // proposal's estimate without double-counting its own reservation.
    const spent = spentInWindowExcludingDb(db, proposalId);
    const projected = spent + estimated;

    if (projected > cap) {
      return {
        allow: false,
        reason:
          `Daily spend cap breached: $${spent.toFixed(2)} already spent, ` +
          `$${estimated.toFixed(2)} pending → $${projected.toFixed(2)} > $${cap} limit.`,
      };
    }
    return { allow: true };
  } finally {
    db.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runPolicyFromStdin(check);
}

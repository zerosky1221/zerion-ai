#!/usr/bin/env node
/**
 * Executable policy: refuse to sign unless a Squad Treasury proposal with
 * matching id exists and has been approved by a member quorum.
 *
 * Contract:
 *   ZERION_PROPOSAL_ID — UUID-ish string, supplied by the bot in the env of
 *   the spawned `zerion swap/bridge/send` process.
 *
 * The proposal row must satisfy BOTH:
 *   status ∈ { approved, executing }   // rejected/expired/pending all fail closed
 *   tally.yes >= policy_config.quorum  // re-computed here, trust nothing
 *
 * Fails closed if the DB cannot be opened — operator must keep the bot and
 * the CLI pointed at the same sqlite file via SQUAD_DB_PATH.
 */

import { fileURLToPath } from "node:url";
import { runPolicyFromStdin } from "../lib/util/prompt.js";
import { getReadOnlyDb, readonlyPolicyConfig } from "../../squad/db.js";

const APPROVED_STATES = new Set(["approved", "executing"]);

export function check(ctx) {
  const proposalId = process.env.ZERION_PROPOSAL_ID;
  if (!proposalId) {
    return {
      allow: false,
      reason:
        "No ZERION_PROPOSAL_ID in environment. Every Squad Treasury transaction " +
        "must originate from an approved group proposal — direct CLI invocation is blocked.",
    };
  }

  let db;
  try {
    db = getReadOnlyDb();
  } catch (err) {
    return {
      allow: false,
      reason: `Squad DB unreachable (${err.message}). Blocking to avoid rogue execution.`,
    };
  }

  try {
    const proposal = db
      .prepare("SELECT id, status, params_json FROM proposals WHERE id = ?")
      .get(proposalId);
    if (!proposal) {
      return { allow: false, reason: `Proposal ${proposalId} not found in squad DB.` };
    }
    if (!APPROVED_STATES.has(proposal.status)) {
      return {
        allow: false,
        reason: `Proposal ${proposalId} has status "${proposal.status}". Only approved proposals can execute.`,
      };
    }

    const tallyRow = db
      .prepare(
        "SELECT COALESCE(SUM(CASE WHEN vote='yes' THEN 1 ELSE 0 END), 0) as yes FROM votes WHERE proposal_id = ?"
      )
      .get(proposalId);
    const yes = Number(tallyRow?.yes || 0);
    const cfg = readonlyPolicyConfig(db);
    const quorum = Number(cfg.quorum ?? 2);

    if (yes < quorum) {
      return {
        allow: false,
        reason: `Proposal ${proposalId} has ${yes}/${quorum} yes votes. Quorum not reached.`,
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

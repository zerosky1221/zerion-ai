#!/usr/bin/env node
/**
 * Executable policy: verify the proposal only references tokens/chains that
 * the squad has explicitly whitelisted. Operates on the proposal record
 * instead of raw calldata — that is the semantic intent the group voted on.
 *
 * Checks:
 *   policy_config.allowed_tokens  - symbols (case-insensitive), null = any
 *   policy_config.allowed_chains  - chain ids/names, null = any
 */

import { fileURLToPath } from "node:url";
import { runPolicyFromStdin } from "../lib/util/prompt.js";
import { getReadOnlyDb, readonlyPolicyConfig } from "../../squad/db.js";

function toUpperList(list) {
  return Array.isArray(list) ? list.map((s) => String(s).toUpperCase()) : null;
}
function toLowerList(list) {
  return Array.isArray(list) ? list.map((s) => String(s).toLowerCase()) : null;
}

export function check(ctx) {
  const proposalId = process.env.ZERION_PROPOSAL_ID;
  // Fail-closed on missing context. Every policy must refuse independently.
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
    const tokens = toUpperList(cfg.allowed_tokens);
    const chains = toLowerList(cfg.allowed_chains);
    if (!tokens && !chains) return { allow: true };

    const row = db
      .prepare("SELECT params_json, type FROM proposals WHERE id = ?")
      .get(proposalId);
    if (!row) return { allow: false, reason: `Proposal ${proposalId} not found.` };
    const params = JSON.parse(row.params_json);

    // Collect every token symbol and chain the proposal touches.
    const touchedTokens = [];
    const touchedChains = [];
    if (params.fromToken) touchedTokens.push(String(params.fromToken));
    if (params.toToken) touchedTokens.push(String(params.toToken));
    if (params.token) touchedTokens.push(String(params.token));
    if (params.chain) touchedChains.push(String(params.chain));
    if (params.fromChain) touchedChains.push(String(params.fromChain));
    if (params.toChain) touchedChains.push(String(params.toChain));

    if (tokens) {
      const bad = touchedTokens
        .map((t) => t.toUpperCase())
        .filter((t) => !tokens.includes(t));
      if (bad.length) {
        return {
          allow: false,
          reason: `Token(s) not in allowlist: ${bad.join(", ")}. Allowed: ${tokens.join(", ")}`,
        };
      }
    }
    if (chains) {
      const bad = touchedChains
        .map((c) => c.toLowerCase())
        .filter((c) => !chains.includes(c));
      if (bad.length) {
        return {
          allow: false,
          reason: `Chain(s) not in allowlist: ${bad.join(", ")}. Allowed: ${chains.join(", ")}`,
        };
      }
    }
    return { allow: true };
  } finally {
    db.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runPolicyFromStdin(check);
}
